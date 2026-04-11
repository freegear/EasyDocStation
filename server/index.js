require('dotenv').config()
const express = require('express')
const cors = require('cors')

const authRouter = require('./routes/auth')
const usersRouter = require('./routes/users')
const channelsRouter = require('./routes/channels')

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({
  origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  credentials: true,
}))
app.use(express.json())

app.use('/api/auth', authRouter)
app.use('/api/users', usersRouter)
app.use('/api/channels', channelsRouter)

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
