require('dotenv').config()
const express = require('express')
const cors = require('cors')

const authRouter = require('./routes/auth')
const usersRouter = require('./routes/users')
const channelsRouter = require('./routes/channels')
const adminRouter = require('./routes/admin')
const teamsRouter = require('./routes/teams')
const filesRouter = require('./routes/files')
const postsRouter = require('./routes/posts')
const ragRouter   = require('./routes/rag')
const { initCassandra } = require('./cassandra')
const { initRag } = require('./rag')

const app = express()
const PORT = process.env.PORT || 3001

// Initialize Cassandra
initCassandra()

// Initialize RAG scheduler (config.json 의 rag 설정 반영)
initRag()

app.use(cors({
  origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  credentials: true,
}))
app.use(express.json())

app.use('/api/auth', authRouter)
app.use('/api/users', usersRouter)
app.use('/api/channels', channelsRouter)
app.use('/api/admin', adminRouter)
app.use('/api/teams', teamsRouter)
app.use('/api/files', filesRouter)
app.use('/api/posts', postsRouter)
app.use('/api/rag',   ragRouter)

// 공용 설정 API (관리자 설정값 조회용)
app.get('/api/config/display', (req, res) => {
  try {
    const fs = require('fs')
    const path = require('path')
    const configPath = path.resolve(__dirname, '../config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    res.json({
      imagePreview:  config.imagePreview  || { width: 512, height: 512 },
      pptPreview:    config.pptPreview    || { width: 480, height: 270 },
      pptxPreview:   config.pptxPreview   || { width: 480, height: 270 },
      excelPreview:  config.excelPreview  || { width: 480, height: 270 },
      wordPreview:   config.wordPreview   || { width: 270, height: 480 },
      moviePreview:  config.moviePreview  || { width: 480, height: 270 },
    })
  } catch (e) {
    res.json({ moviePreview: { width: 480, height: 270 } })
  }
})

app.get('/api/config/agenticai', (req, res) => {
  try {
    const fs = require('fs')
    const path = require('path')
    const configPath = path.resolve(__dirname, '../config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    res.json(config.agenticai || { num_predict: 4096, num_ctx: 8192 })
  } catch (e) {
    res.json({ num_predict: 4096, num_ctx: 8192 })
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
    console.error(`❌ 포트 ${PORT} 이미 사용 중입니다.`)
    console.error(`   해결: lsof -ti :${PORT} | xargs kill -9`)
    process.exit(1)
  } else {
    throw err
  }
})
