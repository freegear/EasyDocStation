const MAX_MESSAGES = 20
const MAX_AGE_DAYS = 90
const DECAY = 0.7

function messageTime(message) {
  const value = message.received_at || message.sent_at || message.created_at
  const time = value ? new Date(value).getTime() : Number.NaN
  return Number.isFinite(time) ? time : 0
}

function selectThreadScope(messages, { maxMessages = MAX_MESSAGES, maxAgeDays = MAX_AGE_DAYS } = {}) {
  const deduplicated = new Map()
  for (const message of Array.isArray(messages) ? messages : []) {
    const key = message.internet_message_id || message.provider_message_id || message.id
    if (key && !deduplicated.has(String(key))) deduplicated.set(String(key), message)
  }
  const sorted = [...deduplicated.values()].sort((a, b) => messageTime(b) - messageTime(a))
  if (!sorted.length) return []
  const newest = messageTime(sorted[0])
  const cutoff = newest - maxAgeDays * 86400000
  return sorted.filter(message => !messageTime(message) || messageTime(message) >= cutoff).slice(0, maxMessages)
}

function calculateThreadWeights(messageCount, decay = DECAY) {
  if (messageCount <= 0) return []
  const fixed = [0.5, 0.3, 0.1].slice(0, messageCount)
  if (messageCount <= 3) {
    const total = fixed.reduce((sum, value) => sum + value, 0)
    return fixed.map(value => value / total)
  }
  const tailRaw = Array.from({ length: messageCount - 3 }, (_, index) => decay ** index)
  const tailTotal = tailRaw.reduce((sum, value) => sum + value, 0)
  return [...fixed, ...tailRaw.map(value => value / tailTotal * 0.1)]
}

function buildWeightedThreadContext(messages, options) {
  const scoped = selectThreadScope(messages, options)
  const weights = calculateThreadWeights(scoped.length, options?.decay)
  return scoped.map((message, index) => ({
    ...message,
    rank: index + 1,
    weight: weights[index],
  }))
}

module.exports = { buildWeightedThreadContext, calculateThreadWeights, selectThreadScope }
