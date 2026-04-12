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
