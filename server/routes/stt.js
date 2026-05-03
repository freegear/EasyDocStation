const express = require('express')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')
const db = require('../db')
const requireAuth = require('../middleware/auth')
const { client, isConnected } = require('../cassandra')
const { canAccessChannel, ACCESS_DENIED_MESSAGE } = require('../lib/channelAccess')
const { getDatabasePath } = require('../databasePaths')
const { getPythonExecutable } = require('../pythonRuntime')

const router = express.Router()

const MODEL_VERSION = process.env.STT_MODEL_VERSION || 'gemma-4-e4b'
const MODEL_ID = process.env.STT_MODEL_ID || 'google/gemma-4-E4B-it'
const HF_TOKEN = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || ''
const MAX_AUTORETRY = 2

let tablesReadyPromise = null
let workerTicking = false

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
  const base = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ')
  console.log(`[STT] ${message}${base ? ` | ${base}` : ''}`)
}

function sttError(message, meta = {}) {
  const base = Object.entries(meta)
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

function renderSttBlock({ jobId, status, progress = 0, transcript = '', summary = '', error = '' }) {
  const head = `<!--stt-result:start job_id=${jobId}-->`
  const tail = '<!--stt-result:end-->'
  if (status === 'processing' || status === 'queued') {
    return `${head}\n\n## STT 상태\n처리중 (${Math.max(0, Math.min(100, Number(progress) || 0))}%)\n\n${tail}`
  }
  if (status === 'failed') {
    return `${head}\n\n## STT 상태\n실패\n\n사유: ${error || '알 수 없는 오류'}\n\n${tail}`
  }
  const safeTranscript = sanitizeTranscriptText(transcript || '')
  const safeSummary = String(summary || '').trim()
  return `${head}\n\n## STT 상태\n완료\n\n### 전사문\n\`\`\`text\n${safeTranscript || '(전사문 없음)'}\n\`\`\`\n\n### 회의 요약\n\`\`\`text\n${safeSummary || '(요약 없음)'}\n\`\`\`\n\n${tail}`
}

function upsertSttBlock(content = '', blockText = '') {
  const source = String(content || '')
  const blockPattern = /<!--stt-result:start job_id=.*?-->[\s\S]*?<!--stt-result:end-->/m
  if (blockPattern.test(source)) {
    return source.replace(blockPattern, blockText)
  }
  return `${source.trimEnd()}\n\n${blockText}\n`
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
  if (!locator) throw new Error('POST_NOT_FOUND')

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

function runPythonStt(audioPath, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = {
      audioPath,
      language: options.language || 'ko',
      diarization: options.diarization !== false,
      diarizationRequired: options.diarizationRequired === true,
      modelId: MODEL_ID,
      hfToken: HF_TOKEN,
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
    execFile(py, [STT_SCRIPT, payloadPath], { timeout: 1000 * 60 * 20, maxBuffer: 1024 * 1024 * 32 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(payloadPath) } catch (_) {}
      if (err) {
        const detail = String(stderr || err.message || '').slice(0, 1000)
        sttError('python worker failed', { code: 'TRANSCRIPTION_FAILED', detail })
        reject({ code: 'TRANSCRIPTION_FAILED', message: detail || 'python worker failed' })
        return
      }
      try {
        const parsed = JSON.parse(String(stdout || '{}'))
        if (!parsed.ok) {
          sttError('python worker returned failure', {
            code: parsed.error_code || 'TRANSCRIPTION_FAILED',
            message: parsed.error_message || 'stt failed',
          })
          reject({ code: parsed.error_code || 'TRANSCRIPTION_FAILED', message: parsed.error_message || 'stt failed' })
          return
        }
        sttLog('python worker completed', {
          segments: Array.isArray(parsed.segments) ? parsed.segments.length : 0,
          transcriptLength: String(parsed.full_transcript || '').length,
          summaryLength: String(parsed.summary || '').length,
          diarizationUsed: parsed?.diarization?.used,
          diarizationSpeakerCount: parsed?.diarization?.speaker_count,
          diarizationSegmentCount: parsed?.diarization?.segment_count,
        })
        resolve(parsed)
      } catch (e) {
        sttError('python worker output parse failed', { error: e.message })
        reject({ code: 'TRANSCRIPTION_FAILED', message: `invalid stt output: ${e.message}` })
      }
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
    'Transcribe this audio accurately. Output transcript only.',
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
    sttLog('job dequeued', {
      jobId: job.id,
      postId: job.post_id,
      attachmentId: job.attachment_id,
      channelId: job.channel_id,
      retryCount: job.retry_count,
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
    try {
      sttResult = await runPythonStt(fullPath, parsedOptions)
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
      return
    }

    await updateJob(job.id, { progress: 75 })
    sttLog('state update', { jobId: job.id, status: 'processing', progress: 75, stage: 'mapping-merge-summary' })
    await applyScopedPatch(job, { status: 'processing', progress: 75 })

    const mappedSegments = await applySpeakerMapping(job.channel_id, sttResult.segments || [])
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

    await db.query(
      `INSERT INTO stt_summaries (job_id, full_transcript, meeting_summary, action_items, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (job_id)
       DO UPDATE SET
         full_transcript = EXCLUDED.full_transcript,
         meeting_summary = EXCLUDED.meeting_summary,
         action_items = EXCLUDED.action_items,
         updated_at = NOW()`,
      [job.id, fullTranscript, summary, '[]'],
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
  } catch (err) {
    sttError('worker unexpected error', { error: err?.message || err })
  } finally {
    workerTicking = false
    setTimeout(() => {
      queueWorkerTick().catch(() => {})
    }, 300)
  }
}

router.post('/speaker-mappings', requireAuth, async (req, res, next) => {
  try {
    await ensureTables()
    const { channelId, speakerLabel, userId = null, displayName = '', confidence = 0.9 } = req.body || {}
    sttLog('speaker mapping upsert requested', { actorUserId: req.user?.id, channelId, speakerLabel, userId, displayName, confidence })
    if (!channelId || !speakerLabel || !displayName) {
      return res.status(400).json({ error: 'channelId, speakerLabel, displayName은 필수입니다.' })
    }

    const allowed = await canAccessChannel(db, req.user, String(channelId))
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })

    await db.query(
      `INSERT INTO stt_speaker_mappings (channel_id, speaker_label, user_id, display_name, confidence, created_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (channel_id, speaker_label)
       DO UPDATE SET user_id = EXCLUDED.user_id,
                     display_name = EXCLUDED.display_name,
                     confidence = EXCLUDED.confidence,
                     updated_at = NOW()`,
      [String(channelId), String(speakerLabel), userId || null, String(displayName), Number(confidence || 0), req.user.id],
    )

    res.json({ success: true })
    sttLog('speaker mapping upsert completed', { actorUserId: req.user?.id, channelId, speakerLabel })
  } catch (err) {
    sttError('speaker mapping upsert failed', { error: err?.message || err })
    next(err)
  }
})

router.get('/speaker-mappings', requireAuth, async (req, res, next) => {
  try {
    await ensureTables()
    const channelId = String(req.query.channelId || '')
    sttLog('speaker mapping list requested', { actorUserId: req.user?.id, channelId })
    if (!channelId) return res.status(400).json({ error: 'channelId가 필요합니다.' })
    const allowed = await canAccessChannel(db, req.user, channelId)
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })

    const rows = await db.query(
      `SELECT m.channel_id, m.speaker_label, m.user_id, m.display_name, m.confidence, m.updated_at, u.name AS user_name
       FROM stt_speaker_mappings m
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.channel_id = $1
       ORDER BY m.speaker_label ASC`,
      [channelId],
    )
    res.json(rows.rows || [])
    sttLog('speaker mapping list completed', { actorUserId: req.user?.id, channelId, count: rows.rows?.length || 0 })
  } catch (err) {
    sttError('speaker mapping list failed', { error: err?.message || err })
    next(err)
  }
})

router.delete('/speaker-mappings', requireAuth, async (req, res, next) => {
  try {
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
  }
})

router.post('/jobs', requireAuth, async (req, res, next) => {
  try {
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
  }
})

router.get('/jobs/:id', requireAuth, async (req, res, next) => {
  try {
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
  }
})

router.post('/jobs/:id/retry', requireAuth, async (req, res, next) => {
  try {
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
  }
})

module.exports = router
