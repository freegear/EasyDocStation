const GOOGLE_CARDDAV_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/carddav',
]
const GOOGLE_CARDDAV_SCOPE = 'https://www.googleapis.com/auth/carddav'

function normalizeGrantedScopes(value) {
  return [...new Set((Array.isArray(value) ? value : String(value || '').split(/\s+/)).map(scope => String(scope).trim()).filter(Boolean))]
}

function validateGoogleContactScopes(value) {
  const scopes = normalizeGrantedScopes(value)
  if (!scopes.includes(GOOGLE_CARDDAV_SCOPE)) {
    const error = new Error('Google 연락처 접근 권한이 승인되지 않았습니다.')
    error.status = 403
    error.code = 'GOOGLE_CONTACT_SCOPE_MISSING'
    throw error
  }
  return scopes
}

module.exports = { GOOGLE_CARDDAV_SCOPES, GOOGLE_CARDDAV_SCOPE, normalizeGrantedScopes, validateGoogleContactScopes }
