const DEFAULT_MAILCLAW_TRASH_RULE_NAME = 'MailClaw 휴지통 이동'

function normalize(value) {
  return String(value || '').trim().toLowerCase()
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function isCompleteEmailAddress(value) {
  const email = normalize(value)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function oneOfContains(haystack, needles) {
  const source = normalize(haystack)
  return asArray(needles).some(item => {
    const needle = normalize(item)
    return needle && source.includes(needle)
  })
}

function anyAddressMatches(addresses, conditions, { requireCompleteEmail = false } = {}) {
  const normalizedAddresses = addresses.map(normalize).filter(Boolean)
  const normalizedConditions = asArray(conditions)
    .map(normalize)
    .filter(condition => condition && (!requireCompleteEmail || isCompleteEmailAddress(condition)))
  if (!normalizedConditions.length) return false
  return normalizedAddresses.some(address => (
    normalizedConditions.some(condition => address === condition || address.includes(condition))
  ))
}

function addressEmails(value) {
  return asArray(value).map(item => normalize(item?.email || item)).filter(Boolean)
}

function matchRule(rule, message) {
  const activeConditions = [
    rule.sender_check_enabled,
    rule.recipient_check_enabled,
    rule.cc_check_enabled,
    rule.keyword_check_enabled,
  ].filter(Boolean).length
  if (activeConditions === 0) return false

  if (rule.sender_check_enabled) {
    const requireCompleteEmail = normalize(rule.name) === normalize(DEFAULT_MAILCLAW_TRASH_RULE_NAME)
    if (!anyAddressMatches([message.from_email], rule.sender_conditions, { requireCompleteEmail })) return false
  }
  if (rule.recipient_check_enabled) {
    if (!anyAddressMatches(addressEmails(message.to_json), rule.recipient_conditions)) return false
  }
  if (rule.cc_check_enabled) {
    if (!anyAddressMatches(addressEmails(message.cc_json), rule.cc_conditions)) return false
  }
  if (rule.keyword_check_enabled) {
    if (!oneOfContains(message.subject, rule.keyword_conditions)) return false
  }
  return true
}

module.exports = {
  isCompleteEmailAddress,
  anyAddressMatches,
  matchRule,
}
