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

function normalizeResourceTypes(action, target) {
  if (action !== ACTIONS.LOCATE) return []
  if (target === TARGETS.IMAGE) return ['image_attachment']
  if (target === TARGETS.DIAGRAM) return ['image_attachment', 'presentation']
  if (target === TARGETS.ATTACHMENTS) return ['attachment']
  return []
}

function normalizeSemanticHints(action, target) {
  if (action !== ACTIONS.LOCATE) return []
  if (target === TARGETS.IMAGE) return ['이미지', '사진', '그림', '스크린샷', '캡처', 'image', 'photo', 'picture', 'screenshot']
  if (target === TARGETS.DIAGRAM) return ['블럭도', '블록도', '도면', '회로도', '다이어그램', 'block diagram']
  return []
}

class IntentNormalizer {
  normalize(intent, context = {}) {
    const action = intent.action || ACTIONS.SUMMARIZE
    const target = intent.target || (action === ACTIONS.LOCATE ? TARGETS.RESOURCES : TARGETS.POSTS)
    const normalized = {
      action,
      target,
      scope: intent.scope || SCOPES.CURRENT_CHANNEL,
      dateRange: intent.date?.date ? toDateRange(intent.date.date) : null,
      author: intent.author || null,
      keywords: Array.isArray(intent.keywords) ? intent.keywords : [],
      matchMode: intent.matchMode || (action === ACTIONS.LOCATE ? 'keyword_contains' : null),
      semanticHints: normalizeSemanticHints(action, target),
      resourceTypes: normalizeResourceTypes(action, target),
      channelId: context.channelId || null,
      responseMode: action === ACTIONS.LOCATE ? 'post_link' : 'summary',
      linkType: action === ACTIONS.LOCATE ? 'frontend_deeplink' : null,
      original: {
        date: intent.date || null,
        confidence: intent.confidence || 0,
      },
    }

    return normalized
  }
}

module.exports = IntentNormalizer
