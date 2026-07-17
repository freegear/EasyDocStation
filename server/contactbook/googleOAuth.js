const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { getGoogleOAuthConfig } = require('../mail/settings')

const GOOGLE_CARDDAV_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/carddav',
]

function readProjectConfig() {
  try { return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../config.json'), 'utf8')) } catch { return {} }
}

async function getContactBookGoogleConfig() {
  const shared = await getGoogleOAuthConfig()
  const project = readProjectConfig()
  const configured = String(process.env.CONTACTBOOK_GOOGLE_REDIRECT_URI || project.google?.contactbook_redirect_uri || '').trim()
  const fallback = shared.redirectUri ? shared.redirectUri.replace(/\/api\/mail\/gmail\/callback(?:\?.*)?$/, '/api/contactbook/oauth/google/callback') : ''
  const config = { ...shared, redirectUri: configured || fallback }
  const missing = []
  if (!config.clientId) missing.push('GOOGLE_CLIENT_ID')
  if (!config.clientSecret) missing.push('GOOGLE_CLIENT_SECRET')
  if (!config.redirectUri) missing.push('CONTACTBOOK_GOOGLE_REDIRECT_URI')
  if (missing.length) {
    const error = new Error(`Google OAuth 설정이 필요합니다: ${missing.join(', ')}`)
    error.status = 500
    error.code = 'GOOGLE_OAUTH_CONFIG_MISSING'
    throw error
  }
  const redirect = new URL(config.redirectUri)
  const localDevelopment = ['localhost', '127.0.0.1', '::1'].includes(redirect.hostname)
  if (redirect.protocol !== 'https:' && !localDevelopment) {
    const error = new Error('Google ContactBook OAuth callback은 운영 환경에서 HTTPS 주소여야 합니다.')
    error.status = 400
    error.code = 'GOOGLE_OAUTH_REDIRECT_NOT_SECURE'
    throw error
  }
  return config
}

function createPkce() {
  const verifier = crypto.randomBytes(48).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

async function buildGoogleContactAuthUrl({ state, codeChallenge }) {
  const { clientId, redirectUri } = await getContactBookGoogleConfig()
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', GOOGLE_CARDDAV_SCOPES.join(' '))
  url.searchParams.set('state', state)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('include_granted_scopes', 'true')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

async function fetchJson(url, options) {
  const response = await fetch(url, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error_description || data.error || `Google OAuth 오류 (${response.status})`)
    error.status = response.status
    error.oauthCode = data.error || ''
    throw error
  }
  return data
}

async function exchangeGoogleContactCode(code, codeVerifier) {
  const { clientId, clientSecret, redirectUri } = await getContactBookGoogleConfig()
  const body = new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: codeVerifier })
  return fetchJson('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
}

async function refreshGoogleContactToken(refreshToken) {
  const { clientId, clientSecret } = await getContactBookGoogleConfig()
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
  return fetchJson('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
}

async function getGoogleIdentity(accessToken) {
  return fetchJson('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } })
}

async function revokeGoogleToken(token) {
  if (!token) return
  const response = await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }),
  })
  if (!response.ok && response.status !== 400) throw new Error(`Google token 철회 오류 (${response.status})`)
}

module.exports = {
  GOOGLE_CARDDAV_SCOPES,
  createPkce,
  buildGoogleContactAuthUrl,
  exchangeGoogleContactCode,
  refreshGoogleContactToken,
  getGoogleIdentity,
  revokeGoogleToken,
}
