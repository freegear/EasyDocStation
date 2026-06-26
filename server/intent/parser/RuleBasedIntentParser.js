const { ACTIONS, TARGETS, SCOPES, createEmptyIntent } = require('../schema/IntentSchema')

function getKstParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  }
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function toKstDateOnly(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`
}

function addDaysKst(dateOnly, days) {
  const date = new Date(`${dateOnly}T00:00:00+09:00`)
  date.setUTCDate(date.getUTCDate() + days)
  return getKstParts(date)
}

function parseDateExpression(question, now = new Date()) {
  const text = String(question || '').trim()
  const today = getKstParts(now)

  if (/오늘/.test(text)) {
    return { type: 'single_day', date: toKstDateOnly(today.year, today.month, today.day), source: '오늘' }
  }

  if (/어제/.test(text)) {
    const yesterday = addDaysKst(toKstDateOnly(today.year, today.month, today.day), -1)
    return { type: 'single_day', date: toKstDateOnly(yesterday.year, yesterday.month, yesterday.day), source: '어제' }
  }

  const monthDayMatch = text.match(/(?:(\d{1,2})\s*월\s*)?(\d{1,2})\s*일/)
  if (monthDayMatch) {
    const month = monthDayMatch[1] ? Number(monthDayMatch[1]) : today.month
    const day = Number(monthDayMatch[2])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return {
        type: 'single_day',
        date: toKstDateOnly(today.year, month, day),
        source: monthDayMatch[0],
      }
    }
  }

  return null
}

function parseAction(question) {
  return /(요약|정리|핵심|요점)/.test(question) ? ACTIONS.SUMMARIZE : null
}

function parseTarget(question) {
  return /(글|게시글|포스트|post)/i.test(question) ? TARGETS.POSTS : null
}

class RuleBasedIntentParser {
  parse(question, context = {}) {
    const intent = createEmptyIntent()
    const text = String(question || '').trim()

    intent.action = parseAction(text)
    intent.target = parseTarget(text)
    intent.scope = SCOPES.CURRENT_CHANNEL
    intent.date = parseDateExpression(text, context.now)

    const matchedSlots = [intent.action, intent.target, intent.date].filter(Boolean).length
    intent.confidence = matchedSlots / 3

    return intent
  }
}

module.exports = RuleBasedIntentParser
