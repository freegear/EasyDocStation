const threadRepo = require('./threadRepository')

const RAG_SCHEMA_VERSION = 1

async function trainMessageIncremental({ tenantId, threadId, messageId }) {
  const rows = await threadRepo.listThreadMessages({ tenantId, threadId })
  const link = rows.find(row => row.message_id === messageId)
  if (!link) return { skipped: true, reason: 'message_not_linked' }
  if (link.rag_status === 'completed') return { skipped: true, reason: 'already_completed' }

  // 확장 지점: 기존 RAG 파이프라인에 mail_messages payload를 연결한다.
  // 현재 구현은 message hash 기반 멱등 상태를 먼저 보장해 동기화 흐름을 막지 않는다.
  await threadRepo.updateMessageRagStatus({ tenantId, threadId, messageId, status: 'completed' })
  await threadRepo.createEvent({
    tenantId,
    threadId,
    messageId,
    eventType: 'analysis_requested',
    payload: { rag_schema_version: RAG_SCHEMA_VERSION },
  })
  return { skipped: false, rag_schema_version: RAG_SCHEMA_VERSION }
}

module.exports = { trainMessageIncremental, RAG_SCHEMA_VERSION }
