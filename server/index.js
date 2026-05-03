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
const ragRouter    = require('./routes/rag')
const aiRouter = require('./routes/ai')
const sttRouter = require('./routes/stt')
const eventsRouter = require('./routes/events')
const expenseRouter = require('./routes/expense')
const tripRouter = require('./routes/trip')
const dmRouter = require('./routes/dm')
const snsRouter = require('./routes/sns')
const { initCassandra } = require('./cassandra')
const { initRag } = require('./rag')

const app = express()
const PORT = process.env.PORT || 3001

function normalizeAgenticAiConfig(ai = {}) {
  const language = ['ko', 'ja', 'en', 'zh'].includes(ai?.language) ? ai.language : 'ko'
  return {
    num_predict: Number.isFinite(Number(ai?.num_predict)) ? Number(ai.num_predict) : 4096,
    num_ctx: Number.isFinite(Number(ai?.num_ctx)) ? Number(ai.num_ctx) : 8192,
    history: Number.isFinite(Number(ai?.history)) ? Number(ai.history) : 6,
    language,
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
app.use('/api/files', filesRouter)
app.use('/api/posts', postsRouter)
app.use('/api/rag',    ragRouter)
app.use('/api/ai', aiRouter)
app.use('/api/ai/stt', sttRouter)
app.use('/api/events', eventsRouter)
app.use('/api/expense', expenseRouter)
app.use('/api/trip', tripRouter)
app.use('/api/dm', dmRouter)
app.use('/api/sns', snsRouter)

// 공용 설정 API (관리자 설정값 조회용)
app.get('/api/config/version', (req, res) => {
  try {
    const fs = require('fs')
    const path = require('path')
    const configPath = path.resolve(__dirname, '../config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    res.json({ version: config['EasyDocStation Version'] || '0.0.1' })
  } catch (e) {
    res.json({ version: '0.0.1' })
  }
})

app.get('/api/config/display', (req, res) => {
  try {
    const fs = require('fs')
    const path = require('path')
    const configPath = path.resolve(__dirname, '../config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
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
    })
  } catch (e) {
    res.json({
      pdfPreview: { width: 480, height: 270 },
      moviePreview: { width: 480, height: 270 },
      txtPreview: { width: 270, height: 480 },
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
    res.json({
      ...ai,
      operation_mode: normalizeAgenticAiOperationMode(config.agenticai_operation_mode),
    })
  } catch (e) {
    res.json({ num_predict: 4096, num_ctx: 8192, history: 6, language: 'ko', operation_mode: 'server' })
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

app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: '서버 오류가 발생했습니다.' })
})

const server = app.listen(PORT, () => {
  console.log(`✅ EasyDocStation server running on http://localhost:${PORT}`)
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ 포트 ${PORT} 이미 사용 중입니다. run 스크립트에서 선정리 후 다시 실행하세요.`)
    process.exit(1)
  } else {
    throw err
  }
})
