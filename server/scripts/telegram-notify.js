#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const ROOT_DIR = path.resolve(__dirname, '../..')
const SERVER_DIR = path.resolve(__dirname, '..')
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json')

try {
  require('dotenv').config({ path: path.join(SERVER_DIR, '.env') })
} catch (_) {}

const db = require('../db')

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch (_) {
    return {}
  }
}

function parseChatIds(value = '') {
  return String(value || '')
    .split(',')
    .map(v => v.trim())
    .filter(v => /^-?[0-9]+$/.test(v))
}

async function resolveChatIds() {
  const envIds = parseChatIds(process.env.EASYDOC_REBUILD_TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || '')
  if (envIds.length > 0) return [...new Set(envIds)]

  try {
    const result = await db.query(`
      SELECT telegram_id
      FROM users
      WHERE is_active = true
        AND use_sns_channel = 'telegram'
        AND telegram_id IS NOT NULL
        AND telegram_id ~ '^-?[0-9]+$'
    `)
    return [...new Set((result.rows || []).map(r => String(r.telegram_id || '').trim()).filter(Boolean))]
  } catch (e) {
    console.error(`[telegram-notify] chat id 조회 실패: ${e.message}`)
    return []
  }
}

async function sendTelegram(text) {
  const cfg = readConfig()
  const telegramCfg = cfg?.sns?.telegram || {}
  const botToken = String(process.env.TELEGRAM_BOT_TOKEN || telegramCfg.httpApiToken || '').trim()
  const enabledByConfig = Boolean(telegramCfg.enabled)
  const enabledByEnv = String(process.env.EASYDOC_REBUILD_TELEGRAM_FORCE || '').trim() === '1'

  if (!botToken || (!enabledByConfig && !enabledByEnv)) {
    console.log('[telegram-notify] 텔레그램 알림 비활성: bot token 또는 enabled 설정 없음')
    return
  }

  const chatIds = await resolveChatIds()
  if (chatIds.length === 0) {
    console.log('[telegram-notify] 수신 chat_id 없음')
    return
  }

  for (const chatId of chatIds) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) {
        console.warn(`[telegram-notify] 전송 실패: chat_id=${chatId} ${data.description || res.status}`)
      }
    } catch (e) {
      console.warn(`[telegram-notify] 전송 오류: chat_id=${chatId} ${e.message}`)
    }
  }
}

const message = process.argv.slice(2).join(' ').trim()
if (!message) {
  console.error('Usage: node server/scripts/telegram-notify.js "message"')
  process.exit(1)
}

sendTelegram(message)
  .catch(err => {
    console.error('[telegram-notify] 실패:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    try { await db.end() } catch (_) {}
  })
