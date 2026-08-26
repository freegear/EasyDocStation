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

export const CASSANDRA_SYSTEM_ERROR_EVENT = 'easydoc:cassandra-system-error'

export function isCassandraUnavailableResponse(status, data = {}) {
  const code = String(data?.code || '')
  const message = String(data?.error || data?.detail || '')
  return code === 'CASSANDRA_UNAVAILABLE'
    || (Number(status) === 503 && /cassandra/i.test(message))
    || /NoHostAvailableError|All host\(s\) tried for query failed/i.test(message)
}

function notifyCassandraSystemError() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(CASSANDRA_SYSTEM_ERROR_EVENT))
}

export async function apiFetch(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  }
  const res = await fetch(`/api${path}`, { ...options, headers, credentials: 'include' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    if (isCassandraUnavailableResponse(res.status, data)) {
      notifyCassandraSystemError()
    }
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    if (data.code) err.code = data.code
    if (data.reason) err.reason = data.reason
    if (data.guide) err.guide = data.guide
    if (data.detail) err.detail = data.detail
    if (data.current) err.current = data.current
    if (data.code === 'SESSION_INVALIDATED' && _sessionInvalidatedHandler) {
      _sessionInvalidatedHandler()
    }
    throw err
  }
  return res.json()
}
