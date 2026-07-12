const crypto = require('crypto')
const { spawn } = require('child_process')
const db = require('../db')
const { resolveAttachmentPreview } = require('./attachmentPreview')

const MAX_IMAGES = 10
const MAX_IMAGE_BYTES = 15 * 1024 * 1024
let schemaPromise

function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = db.query(`
      CREATE TABLE IF NOT EXISTS mail_image_ocr_cache (
        tenant_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        engine_key TEXT NOT NULL,
        result_json JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, content_hash, engine_key)
      )
    `).catch(error => { schemaPromise = null; throw error })
  }
  return schemaPromise
}

function runTesseract(buffer, timeoutMs = 30000) {
  return new Promise(resolve => {
    const child = spawn('tesseract', ['stdin', 'stdout', '-l', 'kor+eng'], { stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks = []
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.on('error', () => { clearTimeout(timer); resolve('') })
    child.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8').trim()) })
    child.stdin.on('error', () => {})
    child.stdin.end(buffer)
  })
}

async function runVision(buffer, contentType, model) {
  try {
    const response = await fetch(`${String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || process.env.EASYDOC_OCR_MODEL || 'gemma4:e4b',
        stream: false,
        messages: [{
          role: 'user',
          content: '이미지에서 실제로 보이는 한국어와 영어 텍스트를 충실히 추출하고, 문서 유형과 일정·기관·장소·금액·URL을 한국어로 정리하세요. 읽을 수 없는 내용은 추측하지 마세요.',
          images: [buffer.toString('base64')],
        }],
      }),
      signal: AbortSignal.timeout(60000),
    })
    if (!response.ok) return ''
    const data = await response.json()
    return String(data?.message?.content || '').trim()
  } catch {
    return ''
  }
}

function qualityFor(text) {
  const clean = String(text || '').trim()
  if (clean.length >= 100) return 'high'
  if (clean.length >= 20) return 'medium'
  return clean ? 'low' : 'failed'
}

async function analyzeMailImages({ tenantId, attachments, storage, visionModel }) {
  await ensureSchema()
  const results = []
  for (const attachment of (attachments || []).slice(0, MAX_IMAGES)) {
    if (Number(attachment.size_bytes || 0) > MAX_IMAGE_BYTES) continue
    let buffer
    try { buffer = await storage.getObject(attachment.object_key) } catch { continue }
    const preview = resolveAttachmentPreview({
      buffer,
      filename: attachment.filename,
      declaredContentType: attachment.content_type,
    })
    if (!preview.allowed || preview.kind !== 'image') continue
    const hash = crypto.createHash('sha256').update(buffer).digest('hex')
    const engineKey = `tesseract-kor+eng+vision-v1:${visionModel || process.env.EASYDOC_OCR_MODEL || 'gemma4:e4b'}`
    const cached = await db.query(
      'SELECT result_json FROM mail_image_ocr_cache WHERE tenant_id = $1 AND content_hash = $2 AND engine_key = $3',
      [tenantId, hash, engineKey],
    )
    if (cached.rows[0]) {
      results.push({ attachmentId: attachment.id, filename: attachment.filename, cached: true, ...cached.rows[0].result_json })
      continue
    }
    const text = await runTesseract(buffer)
    const visionSummary = text.length < 100 ? await runVision(buffer, preview.contentType, visionModel) : ''
    const result = { text, visionSummary, quality: qualityFor(text || visionSummary), contentHash: hash }
    await db.query(
      `INSERT INTO mail_image_ocr_cache (tenant_id, content_hash, engine_key, result_json)
       VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (tenant_id, content_hash, engine_key) DO UPDATE SET result_json = EXCLUDED.result_json, updated_at = NOW()`,
      [tenantId, hash, engineKey, JSON.stringify(result)],
    )
    results.push({ attachmentId: attachment.id, filename: attachment.filename, cached: false, ...result })
  }
  return results
}

function formatImageAnalysisForSummary(results) {
  return (results || []).filter(item => item.text || item.visionSummary).map((item, index) => [
    `[이미지 OCR ${index + 1}]`,
    `attachmentId: ${item.attachmentId}`,
    `quality: ${item.quality}`,
    item.text ? `text:\n${item.text}` : '',
    item.visionSummary ? `vision:\n${item.visionSummary}` : '',
  ].filter(Boolean).join('\n')).join('\n\n')
}

module.exports = { analyzeMailImages, formatImageAnalysisForSummary, qualityFor }
