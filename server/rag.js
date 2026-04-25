/**
 * RAG (Retrieval-Augmented Generation) 학습 스케줄러
 *
 * trainingType:
 *   'daily'     — 매일 설정된 시각에 전날 게시글 일괄 학습
 *   'immediate' — 게시글 등록 즉시 학습
 *   'manual'    — 관리자가 버튼을 누를 때만 학습
 */

const fs                    = require('fs')
const path                  = require('path')
const { spawn }             = require('child_process')
const db                    = require('./db')
const { client, isConnected } = require('./cassandra')
const { getDatabasePath }   = require('./databasePaths')
const { getPythonExecutable } = require('./pythonRuntime')

const CONFIG_PATH = path.resolve(__dirname, '../config.json')

// ─── 현재 상태 ────────────────────────────────────────────────
const state = {
  trainingType : 'manual',
  dailyTime    : '02:00',
  isTraining   : false,
  lastTrained  : null,
  timer        : null,
}

// ─── config.json 에서 RAG 설정 읽기 ──────────────────────────
function loadRagConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
    const cfg = JSON.parse(raw)
    return cfg.rag || { trainingType: 'manual', dailyTime: '02:00' }
  } catch (e) {
    console.error('[RAG] config.json 읽기 실패:', e.message)
    return { trainingType: 'manual', dailyTime: '02:00' }
  }
}

function normalizeTrainerTimeoutMs(ragCfg = {}) {
  const sec = Number(ragCfg.trainer_timeout_sec)
  const safeSec = Number.isFinite(sec) && sec > 0 ? sec : 1800
  return Math.max(60, Math.floor(safeSec)) * 1000
}

function buildTrainerConfig(cfg, ragCfg) {
  return {
    lancedb_path: getDatabasePath(cfg, 'lancedb Database Path'),
    file_training_path: path.resolve(__dirname, '../Database/ObjectFile/FileTrainingData'),
    chunk_size: ragCfg.chunk_size ?? 800,
    chunk_overlap: ragCfg.chunk_overlap ?? 100,
    vector_size: ragCfg.vectorSize ?? 1024,
    trainer_timeout_sec: ragCfg.trainer_timeout_sec ?? 1800,
    pdf_parse_strategy: ragCfg.pdf_parse_strategy ?? 'auto',
    pdf_parse_timeout_sec: ragCfg.pdf_parse_timeout_sec ?? 180,
  }
}

function normalizePdfParseStrategy(ragCfg = {}) {
  const raw = String(ragCfg.pdf_parse_strategy ?? 'auto').trim().toLowerCase()
  if (['auto', 'fast', 'hi-res'].includes(raw)) return raw
  return 'auto'
}

const DOC_CONTENT_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
]
const IMAGE_CONTENT_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/heic',
  'image/heif',
]
const IMAGE_FILE_EXT_RE = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif)$/i

function isTxtAttachment(row = {}) {
  const ct = String(row.content_type || '').toLowerCase()
  const filename = String(row.filename || '').toLowerCase()
  return ct === 'text/plain' || filename.endsWith('.txt')
}

function isImageAttachment(row = {}) {
  const ct = String(row.content_type || '').toLowerCase()
  const filename = String(row.filename || '')
  if (IMAGE_CONTENT_TYPES.includes(ct)) return true
  return IMAGE_FILE_EXT_RE.test(filename)
}

// ─── 문서 첨부파일 경로 조회 (PDF + Word + TXT) ───────────────
async function getDocumentPathsForPost(postId) {
  try {
    const cfg         = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const storageBase = getDatabasePath(cfg, 'ObjectFile Path')
    const result = await db.query(
      `SELECT id, storage_path, content_type, filename FROM attachments
       WHERE post_id = $1 AND status = 'COMPLETED'`,
      [postId]
    )
    const pdfs  = []
    const words = []
    const txts = []
    const images = []
    for (const r of result.rows) {
      const item = { id: r.id, path: path.join(storageBase, r.storage_path), file_name: r.filename || '' }
      if (r.content_type === 'application/pdf') pdfs.push(item)
      else if (isTxtAttachment(r)) txts.push(item)
      else if (isImageAttachment(r)) images.push(item)
      else words.push(item)
    }
    return { pdfs, words, txts, images }
  } catch (e) {
    console.error('[RAG] 문서 경로 조회 실패:', e.message)
    return { pdfs: [], words: [], txts: [], images: [] }
  }
}

// ─── Python 학습 스크립트 호출 ────────────────────────────────
function callPythonTrainer(payload, options = {}) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve(__dirname, 'rag_train.py')
    const startedAt = Date.now()
    const timeoutMs = options.timeoutMs || normalizeTrainerTimeoutMs(payload?.config || {})
    const proc = spawn(getPythonExecutable(), [scriptPath], { timeout: timeoutMs })

    proc.stdin.on('error', () => {})
    proc.stdin.write(JSON.stringify(payload))
    proc.stdin.end()

    proc.stdout.on('data', d => process.stdout.write(d))
    proc.stderr.on('data', d => process.stderr.write(d))

    proc.on('close', (code, signal) => {
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`rag_train.py 종료 코드: ${code} (signal=${signal || 'none'}, ${elapsedSec}s)`))
      }
    })
    proc.on('error', reject)
  })
}

// ─── 학습 제외 조건: 첨부 없고 100자 미만 ────────────────────
const RAG_MIN_CONTENT_LENGTH = 100

function shouldSkipTraining(content, pdfs, words, txts = [], images = []) {
  return pdfs.length === 0 && words.length === 0 && txts.length === 0 && images.length === 0 && (content || '').length < RAG_MIN_CONTENT_LENGTH
}

// ─── 실제 학습 로직 ───────────────────────────────────────────
async function runTraining(posts, options = {}) {
  if (posts.length === 0) {
    console.log('[RAG] 학습할 게시글이 없습니다.')
    return
  }

  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  const ragCfg = cfg.rag || {}

  // 각 게시글의 PDF + Word + TXT 첨부파일 경로를 함께 전달
  const postsWithPdfs = (await Promise.all(
    posts.map(async post => {
      const { pdfs, words, txts, images } = await getDocumentPathsForPost(post.id)
      return {
        id:         post.id,
        channel_id: post.channel_id || '',
        content:    post.content || '',
        source:     'post',
        pdfs,
        words,
        txts,
        images,
      }
    })
  )).filter(p => {
    if (shouldSkipTraining(p.content, p.pdfs, p.words, p.txts, p.images)) {
      console.log(`[RAG] 학습 제외 (게시글): ${p.id} — 첨부파일 없음, ${(p.content || '').length}자`)
      return false
    }
    return true
  })

  if (postsWithPdfs.length === 0) {
    console.log('[RAG] 학습 제외 후 학습할 게시글이 없습니다.')
    return
  }

  const payload = {
    config: buildTrainerConfig(cfg, ragCfg),
    posts: postsWithPdfs,
  }
  if (Array.isArray(options.deletePostIds) && options.deletePostIds.length > 0) {
    payload.delete_post_ids = options.deletePostIds
  }

  console.log(`[RAG] 학습 시작 — ${postsWithPdfs.length}개 게시글 (제외: ${posts.length - postsWithPdfs.length}개)`)
  await callPythonTrainer(payload)
  console.log('[RAG] 학습 완료')
}

// ─── 게시글 조회 (Cassandra / PostgreSQL 통합) ───────────────
// since: Date|null, until: Date|null
async function queryPosts(since, until) {
  if (isConnected()) {
    // Cassandra: ALLOW FILTERING으로 시간 범위 조회
    let cql, params
    if (since && until) {
      cql    = 'SELECT id, channel_id, author_id, content, authored_at FROM posts WHERE authored_at >= ? AND authored_at < ? ALLOW FILTERING'
      params = [since, until]
    } else if (since) {
      cql    = 'SELECT id, channel_id, author_id, content, authored_at FROM posts WHERE authored_at > ? ALLOW FILTERING'
      params = [since]
    } else {
      cql    = 'SELECT id, channel_id, author_id, content, authored_at FROM posts ALLOW FILTERING'
      params = []
    }
    const result = await client.execute(cql, params, { prepare: true })
    return result.rows.map(r => ({
      id:         r.id.toString(),
      channel_id: r.channel_id,
      author_id:  r.author_id,
      content:    r.content,
      created_at: r.authored_at,
    }))
  } else {
    // PostgreSQL 경로
    let sql, params
    if (since && until) {
      sql    = 'SELECT id, channel_id, author_id, content, created_at FROM posts WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at ASC'
      params = [since, until]
    } else if (since) {
      sql    = 'SELECT id, channel_id, author_id, content, created_at FROM posts WHERE created_at > $1 ORDER BY created_at ASC'
      params = [since]
    } else {
      sql    = 'SELECT id, channel_id, author_id, content, created_at FROM posts ORDER BY created_at ASC'
      params = []
    }
    const result = await db.query(sql, params)
    return result.rows
  }
}

// ─── 전날(자정~자정) 게시글 학습 (daily 모드) ─────────────────
async function runDailyTraining() {
  if (state.isTraining) {
    console.log('[RAG] 이미 학습 중입니다.')
    return
  }
  state.isTraining = true
  try {
    // 오늘 자정과 어제 자정 계산 → 전날 게시글만 학습
    const todayMidnight = new Date()
    todayMidnight.setHours(0, 0, 0, 0)
    const yesterdayMidnight = new Date(todayMidnight)
    yesterdayMidnight.setDate(yesterdayMidnight.getDate() - 1)

    console.log(`[RAG] daily 학습 범위: ${yesterdayMidnight.toLocaleString('ko-KR')} ~ ${todayMidnight.toLocaleString('ko-KR')}`)
    const posts    = await queryPosts(yesterdayMidnight, todayMidnight)
    const comments = await queryComments(yesterdayMidnight, todayMidnight)
    await runTraining(posts)
    await runCommentTraining(comments)
    state.lastTrained = new Date()
  } catch (e) {
    console.error('[RAG] daily 학습 오류:', e.message)
  } finally {
    state.isTraining = false
  }
}

// ─── 게시글 1건 즉시 임베딩 (업로드 시 항상 실행) ────────────
async function trainPostImmediate(post) {
  try {
    await runTraining([post])
    state.lastTrained = new Date()
    return true
  } catch (e) {
    console.error('[RAG] 게시글 임베딩 오류:', e.message)
    return false
  }
}

// ─── 게시글 수정 시: 기존 삭제 후 재학습 ──────────────────────
async function retrainPostImmediate(post) {
  try {
    await runTraining([post], { deletePostIds: [post.id] })
    state.lastTrained = new Date()
    return true
  } catch (e) {
    console.error('[RAG] 게시글 재학습 오류:', e.message)
    return false
  }
}

// ─── 댓글 첨부파일 경로 조회 (attachment ID 목록으로 직접 조회) ─
async function getDocumentPathsByIds(attachmentIds) {
  if (!attachmentIds || attachmentIds.length === 0) return { pdfs: [], words: [], txts: [], images: [] }
  try {
    const cfg         = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const storageBase = getDatabasePath(cfg, 'ObjectFile Path')
    const placeholders = attachmentIds.map((_, i) => `$${i + 1}`).join(', ')
    const result = await db.query(
      `SELECT id, storage_path, content_type, filename FROM attachments
       WHERE id IN (${placeholders}) AND status = 'COMPLETED'`,
      [...attachmentIds]
    )
    const pdfs = [], words = [], txts = [], images = []
    for (const r of result.rows) {
      const item = { id: r.id, path: path.join(storageBase, r.storage_path), file_name: r.filename || '' }
      if (r.content_type === 'application/pdf') pdfs.push(item)
      else if (isTxtAttachment(r)) txts.push(item)
      else if (isImageAttachment(r)) images.push(item)
      else words.push(item)
    }
    return { pdfs, words, txts, images }
  } catch (e) {
    console.error('[RAG] 댓글 문서 경로 조회 실패:', e.message)
    return { pdfs: [], words: [], txts: [], images: [] }
  }
}

// ─── 댓글 학습 (Python에 comments 배열 전달) ─────────────────
async function runCommentTraining(comments, options = {}) {
  if (comments.length === 0) {
    console.log('[RAG] 학습할 댓글이 없습니다.')
    return
  }

  const cfg    = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  const ragCfg = cfg.rag || {}

  // 각 댓글의 PDF + Word + TXT 첨부파일 경로 조회
  const commentsWithDocs = (await Promise.all(
    comments.map(async c => {
      const { pdfs, words, txts, images } = await getDocumentPathsByIds(c.attachmentIds || [])
      return {
        id:            c.id,
        post_id:       c.post_id,
        channel_id:    c.channel_id || '',
        content:       c.content || '',
        pdfs,
        words,
        txts,
        images,
      }
    })
  )).filter(c => {
    if (shouldSkipTraining(c.content, c.pdfs, c.words, c.txts, c.images)) {
      console.log(`[RAG] 학습 제외 (댓글): ${c.id} — 첨부파일 없음, ${(c.content || '').length}자`)
      return false
    }
    return true
  })

  if (commentsWithDocs.length === 0) {
    console.log('[RAG] 학습 제외 후 학습할 댓글이 없습니다.')
    return
  }

  const payload = {
    config: buildTrainerConfig(cfg, ragCfg),
    posts:    [],
    comments: commentsWithDocs,
  }
  if (Array.isArray(options.deleteCommentIds) && options.deleteCommentIds.length > 0) {
    payload.delete_comment_ids = options.deleteCommentIds
  }

  const startedAt = Date.now()
  console.log(`[RAG] 댓글 학습 시작 — ${commentsWithDocs.length}개 댓글 (제외: ${comments.length - commentsWithDocs.length}개)`)
  try {
    await callPythonTrainer(payload)
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(`[RAG] 댓글 학습 완료 — ${comments.length}개 댓글 (${elapsedSec}s)`)
  } catch (e) {
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.error(`[RAG] 댓글 학습 실패 — ${comments.length}개 댓글 (${elapsedSec}s): ${e.message}`)
    throw e
  }
}

// ─── 댓글 1건 즉시 임베딩 (업로드 시 항상 실행) ─────────────
async function trainCommentImmediate(comment) {
  try {
    await runCommentTraining([comment])
    state.lastTrained = new Date()
    return true
  } catch (e) {
    console.error('[RAG] 댓글 임베딩 오류:', e.message)
    return false
  }
}

// ─── 댓글 수정 시: 기존 삭제 후 재학습 ────────────────────────
async function retrainCommentImmediate(comment) {
  try {
    await runCommentTraining([comment], { deleteCommentIds: [comment.id] })
    state.lastTrained = new Date()
    return true
  } catch (e) {
    console.error('[RAG] 댓글 재학습 오류:', e.message)
    return false
  }
}

// ─── dt 객체 → 한국어 날짜 문자열 변환 (allDay 플래그에 따라 시간 포함 여부 결정) ─
function dtToKorean(dt, includeTime = true) {
  if (!dt || typeof dt !== 'object') return ''
  const { year, month, day, ampm, hour, minute } = dt
  if (!year) return ''
  const dateStr = `${year}년 ${month}월 ${day}일`
  if (!includeTime) return dateStr
  const timeStr = (hour != null) ? ` ${ampm || ''} ${hour}시 ${String(minute || 0).padStart(2, '0')}분` : ''
  return `${dateStr}${timeStr}`
}

// ─── 캘린더 이벤트 기존 청크 삭제만 수행 ────────────────────
async function deleteEventFromRAG(eventId) {
  try {
    const cfg    = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const ragCfg = cfg.rag || {}
    const payload = {
      config: buildTrainerConfig(cfg, ragCfg),
      delete_ids: [eventId],
      posts: [],
    }
    await callPythonTrainer(payload)
  } catch (e) {
    console.error('[RAG] 캘린더 이벤트 삭제 오류:', e.message)
  }
}

// ─── 캘린더 이벤트 수정 시: 기존 삭제 후 재학습 ──────────────
async function retrainEventImmediate(oldEventId, newEvent) {
  try {
    const cfg    = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const ragCfg = cfg.rag || {}

    const allDay   = newEvent.allDay || newEvent.all_day || false
    const startDt  = typeof newEvent.startDt === 'string' ? JSON.parse(newEvent.startDt) : (newEvent.startDt || {})
    const endDt    = typeof newEvent.endDt   === 'string' ? JSON.parse(newEvent.endDt)   : (newEvent.endDt   || {})
    const startStr = dtToKorean(startDt, !allDay)
    const endStr   = dtToKorean(endDt,   !allDay)

    const invitees = (() => {
      try {
        const arr = typeof newEvent.invitees === 'string' ? JSON.parse(newEvent.invitees) : (newEvent.invitees || [])
        return arr.map(inv => inv.name || inv.id).join(', ')
      } catch { return '' }
    })()

    const lines = [
      `[캘린더 이벤트] ${newEvent.title || '(제목 없음)'}`,
      `유형: ${allDay ? '하루종일 이벤트' : '시간 지정 이벤트'}`,
      `시작: ${startStr}`,
      `종료: ${endStr}`,
    ]
    if (invitees) lines.push(`참석자: ${invitees}`)
    if (newEvent.memo) lines.push(`메모: ${newEvent.memo}`)
    if (newEvent.repeat && newEvent.repeat !== 'none') lines.push(`반복: ${newEvent.repeat}`)
    const content = lines.join('\n')

    const payload = {
      config: buildTrainerConfig(cfg, ragCfg),
      delete_ids: [oldEventId],   // 기존 청크 먼저 삭제
      posts: [{
        id:         newEvent.id,
        channel_id: 'calendar',
        content,
        source:     'calendar_event',
        pdfs:       [],
        words:      [],
      }],
    }

    console.log(`[RAG] 캘린더 이벤트 재학습 시작 — id=${newEvent.id} "${newEvent.title}"`)
    await callPythonTrainer(payload)
    state.lastTrained = new Date()
    console.log(`[RAG] 캘린더 이벤트 재학습 완료 — id=${newEvent.id}`)
  } catch (e) {
    console.error('[RAG] 캘린더 이벤트 재학습 오류:', e.message)
  }
}

// ─── 캘린더 이벤트 1건 즉시 RAG 학습 ─────────────────────────
async function trainEventImmediate(event) {
  try {
    const cfg    = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const ragCfg = cfg.rag || {}

    const allDay   = event.allDay || event.all_day || false
    const startDt  = typeof event.startDt === 'string' ? JSON.parse(event.startDt) : (event.startDt || {})
    const endDt    = typeof event.endDt   === 'string' ? JSON.parse(event.endDt)   : (event.endDt   || {})

    // allDay이면 날짜만, 시간 지정이면 날짜+시간 포함
    const startStr = dtToKorean(startDt, !allDay)
    const endStr   = dtToKorean(endDt,   !allDay)

    const invitees = (() => {
      try {
        const arr = typeof event.invitees === 'string' ? JSON.parse(event.invitees) : (event.invitees || [])
        return arr.map(inv => inv.name || inv.id).join(', ')
      } catch { return '' }
    })()

    const lines = [
      `[캘린더 이벤트] ${event.title || '(제목 없음)'}`,
      `유형: ${allDay ? '하루종일 이벤트' : '시간 지정 이벤트'}`,
      `시작: ${startStr}`,
      `종료: ${endStr}`,
    ]
    if (invitees) lines.push(`참석자: ${invitees}`)
    if (event.memo) lines.push(`메모: ${event.memo}`)
    if (event.repeat && event.repeat !== 'none') lines.push(`반복: ${event.repeat}`)
    const content = lines.join('\n')

    const payload = {
      config: buildTrainerConfig(cfg, ragCfg),
      posts: [{
        id:         event.id,
        channel_id: 'calendar',
        content,
        source:     'calendar_event',
        pdfs:       [],
        words:      [],
      }],
    }

    console.log(`[RAG] 캘린더 이벤트 학습 시작 — id=${event.id} "${event.title}"`)
    await callPythonTrainer(payload)
    state.lastTrained = new Date()
    console.log(`[RAG] 캘린더 이벤트 학습 완료 — id=${event.id}`)
  } catch (e) {
    console.error('[RAG] 캘린더 이벤트 임베딩 오류:', e.message)
  }
}

// ─── 캘린더 이벤트 여러 건 일괄 RAG 학습 (python 1회 호출) ──────
function buildEventPost(event) {
  const allDay  = event.allDay || event.all_day || false
  const startDt = typeof event.startDt === 'string' ? JSON.parse(event.startDt) : (event.startDt || {})
  const endDt   = typeof event.endDt   === 'string' ? JSON.parse(event.endDt)   : (event.endDt   || {})
  const startStr = dtToKorean(startDt, !allDay)
  const endStr   = dtToKorean(endDt,   !allDay)
  const invitees = (() => {
    try {
      const arr = typeof event.invitees === 'string' ? JSON.parse(event.invitees) : (event.invitees || [])
      return arr.map(inv => inv.name || inv.id).join(', ')
    } catch { return '' }
  })()
  const lines = [
    `[캘린더 이벤트] ${event.title || '(제목 없음)'}`,
    `유형: ${allDay ? '하루종일 이벤트' : '시간 지정 이벤트'}`,
    `시작: ${startStr}`,
    `종료: ${endStr}`,
  ]
  if (invitees) lines.push(`참석자: ${invitees}`)
  if (event.memo) lines.push(`메모: ${event.memo}`)
  if (event.repeat && event.repeat !== 'none') lines.push(`반복: ${event.repeat}`)
  return { id: event.id, channel_id: 'calendar', content: lines.join('\n'), source: 'calendar_event', pdfs: [], words: [] }
}

async function trainEventsImmediate(events) {
  if (!events || events.length === 0) return
  try {
    const cfg    = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const ragCfg = cfg.rag || {}
    const payload = {
      config: buildTrainerConfig(cfg, ragCfg),
      posts: events.map(buildEventPost),
    }
    console.log(`[RAG] 캘린더 이벤트 일괄 학습 시작 — ${events.length}건`)
    await callPythonTrainer(payload)
    state.lastTrained = new Date()
    console.log(`[RAG] 캘린더 이벤트 일괄 학습 완료 — ${events.length}건`)
  } catch (e) {
    console.error('[RAG] 캘린더 이벤트 일괄 학습 오류:', e.message)
  }
}

// ─── 지출결의서 RAG 텍스트 빌더 ──────────────────────────────
function buildExpenseContent(postId, formData) {
  const f = formData || {}
  const lines = [
    `[지출결의서] 문서번호: ${f.docNo || ''}`,
    `작성일: ${f.docDate || ''}`,
    `작성자: ${f.author || ''}`,
    `작성부서: ${f.department || ''}`,
    `지급일자: ${f.payDate || ''}`,
  ]
  if (Array.isArray(f.rows) && f.rows.length > 0) {
    lines.push('지출 내역:')
    f.rows.forEach((row, i) => {
      if (row.vendor || row.detail || row.amount) {
        lines.push(`  ${i + 1}. 거래처: ${row.vendor || ''}, 사용내역: ${row.detail || ''}, 금액: ${row.amount || ''}`)
      }
    })
  }
  if (f.vat != null)        lines.push(`부가세: ${f.vat}`)
  if (f.grandTotal != null) lines.push(`합계: ${f.grandTotal}`)
  if (f.reviewOpinion)      lines.push(`검토의견: ${f.reviewOpinion}`)
  return lines.join('\n')
}

// ─── 지출결의서 1건 즉시 RAG 학습 ────────────────────────────
async function trainExpenseImmediate(postId, formData) {
  try {
    const cfg    = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const ragCfg = cfg.rag || {}
    const content = buildExpenseContent(postId, formData)
    const payload = {
      config: buildTrainerConfig(cfg, ragCfg),
      posts: [{
        id:         postId,
        channel_id: 'expense',
        content,
        source:     'expense_report',
        pdfs:       [],
        words:      [],
        txts:       [],
      }],
    }
    console.log(`[RAG] 지출결의서 학습 시작 — id=${postId}`)
    await callPythonTrainer(payload)
    state.lastTrained = new Date()
    console.log(`[RAG] 지출결의서 학습 완료 — id=${postId}`)
  } catch (e) {
    console.error('[RAG] 지출결의서 학습 오류:', e.message)
  }
}

// ─── 지출결의서 수정 시: 기존 삭제 후 재학습 ─────────────────
async function retrainExpenseImmediate(postId, formData) {
  try {
    const cfg    = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const ragCfg = cfg.rag || {}
    const content = buildExpenseContent(postId, formData)
    const payload = {
      config: buildTrainerConfig(cfg, ragCfg),
      delete_ids: [postId],
      posts: [{
        id:         postId,
        channel_id: 'expense',
        content,
        source:     'expense_report',
        pdfs:       [],
        words:      [],
        txts:       [],
      }],
    }
    console.log(`[RAG] 지출결의서 재학습 시작 — id=${postId}`)
    await callPythonTrainer(payload)
    state.lastTrained = new Date()
    console.log(`[RAG] 지출결의서 재학습 완료 — id=${postId}`)
  } catch (e) {
    console.error('[RAG] 지출결의서 재학습 오류:', e.message)
  }
}

// ─── 댓글 조회 (Cassandra, 시간 범위 필터) ───────────────────
async function queryComments(since, until) {
  if (!isConnected()) return []

  let cql, params
  if (since && until) {
    cql    = 'SELECT id, post_id, author_id, content, attachments, created_at FROM comments WHERE created_at >= ? AND created_at <= ? ALLOW FILTERING'
    params = [since, until]
  } else if (since) {
    cql    = 'SELECT id, post_id, author_id, content, attachments, created_at FROM comments WHERE created_at > ? ALLOW FILTERING'
    params = [since]
  } else {
    cql    = 'SELECT id, post_id, author_id, content, attachments, created_at FROM comments ALLOW FILTERING'
    params = []
  }
  const result = await client.execute(cql, params, { prepare: true })
  return result.rows.map(r => ({
    id:         r.id,
    post_id:    r.post_id ? r.post_id.toString() : '',
    channel_id: '',   // Cassandra comments 테이블에 channel_id 없음, RAG에서 빈값 허용
    author_id:  r.author_id,
    content:    r.content,
    attachmentIds: Array.isArray(r.attachments) ? r.attachments.filter(Boolean) : [],
    created_at: r.created_at,
  }))
}

// ─── 마지막 학습 이후 게시글 학습 (manual 모드) ───────────────
async function runManualTraining() {
  if (state.isTraining) throw new Error('이미 학습 중입니다.')
  state.isTraining = true
  try {
    // lastTrained 이후 게시글만 학습; 최초에는 전체 학습
    const since = state.lastTrained || null
    if (since) {
      console.log(`[RAG] manual 학습 범위: ${since.toLocaleString('ko-KR')} 이후`)
    } else {
      console.log('[RAG] manual 학습 범위: 전체 게시글')
    }
    const posts    = await queryPosts(since, null)
    const comments = await queryComments(since, null)
    await runTraining(posts)
    await runCommentTraining(comments)
    state.lastTrained = new Date()
  } catch (e) {
    console.error('[RAG] manual 학습 오류:', e.message)
    throw e
  } finally {
    state.isTraining = false
  }
}

// ─── 매일 지정 시각 스케줄러 ─────────────────────────────────
function scheduleDailyAt(timeStr) {
  if (state.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }

  const [h, m] = timeStr.split(':').map(Number)

  function getNextMs() {
    const now  = new Date()
    const next = new Date()
    next.setHours(h, m, 0, 0)
    if (next <= now) next.setDate(next.getDate() + 1)
    return next - now
  }

  function scheduleNext() {
    const ms   = getNextMs()
    const fire = new Date(Date.now() + ms)
    console.log(`[RAG] 다음 일괄 학습 예약: ${fire.toLocaleString('ko-KR')}`)
    state.timer = setTimeout(async () => {
      await runDailyTraining()
      scheduleNext()            // 다음 날 재예약
    }, ms)
  }

  scheduleNext()
}

// ─── 초기화: 서버 시작 시 호출 ───────────────────────────────
function initRag() {
  const cfg = loadRagConfig()
  state.trainingType = cfg.trainingType || 'manual'
  state.dailyTime    = cfg.dailyTime    || '02:00'
  const pdfParseStrategy = normalizePdfParseStrategy(cfg)

  console.log(`[RAG] 초기화 — 학습 방식: ${state.trainingType}${state.trainingType === 'daily' ? ` (매일 ${state.dailyTime})` : ''}`)
  console.log(`[RAG] 초기화 — PDF 파싱 모드: ${pdfParseStrategy.toUpperCase()}`)

  if (state.trainingType === 'daily') {
    scheduleDailyAt(state.dailyTime)
  }
  // 'immediate' 는 posts.js 에서 trainPostImmediate() 호출로 동작
  // 'manual'    은 관리자 버튼 → POST /api/admin/rag/train 으로 동작
}

// ─── config 변경 후 재적용 (관리자 설정 저장 시 호출) ─────────
function reloadRagConfig() {
  // 기존 타이머 해제
  if (state.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }
  initRag()
}

module.exports = {
  initRag,
  reloadRagConfig,
  trainPostImmediate,
  retrainPostImmediate,
  trainCommentImmediate,
  retrainCommentImmediate,
  trainEventImmediate,
  trainEventsImmediate,
  retrainEventImmediate,
  deleteEventFromRAG,
  trainExpenseImmediate,
  retrainExpenseImmediate,
  runManualTraining,
  getState: () => ({ ...state, timer: undefined }),
}
