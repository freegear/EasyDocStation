const { ACTIONS, TARGETS, SCOPES } = require('../schema/IntentSchema')

function toDateRange(dateOnly) {
  const from = new Date(`${dateOnly}T00:00:00+09:00`)
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000)
  const nextDateOnly = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(to)

  return {
    from: `${dateOnly}T00:00:00+09:00`,
    to: `${nextDateOnly}T00:00:00+09:00`,
    timezone: 'Asia/Seoul',
  }
}

class IntentNormalizer {
  normalize(intent, context = {}) {
    const normalized = {
      action: intent.action || ACTIONS.SUMMARIZE,
      target: intent.target || TARGETS.POSTS,
      scope: intent.scope || SCOPES.CURRENT_CHANNEL,
      dateRange: intent.date?.date ? toDateRange(intent.date.date) : null,
      author: intent.author || null,
      keywords: Array.isArray(intent.keywords) ? intent.keywords : [],
      channelId: context.channelId || null,
      original: {
        date: intent.date || null,
        confidence: intent.confidence || 0,
      },
    }

    return normalized
  }
}

module.exports = IntentNormalizer
