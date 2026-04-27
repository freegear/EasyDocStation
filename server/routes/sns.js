const express = require('express')
const fs = require('fs')
const path = require('path')
const pool = require('../db')
const requireAuth = require('../middleware/auth')

const router = express.Router()
router.use(requireAuth)

// POST /api/sns/test-telegram
// 현재 로그인된 사용자의 telegram_id로 "Hi I'm EasyStation" 전송
router.post('/test-telegram', async (req, res) => {
  try {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: '인증 정보가 없습니다.' })

    const userResult = await pool.query('SELECT telegram_id FROM users WHERE id = $1', [userId])
    const telegramId = userResult.rows[0]?.telegram_id?.trim()
    if (!telegramId) {
      return res.status(400).json({ error: '텔레그램 ID가 설정되어 있지 않습니다.' })
    }

    const configPath = path.resolve(__dirname, '../../config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const botToken = config.sns?.telegram?.httpApiToken?.trim()
    if (!botToken) {
      return res.status(400).json({ error: '텔레그램 Bot API Token이 설정되어 있지 않습니다.' })
    }

    const tgRes = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: telegramId, text: "Hi I'm EasyStation" }),
      },
    )
    const tgData = await tgRes.json()
    if (!tgData.ok) {
      return res.status(502).json({ error: `텔레그램 전송 실패: ${tgData.description || '알 수 없는 오류'}` })
    }

    res.json({ ok: true })
  } catch (e) {
    console.error('[sns/test-telegram]', e)
    res.status(500).json({ error: e.message || '서버 오류' })
  }
})

module.exports = router
