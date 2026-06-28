const crypto = require('crypto')
const repo = require('../repository')
const { getMailStorage } = require('../storage')
const threadRepo = require('./threadRepository')
const {
  normalizeSubject,
  matchWatchTarget,
  participantFingerprint,
  buildAgenticThreadId,
  inferDirection,
} = require('./threadMatcher')
const { trainMessageIncremental } = require('./ragTrainer')
const { analyzeThread } = require('./analyzer')
const { syncTodosFromReport } = require('./todoService')
const { notifyThreadUpdate } = require('./telegramNotifier')

let timer = null
let running = false

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex')
}

async function loadMessageBody(message) {
  const storage = getMailStorage()
  if (!message?.body_text_object_key) return ''
  try {
    return (await storage.getObject(message.body_text_object_key)).toString('utf8')
  } catch {
    return ''
  }
}

async function attachmentHash({ tenantId, messageId }) {
  const attachments = await repo.listMessageAttachments({ tenantId, messageId })
  return sha256(attachments.map(att => `${att.id}:${att.filename}:${att.size_bytes}:${att.object_key}`).join('|'))
}

async function handleMessageEvent(event) {
  const messageId = event.message_id || event.payload?.message_id
  if (!messageId) return { matched: 0 }
  const message = await repo.getMessageForAgentic({ tenantId: event.tenant_id, messageId })
  if (!message) return { matched: 0, missing: true }
  const bodyText = await loadMessageBody(message)
  const targets = await threadRepo.listEnabledWatchTargets({ tenantId: event.tenant_id })
  let matched = 0

  for (const target of targets) {
    if (!matchWatchTarget(target, message, bodyText)) continue
    const normalizedSubject = normalizeSubject(message.subject)
    const participants = participantFingerprint(message)
    const threadId = buildAgenticThreadId({
      tenantId: event.tenant_id,
      accountId: message.account_id,
      providerThreadId: message.provider_thread_id,
      normalizedSubject,
      participantKey: participants,
    })
    await threadRepo.upsertThreadForMessage({
      tenantId: event.tenant_id,
      target,
      message,
      agenticThreadId: threadId,
      normalizedSubject,
      participantFingerprint: participants,
      direction: inferDirection(message),
      contentHash: sha256([message.subject, message.snippet, bodyText].join('\n')),
      attachmentHash: await attachmentHash({ tenantId: event.tenant_id, messageId: message.id }),
    })
    matched += 1
  }
  return { matched }
}

async function handleAnalysisRequested(event) {
  const report = await analyzeThread({ tenantId: event.tenant_id, threadId: event.thread_id })
  const threads = await threadRepo.listThreads({ tenantId: event.tenant_id, userId: 0, isSiteAdmin: true })
  const thread = threads.find(item => item.id === event.thread_id)
  if (thread?.auto_create_todos !== false) {
    await syncTodosFromReport({
      tenantId: event.tenant_id,
      threadId: event.thread_id,
      ownerUserId: thread?.owner_user_id || null,
      report,
    })
  }
  if (thread?.notify_telegram !== false) {
    await notifyThreadUpdate({
      tenantId: event.tenant_id,
      threadId: event.thread_id,
      messageId: event.message_id,
      report,
    })
  }
  return report
}

async function processEvent(event) {
  if (event.event_type === 'mail_message_synced' || event.event_type === 'mail_message_sent') {
    return handleMessageEvent(event)
  }
  if (event.event_type === 'rag_train_requested') {
    return trainMessageIncremental({
      tenantId: event.tenant_id,
      threadId: event.thread_id,
      messageId: event.message_id,
    })
  }
  if (event.event_type === 'analysis_requested') {
    return handleAnalysisRequested(event)
  }
  return { skipped: true, reason: 'unknown_event_type' }
}

async function processPendingForTenant(tenantId, limit = 20) {
  const events = await threadRepo.listPendingEvents({ tenantId, limit })
  let done = 0
  for (const event of events) {
    try {
      await processEvent(event)
      await threadRepo.markEventDone({ tenantId, id: event.id })
      done += 1
    } catch (err) {
      await threadRepo.markEventFailed({ tenantId, id: event.id, error: err.message })
    }
  }
  return { done, total: events.length }
}

async function enqueueMessageSynced({ tenantId, messageId, direction = 'inbound' }) {
  if (!tenantId || !messageId) return null
  return threadRepo.createEvent({
    tenantId,
    messageId,
    eventType: direction === 'outbound' ? 'mail_message_sent' : 'mail_message_synced',
    payload: { direction },
  })
}

async function startAgenticMailWorker({ intervalSec = 30 } = {}) {
  if (timer || String(process.env.AGENTICAI_MAIL_ENABLED || 'true').toLowerCase() === 'false') return
  async function tick() {
    if (running) return
    running = true
    try {
      const accounts = await repo.listSyncableAccounts()
      const tenantIds = [...new Set(accounts.map(account => account.tenant_id))]
      for (const tenantId of tenantIds) {
        await processPendingForTenant(tenantId, 25)
      }
    } catch (err) {
      console.warn('[AgenticAI Mail] worker tick failed:', err.message)
    } finally {
      running = false
    }
  }
  timer = setInterval(tick, Math.max(5, intervalSec) * 1000)
  tick().catch(() => {})
}

function stopAgenticMailWorker() {
  if (timer) clearInterval(timer)
  timer = null
}

module.exports = {
  enqueueMessageSynced,
  processPendingForTenant,
  processEvent,
  startAgenticMailWorker,
  stopAgenticMailWorker,
}
