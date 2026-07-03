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
  // 첨부파일 정책 (전역, 사이트 관리자 편집 / 인증 사용자 조회) — MailService.md 10.8
  attachMaxFileMb: 'attach_max_file_mb',
  attachMaxTotalMb: 'attach_max_total_mb',
  attachMaxFiles: 'attach_max_files',
  attachBlockedExtensions: 'attach_blocked_extensions',
}

// 하드코딩 상수를 대체하는 기본 정책 (설정이 없을 때 사용)
// 합계 20MB: Gmail 등의 25MB 한도에 base64 오버헤드(약 +37%)를 감안한 안전선 (MailService.md 10.9)
const DEFAULT_ATTACHMENT_POLICY = {
  maxFileMb: 20,
  maxTotalMb: 20,
  maxFiles: 20,
  blockedExtensions: ['exe', 'bat', 'cmd', 'com', 'scr', 'pif', 'js', 'vbs', 'jar', 'msi', 'cpl', 'dll'],
}

// 잘못된 값이 저장되어도 서비스가 깨지지 않도록 합리적 범위로 clamp 한다.
const ATTACHMENT_POLICY_LIMITS = {
  maxFileMb: { min: 1, max: 200 },
  maxTotalMb: { min: 1, max: 200 },
  maxFiles: { min: 1, max: 100 },
}

function clampInt(value, { min, max }, fallback) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

// 확장자 목록 정규화: 콤마/공백/줄바꿈 구분 → 소문자, 앞 '.' 제거, 중복 제거.
function normalizeBlockedExtensions(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[,\s]+/)
  const seen = new Set()
  for (const item of raw) {
    const ext = String(item || '').trim().toLowerCase().replace(/^\.+/, '')
    if (ext) seen.add(ext)
  }
  return [...seen]
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

// 저장된 첨부 정책을 읽어 기본값과 병합해 반환한다. (모든 값 정규화 완료 상태)
async function getAttachmentPolicy() {
  const [fileMb, totalMb, files, blocked] = await Promise.all([
    getMailSetting(SETTING_KEYS.attachMaxFileMb),
    getMailSetting(SETTING_KEYS.attachMaxTotalMb),
    getMailSetting(SETTING_KEYS.attachMaxFiles),
    getMailSetting(SETTING_KEYS.attachBlockedExtensions),
  ])
  const maxFileMb = fileMb ? clampInt(fileMb, ATTACHMENT_POLICY_LIMITS.maxFileMb, DEFAULT_ATTACHMENT_POLICY.maxFileMb) : DEFAULT_ATTACHMENT_POLICY.maxFileMb
  const maxTotalMb = totalMb ? clampInt(totalMb, ATTACHMENT_POLICY_LIMITS.maxTotalMb, DEFAULT_ATTACHMENT_POLICY.maxTotalMb) : DEFAULT_ATTACHMENT_POLICY.maxTotalMb
  const maxFiles = files ? clampInt(files, ATTACHMENT_POLICY_LIMITS.maxFiles, DEFAULT_ATTACHMENT_POLICY.maxFiles) : DEFAULT_ATTACHMENT_POLICY.maxFiles
  const blockedExtensions = blocked ? normalizeBlockedExtensions(blocked) : [...DEFAULT_ATTACHMENT_POLICY.blockedExtensions]
  return {
    maxFileMb,
    maxTotalMb,
    maxFiles,
    blockedExtensions,
    // 파생값(바이트)도 함께 제공해 라우트에서 재계산할 필요가 없게 한다.
    maxFileBytes: maxFileMb * 1024 * 1024,
    maxTotalBytes: maxTotalMb * 1024 * 1024,
  }
}

// 프론트/응답용 직렬화 형태(snake_case).
function serializeAttachmentPolicy(policy) {
  return {
    max_file_mb: policy.maxFileMb,
    max_total_mb: policy.maxTotalMb,
    max_files: policy.maxFiles,
    blocked_extensions: policy.blockedExtensions,
  }
}

// 관리 화면에서 넘어온 값을 정규화해 저장한다. 부분 업데이트 허용(넘어온 필드만 저장).
async function updateAttachmentPolicy({ fields = {}, updatedBy = null } = {}) {
  const tasks = []
  if (fields.max_file_mb != null) {
    tasks.push(upsertMailSetting({ key: SETTING_KEYS.attachMaxFileMb, value: String(clampInt(fields.max_file_mb, ATTACHMENT_POLICY_LIMITS.maxFileMb, DEFAULT_ATTACHMENT_POLICY.maxFileMb)), updatedBy }))
  }
  if (fields.max_total_mb != null) {
    tasks.push(upsertMailSetting({ key: SETTING_KEYS.attachMaxTotalMb, value: String(clampInt(fields.max_total_mb, ATTACHMENT_POLICY_LIMITS.maxTotalMb, DEFAULT_ATTACHMENT_POLICY.maxTotalMb)), updatedBy }))
  }
  if (fields.max_files != null) {
    tasks.push(upsertMailSetting({ key: SETTING_KEYS.attachMaxFiles, value: String(clampInt(fields.max_files, ATTACHMENT_POLICY_LIMITS.maxFiles, DEFAULT_ATTACHMENT_POLICY.maxFiles)), updatedBy }))
  }
  if (fields.blocked_extensions != null) {
    tasks.push(upsertMailSetting({ key: SETTING_KEYS.attachBlockedExtensions, value: normalizeBlockedExtensions(fields.blocked_extensions).join(','), updatedBy }))
  }
  await Promise.all(tasks)
  return getAttachmentPolicy()
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
  DEFAULT_ATTACHMENT_POLICY,
  getAttachmentPolicy,
  serializeAttachmentPolicy,
  updateAttachmentPolicy,
}
