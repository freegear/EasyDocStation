const express = require('express')
const router = express.Router()
const path = require('path')
const fs = require('fs')
const http = require('http')
const { spawn } = require('child_process')
const multer = require('multer')
const db = require('../db')
const requireAuth = require('../middleware/auth')
const { getDatabasePath } = require('../databasePaths')
const { getPythonExecutable } = require('../pythonRuntime')

const CONFIG_PATH = path.resolve(__dirname, '../../config.json')
const RAG_SERVER_PORT = 5001
const RAG_DATA_DIR = path.resolve(__dirname, '../../Database/RAGTrainingData')
const RAG_DATA_INDEX_PATH = path.join(RAG_DATA_DIR, 'index.json')
const RAG_DATA_TMP_DIR = path.join(RAG_DATA_DIR, 'tmp')

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }
  catch (e) { return {} }
}

function ensureRagDatasetStore() {
  fs.mkdirSync(RAG_DATA_DIR, { recursive: true })
  fs.mkdirSync(RAG_DATA_TMP_DIR, { recursive: true })
  if (!fs.existsSync(RAG_DATA_INDEX_PATH)) {
    fs.writeFileSync(RAG_DATA_INDEX_PATH, '[]', 'utf8')
  }
}

function readRagDatasetIndex() {
  ensureRagDatasetStore()
  try {
    const raw = fs.readFileSync(RAG_DATA_INDEX_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch (_) {
    return []
  }
}

function writeRagDatasetIndex(items) {
  ensureRagDatasetStore()
  fs.writeFileSync(RAG_DATA_INDEX_PATH, JSON.stringify(items, null, 2), 'utf8')
}

function buildPgInClause(values = [], startIndex = 1) {
  const placeholders = values.map((_, i) => `$${startIndex + i}`).join(', ')
  return `(${placeholders})`
}

function makeDatasetId() {
  return `rag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function sanitizeFilename(name = '') {
  const normalized = String(name || '').normalize('NFC')
  const noPathSep = normalized.replace(/[\/\\]/g, '_')
  const noControl = noPathSep.replace(/[\u0000-\u001F\u007F]/g, '')
  const safe = noControl
    .replace(/[^\p{L}\p{N}.\-()\[\] _]+/gu, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return safe || `file-${Date.now()}`
}

function extnameOf(fileName = '') {
  return path.extname(fileName).replace('.', '').toLowerCase()
}

function hangulCount(str = '') {
  return (String(str).match(/[가-힣]/g) || []).length
}

function maybeDecodeLatin1Filename(name = '') {
  const original = String(name || '')
  if (!original) return original
  // RFC5987 / percent-encoded 케이스 우선 복원
  if (/%[0-9A-Fa-f]{2}/.test(original)) {
    try {
      return decodeURIComponent(original)
    } catch (_) {}
  }
  try {
    const decoded = Buffer.from(original, 'latin1').toString('utf8')
    const originalHangul = hangulCount(original)
    const decodedHangul = hangulCount(decoded)
    if (decodedHangul > originalHangul) return decoded
    if (/[\u00C0-\u00FF]/.test(original) && decodedHangul > 0) return decoded
    return original
  } catch (_) {
    return original
  }
}

function looksMojibake(name = '') {
  const s = String(name || '')
  if (!s) return false
  if (/[�]/.test(s)) return true
  if (/[ÃÂáàäâéèêëíìïîóòôöúùûüµ¼]/.test(s)) return true
  const underscoreRatio = (s.match(/_/g) || []).length / Math.max(1, s.length)
  return underscoreRatio > 0.25 && !/[가-힣]/.test(s)
}

function getExtFromName(name = '', fallbackExt = '') {
  const ext = path.extname(String(name || '')).replace('.', '').toLowerCase()
  return ext || String(fallbackExt || '').toLowerCase()
}

function fallbackKoreanDisplayName(item, decodedName) {
  const ext = getExtFromName(decodedName, item.ext)
  const base = String(decodedName || '').replace(/\.[^.]+$/, '')
  const dateMatch = base.match(/(20\d{6,8})/)
  const suffix = dateMatch ? dateMatch[1] : String(item.id || '').slice(-6)
  return `학습데이터_${suffix}${ext ? `.${ext}` : ''}`
}

function getDisplayFilename(item) {
  const preferred = item.original_filename || item.filename
  const decoded = maybeDecodeLatin1Filename(preferred)
  if (looksMojibake(decoded)) return fallbackKoreanDisplayName(item, decoded)
  return decoded
}

ensureRagDatasetStore()

const ragDatasetUpload = multer({
  dest: RAG_DATA_TMP_DIR,
  limits: {
    files: 100,
    fileSize: 1024 * 1024 * 1024, // 1GB per file
  },
})

function callPythonTrainer(payload) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve(__dirname, '../rag_train.py')
    const proc = spawn(getPythonExecutable(), [scriptPath], { timeout: 600000 })

    proc.stdin.write(JSON.stringify(payload))
    proc.stdin.end()

    let stderr = ''
    proc.stdout.on('data', d => process.stdout.write(d))
    proc.stderr.on('data', d => {
      stderr += d.toString()
      process.stderr.write(d)
    })
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(stderr || `rag_train.py exit ${code}`))
    })
    proc.on('error', reject)
  })
}

function toDatasetRecordView(item) {
  return {
    id: item.id,
    filename: getDisplayFilename(item),
    content_type: item.content_type || 'application/octet-stream',
    size: item.size || 0,
    ext: item.ext || '',
    created_at: item.created_at,
    status: item.status || 'ready',
    trained_at: item.trained_at || null,
    error: item.error || null,
  }
}

async function buildTrainerPostFromDataset(item) {
  const cfg = readConfig()
  const ragCfg = cfg.rag || {}
  const absPath = path.resolve(RAG_DATA_DIR, item.storage_path || '')
  const ext = (item.ext || '').toLowerCase()
  const isPdf = ext === 'pdf' || String(item.content_type || '').includes('pdf')
  const isWord = ['doc', 'docx'].includes(ext)
  const isText = ['txt', 'md', 'csv', 'log', 'json'].includes(ext) || String(item.content_type || '').startsWith('text/')

  const post = {
    id: item.id,
    channel_id: 'rag_dataset',
    content: '',
    source: 'manual_dataset',
    pdfs: [],
    words: [],
  }

  if (!fs.existsSync(absPath)) {
    throw new Error(`학습 파일이 존재하지 않습니다: ${item.filename}`)
  }
  const displayFilename = getDisplayFilename(item)

  if (isPdf) {
    post.content = `[RAG 학습 데이터] ${displayFilename}`
    post.pdfs = [{ id: item.id, path: absPath, file_name: displayFilename }]
  } else if (isWord) {
    post.content = `[RAG 학습 데이터] ${displayFilename}`
    post.words = [{ id: item.id, path: absPath, file_name: displayFilename }]
  } else if (isText) {
    let text = ''
    try {
      text = fs.readFileSync(absPath, 'utf8')
    } catch (e) {
      throw new Error(`텍스트 파일 읽기 실패: ${displayFilename}`)
    }
    post.content = `[RAG 학습 데이터] ${displayFilename}\n\n${text}`
  } else {
    // Excel / PPT / Image 등 파싱 미지원 형식은 메타데이터 텍스트로 학습
    post.content = [
      `[RAG 학습 데이터] ${displayFilename}`,
      `파일 형식: ${ext || 'unknown'}`,
      '이 파일 형식은 현재 원문 파싱 미지원이며 파일 메타데이터만 학습됩니다.',
    ].join('\n')
  }

  return {
    payload: {
      config: {
        lancedb_path: getDatabasePath(cfg, 'lancedb Database Path'),
        file_training_path: path.resolve(__dirname, '../../Database/ObjectFile/FileTrainingData'),
        chunk_size: ragCfg.chunk_size ?? 800,
        chunk_overlap: ragCfg.chunk_overlap ?? 100,
        vector_size: ragCfg.vectorSize ?? 1024,
      },
      posts: [post],
      comments: [],
    }
  }
}

// ─── 영구 Python RAG 서버 관리 ────────────────────────────────
let ragServerReady = false
let ragServerProc  = null
let ragServerDisabled = false
let ragServerDisableReason = ''

function startRagServer() {
  if (ragServerDisabled) return
  const script = path.resolve(__dirname, '../rag_server.py')
  let fatalImportError = false
  ragServerProc = spawn(getPythonExecutable(), [script, String(RAG_SERVER_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  ragServerProc.stdout.on('data', d => {
    const msg = d.toString()
    process.stdout.write(`[RAG Server] ${msg}`)
    if (msg.includes('시작됨')) ragServerReady = true
  })
  ragServerProc.stderr.on('data', d => {
    const msg = d.toString()
    // 모델 초기화 과정의 정상 stderr 메시지는 억제
    const IGNORE_PATTERNS = [
      'huggingface', 'tokenizer', 'Batches',
      'HF Hub', 'HF_TOKEN', 'unauthenticated',   // HF Hub 인증 경고 (정상)
      'rate limits', 'faster downloads',           // HF Hub 속도 안내 (정상)
      'Loading weights', 'FutureWarning',          // 모델 로드 경고 (정상)
      'UserWarning', 'DeprecationWarning',         // Python 라이브러리 경고 (정상)
      'warnings.warn',
    ]
    const isNoise = IGNORE_PATTERNS.some(p => msg.includes(p))
    if (msg.includes("ModuleNotFoundError: No module named 'torch'")) {
      fatalImportError = true
      ragServerDisabled = true
      ragServerDisableReason = "python module 'torch' is missing"
    }
    if (!isNoise) {
      process.stderr.write(`[RAG Server ERR] ${msg}`)
    }
  })
  ragServerProc.on('close', code => {
    ragServerReady = false
    ragServerProc = null
    if (fatalImportError) {
      console.warn(`[RAG Server] 비활성화됨: ${ragServerDisableReason}.`)
      return
    }
    if (code !== null) {  // 의도적 종료가 아닐 때만 재시작
      console.log(`[RAG Server] 프로세스 종료 (code=${code}), 5초 후 재시작...`)
      setTimeout(startRagServer, 5000)
    }
  })
}

startRagServer()

// ─── 영구 서버 HTTP 호출 ──────────────────────────────────────
function callRagServer(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = http.request({
      hostname: '127.0.0.1',
      port: RAG_SERVER_PORT,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, res => {
      let data = ''
      res.on('data', d => data += d)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error('검색 결과 파싱 실패')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('RAG 서버 타임아웃')) })
    req.write(body)
    req.end()
  })
}

function waitForRagServerReady(timeoutMs = 1200) {
  if (ragServerReady) return Promise.resolve(true)
  if (ragServerDisabled) return Promise.resolve(false)

  const startedAt = Date.now()
  return new Promise(resolve => {
    const timer = setInterval(() => {
      if (ragServerReady) {
        clearInterval(timer)
        resolve(true)
        return
      }
      if (ragServerDisabled || Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer)
        resolve(false)
      }
    }, 100)
  })
}

async function callPythonSearch(payload) {
  if (ragServerDisabled) return []
  const ready = ragServerReady ? true : await waitForRagServerReady(1200)
  if (!ready) return []

  try {
    return await callRagServer(payload)
  } catch (e) {
    ragServerReady = false
    console.warn('[RAG] 서버 검색 실패, 이번 요청은 빈 결과로 처리:', e.message)
    return []
  }
}

function isAmountQuery(query = '') {
  return /(금액|합계|총액|소계|부가세|vat|견적\s*비용|견적\s*금액|얼마)/i.test(String(query || ''))
}

function isCommandQuery(query = '') {
  return /(명령어|커맨드|cli|command|설정\s*명령|show\s+\S+|snmp|config|configure|실행\s*명령)/i.test(String(query || ''))
}

function asNum(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function amountDocScore(doc) {
  const meta = doc?.metadata || {}
  const text = String(doc?.text || '')
  const type = String(meta.type || '').toLowerCase()
  const distance = asNum(doc?.score)
  let score = -distance

  if (type === 'amount_summary') score += 100
  if (asNum(meta.amount_total) > 0) score += 40
  if (asNum(meta.amount_subtotal) > 0) score += 20
  if (asNum(meta.amount_vat) > 0) score += 20
  if (/(합계|총액|소계|부가세|vat|원)/i.test(text)) score += 15

  return score
}

function hasAmountSignal(doc) {
  const meta = doc?.metadata || {}
  const type = String(meta.type || '').toLowerCase()
  const text = String(doc?.text || '')
  return (
    type === 'amount_summary' ||
    asNum(meta.amount_total) > 0 ||
    asNum(meta.amount_subtotal) > 0 ||
    asNum(meta.amount_vat) > 0 ||
    /(합계|총액|소계|부가세|vat|공급가액|총\s*금액|원)/i.test(text)
  )
}

function hasCommandSignal(doc) {
  const text = String(doc?.text || '')
  return (
    /(snmp-server|show\s+snmp|show\s+\S+|no\s+snmp-server|community|trap-source|enable\s+traps)/i.test(text) ||
    /(명령어|CLI|설정 예제)/i.test(text)
  )
}

function normalizeMatchToken(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '')
}

function extractSourceHints(query = '', preferredSources = []) {
  const hints = new Set()
  const src = String(query || '')
  const directFiles = src.match(/[A-Za-z0-9가-힣_.()\-]+\.(pdf|docx|doc|pptx|xlsx|csv|txt|md)/gi) || []
  for (const item of directFiles) hints.add(item)

  const cSeries = src.match(/\bC\d{3,}\b/gi) || []
  for (const item of cSeries) hints.add(item)

  const manualWords = src.match(/[A-Za-z0-9가-힣_.()\-]{2,}(?:매뉴얼|manual|시리즈|series)/gi) || []
  for (const item of manualWords) hints.add(item)

  for (const item of (Array.isArray(preferredSources) ? preferredSources : [])) {
    if (item) hints.add(String(item))
  }

  const normalized = [...hints]
    .map(normalizeMatchToken)
    .filter(v => v.length >= 2)
  return [...new Set(normalized)]
}

function sourceHintBoost(doc, sourceHints = []) {
  if (!Array.isArray(sourceHints) || sourceHints.length === 0) return 0
  const meta = doc?.metadata || {}
  const source = normalizeMatchToken(`${meta.source || ''} ${meta.file_name || ''}`)
  if (!source) return 0

  let boost = 0
  for (const hint of sourceHints) {
    if (!hint) continue
    if (source.includes(hint)) boost += 35
    else if (hint.includes(source) && source.length >= 5) boost += 15
  }
  return Math.min(boost, 80)
}

function amountDocBonus(doc) {
  const base = -asNum(doc?.score)
  return amountDocScore(doc) - base
}

function commandDocBonus(doc) {
  const text = String(doc?.text || '')
  let score = 0
  if (/(snmp-server|show\s+snmp|no\s+snmp-server)/i.test(text)) score += 70
  if (/(show\s+\S+|no\s+\S+)/i.test(text)) score += 25
  if (/(명령어:|CLI|설정 예제|SNMPv1\/2c|SNMPv3|Trap)/i.test(text)) score += 20
  return score
}

function buildSearchResultKey(item = {}) {
  const m = item?.metadata || {}
  const textHead = String(item?.text || '').slice(0, 80)
  return [
    m.post_id || '',
    m.type || '',
    m.attachment_id || '',
    m.comment_id || '',
    m.page_number || 0,
    m.chunk_index ?? m.chunk_id ?? 0,
    textHead,
  ].join(':')
}

function mergeUniqueResults(...arrays) {
  const out = []
  const seen = new Set()
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue
    for (const item of arr) {
      const key = buildSearchResultKey(item)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  return out
}

// ─── 참고문헌 정보 DB 조회 (병렬 처리) ──────────────────────
async function enrichReferences(results) {
  function classifyRefType(rawType = '') {
    const t = String(rawType || '').toLowerCase()
    if (t.includes('comment')) return 'comment'
    if (t === 'amount_summary') return 'amount'
    if (t === 'table') return 'table'
    if (t === 'image') return 'image'
    if (t === 'word') return 'word'
    if (t === 'text') return 'text'
    return 'post'
  }

  const seen = new Set()
  const unique = []
  for (const r of results) {
    const {
      post_id,
      type,
      channel_id: metaChannelId,
      attachment_id,
      comment_id,
      source,
      file_name,
      page_number,
    } = r.metadata
    if (!post_id || post_id === '') continue
    const key = `${post_id}:${type}:${attachment_id || ''}:${comment_id || ''}:${page_number || 0}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push({ r, post_id, type, metaChannelId, attachment_id, comment_id, source, file_name, page_number })
  }

  if (unique.length === 0) return []

  const attachmentIds = [...new Set(unique.map(u => u.attachment_id).filter(Boolean))]
  const postIdsNeedChannel = [...new Set(unique.filter(u => !u.metaChannelId).map(u => u.post_id).filter(Boolean))]

  const attachmentMap = new Map()
  const postChannelMap = new Map()
  const attachmentPostChannelMap = new Map()

  try {
    if (attachmentIds.length > 0) {
      const inClause = buildPgInClause(attachmentIds)
      const sql = `SELECT id, filename, channel_id, post_id FROM attachments WHERE id IN ${inClause}`
      const res = await db.query(sql, attachmentIds)
      for (const row of res.rows || []) {
        attachmentMap.set(String(row.id), {
          filename: row.filename || '',
          channel_id: row.channel_id || '',
          post_id: row.post_id || '',
        })
      }
    }

    if (postIdsNeedChannel.length > 0) {
      const postInClause = buildPgInClause(postIdsNeedChannel)
      const postSql = `SELECT id, channel_id FROM posts WHERE id IN ${postInClause}`
      const postRes = await db.query(postSql, postIdsNeedChannel)
      for (const row of postRes.rows || []) {
        if (row.id && row.channel_id) postChannelMap.set(String(row.id), String(row.channel_id))
      }

      const attInClause = buildPgInClause(postIdsNeedChannel)
      const attSql = `SELECT post_id, channel_id FROM attachments WHERE post_id IN ${attInClause}`
      const attRes = await db.query(attSql, postIdsNeedChannel)
      for (const row of attRes.rows || []) {
        if (row.post_id && row.channel_id && !attachmentPostChannelMap.has(String(row.post_id))) {
          attachmentPostChannelMap.set(String(row.post_id), String(row.channel_id))
        }
      }
    }
  } catch (e) {
    console.error('[RAG] 참고문헌 사전 조회 오류:', e.message)
  }

  const channelIds = [...new Set(unique.map(u => {
    const postId = String(u.post_id || '')
    const attachmentInfo = u.attachment_id ? attachmentMap.get(String(u.attachment_id)) : null
    return (
      u.metaChannelId ||
      postChannelMap.get(postId) ||
      attachmentPostChannelMap.get(postId) ||
      attachmentInfo?.channel_id ||
      ''
    )
  }).filter(Boolean))]

  const channelInfoMap = new Map()
  if (channelIds.length > 0) {
    try {
      const inClause = buildPgInClause(channelIds)
      const sql = `
        SELECT c.id, c.name AS channel_name, t.name AS team_name
        FROM channels c
        LEFT JOIN teams t ON t.id = c.team_id
        WHERE c.id IN ${inClause}
      `
      const res = await db.query(sql, channelIds)
      for (const row of res.rows || []) {
        channelInfoMap.set(String(row.id), {
          channel_name: row.channel_name || '',
          team_name: row.team_name || '',
        })
      }
    } catch (e) {
      console.error('[RAG] 채널 정보 조회 오류:', e.message)
    }
  }

  const refs = unique.map(({ r, post_id, type, metaChannelId, attachment_id, comment_id, source, file_name, page_number }) => {
    const postId = String(post_id || '')
    const attachmentInfo = attachment_id ? attachmentMap.get(String(attachment_id)) : null
    const channelId = (
      metaChannelId ||
      postChannelMap.get(postId) ||
      attachmentPostChannelMap.get(postId) ||
      attachmentInfo?.channel_id ||
      ''
    )
    const channelInfo = channelInfoMap.get(String(channelId)) || {}
    const mappedType = classifyRefType(type)
    const fileLabel = attachmentInfo?.filename || file_name || source || ''
    const pageLabel = Number(page_number || 0) > 0 ? `p.${Number(page_number)}` : ''
    const baseRef = {
      channel: channelInfo.channel_name || '',
      channel_id: channelId || '',
      team: channelInfo.team_name || '',
      post_id: post_id || '',
      attachment_id: attachment_id || '',
      comment_id: comment_id || '',
      page_number: Number(page_number || 0),
      source: source || file_name || '',
      file_name: file_name || source || '',
    }

    if (mappedType === 'comment') {
      const preview = (r.text || '').slice(0, 60).replace(/\n/g, ' ')
      return {
        ...baseRef,
        type: 'comment',
        label: preview + ((r.text?.length ?? 0) > 60 ? '…' : ''),
      }
    }

    if (mappedType === 'amount') {
      const total = asNum(r.metadata?.amount_total)
      const label = [fileLabel || '문서', total > 0 ? `합계 ${total.toLocaleString('ko-KR')}원` : '', 'AMOUNT'].filter(Boolean).join(' · ')
      return { ...baseRef, type: 'amount', label }
    }

    if (mappedType === 'table' || mappedType === 'image' || mappedType === 'text' || mappedType === 'word') {
      const typeLabel = mappedType.toUpperCase()
      const label = [fileLabel || '문서', pageLabel, typeLabel].filter(Boolean).join(' · ')
      return { ...baseRef, type: mappedType, label }
    }

    if (type === 'pdf') {
      const label = [fileLabel || '첨부 문서', pageLabel].filter(Boolean).join(' · ')
      return { ...baseRef, type: 'pdf', label }
    }

    const preview = (r.text || '').slice(0, 60).replace(/\n/g, ' ')
    return {
      ...baseRef,
      type: 'post',
      label: preview + ((r.text?.length ?? 0) > 60 ? '…' : ''),
    }
  })

  return refs.filter(Boolean)
}

// ─── POST /api/rag/search ─────────────────────────────────────
router.post('/search', requireAuth, async (req, res) => {
  try {
    const { query, limit = 3, preferred_sources: preferredSources = [] } = req.body
    if (!query?.trim()) return res.json({ context: '', references: [] })
    const amountQuery = isAmountQuery(query)
    const commandQuery = isCommandQuery(query)
    const sourceHints = extractSourceHints(query, preferredSources)
    const requestedLimit = Math.max(1, Number(limit) || 3)
    const effectiveRequestedLimit = commandQuery ? Math.max(requestedLimit, 8) : requestedLimit
    const firstPassLimit = Math.max(
      effectiveRequestedLimit,
      amountQuery ? 4 : 0,
      commandQuery ? 8 : 0,
    )

    const cfg = readConfig()
    const ragCfg = cfg.rag || {}

    const payload = {
      config: {
        lancedb_path: getDatabasePath(cfg, 'lancedb Database Path'),
        vector_size: ragCfg.vectorSize ?? 1024,
      },
      query,
      limit: firstPassLimit,
    }

    let results = await callPythonSearch(payload)

    if (amountQuery) {
      const baseResults = Array.isArray(results) ? results : []
      const needsSecondPass = baseResults.length < Math.max(6, effectiveRequestedLimit * 2) || !baseResults.some(hasAmountSignal)
      if (needsSecondPass) {
        const secondPassLimit = Math.max(effectiveRequestedLimit * 4, 16)
        const amountHintQuery = `${query}\n합계 총액 공급가액 부가세 VAT 견적 금액 원`
        const [r2, r3] = await Promise.all([
          callPythonSearch({ ...payload, limit: secondPassLimit }),
          callPythonSearch({ ...payload, query: amountHintQuery, limit: secondPassLimit }),
        ])
        results = mergeUniqueResults(baseResults, r2, r3)
      }
    }

    if (commandQuery) {
      const baseResults = Array.isArray(results) ? results : []
      const needsSecondPass = baseResults.length < Math.max(12, effectiveRequestedLimit * 2) || !baseResults.some(hasCommandSignal)
      if (needsSecondPass) {
        const secondPassLimit = Math.max(effectiveRequestedLimit * 4, 24)
        const commandHintQuery = `${query}\nCLI 명령어 command show configure config snmp-server no snmp-server`
        const [r2, r3] = await Promise.all([
          callPythonSearch({ ...payload, limit: secondPassLimit }),
          callPythonSearch({ ...payload, query: commandHintQuery, limit: secondPassLimit }),
        ])
        results = mergeUniqueResults(baseResults, r2, r3)
      }
    }

    if (!Array.isArray(results) || results.length === 0) {
      return res.json({ context: '', references: [] })
    }

    // init 레코드 제외
    const validResults = results.filter(r => r.text !== '__init__')
    if (validResults.length === 0) {
      return res.json({ context: '', references: [] })
    }

    let rankedResults = validResults
    if (amountQuery || commandQuery || sourceHints.length > 0) {
      rankedResults = [...validResults].sort((a, b) => {
        const baseA = -asNum(a?.score)
        const baseB = -asNum(b?.score)
        let scoreA = baseA
        let scoreB = baseB
        if (amountQuery) {
          scoreA += amountDocBonus(a)
          scoreB += amountDocBonus(b)
        }
        if (commandQuery) {
          scoreA += commandDocBonus(a)
          scoreB += commandDocBonus(b)
        }
        if (sourceHints.length > 0) {
          scoreA += sourceHintBoost(a, sourceHints)
          scoreB += sourceHintBoost(b, sourceHints)
        }
        return scoreB - scoreA
      })
    }
    const finalResults = rankedResults.slice(0, effectiveRequestedLimit)

    const context = finalResults.map((r) => {
      const meta = r.metadata || {}
      const source = meta.source || meta.file_name || 'unknown'
      const page = Number(meta.page_number || 0)
      const type = meta.type || 'text'
      const total = asNum(meta.amount_total)
      const subtotal = asNum(meta.amount_subtotal)
      const vat = asNum(meta.amount_vat)
      const amountPart = (total > 0 || subtotal > 0 || vat > 0)
        ? ` / amount_total: ${total || 0} / amount_subtotal: ${subtotal || 0} / amount_vat: ${vat || 0}`
        : ''
      const header = `[source: ${source}${page > 0 ? ` / page: ${page}` : ''} / type: ${type}${amountPart}]`
      return `${header}\n${r.text}`
    }).join('\n\n')
    const references = await enrichReferences(finalResults)

    res.json({ context, references })
  } catch (err) {
    console.error('[RAG Search Error]', err.message)
    // 검색 실패 시 RAG 없이 진행할 수 있도록 빈 결과 반환
    res.json({ context: '', references: [] })
  }
})

// ─── GET /api/rag/datasets ───────────────────────────────────
router.get('/datasets', requireAuth, async (req, res) => {
  try {
    const items = readRagDatasetIndex()
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      .map(toDatasetRecordView)
    res.json({ items })
  } catch (e) {
    res.status(500).json({ error: `학습 데이터 목록 조회 실패: ${e.message}` })
  }
})

// ─── POST /api/rag/datasets (base64 업로드) ──────────────────
router.post('/datasets', requireAuth, async (req, res) => {
  try {
    const { filename, contentType, dataBase64 } = req.body || {}
    if (!filename || !dataBase64) {
      return res.status(400).json({ error: 'filename, dataBase64가 필요합니다.' })
    }

    ensureRagDatasetStore()
    const safeName = sanitizeFilename(filename)
    const ext = extnameOf(safeName)
    const id = makeDatasetId()
    const storageName = `${id}-${safeName}`
    const storagePath = path.join(RAG_DATA_DIR, storageName)
    const buffer = Buffer.from(String(dataBase64), 'base64')
    fs.writeFileSync(storagePath, buffer)

    const items = readRagDatasetIndex()
    const record = {
      id,
      filename: safeName,
      original_filename: safeName,
      content_type: contentType || 'application/octet-stream',
      size: buffer.length,
      ext,
      storage_path: storageName,
      created_at: new Date().toISOString(),
      status: 'ready',
      trained_at: null,
      error: null,
    }
    items.push(record)
    writeRagDatasetIndex(items)
    res.json({ item: toDatasetRecordView(record) })
  } catch (e) {
    res.status(500).json({ error: `학습 데이터 추가 실패: ${e.message}` })
  }
})

// ─── POST /api/rag/datasets/upload (multipart 업로드) ────────
router.post('/datasets/upload', requireAuth, ragDatasetUpload.array('files', 100), async (req, res) => {
  try {
    const files = Array.isArray(req.files) ? req.files : []
    if (files.length === 0) {
      return res.status(400).json({ error: '업로드할 파일이 없습니다.' })
    }
    let clientOriginalNames = []
    if (typeof req.body?.originalNames === 'string') {
      try {
        const parsed = JSON.parse(req.body.originalNames)
        if (Array.isArray(parsed)) clientOriginalNames = parsed
      } catch (_) {}
    }

    ensureRagDatasetStore()
    const items = readRagDatasetIndex()
    const created = []

    for (let idx = 0; idx < files.length; idx += 1) {
      const file = files[idx]
      const clientName = clientOriginalNames[idx]
      const decodedOriginalName = maybeDecodeLatin1Filename(clientName || file.originalname || file.filename)
      const safeName = sanitizeFilename(decodedOriginalName)
      const ext = extnameOf(safeName)
      const id = makeDatasetId()
      const storageName = `${id}-${safeName}`
      const finalPath = path.join(RAG_DATA_DIR, storageName)
      fs.renameSync(file.path, finalPath)

      const record = {
        id,
        filename: safeName,
        original_filename: decodedOriginalName,
        content_type: file.mimetype || 'application/octet-stream',
        size: file.size || 0,
        ext,
        storage_path: storageName,
        created_at: new Date().toISOString(),
        status: 'ready',
        trained_at: null,
        error: null,
      }
      items.push(record)
      created.push(toDatasetRecordView(record))
    }

    writeRagDatasetIndex(items)
    res.json({ items: created })
  } catch (e) {
    res.status(500).json({ error: `multipart 업로드 실패: ${e.message}` })
  }
})

// ─── POST /api/rag/datasets/delete ───────────────────────────
router.post('/datasets/delete', requireAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (ids.length === 0) return res.status(400).json({ error: '삭제할 데이터가 없습니다.' })

    const items = readRagDatasetIndex()
    const idSet = new Set(ids.map(String))
    const keep = []
    let deleted = 0
    for (const item of items) {
      if (!idSet.has(String(item.id))) {
        keep.push(item)
        continue
      }
      const absPath = path.resolve(RAG_DATA_DIR, item.storage_path || '')
      if (fs.existsSync(absPath)) {
        try { fs.unlinkSync(absPath) } catch (_) {}
      }
      deleted += 1
    }
    writeRagDatasetIndex(keep)
    res.json({ deleted })
  } catch (e) {
    res.status(500).json({ error: `학습 데이터 삭제 실패: ${e.message}` })
  }
})

// ─── POST /api/rag/datasets/train ────────────────────────────
router.post('/datasets/train', requireAuth, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : []
  try {
    let items = readRagDatasetIndex()
    const targets = items.filter(item => ids.length === 0 || ids.includes(String(item.id)))
    if (targets.length === 0) return res.status(400).json({ error: '학습 대상 데이터가 없습니다.' })

    const results = []
    for (const target of targets) {
      try {
        const { payload } = await buildTrainerPostFromDataset(target)
        await callPythonTrainer(payload)
        target.status = 'trained'
        target.trained_at = new Date().toISOString()
        target.error = null
        results.push({ id: target.id, filename: target.filename, status: 'trained' })
      } catch (e) {
        target.status = 'failed'
        target.error = e.message
        results.push({ id: target.id, filename: target.filename, status: 'failed', error: e.message })
      }
    }
    writeRagDatasetIndex(items)
    res.json({ total: targets.length, results })
  } catch (e) {
    res.status(500).json({ error: `학습 시작 실패: ${e.message}` })
  }
})

module.exports = router
