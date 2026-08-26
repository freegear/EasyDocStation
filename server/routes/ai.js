const express = require('express')
const requireAuth = require('../middleware/auth')
const { requestChatCompletion } = require('../llmClient')

const router = express.Router()

function safeLogValue(value, fallback = '-') {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, 120) : fallback
}

router.post('/chat', requireAuth, async (req, res) => {
  const startedAt = Date.now()
  try {
    const result = await requestChatCompletion({ ...(req.body || {}), stream: false })
    console.log(
      `[AI] chat complete provider=${safeLogValue(result.provider)}`
      + ` model=${safeLogValue(result.model)}`
      + ` fallback=${result.fallback ? 'yes' : 'no'}`
      + ` fallback_from=${safeLogValue(result.fallbackFrom)}`
      + ` duration_ms=${Date.now() - startedAt}`,
    )
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.end(JSON.stringify({
      model: result.model,
      provider: result.provider,
      message: { role: 'assistant', content: result.content },
      done: true,
    }) + '\n')
  } catch (err) {
    console.error(
      `[AI] chat failed error=${safeLogValue(err?.name, 'Error')}`
      + ` duration_ms=${Date.now() - startedAt}`,
    )
    res.status(502).json({ error: `AI/LLM 호출 실패: ${err.message}` })
  }
})

module.exports = router
