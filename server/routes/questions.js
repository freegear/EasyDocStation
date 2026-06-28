const express = require('express')
const requireAuth = require('../middleware/auth')
const HandleUserQuestionUseCase = require('../application/usecase/HandleUserQuestionUseCase')
const db = require('../db')

const router = express.Router()
const handleUserQuestion = new HandleUserQuestionUseCase()

async function canEditSearchResults(user = {}) {
  if (user?.role === 'site_admin') return true
  const userId = Number.parseInt(user?.id, 10)
  if (!Number.isFinite(userId)) return false
  const result = await db.query(
    'SELECT can_edit_search_results FROM users WHERE id = $1 LIMIT 1',
    [userId],
  )
  return Boolean(result.rows?.[0]?.can_edit_search_results)
}

router.post('/exclusions', requireAuth, async (req, res, next) => {
  try {
    if (!await canEditSearchResults(req.user)) {
      return res.status(403).json({ ok: false, error: '검색 결과 편집 권한이 필요합니다.' })
    }
    const exclusion = await handleUserQuestion.postRepository.addLocateExclusion(req.body || {}, req.user)
    res.json({ ok: true, exclusion })
  } catch (err) {
    const message = String(err?.message || '')
    if (/required/.test(message)) return res.status(400).json({ ok: false, error: message })
    next(err)
  }
})

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
