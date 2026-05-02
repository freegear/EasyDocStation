function parseCookies(rawCookie = '') {
  const out = {}
  const source = String(rawCookie || '')
  if (!source) return out
  for (const part of source.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (!key) continue
    out[key] = decodeURIComponent(value)
  }
  return out
}

function getAuthTokenFromRequest(req) {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7)
  const cookies = parseCookies(req.headers.cookie || '')
  return cookies.eds_auth || ''
}

function getAuthCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production'
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  }
}

function getAuthCookieClearOptions() {
  const { httpOnly, secure, sameSite, path } = getAuthCookieOptions()
  return { httpOnly, secure, sameSite, path }
}

module.exports = {
  getAuthTokenFromRequest,
  getAuthCookieOptions,
  getAuthCookieClearOptions,
}
