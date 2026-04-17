const express = require('express')
const http = require('http')
const requireAuth = require('../middleware/auth')

const router = express.Router()

const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1'
const OLLAMA_PORT = Number(process.env.OLLAMA_PORT || 11434)

router.post('/chat', requireAuth, (req, res) => {
  const payload = JSON.stringify(req.body || {})

  const upstream = http.request({
    hostname: OLLAMA_HOST,
    port: OLLAMA_PORT,
    path: '/api/chat',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Accept': 'application/x-ndjson, application/json',
    },
    timeout: 120000,
  }, (upRes) => {
    res.status(upRes.statusCode || 502)
    res.setHeader('Content-Type', upRes.headers['content-type'] || 'application/x-ndjson; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('X-Accel-Buffering', 'no')
    upRes.pipe(res)
  })

  upstream.on('timeout', () => {
    upstream.destroy(new Error('OLLAMA_TIMEOUT'))
  })

  upstream.on('error', (err) => {
    if (res.headersSent) return
    if (err.code === 'ECONNREFUSED' || err.message === 'OLLAMA_TIMEOUT') {
      return res.status(503).json({
        error: `Ollama 서버 연결 실패 (${OLLAMA_HOST}:${OLLAMA_PORT}). ollama serve 상태를 확인하세요.`,
      })
    }
    return res.status(500).json({ error: `AI 프록시 오류: ${err.message}` })
  })

  upstream.write(payload)
  upstream.end()
})

module.exports = router

