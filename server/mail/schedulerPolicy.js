function readBoundedMs(value, fallback, { min, max }) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function calculateBackoffMs(failureCount, { baseMs, maxMs }) {
  const exponent = Math.max(0, Math.min(30, Number(failureCount || 1) - 1))
  return Math.min(maxMs, baseMs * (2 ** exponent))
}

function isBackoffActive(account, now = new Date()) {
  if (!account?.sync_retry_after) return false
  const retryAt = new Date(account.sync_retry_after).getTime()
  return Number.isFinite(retryAt) && retryAt > now.getTime()
}

module.exports = {
  calculateBackoffMs,
  isBackoffActive,
  readBoundedMs,
}
