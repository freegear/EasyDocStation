const crypto = require('crypto')

function normalizeSubject(subject) {
  let value = String(subject || '').trim()
  let previous
  do {
    previous = value
    value = value.replace(/^\s*(re|fw|fwd)\s*:\s*/i, '')
  } while (value !== previous)
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeToken(value) {
  return String(value || '').trim().toLowerCase()
}

function normalizeList(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))]
    : []
}

function matchText(haystack, needle, mode = 'contains') {
  const raw = String(needle || '').trim()
  if (!raw) return false
  const source = String(haystack || '')
  if (mode === 'regex') {
    try {
      return new RegExp(raw, 'i').test(source)
    } catch {
      return false
    }
  }
  if (mode === 'exact') return normalizeToken(source) === normalizeToken(raw)
  return normalizeToken(source).includes(normalizeToken(raw))
}

function addressEmails(value) {
  if (!Array.isArray(value)) return []
  return value.map(item => String(item?.email || item?.address || '').trim()).filter(Boolean)
}

function participantFingerprint(message) {
  const participants = [
    message.from_email,
    ...addressEmails(message.to_json),
    ...addressEmails(message.cc_json),
    ...addressEmails(message.bcc_json),
  ].map(normalizeToken).filter(Boolean).sort()
  return [...new Set(participants)].join('|')
}

function messageSearchText(message, bodyText = '') {
  return [
    message.subject,
    message.snippet,
    bodyText,
    message.from_email,
    addressEmails(message.to_json).join(' '),
    addressEmails(message.cc_json).join(' '),
  ].filter(Boolean).join('\n')
}

function matchWatchTarget(target, message, bodyText = '') {
  if (!target?.enabled) return false
  const mode = target.condition_match_type || 'contains'
  const subjectMode = target.subject_match_type || target.condition_match_type || 'contains'
  const accountConditions = normalizeList(target.account_conditions)
  const keywordConditions = normalizeList(target.keyword_conditions)
  const subjectConditions = normalizeList(target.subject_conditions)
  const normalizedSubject = normalizeSubject(message.subject)
  const accountCandidates = [
    message.account_id,
    message.account_email,
    target.email_address,
  ].map(normalizeToken).filter(Boolean)

  if (target.target_type === 'account') {
    const key = normalizeToken(target.account_id || target.email_address)
    if (key && !accountCandidates.includes(key)) return false
  }

  if (target.target_type === 'subject' && target.subject_pattern) {
    if (!matchText(normalizedSubject, target.subject_pattern, target.subject_match_type || 'contains')) return false
  }

  if (accountConditions.length > 0) {
    const ok = accountConditions.some(condition => accountCandidates.includes(normalizeToken(condition)))
    if (!ok) return false
  }

  if (keywordConditions.length > 0) {
    const text = messageSearchText(message, bodyText)
    const ok = keywordConditions.some(condition => matchText(text, condition, mode))
    if (!ok) return false
  }

  if (subjectConditions.length > 0) {
    const ok = subjectConditions.some(condition => matchText(normalizedSubject, condition, subjectMode))
    if (!ok) return false
  }

  return true
}

function buildAgenticThreadId({ tenantId, accountId, providerThreadId, normalizedSubject, participantKey }) {
  if (providerThreadId) return `mail_thread:${tenantId}:${accountId}:${providerThreadId}`
  const hash = crypto
    .createHash('sha256')
    .update(`${normalizeToken(normalizedSubject)}|${participantKey || ''}`)
    .digest('hex')
    .slice(0, 32)
  return `mail_thread:${tenantId}:${accountId}:${hash}`
}

function inferDirection(message) {
  const from = normalizeToken(message.from_email)
  const account = normalizeToken(message.account_email)
  return from && account && from === account ? 'outbound' : 'inbound'
}

module.exports = {
  normalizeSubject,
  normalizeList,
  matchWatchTarget,
  participantFingerprint,
  buildAgenticThreadId,
  inferDirection,
}
