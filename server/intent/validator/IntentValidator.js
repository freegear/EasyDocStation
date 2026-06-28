const { ACTIONS, TARGETS, SCOPES } = require('../schema/IntentSchema')
const db = require('../../db')
const { ACCESS_DENIED_MESSAGE, canAccessChannel } = require('../../lib/channelAccess')

class IntentValidator {
  async validate(intent, context = {}) {
    const errors = []
    const validTargets = new Set(Object.values(TARGETS))

    if (![ACTIONS.SUMMARIZE, ACTIONS.LOCATE].includes(intent.action)) errors.push('지원하지 않는 action입니다.')
    if (!validTargets.has(intent.target)) errors.push('지원하지 않는 target입니다.')
    if (intent.action === ACTIONS.SUMMARIZE && intent.target !== TARGETS.POSTS) errors.push('요약은 게시글만 지원합니다.')
    if (intent.scope !== SCOPES.CURRENT_CHANNEL) errors.push('지원하지 않는 scope입니다.')
    if (!intent.channelId) errors.push('channelId가 필요합니다.')
    if (intent.action === ACTIONS.SUMMARIZE && (!intent.dateRange?.from || !intent.dateRange?.to)) {
      errors.push('날짜 범위를 이해하지 못했습니다.')
    }
    if (intent.action === ACTIONS.LOCATE && (!Array.isArray(intent.keywords) || intent.keywords.length === 0)) {
      errors.push('찾을 자료의 키워드를 이해하지 못했습니다.')
    }

    if (intent.dateRange?.from && intent.dateRange?.to) {
      const from = new Date(intent.dateRange.from)
      const to = new Date(intent.dateRange.to)
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
        errors.push('날짜 범위가 올바르지 않습니다.')
      }
    }

    if (errors.length > 0) {
      return { status: 'invalid', errors }
    }

    const allowed = await canAccessChannel(db, context.user, intent.channelId)
    if (!allowed) {
      return { status: 'invalid', errors: [ACCESS_DENIED_MESSAGE], code: 'ACCESS_DENIED' }
    }

    return { status: 'valid', errors: [] }
  }
}

module.exports = IntentValidator
