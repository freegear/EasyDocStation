const express = require('express')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')
const multer = require('multer')
const db = require('../db')
const requireAuth = require('../middleware/auth')
const { canAccessChannel, ACCESS_DENIED_MESSAGE } = require('../lib/channelAccess')
const { getDatabasePath } = require('../databasePaths')

const router = express.Router()
const execFileAsync = promisify(execFile)
const config = require('../../config.json')
const STORAGE_BASE = path.resolve(getDatabasePath(config, 'ObjectFile Path'))
const MEETING_BASE = path.join(STORAGE_BASE, 'meeting-recordings')
const CHUNK_MS = 20_000
const CONTEXT_MS = 3_000
const MAX_CHUNK_BYTES = Number(process.env.MEETING_CHUNK_MAX_BYTES || 32 * 1024 * 1024)

fs.mkdirSync(MEETING_BASE, { recursive: true })

const uploadChunk = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: MAX_CHUNK_BYTES },
})

let schemaReadyPromise = null

function ensureMeetingSchema() {
  if (schemaReadyPromise) return schemaReadyPromise
  schemaReadyPromise = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS meeting_recordings (
        id UUID PRIMARY KEY,
        post_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'created',
        content_type TEXT NOT NULL DEFAULT 'audio/webm',
        chunk_duration_ms INTEGER NOT NULL DEFAULT 20000,
        context_overlap_ms INTEGER NOT NULL DEFAULT 3000,
        last_sequence INTEGER,
        total_duration_ms BIGINT,
        attachment_id TEXT,
        stt_job_id UUID,
        download_file_name TEXT,
        download_content_type TEXT,
        download_storage_path TEXT,
        download_size BIGINT,
        download_sha256 TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await db.query('CREATE INDEX IF NOT EXISTS idx_meeting_recordings_post ON meeting_recordings(post_id)')
    await db.query(`
      CREATE TABLE IF NOT EXISTS meeting_audio_chunks (
        meeting_id UUID NOT NULL REFERENCES meeting_recordings(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        started_at_ms BIGINT NOT NULL,
        duration_ms INTEGER NOT NULL,
        core_start_ms BIGINT NOT NULL,
        core_end_ms BIGINT NOT NULL,
        context_start_ms BIGINT NOT NULL,
        context_end_ms BIGINT NOT NULL,
        content_type TEXT NOT NULL,
        size BIGINT NOT NULL,
        sha256 TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'verified',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (meeting_id, sequence)
      )
    `)
    await db.query(`
      CREATE TABLE IF NOT EXISTS meeting_download_audit (
        id BIGSERIAL PRIMARY KEY,
        meeting_id UUID,
        post_id TEXT,
        user_id INTEGER,
        action TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await db.query(`
      CREATE TABLE IF NOT EXISTS meeting_markers (
        id UUID PRIMARY KEY,
        meeting_id UUID NOT NULL REFERENCES meeting_recordings(id) ON DELETE CASCADE,
        offset_ms BIGINT NOT NULL,
        type TEXT NOT NULL,
        memo TEXT,
        created_by INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
  })().catch((err) => {
    schemaReadyPromise = null
    throw err
  })
  return schemaReadyPromise
}

function meetingDir(meetingId) {
  const id = String(meetingId || '')
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('잘못된 회의 ID입니다.')
  return path.join(MEETING_BASE, id)
}

function relativeStoragePath(filePath) {
  return path.relative(STORAGE_BASE, filePath)
}

function resolveStoragePath(relativePath) {
  const full = path.resolve(STORAGE_BASE, String(relativePath || ''))
  if (full !== STORAGE_BASE && !full.startsWith(`${STORAGE_BASE}${path.sep}`)) return null
  return full
}

function safeFilename(value = '') {
  const cleaned = String(value || '회의녹음')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
  return cleaned || '회의녹음'
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

async function postForMeeting(postId) {
  const result = await db.query('SELECT id, channel_id, title FROM posts WHERE id = $1 LIMIT 1', [String(postId)])
  return result.rows?.[0] || null
}

async function isPostDeleted(postId) {
  const result = await db.query(
    "SELECT 1 FROM deleted_items WHERE item_type = 'post' AND item_id = $1 LIMIT 1",
    [String(postId)],
  ).catch(() => ({ rowCount: 0 }))
  return result.rowCount > 0
}

async function loadAuthorizedMeeting(req, res) {
  await ensureMeetingSchema()
  const result = await db.query('SELECT * FROM meeting_recordings WHERE id = $1 LIMIT 1', [req.params.id])
  const meeting = result.rows?.[0]
  if (!meeting || await isPostDeleted(meeting.post_id)) {
    res.status(404).json({ error: '회의 녹음을 찾을 수 없습니다.' })
    return null
  }
  const allowed = await canAccessChannel(db, req.user, String(meeting.channel_id))
  if (!allowed) {
    res.status(403).json({ error: ACCESS_DENIED_MESSAGE })
    return null
  }
  return meeting
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

async function concatenateChunks(rows, combinedPath) {
  const out = fs.createWriteStream(combinedPath, { flags: 'w' })
  for (const row of rows) {
    const chunkPath = resolveStoragePath(row.storage_path)
    if (!chunkPath || !fs.existsSync(chunkPath)) throw new Error(`음성 조각 ${row.sequence} 파일이 없습니다.`)
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(chunkPath)
      input.on('error', reject)
      input.on('end', resolve)
      input.pipe(out, { end: false })
    })
  }
  await new Promise((resolve, reject) => {
    out.on('error', reject)
    out.end(resolve)
  })
}

async function purgeMeetingRecordingsForPost(postId) {
  await ensureMeetingSchema()
  const result = await db.query('SELECT id, download_storage_path FROM meeting_recordings WHERE post_id = $1', [String(postId)])
  for (const meeting of result.rows || []) {
    try { fs.rmSync(meetingDir(meeting.id), { recursive: true, force: true }) } catch (_) {}
  }
  await db.query('DELETE FROM meeting_recordings WHERE post_id = $1', [String(postId)])
  return { deleted: result.rowCount }
}

router.post('/', requireAuth, async (req, res, next) => {
  try {
    await ensureMeetingSchema()
    const postId = String(req.body?.post_id || req.body?.postId || '')
    const post = await postForMeeting(postId)
    if (!post || await isPostDeleted(postId)) return res.status(404).json({ error: '회의록 게시글을 찾을 수 없습니다.' })
    const allowed = await canAccessChannel(db, req.user, String(post.channel_id))
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })

    const existing = await db.query(
      `SELECT * FROM meeting_recordings
       WHERE post_id = $1 AND owner_id = $2 AND status IN ('created','recording','uploading','merge_failed')
       ORDER BY created_at DESC LIMIT 1`,
      [postId, req.user.id],
    )
    if (existing.rowCount > 0) {
      const row = existing.rows[0]
      if (!req.body?.force_new) {
        return res.json({ meetingId: row.id, status: row.status, chunkDurationMs: CHUNK_MS, contextOverlapMs: CONTEXT_MS, maxChunkBytes: MAX_CHUNK_BYTES, resumed: true })
      }
      try { fs.rmSync(meetingDir(row.id), { recursive: true, force: true }) } catch (_) {}
      await db.query("UPDATE meeting_recordings SET status='canceled', updated_at=NOW() WHERE id=$1", [row.id])
      await db.query('DELETE FROM meeting_audio_chunks WHERE meeting_id=$1', [row.id])
    }

    const id = crypto.randomUUID()
    const contentType = String(req.body?.recording_content_type || req.body?.contentType || 'audio/webm').slice(0, 120)
    await db.query(
      `INSERT INTO meeting_recordings
       (id, post_id, channel_id, owner_id, status, content_type, chunk_duration_ms, context_overlap_ms, started_at)
       VALUES ($1,$2,$3,$4,'recording',$5,$6,$7,NOW())`,
      [id, postId, post.channel_id, req.user.id, contentType, CHUNK_MS, CONTEXT_MS],
    )
    fs.mkdirSync(path.join(meetingDir(id), 'chunks'), { recursive: true })
    res.status(201).json({ meetingId: id, status: 'recording', chunkDurationMs: CHUNK_MS, contextOverlapMs: CONTEXT_MS, maxChunkBytes: MAX_CHUNK_BYTES })
  } catch (err) { next(err) }
})

router.get('/post/:postId/latest', requireAuth, async (req, res, next) => {
  try {
    await ensureMeetingSchema()
    const post = await postForMeeting(req.params.postId)
    if (!post || await isPostDeleted(req.params.postId)) return res.status(404).json({ error: '회의록 게시글을 찾을 수 없습니다.' })
    const allowed = await canAccessChannel(db, req.user, String(post.channel_id))
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })
    const result = await db.query(
      `SELECT * FROM meeting_recordings WHERE post_id=$1 AND status <> 'canceled'
       ORDER BY created_at DESC LIMIT 1`,
      [String(req.params.postId)],
    )
    const meeting = result.rows?.[0]
    if (!meeting) return res.status(404).json({ error: '회의 녹음을 찾을 수 없습니다.' })
    res.json({
      meetingId: meeting.id,
      status: meeting.status,
      attachmentId: meeting.attachment_id,
      sttJobId: meeting.stt_job_id,
      totalDurationMs: Number(meeting.total_duration_ms || 0),
      downloadReady: meeting.status === 'completed' && Boolean(meeting.download_storage_path),
      downloadFileName: meeting.download_file_name,
      downloadSize: Number(meeting.download_size || 0),
      error: meeting.error_message ? { code: meeting.error_code, message: meeting.error_message } : null,
    })
  } catch (err) { next(err) }
})

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const meeting = await loadAuthorizedMeeting(req, res)
    if (!meeting) return
    const chunks = await db.query(
      'SELECT sequence, sha256, size, duration_ms FROM meeting_audio_chunks WHERE meeting_id = $1 ORDER BY sequence',
      [meeting.id],
    )
    res.json({
      meetingId: meeting.id,
      postId: meeting.post_id,
      status: meeting.status,
      attachmentId: meeting.attachment_id,
      sttJobId: meeting.stt_job_id,
      totalDurationMs: Number(meeting.total_duration_ms || 0),
      downloadReady: meeting.status === 'completed' && Boolean(meeting.download_storage_path),
      downloadFileName: meeting.download_file_name,
      downloadSize: Number(meeting.download_size || 0),
      chunks: chunks.rows,
      error: meeting.error_message ? { code: meeting.error_code, message: meeting.error_message } : null,
    })
  } catch (err) { next(err) }
})

router.post('/:id/audio-chunks', requireAuth, uploadChunk.single('audio'), async (req, res, next) => {
  try {
    const meeting = await loadAuthorizedMeeting(req, res)
    if (!meeting) return
    if (!['recording', 'uploading', 'merge_failed'].includes(String(meeting.status))) {
      return res.status(409).json({ error: '현재 상태에서는 음성 조각을 업로드할 수 없습니다.' })
    }
    if (!req.file?.buffer?.length) return res.status(400).json({ error: '음성 조각이 없습니다.' })
    const sequence = Number.parseInt(req.body.sequence, 10)
    const startedAtMs = Number.parseInt(req.body.started_at_ms, 10)
    const durationMs = Math.max(0, Number.parseInt(req.body.duration_ms, 10) || CHUNK_MS)
    if (!Number.isInteger(sequence) || sequence < 0 || !Number.isFinite(startedAtMs) || startedAtMs < 0) {
      return res.status(400).json({ error: '음성 조각 순번 또는 시간 정보가 잘못되었습니다.' })
    }
    const actualHash = sha256(req.file.buffer)
    const requestedHash = String(req.body.sha256 || '').toLowerCase()
    if (requestedHash && requestedHash !== actualHash) {
      return res.status(409).json({ error: '음성 조각 해시가 일치하지 않습니다.', code: 'CHUNK_HASH_MISMATCH' })
    }
    const found = await db.query(
      'SELECT sha256 FROM meeting_audio_chunks WHERE meeting_id = $1 AND sequence = $2',
      [meeting.id, sequence],
    )
    if (found.rowCount > 0) {
      if (found.rows[0].sha256 === actualHash) return res.json({ sequence, sha256: actualHash, deduplicated: true })
      return res.status(409).json({ error: '같은 순번에 다른 음성 조각이 존재합니다.', code: 'CHUNK_CONFLICT' })
    }

    const ext = String(req.file.mimetype || meeting.content_type).includes('ogg') ? 'ogg' : 'webm'
    const filePath = path.join(meetingDir(meeting.id), 'chunks', `chunk-${String(sequence).padStart(6, '0')}.${ext}`)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, req.file.buffer, { flag: 'wx' })
    const coreStart = startedAtMs
    const coreEnd = startedAtMs + durationMs
    await db.query(
      `INSERT INTO meeting_audio_chunks
       (meeting_id, sequence, started_at_ms, duration_ms, core_start_ms, core_end_ms,
        context_start_ms, context_end_ms, content_type, size, sha256, storage_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [meeting.id, sequence, startedAtMs, durationMs, coreStart, coreEnd,
        Math.max(0, coreStart - CONTEXT_MS), coreEnd + CONTEXT_MS,
        req.file.mimetype || meeting.content_type, req.file.size, actualHash, relativeStoragePath(filePath)],
    )
    await db.query("UPDATE meeting_recordings SET status='uploading', updated_at=NOW() WHERE id=$1", [meeting.id])
    res.status(201).json({ sequence, sha256: actualHash, size: req.file.size })
  } catch (err) { next(err) }
})

// Marker 저장 (중요 발언 등)
router.post('/:id/markers', requireAuth, async (req, res, next) => {
  try {
    const meeting = await loadAuthorizedMeeting(req, res)
    if (!meeting) return
    const offsetMs = Number.isFinite(Number(req.body?.offset_ms)) ? Number(req.body.offset_ms) : null
    const type = String(req.body?.type || 'important')
    const memo = typeof req.body?.memo === 'string' ? req.body.memo.slice(0, 2000) : null
    if (offsetMs === null) return res.status(400).json({ error: 'offset_ms가 필요합니다.' })
    const id = crypto.randomUUID()
    await db.query(
      `INSERT INTO meeting_markers (id, meeting_id, offset_ms, type, memo, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, meeting.id, offsetMs, type, memo, req.user.id],
    )
    res.status(201).json({ id, meetingId: meeting.id, offset_ms: offsetMs, type, memo })
  } catch (err) { next(err) }
})

router.post('/:id/finish', requireAuth, async (req, res, next) => {
  let meeting
  try {
    meeting = await loadAuthorizedMeeting(req, res)
    if (!meeting) return
    if (meeting.status === 'completed') {
      return res.json({ meetingId: meeting.id, status: meeting.status, attachmentId: meeting.attachment_id, deduplicated: true })
    }
    if (meeting.status === 'merging') return res.status(409).json({ error: '음성 파일을 병합하고 있습니다.' })
    const lastSequence = Number.parseInt(req.body?.last_sequence, 10)
    const totalDurationMs = Math.max(0, Number.parseInt(req.body?.total_duration_ms, 10) || 0)
    if (!Number.isInteger(lastSequence) || lastSequence < 0) return res.status(400).json({ error: '마지막 조각 순번이 필요합니다.' })
    const chunks = await db.query(
      'SELECT * FROM meeting_audio_chunks WHERE meeting_id=$1 ORDER BY sequence',
      [meeting.id],
    )
    const sequenceSet = new Set(chunks.rows.map((r) => Number(r.sequence)))
    const missing = []
    for (let i = 0; i <= lastSequence; i += 1) if (!sequenceSet.has(i)) missing.push(i)
    if (missing.length > 0) return res.status(409).json({ error: '업로드되지 않은 음성 조각이 있습니다.', code: 'MISSING_CHUNKS', missing })

    await db.query(
      "UPDATE meeting_recordings SET status='merging', last_sequence=$2, total_duration_ms=$3, error_code=NULL, error_message=NULL, updated_at=NOW() WHERE id=$1",
      [meeting.id, lastSequence, totalDurationMs],
    )
    const dir = meetingDir(meeting.id)
    const combinedPath = path.join(dir, 'meeting-combined.webm')
    const mp3Path = path.join(dir, 'meeting.mp3')
    await concatenateChunks(chunks.rows, combinedPath)
    await execFileAsync(process.env.FFMPEG_BIN || 'ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', combinedPath,
      '-vn', '-codec:a', 'libmp3lame', '-q:a', '4', mp3Path,
    ], { timeout: Number(process.env.MEETING_FFMPEG_TIMEOUT_MS || 30 * 60 * 1000) })
    const stat = fs.statSync(mp3Path)
    if (!stat.size) throw new Error('병합된 음성 파일이 비어 있습니다.')
    const fileHash = sha256(fs.readFileSync(mp3Path))
    const post = await postForMeeting(meeting.post_id)
    const fileName = `${safeFilename(post?.title || '회의녹음')}_${stamp(new Date(meeting.created_at))}.mp3`
    const attachmentId = meeting.attachment_id || crypto.randomUUID()
    await db.query(
      `INSERT INTO attachments
       (id, filename, content_type, size, status, storage_path, uploader_id, channel_id, post_id, created_at)
       VALUES ($1,$2,'audio/mpeg',$3,'COMPLETED',$4,$5,$6,$7,NOW())
       ON CONFLICT (id) DO UPDATE SET filename=EXCLUDED.filename, content_type='audio/mpeg', size=EXCLUDED.size,
         status='COMPLETED', storage_path=EXCLUDED.storage_path, post_id=EXCLUDED.post_id`,
      [attachmentId, fileName, stat.size, relativeStoragePath(mp3Path), meeting.owner_id, meeting.channel_id, meeting.post_id],
    )
    await db.query(
      `UPDATE meeting_recordings SET status='completed', attachment_id=$2, download_file_name=$3,
       download_content_type='audio/mpeg', download_storage_path=$4, download_size=$5,
       download_sha256=$6, finished_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [meeting.id, attachmentId, fileName, relativeStoragePath(mp3Path), stat.size, fileHash],
    )

    // Attempt to enqueue STT job programmatically (best-effort)
    try {
      const sttModule = require('./stt')
      if (sttModule && typeof sttModule.createSttJob === 'function') {
        const sttRes = await sttModule.createSttJob({ postId: meeting.post_id, attachmentId, options: { diarization: true, diarizationRequired: false, language: 'ko', chunkContextOverlapSec: 3 }, user: req.user })
        if (sttRes && sttRes.jobId) {
          await db.query('UPDATE meeting_recordings SET stt_job_id=$2, updated_at=NOW() WHERE id=$1', [meeting.id, sttRes.jobId]).catch(() => {})
        }
      }
    } catch (e) {
      // Non-fatal: STT enqueue failed, client may still create job later
      console.error('STT enqueue failed for meeting', meeting.id, String(e?.message || e))
    }

    res.json({ meetingId: meeting.id, status: 'completed', attachmentId, downloadFileName: fileName, downloadSize: stat.size })
  } catch (err) {
    if (meeting?.id) {
      await db.query(
        "UPDATE meeting_recordings SET status='merge_failed', error_code='MERGE_FAILED', error_message=$2, updated_at=NOW() WHERE id=$1",
        [meeting.id, String(err?.message || err).slice(0, 1000)],
      ).catch(() => {})
    }
    next(err)
  }
})

router.patch('/:id/stt-job', requireAuth, async (req, res, next) => {
  try {
    const meeting = await loadAuthorizedMeeting(req, res)
    if (!meeting) return
    const jobId = String(req.body?.stt_job_id || req.body?.sttJobId || '')
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) return res.status(400).json({ error: 'STT 작업 ID가 잘못되었습니다.' })
    await db.query('UPDATE meeting_recordings SET stt_job_id=$2, updated_at=NOW() WHERE id=$1', [meeting.id, jobId])
    res.json({ success: true })
  } catch (err) { next(err) }
})

router.get('/:id/audio/download', requireAuth, async (req, res, next) => {
  try {
    const meeting = await loadAuthorizedMeeting(req, res)
    if (!meeting) return
    if (meeting.status !== 'completed' || !meeting.download_storage_path) return res.status(409).json({ error: '통합 음성 파일이 아직 준비되지 않았습니다.' })
    const filePath = resolveStoragePath(meeting.download_storage_path)
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: '통합 음성 파일을 찾을 수 없습니다.' })
    const stat = fs.statSync(filePath)
    const total = stat.size
    const range = req.headers.range
    // audit
    await db.query(
      "INSERT INTO meeting_download_audit (meeting_id, post_id, user_id, action) VALUES ($1,$2,$3,'download')",
      [meeting.id, meeting.post_id, req.user.id],
    ).catch(() => {})

    res.setHeader('Accept-Ranges', 'bytes')
    const filename = meeting.download_file_name || 'meeting.mp3'
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/)
      if (!m) return res.status(416).end()
      const start = m[1] === '' ? 0 : Math.max(0, Number(m[1]))
      const end = m[2] === '' ? total - 1 : Math.min(total - 1, Number(m[2]))
      if (start > end || start >= total) return res.status(416).end()
      res.status(206)
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`)
      res.setHeader('Content-Length', String(end - start + 1))
      res.setHeader('Content-Type', meeting.download_content_type || 'audio/mpeg')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      const stream = fs.createReadStream(filePath, { start, end })
      stream.on('error', (err) => { if (!res.headersSent) next(err) })
      stream.pipe(res)
      return
    }

    res.setHeader('Content-Length', String(total))
    res.setHeader('Content-Type', meeting.download_content_type || 'audio/mpeg')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    const stream = fs.createReadStream(filePath)
    stream.on('error', (err) => { if (!res.headersSent) next(err) })
    stream.pipe(res)
  } catch (err) { next(err) }
})

router.post('/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const meeting = await loadAuthorizedMeeting(req, res)
    if (!meeting) return
    if (meeting.status === 'completed') return res.status(409).json({ error: '완료된 회의 녹음은 취소할 수 없습니다.' })
    try { fs.rmSync(meetingDir(meeting.id), { recursive: true, force: true }) } catch (_) {}
    await db.query("UPDATE meeting_recordings SET status='canceled', updated_at=NOW() WHERE id=$1", [meeting.id])
    await db.query('DELETE FROM meeting_audio_chunks WHERE meeting_id=$1', [meeting.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
module.exports.ensureMeetingSchema = ensureMeetingSchema
module.exports.purgeMeetingRecordingsForPost = purgeMeetingRecordingsForPost
