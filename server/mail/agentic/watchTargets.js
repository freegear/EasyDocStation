const threadRepo = require('./threadRepository')
const { normalizeList } = require('./threadMatcher')

const TARGET_TYPES = new Set(['subject', 'account', 'account_subject', 'condition_group', 'sender', 'manual_thread'])
const MATCH_TYPES = new Set(['contains', 'exact', 'regex'])

function normalizeFields(input = {}) {
  const fields = {
    target_type: String(input.target_type || 'condition_group').trim(),
    account_id: String(input.account_id || '').trim(),
    email_address: String(input.email_address || '').trim(),
    account_conditions: normalizeList(input.account_conditions),
    keyword_conditions: normalizeList(input.keyword_conditions),
    subject_conditions: normalizeList(input.subject_conditions),
    condition_match_type: String(input.condition_match_type || 'contains').trim(),
    subject_match_type: String(input.subject_match_type || input.condition_match_type || '').trim() || null,
    subject_pattern: String(input.subject_pattern || '').trim(),
    sender_pattern: String(input.sender_pattern || '').trim(),
    enabled: input.enabled !== false,
    notify_telegram: input.notify_telegram !== false,
    auto_create_todos: input.auto_create_todos !== false,
    rag_enabled: input.rag_enabled !== false,
    analysis_enabled: input.analysis_enabled !== false,
  }

  if (!TARGET_TYPES.has(fields.target_type)) {
    const err = new Error('지원하지 않는 watch target 타입입니다.')
    err.status = 400
    throw err
  }
  if (!MATCH_TYPES.has(fields.condition_match_type)) {
    const err = new Error('condition_match_type은 contains, exact, regex만 가능합니다.')
    err.status = 400
    throw err
  }
  if (fields.subject_match_type && !MATCH_TYPES.has(fields.subject_match_type)) {
    const err = new Error('subject_match_type은 contains, exact, regex만 가능합니다.')
    err.status = 400
    throw err
  }

  if (fields.target_type === 'account' && !fields.account_id && !fields.email_address && fields.account_conditions.length === 0) {
    const err = new Error('계정 기준 watch target에는 account_id, email_address 또는 account_conditions가 필요합니다.')
    err.status = 400
    throw err
  }

  if (fields.target_type === 'subject' && !fields.subject_pattern && fields.subject_conditions.length === 0) {
    const err = new Error('제목 기준 watch target에는 subject_pattern 또는 subject_conditions가 필요합니다.')
    err.status = 400
    throw err
  }

  const hasGroup = fields.account_conditions.length || fields.keyword_conditions.length || fields.subject_conditions.length
  const hasLegacy = fields.account_id || fields.email_address || fields.subject_pattern
  if (!hasGroup && !hasLegacy) {
    const err = new Error('최소 하나 이상의 조건을 입력해야 합니다.')
    err.status = 400
    throw err
  }

  return fields
}

async function createWatchTarget({ tenantId, ownerUserId, input }) {
  return threadRepo.createWatchTarget({
    tenantId,
    ownerUserId,
    fields: normalizeFields(input),
  })
}

async function updateWatchTarget({ tenantId, id, ownerUserId, isSiteAdmin, input }) {
  return threadRepo.updateWatchTarget({
    tenantId,
    id,
    ownerUserId,
    isSiteAdmin,
    fields: normalizeFields(input),
  })
}

module.exports = {
  normalizeFields,
  createWatchTarget,
  updateWatchTarget,
}
