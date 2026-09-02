const DEFAULT_RETRY_DELAYS_MS = [250, 750]

const NON_RETRYABLE_CODES = new Set([
  'IMAP_MESSAGE_NOT_FOUND',
  'IMAP_SOURCE_MAILBOX_NOT_FOUND',
  'IMAP_TRASH_MAILBOX_NOT_FOUND',
  'IMAP_MOVE_SUCCEEDED_UID_PENDING',
  'LOCAL_ORPHAN_CANDIDATE',
])

function isRetryableMailDeleteError(err) {
  const code = String(err?.code || '').toUpperCase()
  if (NON_RETRYABLE_CODES.has(code)) return false
  if (code === 'MAIL_REAUTH_REQUIRED' || code === 'EAUTH') return true
  if (/^(ECONN|ETIMEDOUT|ESOCKET|ENET|EHOST|EPIPE|UND_ERR_|HTTP_5)/.test(code)) return true

  const status = Number(err?.status || err?.statusCode || err?.response?.status)
  if (status === 401 || status === 403 || status === 408 || status === 429 || status >= 500) return true

  const text = `${err?.message || ''} ${err?.responseText || ''}`.toLowerCase()
  return /auth|login|credential|password|token|timeout|timed out|connection|connect|socket|network|temporar|try again|rate limit|unavailable|reset|closed|econn|etimedout/.test(text)
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function runMailDeleteWithRetry(operation, {
  delaysMs = DEFAULT_RETRY_DELAYS_MS,
  sleep = wait,
  onRetry = null,
} = {}) {
  let attempt = 0
  while (true) {
    try {
      return await operation(attempt + 1)
    } catch (err) {
      const retryable = isRetryableMailDeleteError(err)
      if (!retryable || attempt >= delaysMs.length) {
        err.retryable = retryable
        err.attempts = attempt + 1
        throw err
      }
      const delayMs = delaysMs[attempt]
      attempt += 1
      onRetry?.({ err, attempt: attempt + 1, delayMs })
      await sleep(delayMs)
    }
  }
}

module.exports = {
  DEFAULT_RETRY_DELAYS_MS,
  isRetryableMailDeleteError,
  runMailDeleteWithRetry,
}
