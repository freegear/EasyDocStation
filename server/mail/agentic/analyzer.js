const crypto = require('crypto')
const threadRepo = require('./threadRepository')

const ANALYSIS_VERSION = 1
const ACTION_KEYWORDS = ['요청', '확인', '전송', '검토', '회신', '공유', '준비', '처리', '계약', '납품']
const RISK_KEYWORDS = ['긴급', '지연', '장애', '위험', '문제', '오류', '클레임', '취소', '변경']

function stableId(prefix, text) {
  return `${prefix}-${crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 12)}`
}

function messageDate(message) {
  const value = message.received_at || message.sent_at || message.created_at
  return value ? new Date(value).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)
}

function mergeById(existing = [], incoming = []) {
  const map = new Map()
  for (const item of existing) {
    if (item?.id) map.set(item.id, item)
  }
  for (const item of incoming) {
    if (!item?.id) continue
    map.set(item.id, { ...(map.get(item.id) || {}), ...item })
  }
  return [...map.values()]
}

function buildHeuristicDelta(messages) {
  const progress = []
  const issues = []
  const actions = []
  for (const message of messages) {
    const text = [message.subject, message.snippet].filter(Boolean).join(' ')
    if (!text.trim()) continue
    progress.push({
      date: messageDate(message),
      description: `${message.from_name || message.from_email || '발신자'}: ${message.subject || '(제목 없음)'}`,
      evidence_message_ids: [message.message_id],
    })
    if (RISK_KEYWORDS.some(keyword => text.includes(keyword))) {
      issues.push({
        id: stableId('issue', `${message.thread_id}:${message.message_id}:${text}`),
        title: message.subject || '중요 이슈',
        description: message.snippet || message.subject || '',
        severity: text.includes('긴급') ? 'high' : 'normal',
        status: 'open',
        evidence_message_ids: [message.message_id],
      })
    }
    if (ACTION_KEYWORDS.some(keyword => text.includes(keyword))) {
      const title = message.subject || message.snippet || '메일 후속 조치'
      actions.push({
        id: stableId('action', `${message.thread_id}:${title}`),
        title,
        owner_hint: message.from_name || message.from_email || '',
        due_at: null,
        priority: text.includes('긴급') ? 'high' : 'normal',
        status: 'open',
        source_message_id: message.message_id,
      })
    }
  }
  return { progress, issues, actions }
}

async function analyzeThread({ tenantId, threadId }) {
  const existing = await threadRepo.getThreadReport({ tenantId, threadId })
  const allMessages = await threadRepo.listThreadMessages({ tenantId, threadId })
  const sourceIds = new Set(Array.isArray(existing?.source_message_ids) ? existing.source_message_ids : [])
  const deltaMessages = allMessages.filter(message => !sourceIds.has(message.message_id))
  if (deltaMessages.length === 0 && existing) return existing

  const delta = buildHeuristicDelta(deltaMessages.length ? deltaMessages : allMessages.slice(-5))
  const nextSourceIds = [...new Set([...sourceIds, ...deltaMessages.map(message => message.message_id)])]
  const last = allMessages[allMessages.length - 1]
  const summaryBase = existing?.summary || ''
  const latestSubject = last?.subject || ''
  const summary = summaryBase
    ? `${summaryBase}\n\n최근 업데이트: ${latestSubject || '새 메일'}`
    : `${latestSubject || '메일 타래'} 관련 메일 타래를 모니터링 중입니다. 신규 메시지 ${deltaMessages.length || allMessages.length}건이 반영되었습니다.`

  const actionItems = mergeById(existing?.action_items || [], delta.actions)
  const todoItems = actionItems
    .filter(item => item.status === 'open' || item.status === 'in_progress')
    .map(item => ({
      action_item_id: item.id,
      title: item.title,
      description: item.owner_hint ? `담당 후보: ${item.owner_hint}` : '',
      due_at: item.due_at || null,
      priority: item.priority || 'normal',
    }))

  const report = {
    summary,
    important_issues: mergeById(existing?.important_issues || [], delta.issues),
    progress_summary: [...(existing?.progress_summary || []), ...delta.progress],
    action_items: actionItems,
    todo_items: todoItems,
    decisions: existing?.decisions || [],
    risks: existing?.risks || [],
    open_questions: existing?.open_questions || [],
    last_message_id: last?.message_id || null,
    learned_message_count: nextSourceIds.length,
    source_message_ids: nextSourceIds,
    analysis_version: ANALYSIS_VERSION,
  }
  const saved = await threadRepo.upsertThreadReport({ tenantId, threadId, report })
  await threadRepo.markMessagesAnalyzed({
    tenantId,
    threadId,
    messageIds: deltaMessages.map(message => message.message_id),
  })
  await threadRepo.createEvent({
    tenantId,
    threadId,
    messageId: last?.message_id || null,
    eventType: 'analysis_completed',
    payload: { analysis_version: ANALYSIS_VERSION },
  })
  return saved
}

module.exports = { analyzeThread, ANALYSIS_VERSION }
