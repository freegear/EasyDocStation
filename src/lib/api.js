const TOKEN_KEY = 'eds_token'

export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}
export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token)
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

let _sessionInvalidatedHandler = null
export function setSessionInvalidatedHandler(fn) {
  _sessionInvalidatedHandler = fn
}

export async function apiFetch(path, options = {}) {
  const token = getToken()
  const headers = {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` }),
    ...options.headers,
  }
  const res = await fetch(`/api${path}`, { ...options, headers })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const err = new Error(data.error || `HTTP ${res.status}`)
    if (data.code) err.code = data.code
    if (data.code === 'SESSION_INVALIDATED' && _sessionInvalidatedHandler) {
      _sessionInvalidatedHandler()
    }
    throw err
  }
  return res.json()
}
