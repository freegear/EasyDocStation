const jwt = require('jsonwebtoken')

module.exports = function requireAuth(req, res, next) {
  const header = req.headers.authorization
  // Also accept ?auth_token= for browser requests (img tags, file downloads)
  const queryToken = req.query.auth_token
  const token = header?.startsWith('Bearer ') ? header.slice(7) : queryToken
  if (!token) {
    return res.status(401).json({ error: '인증이 필요합니다.' })
  }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch {
    return res.status(401).json({ error: '유효하지 않은 토큰입니다.' })
  }
}
