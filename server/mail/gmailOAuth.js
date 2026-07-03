const DEFAULT_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.modify',
]

const { getGoogleOAuthConfig } = require('./settings')

async function assertGoogleOAuthConfig() {
  const config = await getGoogleOAuthConfig()
  const missing = []
  if (!config.clientId) missing.push('GOOGLE_CLIENT_ID')
  if (!config.clientSecret) missing.push('GOOGLE_CLIENT_SECRET')
  if (!config.redirectUri) missing.push('GOOGLE_REDIRECT_URI')
  if (missing.length > 0) {
    const err = new Error(`Google OAuth 설정이 필요합니다: ${missing.join(', ')}`)
    err.status = 500
    err.code = 'GOOGLE_OAUTH_CONFIG_MISSING'
    throw err
  }
  return config
}

async function buildGoogleAuthUrl({ state }) {
  const { clientId, redirectUri } = await assertGoogleOAuthConfig()
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', DEFAULT_SCOPES.join(' '))
  url.searchParams.set('state', state)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('include_granted_scopes', 'true')
  return url.toString()
}

async function fetchJson(url, options) {
  const response = await fetch(url, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const err = new Error(data.error_description || data.error || `HTTP ${response.status}`)
    err.status = response.status
    err.data = data
    throw err
  }
  return data
}

async function exchangeCodeForTokens(code) {
  const { clientId, clientSecret, redirectUri } = await assertGoogleOAuthConfig()
  const body = new URLSearchParams()
  body.set('code', code)
  body.set('client_id', clientId)
  body.set('client_secret', clientSecret)
  body.set('redirect_uri', redirectUri)
  body.set('grant_type', 'authorization_code')

  return fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
}

// refresh token으로 access token을 갱신한다. (refresh 응답에는 refresh_token이 없을 수 있음)
async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = await assertGoogleOAuthConfig()
  const body = new URLSearchParams()
  body.set('client_id', clientId)
  body.set('client_secret', clientSecret)
  body.set('refresh_token', refreshToken)
  body.set('grant_type', 'refresh_token')

  return fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
}

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

function authHeader(accessToken) {
  return { Authorization: `Bearer ${accessToken}` }
}

// 메시지 id 목록 조회 (최신순). 반환: { messages:[{id,threadId}], nextPageToken, resultSizeEstimate }
async function gmailListMessages(accessToken, { maxResults = 50, pageToken, q, labelIds } = {}) {
  const url = new URL(`${GMAIL_API_BASE}/messages`)
  url.searchParams.set('maxResults', String(maxResults))
  if (pageToken) url.searchParams.set('pageToken', pageToken)
  if (q) url.searchParams.set('q', q)
  if (Array.isArray(labelIds)) labelIds.forEach(id => url.searchParams.append('labelIds', id))
  return fetchJson(url.toString(), { headers: authHeader(accessToken) })
}

// 단일 메시지 상세 조회 (format=full 기본)
async function gmailGetMessage(accessToken, id, { format = 'full' } = {}) {
  const url = new URL(`${GMAIL_API_BASE}/messages/${encodeURIComponent(id)}`)
  url.searchParams.set('format', format)
  return fetchJson(url.toString(), { headers: authHeader(accessToken) })
}

// 첨부 본문 조회. 반환: { size, data(base64url) }
async function gmailGetAttachment(accessToken, messageId, attachmentId) {
  const url = `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
  return fetchJson(url, { headers: authHeader(accessToken) })
}

// 라벨 목록 조회. 반환: { labels: [{ id, name, type('system'|'user'), ... }] }
async function gmailListLabels(accessToken) {
  return fetchJson(`${GMAIL_API_BASE}/labels`, { headers: authHeader(accessToken) })
}

// 라벨 이름 변경(patch). 라벨 id는 불변, name만 바뀐다. 시스템 라벨은 서버가 거부한다.
// 반환: { id, name, type, ... }
async function gmailPatchLabel(accessToken, labelId, { name } = {}) {
  const url = `${GMAIL_API_BASE}/labels/${encodeURIComponent(labelId)}`
  return fetchJson(url, {
    method: 'PATCH',
    headers: { ...authHeader(accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

// 라벨 삭제. 라벨만 제거되고 메일은 삭제되지 않는다(전체보관함에 남음). 성공 시 204(빈 응답).
// 시스템 라벨은 서버가 거부한다.
async function gmailDeleteLabel(accessToken, labelId) {
  const url = `${GMAIL_API_BASE}/labels/${encodeURIComponent(labelId)}`
  return fetchJson(url, {
    method: 'DELETE',
    headers: authHeader(accessToken),
  })
}

async function gmailModifyMessage(accessToken, id, { addLabelIds = [], removeLabelIds = [] } = {}) {
  const url = `${GMAIL_API_BASE}/messages/${encodeURIComponent(id)}/modify`
  return fetchJson(url, {
    method: 'POST',
    headers: { ...authHeader(accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ addLabelIds, removeLabelIds }),
  })
}

async function gmailTrashMessage(accessToken, id) {
  const url = `${GMAIL_API_BASE}/messages/${encodeURIComponent(id)}/trash`
  return fetchJson(url, {
    method: 'POST',
    headers: { ...authHeader(accessToken), 'Content-Type': 'application/json' },
  })
}

async function getGoogleUserInfo(accessToken) {
  return fetchJson('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
}

async function getGmailProfile(accessToken) {
  return fetchJson('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
}

module.exports = {
  DEFAULT_SCOPES,
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  getGoogleUserInfo,
  getGmailProfile,
  gmailListMessages,
  gmailGetMessage,
  gmailGetAttachment,
  gmailListLabels,
  gmailPatchLabel,
  gmailDeleteLabel,
  gmailModifyMessage,
  gmailTrashMessage,
}
