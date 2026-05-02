const jwt = require('jsonwebtoken')
const { getAuthTokenFromRequest } = require('../lib/authToken')
const { isSupabaseAuthEnabled, verifySupabaseAccessToken } = require('../lib/supabaseAuth')
const { resolveOrProvisionUserBySupabaseClaims } = require('../lib/userIdentity')

module.exports = async function requireAuth(req, res, next) {
  const token = getAuthTokenFromRequest(req)
  if (!token) {
    return res.status(401).json({ error: '인증이 필요합니다.' })
  }

  const jwtSecret = String(process.env.JWT_SECRET || '').trim()
  if (jwtSecret) {
    try {
      req.user = jwt.verify(token, jwtSecret)
      req.authProvider = 'legacy'
      return next()
    } catch (_) {
      // Continue to Supabase verification
    }
  }

  if (isSupabaseAuthEnabled()) {
    try {
      const claims = await verifySupabaseAccessToken(token)
      const localUser = await resolveOrProvisionUserBySupabaseClaims(claims)
      if (!localUser) {
        return res.status(401).json({ error: '사용자 식별에 실패했습니다.' })
      }
      req.user = {
        id: localUser.id,
        email: localUser.email,
        role: localUser.role,
        security_level: localUser.security_level || 0,
        supabase_user_id: localUser.supabase_user_id || claims.sub,
      }
      req.authProvider = 'supabase'
      return next()
    } catch (_) {
      return res.status(401).json({ error: '유효하지 않은 Supabase 토큰입니다.' })
    }
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch {
    return res.status(401).json({ error: '유효하지 않은 토큰입니다.' })
  }
}
