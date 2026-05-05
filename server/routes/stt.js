const express = require('express')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')
const db = require('../db')
const requireAuth = require('../middleware/auth')
const { client, isConnected } = require('../cassandra')
const { canAccessChannel, ACCESS_DENIED_MESSAGE } = require('../lib/channelAccess')
const { getDatabasePath } = require('../databasePaths')
const { getPythonExecutable } = require('../pythonRuntime')
const flags = require('../sttFeatureFlags')

const router = express.Router()

const MODEL_VERSION = process.env.STT_MODEL_VERSION || 'gemma-4-e4b'
const MODEL_ID = process.env.STT_MODEL_ID || 'google/gemma-4-E4B-it'
function getHfToken() { return process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || '' }
const MAX_AUTORETRY = 2

let tablesReadyPromise = null
let workerTicking = false
let sttActorUserId = ''

const configPath = path.join(__dirname, '../../config.json')
let config = {}
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
} catch (_) {
  config = {}
}
const STORAGE_BASE = getDatabasePath(config, 'ObjectFile Path')
const STT_SCRIPT = path.resolve(__dirname, '../stt_infer.py')

function sttLog(message, meta = {}) {
  const mergedMeta = { ...(sttActorUserId ? { actorUserId: sttActorUserId } : {}), ...meta }
  const base = Object.entries(mergedMeta)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ')
  console.log(`[STT] ${message}${base ? ` | ${base}` : ''}`)
}

function sttError(message, meta = {}) {
  const mergedMeta = { ...(sttActorUserId ? { actorUserId: sttActorUserId } : {}), ...meta }
  const base = Object.entries(mergedMeta)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ')
  console.error(`[STT] ${message}${base ? ` | ${base}` : ''}`)
}

function stableStringify(input) {
  if (!input || typeof input !== 'object') return JSON.stringify(input ?? {})
  if (Array.isArray(input)) return `[${input.map(stableStringify).join(',')}]`
  const keys = Object.keys(input).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(input[k])}`).join(',')}}`
}

function hashOptions(options = {}) {
  return crypto.createHash('sha256').update(stableStringify(options)).digest('hex')
}

function buildIdempotencyKey({ postId, attachmentId, modelVersion, optionsHash }) {
  return `${postId}:${attachmentId}:${modelVersion}:${optionsHash}`
}

function mapErrorMessage(code, detail = '') {
  const map = {
    AUDIO_UNSUPPORTED_FORMAT: '지원하지 않는 오디오 형식입니다.',
    AUDIO_TOO_LONG: '오디오 길이가 제한을 초과했습니다.',
    AUDIO_FILE_NOT_FOUND: '원본 음성 파일을 찾지 못했습니다.',
    AUDIO_DECODE_FAILED: '오디오 디코딩에 실패했습니다.',
    MODEL_LOAD_FAILED: 'STT 모델 로딩에 실패했습니다.',
    DIARIZATION_FAILED: '화자 분리에 실패했습니다.',
    TRANSCRIPTION_FAILED: '음성 전사에 실패했습니다.',
    SUMMARY_FAILED: '요약 생성에 실패했습니다.',
    POST_UPDATE_FAILED: '게시글 반영 중 충돌이 발생했습니다.',
    ATTACHMENT_NOT_READY: '첨부파일 업로드가 완료되지 않았습니다.',
  }
  return map[code] || detail || 'STT 처리 중 오류가 발생했습니다.'
}

async function ensureTables() {
  if (!tablesReadyPromise) {
    tablesReadyPromise = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS stt_jobs (
          id UUID PRIMARY KEY,
          post_id VARCHAR(50) NOT NULL,
          channel_id VARCHAR(50) NOT NULL,
          attachment_id VARCHAR(50) NOT NULL,
          idempotency_key TEXT NOT NULL,
          model_version TEXT NOT NULL,
          options_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          options_hash TEXT NOT NULL,
          status VARCHAR(20) NOT NULL CHECK (status IN ('queued', 'processing', 'done', 'failed', 'canceled')),
          progress INTEGER NOT NULL DEFAULT 0,
          error_code TEXT,
          error_message TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          patch_committed BOOLEAN NOT NULL DEFAULT false,
          created_by INTEGER NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ
        )
      `)
      await db.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_stt_jobs_idempotency ON stt_jobs(idempotency_key)')
      await db.query('CREATE INDEX IF NOT EXISTS idx_stt_jobs_post ON stt_jobs(post_id, created_at DESC)')
      await db.query('CREATE INDEX IF NOT EXISTS idx_stt_jobs_status ON stt_jobs(status, created_at ASC)')

      await db.query(`
        CREATE TABLE IF NOT EXISTS stt_segments (
          id BIGSERIAL PRIMARY KEY,
          job_id UUID NOT NULL REFERENCES stt_jobs(id) ON DELETE CASCADE,
          segment_index INTEGER NOT NULL,
          start_sec NUMERIC(10,3) NOT NULL,
          end_sec NUMERIC(10,3) NOT NULL,
          speaker_label TEXT,
          speaker_name TEXT,
          text TEXT NOT NULL,
          confidence NUMERIC(5,4),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (job_id, segment_index)
        )
      `)

      await db.query(`
        CREATE TABLE IF NOT EXISTS stt_summaries (
          job_id UUID PRIMARY KEY REFERENCES stt_jobs(id) ON DELETE CASCADE,
          full_transcript TEXT NOT NULL,
          meeting_summary TEXT NOT NULL,
          action_items TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `)

      await db.query(`
        CREATE TABLE IF NOT EXISTS stt_speaker_mappings (
          id BIGSERIAL PRIMARY KEY,
          channel_id VARCHAR(50) NOT NULL,
          speaker_label TEXT NOT NULL,
          user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          display_name TEXT,
          confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
          created_by INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (channel_id, speaker_label)
        )
      `)
      // Schema migrations: add new columns if not yet present
      await db.query(`ALTER TABLE stt_speaker_mappings ADD COLUMN IF NOT EXISTS voice_embedding_json TEXT`)
      await db.query(`ALTER TABLE stt_summaries ADD COLUMN IF NOT EXISTS speaker_embeddings_json TEXT`)
    })()
  }
  return tablesReadyPromise
}

async function findPostLocator(postId) {
  if (isConnected()) {
    const byId = await client.execute(
      'SELECT channel_id, created_at, author_id FROM posts_by_id WHERE id = ?',
      [postId],
      { prepare: true },
    )
    if (byId.rows.length > 0) return byId.rows[0]

    const legacy = await client.execute(
      'SELECT channel_id, created_at, author_id FROM posts WHERE id = ? ALLOW FILTERING',
      [postId],
      { prepare: true },
    )
    if (legacy.rows.length > 0) return legacy.rows[0]
    return null
  }

  const r = await db.query('SELECT channel_id, created_at, author_id, updated_at, content FROM posts WHERE id = $1 LIMIT 1', [postId])
  if (r.rowCount === 0) return null
  return r.rows[0]
}

async function findAttachmentRow(attachmentId) {
  const r = await db.query(
    `SELECT id, status, post_id, channel_id, storage_path, filename, content_type, size
     FROM attachments
     WHERE id = $1
     LIMIT 1`,
    [attachmentId],
  )
  return r.rows[0] || null
}

async function patchAttachmentMeta(attachmentId, { postId = null, channelId = null } = {}) {
  const sets = []
  const vals = []
  let i = 1
  if (postId != null) {
    sets.push(`post_id = $${i++}`)
    vals.push(String(postId))
  }
  if (channelId != null) {
    sets.push(`channel_id = $${i++}`)
    vals.push(String(channelId))
  }
  if (sets.length === 0) return
  vals.push(String(attachmentId))
  await db.query(`UPDATE attachments SET ${sets.join(', ')} WHERE id = $${i}`, vals)
  sttLog('attachment meta patched', { attachmentId, postId, channelId })
}

function extractTitleFromSummary(summary) {
  const text = String(summary || '').trim()
  if (!text) return ''
  const titleMatch = text.match(/^(?:제목|title|タイトル|标题)\s*:\s*(.+)$/im)
  if (titleMatch) {
    const t = titleMatch[1].trim()
    return t.length > 70 ? t.slice(0, 70) + '…' : t
  }
  for (const line of text.split('\n')) {
    const clean = line.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '').trim()
    if (!clean) continue
    const sentence = clean.split(/[.!?]/)[0].trim()
    if (sentence.length < 5) continue
    return sentence.length > 70 ? sentence.slice(0, 70) + '…' : sentence
  }
  return ''
}

function renderSttBlock({ jobId, status, progress = 0, transcript = '', summary = '', error = '' }) {
  const head = `<!--stt-result:start job_id=${jobId}-->`
  const tail = '<!--stt-result:end-->'
  const nowKst = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date()).replace(' ', ' ')
  if (status === 'processing' || status === 'queued') {
    return `${head}\n\n## STT 상태\n처리중 (${Math.max(0, Math.min(100, Number(progress) || 0))}%)\n\n${tail}`
  }
  if (status === 'failed') {
    return `${head}\n\n## STT 상태\n실패\n\n사유: ${error || '알 수 없는 오류'}\n\n${tail}`
  }
  const safeTranscript = sanitizeTranscriptText(transcript || '')
  const safeSummary = sanitizeTranscriptText(summary || '')
  const sections = parseMeetingSummarySections(safeSummary, safeTranscript)
  const transcriptForDisplay = formatTranscriptForMarkdown(safeTranscript)
  const meetingBody = buildMeetingSectionsMarkdown(sections, transcriptForDisplay)
  return `${head}

## STT 상태
완료

${meetingBody}

${tail}`
}

function upsertSttBlock(content = '', blockText = '') {
  const source = String(content || '')
    .replace(/회의록 내용을 여기에 작성하세요\./g, '')
  const blockPattern = /<!--stt-result:start job_id=.*?-->[\s\S]*?<!--stt-result:end-->/m
  const sourceWithoutBlock = blockPattern.test(source)
    ? source.replace(blockPattern, '').replace(/\n{3,}/g, '\n\n').trimEnd()
    : source
  const cleanedOutside = cleanupOutsideEmptyMeetingSections(sourceWithoutBlock)
    .replace(/\[새회의록작성\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()

  // Prefer placing STT block right below the first markdown title line.
  const firstHeadingMatch = cleanedOutside.match(/^# .*(?:\r?\n|$)/m)
  if (firstHeadingMatch) {
    const heading = firstHeadingMatch[0]
    const idx = cleanedOutside.indexOf(heading)
    const insertPos = idx + heading.length
    return `${cleanedOutside.slice(0, insertPos)}\n${blockText}\n${cleanedOutside.slice(insertPos).replace(/^\n*/, '')}`
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  }
  return `${cleanedOutside.trimEnd()}\n\n${blockText}\n`
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd() + '\n'
}

async function getPostContentForPatch(postId, locator) {
  if (isConnected()) {
    const rowRes = await client.execute(
      'SELECT content, updated_at FROM posts WHERE channel_id = ? AND created_at = ?',
      [locator.channel_id, locator.created_at],
      { prepare: true },
    )
    if (rowRes.rows.length === 0) {
      throw new Error('POST_NOT_FOUND')
    }
    return {
      content: String(rowRes.rows[0].content || ''),
      updatedAt: rowRes.rows[0].updated_at || null,
    }
  }

  const rowRes = await db.query('SELECT content, updated_at FROM posts WHERE id = $1 LIMIT 1', [postId])
  if (rowRes.rowCount === 0) {
    throw new Error('POST_NOT_FOUND')
  }
  return {
    content: String(rowRes.rows[0].content || ''),
    updatedAt: rowRes.rows[0].updated_at || null,
  }
}

async function writePostContentWithOptimisticLock(postId, locator, beforeUpdatedAt, nextContent) {
  if (isConnected()) {
    const now = new Date()
    const result = await client.execute(
      `UPDATE posts
       SET content = ?, updated_at = ?
       WHERE channel_id = ? AND created_at = ?
       IF updated_at = ?`,
      [nextContent, now, locator.channel_id, locator.created_at, beforeUpdatedAt],
      { prepare: true },
    )
    const applied = result?.rows?.[0]?.['[applied]']
    return Boolean(applied)
  }

  const result = await db.query(
    `UPDATE posts
     SET content = $1, updated_at = NOW()
     WHERE id = $2 AND updated_at = $3`,
    [nextContent, postId, beforeUpdatedAt],
  )
  return result.rowCount > 0
}

async function applyScopedPatch(job, payload) {
  const locator = await findPostLocator(job.post_id)
  if (!locator) return false // 게시글이 이미 삭제된 경우 — 업데이트 생략

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await getPostContentForPatch(job.post_id, locator)
    const block = renderSttBlock({
      jobId: job.id,
      status: payload.status,
      progress: payload.progress,
      transcript: payload.transcript,
      summary: payload.summary,
      error: payload.error,
    })
    const nextContent = upsertSttBlock(current.content, block)
    const applied = await writePostContentWithOptimisticLock(job.post_id, locator, current.updatedAt, nextContent)
    if (applied) return true
  }
  return false
}

async function updateJob(id, patch = {}) {
  const sets = []
  const values = []
  let idx = 1
  for (const [key, value] of Object.entries(patch)) {
    sets.push(`${key} = $${idx}`)
    values.push(value)
    idx += 1
  }
  sets.push(`updated_at = NOW()`)
  values.push(id)
  await db.query(`UPDATE stt_jobs SET ${sets.join(', ')} WHERE id = $${idx}`, values)
}

function runPythonStt(audioPath, options = {}, onProgress = null) {
  return new Promise((resolve, reject) => {
    const payload = {
      audioPath,
      language: options.language || 'ko',
      diarization: options.diarization !== false,
      diarizationRequired: options.diarizationRequired === true,
      modelId: MODEL_ID,
      hfToken: getHfToken(),
    }
    const payloadPath = path.join(os.tmpdir(), `stt-payload-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
    fs.writeFileSync(payloadPath, JSON.stringify(payload), 'utf8')
    sttLog('python worker start', {
      script: STT_SCRIPT,
      payloadPath,
      audioPath,
      language: payload.language,
      diarization: payload.diarization,
      diarizationRequired: payload.diarizationRequired,
      modelId: payload.modelId,
      hfTokenSet: Boolean(payload.hfToken),
    })

    const py = getPythonExecutable()
    sttLog('python executable selected', { python: py })
    const child = spawn(py, [STT_SCRIPT, payloadPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdoutBuf = ''
    let stderrBuf = ''
    let finalPayload = null

    const consumeLine = (lineRaw) => {
      const line = String(lineRaw || '').trim()
      if (!line) return
      let obj = null
      try {
        obj = JSON.parse(line)
      } catch {
        return
      }
      if (obj?.event === 'progress') {
        if (typeof onProgress === 'function') onProgress(obj)
        return
      }
      if (Object.prototype.hasOwnProperty.call(obj || {}, 'ok')) {
        finalPayload = obj
      }
    }

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString()
      const lines = stdoutBuf.split(/\r?\n/)
      stdoutBuf = lines.pop() || ''
      for (const line of lines) consumeLine(line)
    })
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString()
    })

    child.on('error', (err) => {
      try { fs.unlinkSync(payloadPath) } catch (_) {}
      sttError('python worker spawn failed', { error: err.message })
      reject({ code: 'TRANSCRIPTION_FAILED', message: err.message || 'python worker spawn failed' })
    })

    child.on('close', (code, signal) => {
      try { fs.unlinkSync(payloadPath) } catch (_) {}
      if (stdoutBuf.trim()) consumeLine(stdoutBuf.trim())

      if (Number(code) !== 0) {
        const detail = String(stderrBuf || `python exit code ${code}, signal ${signal || 'none'}`).slice(0, 1000)
        sttError('python worker failed', { code: 'TRANSCRIPTION_FAILED', detail })
        reject({ code: 'TRANSCRIPTION_FAILED', message: detail || 'python worker failed' })
        return
      }

      if (!finalPayload) {
        sttError('python worker output parse failed', { error: 'missing final payload' })
        reject({ code: 'TRANSCRIPTION_FAILED', message: 'invalid stt output: missing final payload' })
        return
      }
      if (!finalPayload.ok) {
        sttError('python worker returned failure', {
          code: finalPayload.error_code || 'TRANSCRIPTION_FAILED',
          message: finalPayload.error_message || 'stt failed',
        })
        reject({ code: finalPayload.error_code || 'TRANSCRIPTION_FAILED', message: finalPayload.error_message || 'stt failed' })
        return
      }
      sttLog('python worker completed', {
        segments: Array.isArray(finalPayload.segments) ? finalPayload.segments.length : 0,
        transcriptLength: String(finalPayload.full_transcript || '').length,
        summaryLength: String(finalPayload.summary || '').length,
        diarizationUsed: finalPayload?.diarization?.used,
        diarizationSpeakerCount: finalPayload?.diarization?.speaker_count,
        diarizationSegmentCount: finalPayload?.diarization?.segment_count,
      })
      resolve(finalPayload)
    })
  })
}

async function applySpeakerMapping(channelId, segments = []) {
  if (!segments.length) return segments
  const rows = await db.query(
    `SELECT speaker_label, display_name
     FROM stt_speaker_mappings
     WHERE channel_id = $1`,
    [channelId],
  )
  const map = new Map(rows.rows.map((r) => [String(r.speaker_label), String(r.display_name || '').trim()]))
  return segments.map((seg) => {
    const mapped = map.get(String(seg.speaker_label || ''))
    return {
      ...seg,
      speaker_name: mapped || null,
    }
  })
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom > 0 ? dot / denom : 0
}

async function autoMatchSpeakersByEmbedding(channelId, segments, newEmbeddings) {
  if (!flags.USE_VOICE_EMBEDDING) {
    sttLog('voice embedding skip | USE_VOICE_EMBEDDING=off (resemblyzer 화자 자동 인식 비활성)')
    return segments
  }
  if (!newEmbeddings || !Object.keys(newEmbeddings).length) {
    sttLog('voice embedding skip | no embeddings from infer (resemblyzer 미설치 또는 추출 실패)')
    return segments
  }
  sttLog('voice embedding match start | resemblyzer 화자 자동 인식 시작', {
    channelId,
    newSpeakers: Object.keys(newEmbeddings),
  })
  try {
    const rows = await db.query(
      `SELECT speaker_label, display_name, voice_embedding_json
       FROM stt_speaker_mappings
       WHERE channel_id = $1 AND voice_embedding_json IS NOT NULL AND display_name IS NOT NULL`,
      [channelId],
    )
    if (!rows.rows.length) {
      sttLog('voice embedding match skip | 채널에 저장된 음성 임베딩 없음', { channelId })
      return segments
    }

    const stored = rows.rows
      .map((r) => {
        try { return { label: r.speaker_label, name: r.display_name, emb: JSON.parse(r.voice_embedding_json) } }
        catch (_) { return null }
      })
      .filter(Boolean)

    const THRESHOLD = 0.82
    const matches = {}
    const scores = {}
    for (const [newLabel, newEmb] of Object.entries(newEmbeddings)) {
      let bestSim = 0, bestName = null
      for (const s of stored) {
        const sim = cosineSimilarity(newEmb, s.emb)
        if (sim > bestSim) { bestSim = sim; bestName = s.name }
      }
      scores[newLabel] = { bestSim: Math.round(bestSim * 1000) / 1000, bestName }
      if (bestSim >= THRESHOLD && bestName) matches[newLabel] = bestName
    }
    sttLog('voice embedding match result | resemblyzer 화자 매칭 완료', {
      threshold: THRESHOLD,
      scores,
      matched: matches,
    })

    return segments.map((seg) => ({
      ...seg,
      speaker_name: seg.speaker_name || matches[seg.speaker_label] || null,
    }))
  } catch (e) {
    sttLog('voice embedding match error', { error: String(e?.message || e).slice(0, 200) })
    return segments
  }
}

async function notifySttToTelegram(job, { status, title = '', errorMessage = '' }) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const telegramCfg = cfg?.sns?.telegram || {}
    if (!telegramCfg.enabled) return
    const botToken = String(telegramCfg.httpApiToken || '').trim()
    if (!botToken) return

    const userRow = await db.query(
      `SELECT telegram_id, use_sns_channel FROM users WHERE id = $1`,
      [String(job.created_by || '')],
    )
    const u = userRow.rows?.[0]
    if (!u) return
    if (String(u.use_sns_channel || '').trim() !== 'telegram') return
    const chatId = String(u.telegram_id || '').trim()
    if (!/^-?[0-9]+$/.test(chatId)) return

    const chRow = await db.query(`SELECT name FROM channels WHERE id = $1`, [job.channel_id])
    const channelName = chRow.rows?.[0]?.name || job.channel_id

    const siteUrl = String(cfg?.site_url || process.env.CLIENT_ORIGIN || '').replace(/\/$/, '')
    const postLink = (siteUrl && job.post_id && job.channel_id)
      ? `${siteUrl}/?channelId=${encodeURIComponent(job.channel_id)}&postId=${encodeURIComponent(job.post_id)}`
      : ''

    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

    const text = status === 'done'
      ? [
          `✅ AI 회의록 처리 완료`,
          `채널: ${esc(channelName)}`,
          title ? `제목: ${esc(title)}` : '',
          postLink ? `\n🔗 <a href="${postLink}">회의록 보기</a>` : '',
        ].filter(Boolean).join('\n')
      : [
          `❌ AI 회의록 처리 실패`,
          `채널: ${esc(channelName)}`,
          errorMessage ? `사유: ${esc(errorMessage)}` : '',
          postLink ? `\n🔗 <a href="${postLink}">회의록 보기</a>` : '',
        ].filter(Boolean).join('\n')

    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: false }),
    })
    sttLog('telegram notification sent', { jobId: job.id, status, chatId: chatId.slice(0, 3) + '***' })
  } catch (e) {
    sttLog('telegram notification error', { jobId: job.id, error: String(e?.message || e).slice(0, 100) })
  }
}

function mergeMappedTranscript(segments = []) {
  return segments
    .map((seg) => {
      const label = seg.speaker_name || seg.speaker_label || 'SPEAKER'
      return `[${label}] ${sanitizeTranscriptText(seg.text || '')}`.trim()
    })
    .join('\n')
    .trim()
}

function sanitizeTranscriptText(input = '') {
  const source = String(input || '')
  const lines = source.split(/\r?\n/)
  const dropExact = new Set(['user', 'model'])
  const dropContains = [
    '다음 오디오를 한국어로 정확히 전사해줘',
    '군더더기 설명 없이 전사문만 출력해줘',
    '다음 전사문을 회의록 형식으로 요약해줘',
    '안건, 결정사항, 액션아이템을 구분해줘',
    'Summarize transcript into meeting minutes',
    '회의록 형식으로 요약해줘',
    'Transcribe this audio accurately. Output transcript only.',
    '오디오 파일을 업로드',
    '오디오 파일이 제공되지',
    '죄송합니다',
    '전사해 드리겠습니다',
    'I cannot transcribe',
    'Please upload',
    '[음악 소리]',
    '[음원 재생]',
    '챗봇',
  ]

  const filtered = lines
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false
      if (dropExact.has(line.toLowerCase())) return false
      return !dropContains.some((needle) => line.includes(needle))
    })
    .join('\n')

  return filtered
    .replace(/\buser\b/gi, '')
    .replace(/\bmodel\b/gi, '')
    .replace(/다음 오디오를 한국어로 정확히 전사해줘\.?\s*군더더기 설명 없이 전사문만 출력해줘\.?/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function formatTranscriptForMarkdown(input = '') {
  const lines = String(input || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  // Markdown paragraph collapse를 피하기 위해 발화마다 빈 줄을 넣어 1발화 1줄로 확실히 렌더링.
  return lines.join('\n\n').trim()
}

function cleanupOutsideEmptyMeetingSections(content = '') {
  let out = String(content || '')
  const emptySectionPattern =
    /(?:^|\n)##\s*(?:회의\s*목적|안건|결정사항|액션\s*아이템)\s*\n+\(내용 없음\)\s*(?=\n|$)/g
  out = out.replace(emptySectionPattern, '\n')
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

function buildMeetingSectionsMarkdown(sections = {}, transcriptForDisplay = '') {
  const lines = []
  const pushSection = (title, value) => {
    const text = String(value || '').trim()
    if (!text) return
    lines.push(`## ${title}`)
    lines.push(text)
    lines.push('')
  }

  pushSection('회의 목적', sections.purpose)
  pushSection('안건', sections.agenda)
  pushSection('결정사항', sections.decisions)
  pushSection('액션 아이템', sections.actions)

  lines.push('## 회의록 요약')
  lines.push(String(sections.recap || '').trim() || '(요약 없음)')
  lines.push('')
  lines.push('## 전사문')
  lines.push(String(transcriptForDisplay || '').trim() || '(전사문 없음)')

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function parseMeetingSummarySections(summaryText = '', transcriptText = '') {
  const summary = String(summaryText || '')
  const transcript = String(transcriptText || '')

  const cleaned = summary
    .replace(/^(?:제목|title|タイトル|标题)\s*:.*/im, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\r/g, '')
    .replace(/##\s*회의록\s*요약/g, '')
    .replace(/\*\*회의\s*목적\*\*/g, '회의 목적')
    .replace(/\*\*안건\*\*/g, '안건')
    .replace(/\*\*결정사항\*\*/g, '결정사항')
    .replace(/\*\*액션\s*아이템\*\*/g, '액션 아이템')
    .replace(/[ \t]+\n/g, '\n')
    .trim()

  const sectionMatchers = [
    { key: 'purpose', re: /^(?:#{1,6}\s*)?(?:[-*]\s*)?(?:회의\s*목적|회의\s*주제|목적|objective|purpose)\s*(?:\([^)]*\))?\s*:?\s*$/i },
    { key: 'agenda', re: /^(?:#{1,6}\s*)?(?:[-*]\s*)?(?:📌|📊)?\s*(?:안건|논의\s*사항|topics?\s*discussed|discussion\s*points?)\s*(?:\([^)]*\))?\s*:?\s*$/i },
    { key: 'decisions', re: /^(?:#{1,6}\s*)?(?:[-*]\s*)?(?:✅)?\s*(?:결정\s*사항|결정사항|decisions?\s*made|decisions?)\s*(?:\([^)]*\))?\s*:?\s*$/i },
    { key: 'actions', re: /^(?:#{1,6}\s*)?(?:[-*]\s*)?(?:📝|🚀)?\s*(?:액션\s*아이템|action\s*items?|후속\s*조치|to-?do)\s*(?:\([^)]*\))?\s*:?\s*$/i },
    { key: 'recap', re: /^(?:#{1,6}\s*)?(?:[-*]\s*)?(?:회의록\s*요약|회의\s*요약|요약|summary)\s*(?:\([^)]*\))?\s*:?\s*$/i },
  ]
  const keyByLine = (line) => {
    const trimmed = String(line || '').trim()
    const found = sectionMatchers.find((m) => m.re.test(trimmed))
    return found ? found.key : null
  }

  const buckets = { purpose: [], agenda: [], decisions: [], actions: [], recap: [] }
  let current = 'recap'
  for (const rawLine of cleaned.split('\n')) {
    const line = String(rawLine || '').trim().replace(/^\*\*|\*\*$/g, '')
    if (!line) {
      if (buckets[current].length && buckets[current][buckets[current].length - 1] !== '') {
        buckets[current].push('')
      }
      continue
    }
    const nextKey = keyByLine(line)
    if (nextKey) {
      current = nextKey
      continue
    }
    if (/^##\s*전사문$/i.test(line)) break
    buckets[current].push(line)
  }

  const normalizeBlock = (lines = []) => String(lines.join('\n'))
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const removeTranscriptLeak = (text = '') => {
    let out = String(text || '')
    if (!out) return out
    if (transcript) {
      const tLines = transcript.split('\n').map((v) => v.trim()).filter(Boolean)
      const sample = tLines.slice(0, 12)
      for (const line of sample) {
        if (line.length < 20) continue
        out = out.split(line).join('')
      }
    }
    return out
      .replace(/\[SPEAKER_[0-9]+\].*/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  const result = {
    purpose: normalizeBlock(buckets.purpose),
    agenda: normalizeBlock(buckets.agenda),
    decisions: normalizeBlock(buckets.decisions),
    actions: normalizeBlock(buckets.actions),
    recap: normalizeBlock(buckets.recap),
  }

  result.purpose = removeTranscriptLeak(result.purpose)
  result.agenda = removeTranscriptLeak(result.agenda)
  result.decisions = removeTranscriptLeak(result.decisions)
  result.actions = removeTranscriptLeak(result.actions)
  result.recap = removeTranscriptLeak(result.recap)

  if (!result.purpose && !result.agenda && !result.decisions && !result.actions && !result.recap && cleaned) {
    result.recap = cleaned
  }
  return result
}

async function queueWorkerTick() {
  if (workerTicking) return
  workerTicking = true
  try {
    await ensureTables()
    const next = await db.query(
      `SELECT *
       FROM stt_jobs
       WHERE status = 'queued'
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    if (next.rowCount === 0) return
    const job = next.rows[0]
    sttActorUserId = String(job.created_by || '')
    sttLog('job dequeued', {
      jobId: job.id,
      postId: job.post_id,
      attachmentId: job.attachment_id,
      channelId: job.channel_id,
      retryCount: job.retry_count,
    })
    sttLog('feature flags', {
      USE_SPEAKER_REGISTRATION: flags.USE_SPEAKER_REGISTRATION,
      USE_VOICE_EMBEDDING: flags.USE_VOICE_EMBEDDING,
      USE_SPEAKER_CORRECTION: flags.USE_SPEAKER_CORRECTION,
      USE_CUSTOM_MODEL: flags.USE_CUSTOM_MODEL,
      note: flags.USE_VOICE_EMBEDDING ? 'resemblyzer 화자 자동 인식 활성' : 'resemblyzer 화자 자동 인식 비활성',
    })
    sttLog('state transition', { jobId: job.id, from: 'queued', to: 'processing', progress: 5 })

    await updateJob(job.id, { status: 'processing', progress: 5, error_code: null, error_message: null })
    await applyScopedPatch(job, { status: 'processing', progress: 5 })

    const attachment = await findAttachmentRow(job.attachment_id)
    sttLog('attachment lookup', {
      jobId: job.id,
      attachmentId: job.attachment_id,
      found: Boolean(attachment),
      attachmentStatus: attachment?.status,
      attachmentPostId: attachment?.post_id,
      attachmentChannelId: attachment?.channel_id,
      filename: attachment?.filename,
      size: attachment?.size,
    })
    if (!attachment || String(attachment.status || '').toUpperCase() !== 'COMPLETED') {
      sttError('state transition', { jobId: job.id, from: 'processing', to: 'failed', code: 'ATTACHMENT_NOT_READY' })
      await updateJob(job.id, {
        status: 'failed',
        progress: 0,
        error_code: 'ATTACHMENT_NOT_READY',
        error_message: mapErrorMessage('ATTACHMENT_NOT_READY'),
        completed_at: new Date(),
      })
      await applyScopedPatch(job, { status: 'failed', error: mapErrorMessage('ATTACHMENT_NOT_READY') })
      return
    }

    const fullPath = path.join(STORAGE_BASE, attachment.storage_path)
    sttLog('audio path resolved', { jobId: job.id, storageBase: STORAGE_BASE, storagePath: attachment.storage_path, fullPath })
    if (!fs.existsSync(fullPath)) {
      sttError('state transition', { jobId: job.id, from: 'processing', to: 'failed', code: 'AUDIO_FILE_NOT_FOUND', fullPath })
      await updateJob(job.id, {
        status: 'failed',
        progress: 0,
        error_code: 'AUDIO_FILE_NOT_FOUND',
        error_message: mapErrorMessage('AUDIO_FILE_NOT_FOUND'),
        completed_at: new Date(),
      })
      await applyScopedPatch(job, { status: 'failed', error: mapErrorMessage('AUDIO_FILE_NOT_FOUND') })
      return
    }

    await updateJob(job.id, { progress: 35 })
    sttLog('state update', { jobId: job.id, status: 'processing', progress: 35, stage: 'stt-model-start' })
    await applyScopedPatch(job, { status: 'processing', progress: 35 })

    const parsedOptions = typeof job.options_json === 'object' && job.options_json ? job.options_json : {}
    sttLog('job options', { jobId: job.id, options: JSON.stringify(parsedOptions) })
    let sttResult
    let lastFineProgress = 35
    try {
      sttResult = await runPythonStt(fullPath, parsedOptions, async (evt) => {
        const pyProgress = Number(evt?.progress)
        if (!Number.isFinite(pyProgress)) return
        const mappedProgress = Math.max(36, Math.min(74, 35 + Math.floor(pyProgress * 0.39)))
        if (mappedProgress <= lastFineProgress) return
        lastFineProgress = mappedProgress
        sttLog('fine progress update', {
          jobId: job.id,
          progress: mappedProgress,
          pyProgress,
          stage: evt?.stage || 'transcribing',
          current: evt?.current,
          total: evt?.total,
        })
        await updateJob(job.id, { progress: mappedProgress })
        await applyScopedPatch(job, { status: 'processing', progress: mappedProgress })
      })
    } catch (e) {
      const code = e?.code || 'TRANSCRIPTION_FAILED'
      const message = mapErrorMessage(code, e?.message)
      sttError('state transition', { jobId: job.id, from: 'processing', to: 'failed', code, message })
      await updateJob(job.id, {
        status: 'failed',
        progress: 0,
        error_code: code,
        error_message: message,
        completed_at: new Date(),
      })
      await applyScopedPatch(job, { status: 'failed', error: message })
      notifySttToTelegram(job, { status: 'failed', errorMessage: message }).catch(() => {})
      return
    }

    await updateJob(job.id, { progress: 75 })
    sttLog('state update', { jobId: job.id, status: 'processing', progress: 75, stage: 'mapping-merge-summary' })
    await applyScopedPatch(job, { status: 'processing', progress: 75 })

    const speakerEmbeddings = sttResult.speaker_embeddings || {}
    let mappedSegments = await applySpeakerMapping(job.channel_id, sttResult.segments || [])
    mappedSegments = await autoMatchSpeakersByEmbedding(job.channel_id, mappedSegments, speakerEmbeddings)
    sttLog('speaker mapping applied', {
      jobId: job.id,
      originalSegments: Array.isArray(sttResult.segments) ? sttResult.segments.length : 0,
      mappedSegments: Array.isArray(mappedSegments) ? mappedSegments.length : 0,
      diarizationUsed: sttResult?.diarization?.used,
      diarizationSpeakerCount: sttResult?.diarization?.speaker_count,
      diarizationSegmentCount: sttResult?.diarization?.segment_count,
    })

    await db.query('DELETE FROM stt_segments WHERE job_id = $1', [job.id])
    sttLog('old segments deleted', { jobId: job.id })
    for (const seg of mappedSegments) {
      await db.query(
        `INSERT INTO stt_segments (job_id, segment_index, start_sec, end_sec, speaker_label, speaker_name, text, confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          job.id,
          Number(seg.segment_index || 0),
          Number(seg.start_sec || 0),
          Number(seg.end_sec || 0),
          String(seg.speaker_label || 'SPEAKER_00'),
          seg.speaker_name || null,
          String(seg.text || ''),
          Number(seg.confidence || 0.7),
        ],
      )
    }
    sttLog('segments inserted', { jobId: job.id, count: mappedSegments.length })

    const fullTranscript = mergeMappedTranscript(mappedSegments) || String(sttResult.full_transcript || '')
    const summary = String(sttResult.summary || '')
    sttLog('transcript/summary prepared', {
      jobId: job.id,
      transcriptLength: fullTranscript.length,
      summaryLength: summary.length,
    })

    const embeddingsJson = Object.keys(speakerEmbeddings).length ? JSON.stringify(speakerEmbeddings) : null
    await db.query(
      `INSERT INTO stt_summaries (job_id, full_transcript, meeting_summary, action_items, speaker_embeddings_json, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (job_id)
       DO UPDATE SET
         full_transcript = EXCLUDED.full_transcript,
         meeting_summary = EXCLUDED.meeting_summary,
         action_items = EXCLUDED.action_items,
         speaker_embeddings_json = EXCLUDED.speaker_embeddings_json,
         updated_at = NOW()`,
      [job.id, fullTranscript, summary, '[]', embeddingsJson],
    )
    sttLog('summary row upserted', { jobId: job.id })

    const patchApplied = await applyScopedPatch(job, {
      status: 'done',
      progress: 100,
      transcript: fullTranscript,
      summary,
    })

    if (!patchApplied) {
      sttError('state transition', { jobId: job.id, from: 'processing', to: 'failed', code: 'POST_UPDATE_FAILED' })
      await updateJob(job.id, {
        status: 'failed',
        progress: 0,
        error_code: 'POST_UPDATE_FAILED',
        error_message: mapErrorMessage('POST_UPDATE_FAILED'),
        completed_at: new Date(),
      })
      return
    }

    await updateJob(job.id, {
      status: 'done',
      progress: 100,
      patch_committed: true,
      completed_at: new Date(),
    })
    sttLog('state transition', { jobId: job.id, from: 'processing', to: 'done', progress: 100, patchCommitted: true })

    // ── 완료 후처리: 제목 자동 생성 + 오디오 첨부 등록 ──────────
    try {
      // 1) 요약 첫 문장으로 게시글 제목 자동 설정 (기존 제목이 없을 때만)
      const autoTitle = extractTitleFromSummary(summary)
      if (autoTitle && job.post_id) {
        await db.query(
          "UPDATE posts SET title = $1 WHERE id = $2 AND (title IS NULL OR title = '')",
          [autoTitle, job.post_id],
        ).catch(() => {})
        sttLog('auto title set', { jobId: job.id, title: autoTitle })
      }
      notifySttToTelegram(job, { status: 'done', title: autoTitle }).catch(() => {})

      // 2) 오디오 첨부 → attachment_refs 등록 (삭제 보호 연동)
      if (job.attachment_id && job.post_id) {
        await db.query(
          `INSERT INTO attachment_refs (attachment_id, owner_type, owner_id)
           VALUES ($1, 'post', $2)
           ON CONFLICT (attachment_id, owner_type, owner_id) DO NOTHING`,
          [job.attachment_id, job.post_id],
        ).catch(() => {})
        await db.query(
          `UPDATE attachments
           SET ref_count = (SELECT COUNT(*)::int FROM attachment_refs WHERE attachment_id = $1)
           WHERE id = $1`,
          [job.attachment_id],
        ).catch(() => {})
        sttLog('attachment ref registered', { jobId: job.id, attachmentId: job.attachment_id, postId: job.post_id })

        // 3) Cassandra: attachments_1~10 빈 슬롯에 오디오 첨부 ID 등록
        if (isConnected()) {
          const locator = await findPostLocator(job.post_id)
          if (locator) {
            const slotCols = [
              'attachments_1','attachments_2','attachments_3','attachments_4','attachments_5',
              'attachments_6','attachments_7','attachments_8','attachments_9','attachments_10',
            ]
            const cassPost = await client.execute(
              `SELECT ${slotCols.join(', ')} FROM posts WHERE channel_id = ? AND created_at = ?`,
              [locator.channel_id, locator.created_at], { prepare: true },
            ).catch(() => null)
            if (cassPost) {
              const cassRow = cassPost.rows?.[0] || {}
              const existing = slotCols.map(c => String(cassRow[c] || '')).filter(Boolean)
              if (!existing.includes(String(job.attachment_id))) {
                const emptySlot = slotCols.find(c => !cassRow[c])
                if (emptySlot) {
                  await client.execute(
                    `UPDATE posts SET ${emptySlot} = ? WHERE channel_id = ? AND created_at = ?`,
                    [String(job.attachment_id), locator.channel_id, locator.created_at], { prepare: true },
                  ).catch(() => {})
                  sttLog('cassandra attachment slot set', { jobId: job.id, slot: emptySlot, attachmentId: job.attachment_id })
                }
              }
            }
          }
        }
      }
    } catch (postErr) {
      sttError('post-completion handler error', { jobId: job.id, error: postErr?.message || postErr })
    }
  } catch (err) {
    sttError('worker unexpected error', { error: err?.message || err })
  } finally {
    sttActorUserId = ''
    workerTicking = false
    setTimeout(() => {
      queueWorkerTick().catch(() => {})
    }, 300)
  }
}

router.post('/speaker-mappings', requireAuth, async (req, res, next) => {
  try {
    sttActorUserId = String(req.user?.id || '')
    await ensureTables()
    const { channelId, speakerLabel, userId = null, displayName = '', confidence = 0.9, jobId = null } = req.body || {}
    sttLog('speaker mapping upsert requested', { actorUserId: req.user?.id, channelId, speakerLabel, userId, displayName, confidence, jobId })
    if (!channelId || !speakerLabel || !displayName) {
      return res.status(400).json({ error: 'channelId, speakerLabel, displayName은 필수입니다.' })
    }

    const allowed = await canAccessChannel(db, req.user, String(channelId))
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })

    // Voice embedding: jobId가 있으면 해당 job의 embedding을 함께 저장
    let voiceEmbeddingJson = null
    if (flags.USE_VOICE_EMBEDDING && jobId) {
      try {
        const sumRow = await db.query(
          `SELECT speaker_embeddings_json FROM stt_summaries WHERE job_id = $1`,
          [String(jobId)],
        )
        if (sumRow.rows[0]?.speaker_embeddings_json) {
          const allEmbs = JSON.parse(sumRow.rows[0].speaker_embeddings_json)
          if (allEmbs[speakerLabel]) {
            voiceEmbeddingJson = JSON.stringify(allEmbs[speakerLabel])
          }
        }
      } catch (_) {}
    }

    await db.query(
      `INSERT INTO stt_speaker_mappings (channel_id, speaker_label, user_id, display_name, confidence, voice_embedding_json, created_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (channel_id, speaker_label)
       DO UPDATE SET user_id = EXCLUDED.user_id,
                     display_name = EXCLUDED.display_name,
                     confidence = EXCLUDED.confidence,
                     voice_embedding_json = COALESCE(EXCLUDED.voice_embedding_json, stt_speaker_mappings.voice_embedding_json),
                     updated_at = NOW()`,
      [String(channelId), String(speakerLabel), userId || null, String(displayName), Number(confidence || 0), voiceEmbeddingJson, req.user.id],
    )

    res.json({ success: true, voiceEmbeddingStored: Boolean(voiceEmbeddingJson) })
    sttLog('speaker mapping upsert completed', { actorUserId: req.user?.id, channelId, speakerLabel })
  } catch (err) {
    sttError('speaker mapping upsert failed', { error: err?.message || err })
    next(err)
  } finally {
    sttActorUserId = ''
  }
})

router.get('/speaker-mappings', requireAuth, async (req, res, next) => {
  try {
    sttActorUserId = String(req.user?.id || '')
    await ensureTables()
    const channelId = String(req.query.channelId || '')
    const jobId = String(req.query.jobId || '')
    sttLog('speaker mapping list requested', { actorUserId: req.user?.id, channelId, jobId: jobId || undefined })
    if (!channelId) return res.status(400).json({ error: 'channelId가 필요합니다.' })
    const allowed = await canAccessChannel(db, req.user, channelId)
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })

    let rows
    if (jobId) {
      // 해당 job의 세그먼트에 실제 등장한 화자만 반환 (채널 매핑은 pre-fill 용도)
      rows = await db.query(
        `SELECT
           s.speaker_label,
           m.display_name,
           m.user_id,
           m.confidence,
           m.updated_at,
           m.voice_embedding_json,
           u.name AS user_name
         FROM (SELECT DISTINCT speaker_label FROM stt_segments WHERE job_id = $1) s
         LEFT JOIN stt_speaker_mappings m ON m.channel_id = $2 AND m.speaker_label = s.speaker_label
         LEFT JOIN users u ON u.id = m.user_id
         ORDER BY s.speaker_label ASC`,
        [jobId, channelId],
      )
    } else {
      rows = await db.query(
        `SELECT m.channel_id, m.speaker_label, m.user_id, m.display_name, m.confidence, m.updated_at, m.voice_embedding_json, u.name AS user_name
         FROM stt_speaker_mappings m
         LEFT JOIN users u ON u.id = m.user_id
         WHERE m.channel_id = $1
         ORDER BY m.speaker_label ASC`,
        [channelId],
      )
    }
    res.json(rows.rows || [])
    sttLog('speaker mapping list completed', { actorUserId: req.user?.id, channelId, jobId: jobId || undefined, count: rows.rows?.length || 0 })
  } catch (err) {
    sttError('speaker mapping list failed', { error: err?.message || err })
    next(err)
  } finally {
    sttActorUserId = ''
  }
})

router.delete('/speaker-mappings', requireAuth, async (req, res, next) => {
  try {
    sttActorUserId = String(req.user?.id || '')
    await ensureTables()
    const { channelId, speakerLabel } = req.body || {}
    sttLog('speaker mapping delete requested', { actorUserId: req.user?.id, channelId, speakerLabel })
    if (!channelId || !speakerLabel) {
      return res.status(400).json({ error: 'channelId, speakerLabel은 필수입니다.' })
    }
    const allowed = await canAccessChannel(db, req.user, String(channelId))
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })
    await db.query(
      `DELETE FROM stt_speaker_mappings
       WHERE channel_id = $1 AND speaker_label = $2`,
      [String(channelId), String(speakerLabel)],
    )
    res.json({ success: true })
    sttLog('speaker mapping delete completed', { actorUserId: req.user?.id, channelId, speakerLabel })
  } catch (err) {
    sttError('speaker mapping delete failed', { error: err?.message || err })
    next(err)
  } finally {
    sttActorUserId = ''
  }
})

router.get('/feature-flags', requireAuth, (_req, res) => {
  res.json(flags)
})

router.get('/jobs/:id/segments', requireAuth, async (req, res, next) => {
  try {
    await ensureTables()
    const jobId = String(req.params.id || '')
    if (!jobId) return res.status(400).json({ error: 'jobId가 필요합니다.' })

    const jobRow = await db.query(`SELECT channel_id FROM stt_jobs WHERE id = $1`, [jobId])
    if (!jobRow.rows[0]) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' })

    const allowed = await canAccessChannel(db, req.user, jobRow.rows[0].channel_id)
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })

    const rows = await db.query(
      `SELECT id, segment_index, start_sec, end_sec, speaker_label, speaker_name, text, confidence
       FROM stt_segments WHERE job_id = $1 ORDER BY segment_index ASC`,
      [jobId],
    )
    res.json(rows.rows || [])
  } catch (err) {
    next(err)
  }
})

router.patch('/segments/:id', requireAuth, async (req, res, next) => {
  try {
    if (!flags.USE_SPEAKER_CORRECTION) return res.status(403).json({ error: '화자 보정 기능이 비활성화되어 있습니다.' })
    await ensureTables()
    const segId = String(req.params.id || '')
    const { speakerName } = req.body || {}
    if (!segId) return res.status(400).json({ error: 'segmentId가 필요합니다.' })

    const segRow = await db.query(
      `SELECT s.id, s.job_id, j.channel_id
       FROM stt_segments s JOIN stt_jobs j ON j.id = s.job_id
       WHERE s.id = $1`,
      [segId],
    )
    if (!segRow.rows[0]) return res.status(404).json({ error: '세그먼트를 찾을 수 없습니다.' })

    const allowed = await canAccessChannel(db, req.user, segRow.rows[0].channel_id)
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })

    await db.query(
      `UPDATE stt_segments SET speaker_name = $1 WHERE id = $2`,
      [speakerName || null, segId],
    )
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

router.post('/jobs', requireAuth, async (req, res, next) => {
  try {
    sttActorUserId = String(req.user?.id || '')
    await ensureTables()

    const { postId, attachmentId, options = {} } = req.body || {}
    sttLog('job create requested', {
      actorUserId: req.user?.id,
      postId,
      attachmentId,
      options: JSON.stringify(options || {}),
    })
    if (!postId || !attachmentId) {
      return res.status(400).json({ error: 'postId, attachmentId는 필수입니다.' })
    }

    const post = await findPostLocator(String(postId))
    if (!post) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' })
    sttLog('post locator resolved', { postId, channelId: post.channel_id, authorId: post.author_id })

    const allowed = await canAccessChannel(db, req.user, String(post.channel_id))
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })
    sttLog('channel access granted', { actorUserId: req.user?.id, channelId: post.channel_id })

    const attachment = await findAttachmentRow(String(attachmentId))
    if (!attachment) return res.status(404).json({ error: '첨부파일을 찾을 수 없습니다.' })
    if (String(attachment.status || '').toUpperCase() !== 'COMPLETED') {
      return res.status(409).json({ error: '첨부파일 업로드가 완료되지 않았습니다.' })
    }
    const postChannelId = String(post.channel_id || '')
    const attachmentChannelId = String(attachment.channel_id || '')
    const attachmentPostId = String(attachment.post_id || '')
    const targetPostId = String(postId || '')

    // Legacy/temporary rows can miss post_id/channel_id.
    // Auto-heal when it's safe to infer from the requested post.
    if (!attachmentPostId) {
      await patchAttachmentMeta(attachment.id, { postId: targetPostId })
      attachment.post_id = targetPostId
    }
    if (!attachmentChannelId) {
      await patchAttachmentMeta(attachment.id, { channelId: postChannelId })
      attachment.channel_id = postChannelId
    }

    if (String(attachment.channel_id || '') !== postChannelId) {
      // If attachment is already tied to this exact post, channel can be healed.
      if (String(attachment.post_id || '') === targetPostId) {
        await patchAttachmentMeta(attachment.id, { channelId: postChannelId })
        attachment.channel_id = postChannelId
      } else {
        return res.status(400).json({ error: '게시글과 첨부파일 채널이 일치하지 않습니다.' })
      }
    }

    const optionsHash = hashOptions(options)
    const idempotencyKey = buildIdempotencyKey({
      postId: String(postId),
      attachmentId: String(attachmentId),
      modelVersion: MODEL_VERSION,
      optionsHash,
    })

    const exists = await db.query(
      `SELECT id, status FROM stt_jobs WHERE idempotency_key = $1 LIMIT 1`,
      [idempotencyKey],
    )

    if (exists.rowCount > 0) {
      const existing = exists.rows[0]
      if (['queued', 'processing', 'done'].includes(String(existing.status))) {
        sttLog('job create deduplicated', { existingJobId: existing.id, status: existing.status, idempotencyKey })
        return res.json({ jobId: existing.id, status: existing.status, deduplicated: true })
      }
    }

    const inserted = await db.query(
      `INSERT INTO stt_jobs (
        id, post_id, channel_id, attachment_id,
        idempotency_key, model_version, options_json, options_hash,
        status, progress, created_by
      ) VALUES (
        gen_random_uuid(), $1, $2, $3,
        $4, $5, $6::jsonb, $7,
        'queued', 0, $8
      )
      RETURNING id, status`,
      [
        String(postId),
        String(post.channel_id),
        String(attachmentId),
        idempotencyKey,
        MODEL_VERSION,
        JSON.stringify(options || {}),
        optionsHash,
        req.user.id,
      ],
    )

    const job = inserted.rows[0]
    sttLog('job created', { jobId: job.id, status: job.status, idempotencyKey })
    queueWorkerTick().catch(() => {})
    return res.status(201).json({ jobId: job.id, status: job.status })
  } catch (err) {
    sttError('job create failed', { error: err?.message || err })
    next(err)
  } finally {
    sttActorUserId = ''
  }
})

router.get('/jobs/:id', requireAuth, async (req, res, next) => {
  try {
    sttActorUserId = String(req.user?.id || '')
    await ensureTables()
    const { id } = req.params
    sttLog('job status requested', { actorUserId: req.user?.id, jobId: id })
    const r = await db.query('SELECT * FROM stt_jobs WHERE id = $1 LIMIT 1', [id])
    if (r.rowCount === 0) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' })
    const job = r.rows[0]

    const allowed = await canAccessChannel(db, req.user, String(job.channel_id || ''))
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })

    return res.json({
      id: job.id,
      postId: job.post_id,
      attachmentId: job.attachment_id,
      status: job.status,
      progress: job.progress,
      error: job.error_message ? { code: job.error_code, message: job.error_message } : null,
      retryCount: job.retry_count,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      completedAt: job.completed_at,
    })
  } catch (err) {
    sttError('job status failed', { error: err?.message || err })
    next(err)
  } finally {
    sttActorUserId = ''
  }
})

router.post('/jobs/:id/retry', requireAuth, async (req, res, next) => {
  try {
    sttActorUserId = String(req.user?.id || '')
    await ensureTables()
    const { id } = req.params
    sttLog('job retry requested', { actorUserId: req.user?.id, jobId: id })
    const r = await db.query('SELECT * FROM stt_jobs WHERE id = $1 LIMIT 1', [id])
    if (r.rowCount === 0) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' })
    const job = r.rows[0]

    const allowed = await canAccessChannel(db, req.user, String(job.channel_id || ''))
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })

    if (String(job.status) !== 'failed') {
      return res.status(409).json({ error: '실패 상태 작업만 재시도할 수 있습니다.' })
    }
    if (Number(job.retry_count || 0) >= MAX_AUTORETRY) {
      return res.status(429).json({ error: '재시도 한도를 초과했습니다.' })
    }

    await updateJob(id, {
      status: 'queued',
      progress: 0,
      retry_count: Number(job.retry_count || 0) + 1,
      error_code: null,
      error_message: null,
      completed_at: null,
      patch_committed: false,
    })
    sttLog('job retry queued', { jobId: id, retryCount: Number(job.retry_count || 0) + 1 })

    queueWorkerTick().catch(() => {})
    return res.json({ id, status: 'queued' })
  } catch (err) {
    sttError('job retry failed', { error: err?.message || err })
    next(err)
  } finally {
    sttActorUserId = ''
  }
})

module.exports = router
