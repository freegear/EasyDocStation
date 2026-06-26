const express = require('express')
const requireAuth = require('../middleware/auth')
const HandleUserQuestionUseCase = require('../application/usecase/HandleUserQuestionUseCase')

const router = express.Router()
const handleUserQuestion = new HandleUserQuestionUseCase()

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const question = String(req.body?.question || '').trim()
    const channelId = String(req.body?.channelId || req.body?.channel_id || '').trim()
    const model = req.body?.model ? String(req.body.model).trim() : ''

    if (!question) return res.status(400).json({ error: 'question is required' })
    if (!channelId) return res.status(400).json({ error: 'channelId is required' })

    const result = await handleUserQuestion.execute({
      question,
      channelId,
      model,
      user: req.user,
    })

    if (!result.ok) {
      const statusCode = result.errors?.some((msg) => /권한/.test(msg)) ? 403 : 400
      return res.status(statusCode).json(result)
    }

    res.json(result)
  } catch (err) {
    next(err)
  }
})

module.exports = router
