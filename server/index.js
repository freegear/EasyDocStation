const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '.env'), override: true })
const express = require('express')
const cors = require('cors')
const util = require('util')

function pad2(n) {
  return String(n).padStart(2, '0')
}

function logTimestamp() {
  const d = new Date()
  const y = d.getFullYear()
  const m = pad2(d.getMonth() + 1)
  const day = pad2(d.getDate())
  const hh = pad2(d.getHours())
  const mm = pad2(d.getMinutes())
  const ss = pad2(d.getSeconds())
  return `${y}${m}${day}-${hh}:${mm}:${ss}`
}

function installBackendLogPrefix() {
  const methods = ['log', 'info', 'warn', 'error', 'debug']
  for (const method of methods) {
    const original = console[method]?.bind(console)
    if (!original) continue
    console[method] = (...args) => {
      const rendered = args.length > 0
        ? util.formatWithOptions({ colors: false, depth: null }, ...args)
        : ''
      original(`[${logTimestamp()}] ${rendered}`)
    }
  }
}

// NOTE:
// DGX run scripts already prepend timestamps ([BE] ...).
// To avoid duplicated timestamps in logs, internal backend timestamp prefixing
// is disabled by default and can be enabled only when explicitly requested.
if (String(process.env.BE_INTERNAL_TIMESTAMP || '0') === '1') {
  installBackendLogPrefix()
}

const authRouter = require('./routes/auth')
const usersRouter = require('./routes/users')
const channelsRouter = require('./routes/channels')
const adminRouter = require('./routes/admin')
const teamsRouter = require('./routes/teams')
const filesRouter = require('./routes/files')
const postsRouter = require('./routes/posts')
const imageRagRouter = require('./routes/imageRag')
const ragRouter    = require('./routes/rag')
const aiRouter = require('./routes/ai')
const questionsRouter = require('./routes/questions')
const sttRouter = require('./routes/stt')
const meetingsRouter = require('./routes/meetings')
const eventsRouter = require('./routes/events')
const expenseRouter = require('./routes/expense')
const tripRouter = require('./routes/trip')
const dmRouter = require('./routes/dm')
const snsRouter = require('./routes/sns')
const mailRouter = require('./routes/mail')
const mailAgenticRouter = require('./routes/mailAgentic')
const recentPostViewsRouter = require('./routes/recentPostViews')
const welcomeRecentUpdatesRouter = require('./routes/welcomeRecentUpdates')
const folderDatasetsRouter = require('./routes/folderDatasets')
const contactbookRouter = require('./routes/contactbook')
const { initCassandra } = require('./cassandra')
const { initRag } = require('./rag')
const { startImageRagWorker, stopImageRagWorker } = require('./image-rag')
const { startMailSyncScheduler, stopMailSyncScheduler } = require('./mail/scheduler')
const { startAgenticMailWorker } = require('./mail/agentic/worker')
const { loadUpdateHistory } = require('./updateHistory')

const app = express()
const PORT = process.env.PORT || 3001
const FRONTEND_PORT = Number(process.env.SERVE_FRONTEND_PORT || 0)

function normalizeAgenticAiConfig(ai = {}) {
  const language = ['ko', 'ja', 'en', 'zh'].includes(ai?.language) ? ai.language : 'ko'
  const groq = ai?.groq && typeof ai.groq === 'object' ? ai.groq : {}
  const deepseek = ai?.deepseek && typeof ai.deepseek === 'object' ? ai.deepseek : {}
  const meta = ai?.meta && typeof ai.meta === 'object' ? ai.meta : {}
  return {
    num_predict: Number.isFinite(Number(ai?.num_predict)) ? Number(ai.num_predict) : 4096,
    num_ctx: Number.isFinite(Number(ai?.num_ctx)) ? Number(ai.num_ctx) : 8192,
    history: Number.isFinite(Number(ai?.history)) ? Number(ai.history) : 6,
    language,
    provider: ['ollama', 'deepseek', 'meta', 'groq'].includes(String(ai?.provider || '').toLowerCase()) ? String(ai.provider).toLowerCase() : 'ollama',
    fallback_to_ollama: ai?.fallback_to_ollama !== false,
    deepseek: {
      enabled: Boolean(deepseek.enabled),
      api_key: typeof deepseek.api_key === 'string' ? deepseek.api_key : '',
      model: typeof deepseek.model === 'string' && deepseek.model.trim() ? deepseek.model.trim() : 'deepseek-v4-flash',
      base_url: typeof deepseek.base_url === 'string' && deepseek.base_url.trim() ? deepseek.base_url.trim() : 'https://api.deepseek.com',
      use_for_mail_summary: Boolean(deepseek.use_for_mail_summary),
    },
    meta: {
      enabled: Boolean(meta.enabled),
      api_key: typeof meta.api_key === 'string' ? meta.api_key : '',
      model: typeof meta.model === 'string' && meta.model.trim() ? meta.model.trim() : 'muse-spark-1.2',
      base_url: typeof meta.base_url === 'string' && meta.base_url.trim() ? meta.base_url.trim() : 'https://api.meta.ai/v1',
    },
    groq: {
      enabled: Boolean(groq.enabled),
      prefer_when_available: Boolean(groq.prefer_when_available),
      api_key: typeof groq.api_key === 'string' ? groq.api_key : '',
      model: typeof groq.model === 'string' && groq.model.trim() ? groq.model.trim() : 'llama-3.1-8b-instant',
      base_url: typeof groq.base_url === 'string' && groq.base_url.trim() ? groq.base_url.trim() : 'https://api.groq.com/openai/v1',
      use_for_mail_summary: Boolean(groq.use_for_mail_summary),
    },
  }
}

function normalizeAgenticAiOperationMode(mode) {
  return String(mode || '').toLowerCase() === 'local' ? 'local' : 'server'
}

function normalizeRagRetrievalConfig(retrieval = {}) {
  const searchTypeRaw = String(retrieval?.search_type || retrieval?.searchType || 'mmr').toLowerCase()
  const searchType = ['similarity', 'mmr', 'similarity_score_threshold'].includes(searchTypeRaw)
    ? searchTypeRaw
    : 'mmr'
  const k = Number.isFinite(Number(retrieval?.k)) ? Math.max(1, Math.min(20, Number(retrieval.k))) : 8
  const fetchK = Number.isFinite(Number(retrieval?.fetch_k ?? retrieval?.fetchK))
    ? Math.max(k, Math.min(80, Number(retrieval.fetch_k ?? retrieval.fetchK)))
    : Math.max(k, 24)
  const threshold = Number(retrieval?.score_threshold ?? retrieval?.scoreThreshold)
  const score_threshold = Number.isFinite(threshold) ? Math.max(0, Math.min(1, threshold)) : 0
  const mmrLambdaRaw = Number(retrieval?.mmr_lambda ?? retrieval?.mmrLambda)
  const mmr_lambda = Number.isFinite(mmrLambdaRaw) ? Math.max(0, Math.min(1, mmrLambdaRaw)) : 0.7
  const filter = retrieval?.filter && typeof retrieval.filter === 'object' ? retrieval.filter : {}
  return { search_type: searchType, k, fetch_k: fetchK, score_threshold, mmr_lambda, filter }
}

// Initialize Cassandra
initCassandra()

// Initialize RAG scheduler (config.json 의 rag 설정 반영)
initRag()
startImageRagWorker()

// Initialize Mail sync scheduler (10분 주기)
startMailSyncScheduler()
startAgenticMailWorker({
  intervalSec: Number(process.env.AGENTICAI_MAIL_WORKER_INTERVAL_SEC || 30),
})

app.use(cors({
  origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  credentials: true,
}))
app.use(express.json({ limit: '10mb' }))

app.use('/api/auth', authRouter)
app.use('/api/users', usersRouter)
app.use('/api/channels', channelsRouter)
app.use('/api/admin', adminRouter)
app.use('/api/teams', teamsRouter)
app.use('/api/files', imageRagRouter)
app.use('/api/files', filesRouter)
app.use('/api/posts', postsRouter)
app.use('/api/rag',    ragRouter)
app.use('/api/ai', aiRouter)
app.use('/api/questions', questionsRouter)
app.use('/api/ai/stt', sttRouter)
app.use('/api/meetings', meetingsRouter)
app.use('/api/events', eventsRouter)
app.use('/api/expense', expenseRouter)
app.use('/api/trip', tripRouter)
app.use('/api/dm', dmRouter)
app.use('/api/sns', snsRouter)
app.use('/api/mail', mailRouter)
app.use('/api/mail/agentic', mailAgenticRouter)
app.use('/api/recent-post-views', recentPostViewsRouter)
app.use('/api/welcome', welcomeRecentUpdatesRouter)
app.use('/api/folder-datasets', folderDatasetsRouter)
app.use('/api/contactbook', contactbookRouter)

app.get('/api/health', (_req, res) => res.json({ ok: true }))

// 공용 설정 API (관리자 설정값 조회용)
app.get('/api/config/version', (req, res) => {
  const updateHistory = loadUpdateHistory()
  res.setHeader('Cache-Control', 'no-store, max-age=0')
  res.json({ version: updateHistory.currentVersion, available: updateHistory.available })
})

app.get('/api/config/update-history', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0')
  res.json(loadUpdateHistory())
})

app.get('/api/config/display', (req, res) => {
  try {
    const fs = require('fs')
    const path = require('path')
    const configPath = path.resolve(__dirname, '../config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const contentFontScale = Math.min(130, Math.max(90, Number(config.contentFontScale) || 100))
    res.json({
      imagePreview:  config.imagePreview  || { width: 512, height: 512 },
      pdfPreview:    config.pdfPreview    || { width: 480, height: 270 },
      txtPreview:    config.txtPreview    || { width: 270, height: 480 },
      pptPreview:    config.pptPreview    || { width: 480, height: 270 },
      pptxPreview:   config.pptxPreview   || { width: 480, height: 270 },
      excelPreview:  config.excelPreview  || { width: 480, height: 270 },
      wordPreview:   config.wordPreview   || { width: 270, height: 480 },
      moviePreview:  config.moviePreview  || { width: 480, height: 270 },
      htmlPreview:   config.htmlPreview   || { width: 480, height: 270 },
      contentFontScale,
    })
  } catch (e) {
    res.json({
      pdfPreview: { width: 480, height: 270 },
      moviePreview: { width: 480, height: 270 },
      txtPreview: { width: 270, height: 480 },
      contentFontScale: 100,
    })
  }
})

app.get('/api/config/agenticai', (req, res) => {
  try {
    const fs = require('fs')
    const path = require('path')
    const configPath = path.resolve(__dirname, '../config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const ai = normalizeAgenticAiConfig(config.agenticai || {})
    if (ai.groq) ai.groq.api_key = ''
    if (ai.deepseek) ai.deepseek.api_key = ''
    if (ai.meta) ai.meta.api_key = ''
    res.json({
      ...ai,
      operation_mode: normalizeAgenticAiOperationMode(config.agenticai_operation_mode),
    })
  } catch (e) {
    res.json({
      num_predict: 4096,
      num_ctx: 8192,
      history: 6,
      language: 'ko',
      operation_mode: 'server',
      groq: {
        enabled: false,
        prefer_when_available: false,
        api_key: '',
        model: 'llama-3.1-8b-instant',
        base_url: 'https://api.groq.com/openai/v1',
        use_for_mail_summary: false,
      },
    })
  }
})

app.get('/api/config/rag-retrieval', (req, res) => {
  try {
    const fs = require('fs')
    const path = require('path')
    const configPath = path.resolve(__dirname, '../config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const retrieval = normalizeRagRetrievalConfig(config?.rag?.retrieval || {})
    res.json(retrieval)
  } catch (e) {
    res.json(normalizeRagRetrievalConfig({}))
  }
})

app.get('/api/config/limits', (req, res) => {
  try {
    const fs = require('fs')
    const path = require('path')
    const configPath = path.resolve(__dirname, '../config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    res.json({ maxAttachmentFileSize: config.MaxAttachmentFileSize ?? 100 })
  } catch (e) {
    res.json({ maxAttachmentFileSize: 100 })
  }
})

app.get('/api/config/company', (req, res) => {
  try {
    const fs = require('fs')
    const path = require('path')
    const configPath = path.resolve(__dirname, '../config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    res.json(config.company || {})
  } catch (e) {
    res.json({})
  }
})

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API 경로를 찾을 수 없습니다.' })
})

if (process.env.NODE_ENV === 'production' || String(process.env.SERVE_FRONTEND_DIST || '0') === '1') {
  const distDir = path.resolve(__dirname, '../dist')
  const fs = require('fs')
  const indexPath = path.join(distDir, 'index.html')

  if (!fs.existsSync(indexPath)) {
    console.error(`[Frontend] 프로덕션 빌드를 찾을 수 없습니다: ${indexPath}`)
  } else {
    app.use(express.static(distDir, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        } else if (path.basename(filePath) === 'sw.js') {
          res.setHeader('Cache-Control', 'no-cache')
        }
      },
    }))
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache')
      res.sendFile(indexPath)
    })
    console.log(`[Frontend] 프로덕션 빌드 서비스: ${distDir}`)
  }
}

app.use((err, req, res, next) => {
  console.error(err)
  const errorName = String(err?.name || '')
  const errorMessage = String(err?.message || '')
  if (
    errorName === 'NoHostAvailableError'
    || /NoHostAvailableError|All host\(s\) tried for query failed/i.test(errorMessage)
  ) {
    return res.status(503).json({
      error: 'Cassandra 연결이 필요합니다.',
      code: 'CASSANDRA_UNAVAILABLE',
      detail: 'NoHostAvailableError: All host(s) tried for query failed',
    })
  }
  res.status(500).json({ error: '서버 오류가 발생했습니다.' })
})

const server = app.listen(PORT, () => {
  console.log(`✅ EasyDocStation server running on http://localhost:${PORT}`)

  const hfToken = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || ''
  if (!hfToken) {
    console.warn(`⚠️  [CONFIG] HF_TOKEN 미설정 — pyannote 다이어리제이션 비활성화됩니다. server/.env 에 HF_TOKEN을 추가하세요.`)
  } else {
    const masked = hfToken.slice(0, 4) + '****' + hfToken.slice(-4)
    console.log(`✅ [CONFIG] HF_TOKEN 확인됨 (${masked}, 길이 ${hfToken.length})`)
  }

  // GPU 브로커 워커 시작 (MDfiles/GpuScheduling.md 4단계).
  // broker_enabled + queue_enabled 일 때만 실제 동작하는 opt-in 구조.
  try {
    const { startBroker } = require('./gpu/broker')
    const r = startBroker()
    if (r.started && !r.already) console.log('[GPU Broker] 활성화됨')
  } catch (e) {
    console.warn('[GPU Broker] 시작 실패(무시하고 계속):', e.message)
  }
})

const frontendServer = FRONTEND_PORT && FRONTEND_PORT !== Number(PORT)
  ? app.listen(FRONTEND_PORT, () => {
    console.log(`✅ EasyDocStation production frontend running on http://localhost:${FRONTEND_PORT}`)
  })
  : null

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ 포트 ${PORT} 이미 사용 중입니다. run 스크립트에서 선정리 후 다시 실행하세요.`)
    process.exit(1)
  } else {
    throw err
  }
})

frontendServer?.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ 프론트엔드 포트 ${FRONTEND_PORT} 이미 사용 중입니다.`)
    process.exit(1)
  }
  throw err
})

function shutdown() {
  stopImageRagWorker()
  stopMailSyncScheduler()
  frontendServer?.close()
  server.close(() => process.exit(0))
}

process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
