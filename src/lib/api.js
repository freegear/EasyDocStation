export function getToken() {
  return ''
}
export function setToken(token) {
  return token
}
export function clearToken() {
  return undefined
}

let _sessionInvalidatedHandler = null
export function setSessionInvalidatedHandler(fn) {
  _sessionInvalidatedHandler = fn
}

export async function apiFetch(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  }
  const res = await fetch(`/api${path}`, { ...options, headers, credentials: 'include' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    if (data.code) err.code = data.code
    if (data.guide) err.guide = data.guide
    if (data.code === 'SESSION_INVALIDATED' && _sessionInvalidatedHandler) {
      _sessionInvalidatedHandler()
    }
    throw err
  }
  return res.json()
}
