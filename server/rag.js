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

// ─── 문서 첨부파일 경로 조회 (PDF + Word) ────────────────────
async function getDocumentPathsForPost(postId) {
  try {
    const cfg         = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const storageBase = cfg['ObjectFile Path'] || path.resolve(__dirname, '../uploads')
    const result = await db.query(
      `SELECT id, storage_path, content_type FROM attachments
       WHERE post_id = $1 AND status = 'COMPLETED'
         AND content_type IN (
           'application/pdf',
           'application/msword',
           'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
         )`,
      [postId]
    )
    const pdfs  = []
    const words = []
    for (const r of result.rows) {
      const item = { id: r.id, path: path.join(storageBase, r.storage_path) }
      if (r.content_type === 'application/pdf') pdfs.push(item)
      else words.push(item)
    }
    return { pdfs, words }
  } catch (e) {
    console.error('[RAG] 문서 경로 조회 실패:', e.message)
    return { pdfs: [], words: [] }
  }
}

// ─── Python 학습 스크립트 호출 ────────────────────────────────
function callPythonTrainer(payload) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve(__dirname, 'rag_train.py')
    const proc = spawn('python3', [scriptPath], { timeout: 600000 })

    proc.stdin.write(JSON.stringify(payload))
    proc.stdin.end()

    proc.stdout.on('data', d => process.stdout.write(d))
    proc.stderr.on('data', d => process.stderr.write(d))

    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`rag_train.py 종료 코드: ${code}`))
    })
    proc.on('error', reject)
  })
}

// ─── 실제 학습 로직 ───────────────────────────────────────────
async function runTraining(posts) {
  if (posts.length === 0) {
    console.log('[RAG] 학습할 게시글이 없습니다.')
    return
  }

  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  const ragCfg = cfg.rag || {}

  // 각 게시글의 PDF + Word 첨부파일 경로를 함께 전달
  const postsWithPdfs = await Promise.all(
    posts.map(async post => {
      const { pdfs, words } = await getDocumentPathsForPost(post.id)
      return {
        id:         post.id,
        channel_id: post.channel_id || '',
        content:    post.content || '',
        source:     'post',
        pdfs,
        words,
      }
    })
  )

  const payload = {
    config: {
      lancedb_path:  cfg['lancedb Database Path'] || '/Users/kevinim/Desktop/EasyDocStation/Database/LanceDB',
      chunk_size:    ragCfg.chunk_size    ?? 800,
      chunk_overlap: ragCfg.chunk_overlap ?? 100,
      vector_size:   ragCfg.vectorSize    ?? 1024,
    },
    posts: postsWithPdfs,
  }

  console.log(`[RAG] 학습 시작 — ${posts.length}개 게시글`)
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
  } catch (e) {
    console.error('[RAG] 게시글 임베딩 오류:', e.message)
  }
}

// ─── 댓글 학습 (Python에 comments 배열 전달) ─────────────────
async function runCommentTraining(comments) {
  if (comments.length === 0) {
    console.log('[RAG] 학습할 댓글이 없습니다.')
    return
  }

  const cfg    = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  const ragCfg = cfg.rag || {}

  const payload = {
    config: {
      lancedb_path:  cfg['lancedb Database Path'] || '/Users/kevinim/Desktop/EasyDocStation/Database/LanceDB',
      chunk_size:    ragCfg.chunk_size    ?? 800,
      chunk_overlap: ragCfg.chunk_overlap ?? 100,
      vector_size:   ragCfg.vectorSize    ?? 1024,
    },
    posts:    [],
    comments: comments.map(c => ({
      id:         c.id,
      post_id:    c.post_id,
      channel_id: c.channel_id || '',
      content:    c.content || '',
    })),
  }

  console.log(`[RAG] 댓글 학습 시작 — ${comments.length}개 댓글`)
  await callPythonTrainer(payload)
  console.log('[RAG] 댓글 학습 완료')
}

// ─── 댓글 1건 즉시 임베딩 (업로드 시 항상 실행) ─────────────
async function trainCommentImmediate(comment) {
  try {
    await runCommentTraining([comment])
    state.lastTrained = new Date()
  } catch (e) {
    console.error('[RAG] 댓글 임베딩 오류:', e.message)
  }
}

// ─── 댓글 조회 (Cassandra, 시간 범위 필터) ───────────────────
async function queryComments(since, until) {
  if (!isConnected()) return []

  let cql, params
  if (since && until) {
    cql    = 'SELECT id, post_id, author_id, content, created_at FROM comments WHERE created_at >= ? AND created_at <= ? ALLOW FILTERING'
    params = [since, until]
  } else if (since) {
    cql    = 'SELECT id, post_id, author_id, content, created_at FROM comments WHERE created_at > ? ALLOW FILTERING'
    params = [since]
  } else {
    cql    = 'SELECT id, post_id, author_id, content, created_at FROM comments ALLOW FILTERING'
    params = []
  }
  const result = await client.execute(cql, params, { prepare: true })
  return result.rows.map(r => ({
    id:         r.id,
    post_id:    r.post_id ? r.post_id.toString() : '',
    channel_id: '',   // Cassandra comments 테이블에 channel_id 없음, RAG에서 빈값 허용
    author_id:  r.author_id,
    content:    r.content,
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

  console.log(`[RAG] 초기화 — 학습 방식: ${state.trainingType}${state.trainingType === 'daily' ? ` (매일 ${state.dailyTime})` : ''}`)

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
  trainCommentImmediate,
  runManualTraining,
  getState: () => ({ ...state, timer: undefined }),
}
