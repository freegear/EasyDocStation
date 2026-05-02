const { createRemoteJWKSet, jwtVerify } = require('jose')

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '')
const SUPABASE_ISSUER = SUPABASE_URL ? `${SUPABASE_URL}/auth/v1` : ''
const SUPABASE_JWKS_URL = SUPABASE_ISSUER ? new URL(`${SUPABASE_ISSUER}/.well-known/jwks.json`) : null
const SUPABASE_AUDIENCE = String(process.env.SUPABASE_JWT_AUDIENCE || 'authenticated').trim()

const jwks = SUPABASE_JWKS_URL ? createRemoteJWKSet(SUPABASE_JWKS_URL) : null

function isSupabaseAuthEnabled() {
  return Boolean(jwks && SUPABASE_ISSUER)
}

async function verifySupabaseAccessToken(token) {
  if (!isSupabaseAuthEnabled()) {
    throw new Error('SUPABASE_URL is not configured')
  }
  const { payload } = await jwtVerify(token, jwks, {
    issuer: SUPABASE_ISSUER,
    audience: SUPABASE_AUDIENCE,
  })
  return payload
}

module.exports = {
  isSupabaseAuthEnabled,
  verifySupabaseAccessToken,
}
