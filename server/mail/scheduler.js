const repo = require('./repository')
const { syncGmailAccount } = require('./gmailSync')
const { syncImapAccount } = require('./imapSync')
const { calculateBackoffMs, isBackoffActive, readBoundedMs } = require('./schedulerPolicy')
const { describeMailSyncError } = require('./syncError')

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000
const DEFAULT_STARTUP_DELAY_MS = 5 * 60 * 1000
const DEFAULT_BACKOFF_BASE_MS = 5 * 60 * 1000
const DEFAULT_BACKOFF_MAX_MS = 60 * 60 * 1000

let timer = null
let startupTimer = null
let running = false

async function syncAccount(account, { limit = 50 } = {}) {
  if (account.provider === 'gmail') {
    return syncGmailAccount({ tenantId: account.tenant_id, account, limit })
  }
  if (['naver', 'apple', 'imap', 'other'].includes(account.provider)) {
    return syncImapAccount({ tenantId: account.tenant_id, account, limit })
  }
  return { listed: 0, new: 0, saved: 0, failed: 0, errors: [] }
}

async function runMailSyncTick({
  limit = 50,
  now = new Date(),
  backoffBaseMs = readBoundedMs(process.env.MAIL_SYNC_BACKOFF_BASE_MS, DEFAULT_BACKOFF_BASE_MS, { min: 1000, max: 24 * 60 * 60 * 1000 }),
  backoffMaxMs = readBoundedMs(process.env.MAIL_SYNC_BACKOFF_MAX_MS, DEFAULT_BACKOFF_MAX_MS, { min: 1000, max: 7 * 24 * 60 * 60 * 1000 }),
} = {}) {
  if (running) return { skipped: true, reason: 'already_running' }
  running = true
  const startedAt = new Date()
  const summaries = []
  try {
    const accounts = await repo.listSyncableAccounts()
    for (const account of accounts) {
      if (isBackoffActive(account, now)) {
        summaries.push({
          accountId: account.id,
          provider: account.provider,
          skipped: true,
          reason: 'backoff',
          retryAfter: account.sync_retry_after,
        })
        continue
      }
      await repo.markAccountSyncAttempt({
        tenantId: account.tenant_id,
        accountId: account.id,
        attemptedAt: now,
      })
      try {
        const summary = await syncAccount(account, { limit })
        await repo.markAccountSyncSuccess({
          tenantId: account.tenant_id,
          accountId: account.id,
          syncedAt: new Date(),
        })
        summaries.push({ accountId: account.id, provider: account.provider, ok: true, ...summary })
      } catch (err) {
        const errorMessage = describeMailSyncError(err)
        const failureCount = Math.max(0, Number(account.sync_failure_count) || 0) + 1
        const reauthRequired = err.code === 'MAIL_REAUTH_REQUIRED'
        const retryAfter = reauthRequired
          ? null
          : new Date(now.getTime() + calculateBackoffMs(failureCount, {
            baseMs: backoffBaseMs,
            maxMs: Math.max(backoffBaseMs, backoffMaxMs),
          }))
        await repo.markAccountSyncFailure({
          tenantId: account.tenant_id,
          accountId: account.id,
          lastError: errorMessage,
          failureCount,
          retryAfter,
          status: reauthRequired ? 'error' : undefined,
        })
        summaries.push({
          accountId: account.id,
          provider: account.provider,
          ok: false,
          emailAddress: account.email_address,
          error: errorMessage,
          failureCount,
          retryAfter,
        })
      }
    }
    return { startedAt, finishedAt: new Date(), accounts: summaries }
  } finally {
    running = false
  }
}

function startMailSyncScheduler() {
  if (timer) return
  if (String(process.env.MAIL_SYNC_SCHEDULER || '1') === '0') return

  const intervalMs = Math.max(
    60 * 1000,
    Number(process.env.MAIL_SYNC_INTERVAL_MS || DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
  )
  const limit = Math.min(200, Math.max(1, Number(process.env.MAIL_SYNC_LIMIT || 50) || 50))
  const startupDelayMs = readBoundedMs(
    process.env.MAIL_SYNC_STARTUP_DELAY_MS,
    DEFAULT_STARTUP_DELAY_MS,
    { min: 30 * 1000, max: 24 * 60 * 60 * 1000 },
  )

  const tick = () => {
    runMailSyncTick({ limit })
      .then(result => {
        if (result?.skipped) return
        const saved = (result.accounts || []).reduce((sum, item) => sum + Number(item.saved || 0), 0)
        console.log(`[Mail sync] 자동 동기화 완료: accounts=${result.accounts?.length || 0}, saved=${saved}`)
      })
      .catch(err => {
        console.error('[Mail sync] 자동 동기화 실패:', err.message)
      })
  }

  timer = setInterval(tick, intervalMs)
  timer.unref?.()
  startupTimer = setTimeout(tick, startupDelayMs)
  startupTimer.unref?.()
  console.log(`[Mail sync] 자동 동기화 스케줄러 시작: interval=${Math.round(intervalMs / 1000)}s, startupDelay=${Math.round(startupDelayMs / 1000)}s`)
}

function stopMailSyncScheduler() {
  if (timer) clearInterval(timer)
  if (startupTimer) clearTimeout(startupTimer)
  timer = null
  startupTimer = null
}

module.exports = {
  startMailSyncScheduler,
  stopMailSyncScheduler,
  runMailSyncTick,
}
