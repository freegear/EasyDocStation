const repo = require('./repository')
const { syncGmailAccount } = require('./gmailSync')
const { syncImapAccount } = require('./imapSync')

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000

let timer = null
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

async function runMailSyncTick({ limit = 50 } = {}) {
  if (running) return { skipped: true, reason: 'already_running' }
  running = true
  const startedAt = new Date()
  const summaries = []
  try {
    const accounts = await repo.listSyncableAccounts()
    for (const account of accounts) {
      await repo.setAccountSyncStatus({ tenantId: account.tenant_id, accountId: account.id, syncStatus: 'syncing' })
      try {
        const summary = await syncAccount(account, { limit })
        await repo.setAccountSyncStatus({
          tenantId: account.tenant_id,
          accountId: account.id,
          syncStatus: 'idle',
          lastSyncedAt: new Date(),
          lastError: null,
          status: 'connected',
        })
        summaries.push({ accountId: account.id, provider: account.provider, ok: true, ...summary })
      } catch (err) {
        await repo.setAccountSyncStatus({
          tenantId: account.tenant_id,
          accountId: account.id,
          syncStatus: 'error',
          lastError: err.message,
          status: err.code === 'MAIL_REAUTH_REQUIRED' ? 'error' : undefined,
        })
        summaries.push({ accountId: account.id, provider: account.provider, ok: false, error: err.message })
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
  setTimeout(tick, 30 * 1000).unref?.()
  console.log(`[Mail sync] 자동 동기화 스케줄러 시작: interval=${Math.round(intervalMs / 1000)}s`)
}

module.exports = {
  startMailSyncScheduler,
  runMailSyncTick,
}
