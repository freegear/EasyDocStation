const express = require('express')
const fs = require('fs')
const path = require('path')
const pool = require('../db')
const requireAuth = require('../middleware/auth')

const router = express.Router()

const CONFIG_PATH = path.resolve(__dirname, '../../config.json')

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
}

async function telegramPost(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

// ── PUBLIC: Telegram Webhook (인증 불필요 — Telegram 서버가 호출)
// POST /api/sns/telegram/webhook
router.post('/telegram/webhook', express.json(), async (req, res) => {
  // 즉시 200 응답 (Telegram 재시도 방지)
  res.sendStatus(200)

  try {
    const update = req.body
    const msg = update?.message || update?.edited_message
    if (!msg) return

    const chatId = msg.chat?.id          // 숫자형 chat_id
    const fromUsername = msg.from?.username  // "@" 없는 username
    if (!chatId) return

    const config = readConfig()
    const botToken = config.sns?.telegram?.httpApiToken?.trim()
    if (!botToken) return

    // telegram_id 컬럼에서 @username 또는 username 으로 사용자 검색
    let userRow = null
    if (fromUsername) {
      const r = await pool.query(
        `SELECT id, name FROM users
         WHERE LOWER(REGEXP_REPLACE(telegram_id, '^@', '')) = LOWER($1)
           AND telegram_id !~ '^-?[0-9]+$'`,  // 이미 숫자 ID면 건너뜀
        [fromUsername],
      )
      userRow = r.rows[0] || null
    }

    if (userRow) {
      // numeric chat_id 저장
      await pool.query('UPDATE users SET telegram_id = $1 WHERE id = $2', [
        String(chatId),
        userRow.id,
      ])
      const displayName = userRow.name || fromUsername
      await telegramPost(botToken, 'sendMessage', {
        chat_id: chatId,
        text: `✅ ${displayName}님, EasyDocStation 텔레그램 알림이 연동되었습니다!`,
      })
    } else if (/^\/?start$/i.test(msg.text?.trim() || '')) {
      // 등록 안 된 사용자가 /start 를 보낸 경우 안내
      await telegramPost(botToken, 'sendMessage', {
        chat_id: chatId,
        text: '⚠️ EasyDocStation 계정에 이 텔레그램 계정(@' +
          (fromUsername || 'username') +
          ')이 등록되어 있지 않습니다.\n관리자 페이지에서 본인의 Telegram ID를 저장한 뒤 다시 시도해 주세요.',
      })
    }
  } catch (e) {
    console.error('[sns/telegram/webhook]', e)
  }
})

// ── AUTHENTICATED routes ────────────────────────────────────────
router.use(requireAuth)

// POST /api/sns/test-telegram
router.post('/test-telegram', async (req, res) => {
  try {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: '인증 정보가 없습니다.' })

    const userResult = await pool.query('SELECT telegram_id FROM users WHERE id = $1', [userId])
    const telegramId = userResult.rows[0]?.telegram_id?.trim()
    if (!telegramId) {
      return res.status(400).json({ error: '텔레그램 ID가 설정되어 있지 않습니다.' })
    }

    // @username 형식이면 아직 연동 전
    if (/^@/.test(telegramId) || !/^-?[0-9]+$/.test(telegramId)) {
      return res.status(400).json({
        error: '텔레그램 연동이 완료되지 않았습니다.',
        guide: '텔레그램 앱에서 봇에게 아무 메시지나 보내면 자동으로 연동됩니다.',
      })
    }

    const config = readConfig()
    const botToken = config.sns?.telegram?.httpApiToken?.trim()
    if (!botToken) {
      return res.status(400).json({ error: '텔레그램 Bot API Token이 설정되어 있지 않습니다.' })
    }

    const tgData = await telegramPost(botToken, 'sendMessage', {
      chat_id: telegramId,
      text: "Hi I'm EasyStation",
    })
    if (!tgData.ok) {
      return res.status(502).json({ error: `텔레그램 전송 실패: ${tgData.description || '알 수 없는 오류'}` })
    }

    res.json({ ok: true })
  } catch (e) {
    console.error('[sns/test-telegram]', e)
    res.status(500).json({ error: e.message || '서버 오류' })
  }
})

// POST /api/sns/telegram/set-webhook
// body: { webhookUrl: "https://yourserver.com/api/sns/telegram/webhook" }
router.post('/telegram/set-webhook', async (req, res) => {
  try {
    const config = readConfig()
    const botToken = config.sns?.telegram?.httpApiToken?.trim()
    if (!botToken) {
      return res.status(400).json({ error: 'Bot API Token이 설정되어 있지 않습니다.' })
    }

    const webhookUrl = String(req.body?.webhookUrl || '').trim()
    if (!webhookUrl) {
      return res.status(400).json({ error: 'webhookUrl이 필요합니다.' })
    }

    const tgData = await telegramPost(botToken, 'setWebhook', { url: webhookUrl })
    if (!tgData.ok) {
      return res.status(502).json({ error: `웹훅 등록 실패: ${tgData.description || '알 수 없는 오류'}` })
    }

    // config.json에 webhookUrl 저장
    const updatedConfig = readConfig()
    if (!updatedConfig.sns) updatedConfig.sns = {}
    if (!updatedConfig.sns.telegram) updatedConfig.sns.telegram = {}
    updatedConfig.sns.telegram.webhookUrl = webhookUrl
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(updatedConfig, null, 2))

    res.json({ ok: true, webhookUrl })
  } catch (e) {
    console.error('[sns/telegram/set-webhook]', e)
    res.status(500).json({ error: e.message || '서버 오류' })
  }
})

// GET /api/sns/telegram/webhook-info
// 현재 Telegram에 등록된 웹훅 URL 조회
router.get('/telegram/webhook-info', async (req, res) => {
  try {
    const config = readConfig()
    const botToken = config.sns?.telegram?.httpApiToken?.trim()
    if (!botToken) {
      return res.status(400).json({ error: 'Bot API Token이 설정되어 있지 않습니다.' })
    }

    const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`)
    const tgData = await tgRes.json()
    res.json({
      ok: true,
      webhookUrl: tgData.result?.url || '',
      savedWebhookUrl: config.sns?.telegram?.webhookUrl || '',
      pendingUpdateCount: tgData.result?.pending_update_count ?? 0,
      lastError: tgData.result?.last_error_message || '',
    })
  } catch (e) {
    console.error('[sns/telegram/webhook-info]', e)
    res.status(500).json({ error: e.message || '서버 오류' })
  }
})

module.exports = router
