const fs = require('fs')
const path = require('path')
const db = require('../db')
const {
  decryptSecret,
  encryptSecret,
  isMaskedValue,
  maskSecret,
} = require('../lib/secrets')

// 프로젝트 루트 config.json (PostgreSQL/경로 설정 등과 동일한 중앙 설정 파일)
function readProjectConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../config.json'), 'utf8'))
  } catch {
    return {}
  }
}

function getGoogleOAuthConfigFromConfigJson() {
  const g = readProjectConfig().google || {}
  return {
    clientId: String(g.client_id || '').trim(),
    clientSecret: String(g.client_secret || '').trim(),
    redirectUri: String(g.redirect_uri || '').trim(),
  }
}

const SETTING_KEYS = {
  googleClientId: 'google_client_id',
  googleClientSecret: 'google_client_secret',
  googleRedirectUri: 'google_redirect_uri',
}

async function getMailSetting(key) {
  const { rows } = await db.query(
    'SELECT value, is_secret FROM mail_service_settings WHERE key = $1 LIMIT 1',
    [key],
  )
  const row = rows[0]
  if (!row) return ''
  return row.is_secret ? decryptSecret(row.value) : (row.value || '')
}

async function upsertMailSetting({ key, value, isSecret = false, updatedBy = null }) {
  if (isMaskedValue(value)) return
  const storedValue = isSecret ? encryptSecret(value) : String(value || '').trim()
  await db.query(
    `INSERT INTO mail_service_settings (key, value, is_secret, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value,
                   is_secret = EXCLUDED.is_secret,
                   updated_by = EXCLUDED.updated_by,
                   updated_at = NOW()`,
    [key, storedValue, Boolean(isSecret), updatedBy],
  )
}

async function getPublicMailSettings() {
  const { rows } = await db.query(
    `SELECT key, value, is_secret, updated_at
     FROM mail_service_settings
     WHERE key = ANY($1)
     ORDER BY key ASC`,
    [[
      SETTING_KEYS.googleClientId,
      SETTING_KEYS.googleClientSecret,
      SETTING_KEYS.googleRedirectUri,
    ]],
  )
  const byKey = new Map(rows.map(row => [row.key, row]))
  const secret = byKey.get(SETTING_KEYS.googleClientSecret)
  return {
    google_client_id: byKey.get(SETTING_KEYS.googleClientId)?.value || '',
    google_client_secret: secret ? maskSecret(secret.value) : null,
    google_redirect_uri: byKey.get(SETTING_KEYS.googleRedirectUri)?.value || '',
  }
}

async function getGoogleOAuthConfigFromDb() {
  const clientId = await getMailSetting(SETTING_KEYS.googleClientId)
  const clientSecret = await getMailSetting(SETTING_KEYS.googleClientSecret)
  const redirectUri = await getMailSetting(SETTING_KEYS.googleRedirectUri)
  return { clientId, clientSecret, redirectUri }
}

async function getGoogleOAuthConfig() {
  const envConfig = {
    clientId: String(process.env.GOOGLE_CLIENT_ID || process.env.GMAIL_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.GOOGLE_CLIENT_SECRET || process.env.GMAIL_CLIENT_SECRET || '').trim(),
    redirectUri: String(process.env.GOOGLE_REDIRECT_URI || process.env.GMAIL_REDIRECT_URI || '').trim(),
  }
  if (envConfig.clientId && envConfig.clientSecret && envConfig.redirectUri) return envConfig

  // 우선순위: 환경변수 → config.json(google) → DB(mail_service_settings)
  const fileConfig = getGoogleOAuthConfigFromConfigJson()
  const dbConfig = await getGoogleOAuthConfigFromDb()
  return {
    clientId: envConfig.clientId || fileConfig.clientId || dbConfig.clientId,
    clientSecret: envConfig.clientSecret || fileConfig.clientSecret || dbConfig.clientSecret,
    redirectUri: envConfig.redirectUri || fileConfig.redirectUri || dbConfig.redirectUri,
  }
}

module.exports = {
  SETTING_KEYS,
  getGoogleOAuthConfig,
  getPublicMailSettings,
  upsertMailSetting,
}
