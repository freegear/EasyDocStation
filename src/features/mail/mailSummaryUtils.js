import { MAIL_TEXT } from './mailText'

export const MAIL_SUMMARY_NO_INFO = '확인된 내용 없음'

export function normalizeMailSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const schedule = value.schedule && typeof value.schedule === 'object' && !Array.isArray(value.schedule)
    ? value.schedule
    : {}
  const stringOrNoInfo = item => {
    const text = String(item ?? '').trim()
    return text || MAIL_SUMMARY_NO_INFO
  }
  const arrayOrNoInfo = item => {
    if (!Array.isArray(item)) return [MAIL_SUMMARY_NO_INFO]
    const rows = item.map(row => String(row ?? '').trim()).filter(Boolean)
    return rows.length ? rows : [MAIL_SUMMARY_NO_INFO]
  }
  const actions = Array.isArray(value.actionItems) ? value.actionItems : []
  const actionItems = actions.map(item => {
    if (typeof item === 'string') return { task: stringOrNoInfo(item), time: MAIL_SUMMARY_NO_INFO }
    if (!item || typeof item !== 'object') return null
    return {
      task: stringOrNoInfo(item.task),
      time: stringOrNoInfo(item.time),
      timeSource: String(item.timeSource || '').trim(),
      isAllDay: item.isAllDay === true,
      calendarEventId: String(item.calendarEventId || '').trim(),
    }
  }).filter(Boolean)

  return {
    schedule: {
      date: stringOrNoInfo(schedule.date),
      time: stringOrNoInfo(schedule.time),
      location: stringOrNoInfo(schedule.location),
      participants: stringOrNoInfo(schedule.participants),
      notes: stringOrNoInfo(schedule.notes),
    },
    keyPoints: arrayOrNoInfo(value.keyPoints),
    summary: stringOrNoInfo(value.summary),
    actionItems: actionItems.length ? actionItems : [{ task: MAIL_SUMMARY_NO_INFO, time: MAIL_SUMMARY_NO_INFO }],
  }
}

export function parseSummaryActionDateTime(value) {
  const text = String(value || '').trim()
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  if (match) {
    return {
      date: `${match[1]}-${match[2]}-${match[3]}`,
      time: `${match[4]}:${match[5]}`,
    }
  }
  const dateOnlyMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!dateOnlyMatch) return { date: '', time: '' }
  return {
    date: `${dateOnlyMatch[1]}-${dateOnlyMatch[2]}-${dateOnlyMatch[3]}`,
    time: '',
  }
}

export function formatSummaryActionTimeLabel(item, mt = MAIL_TEXT.ko) {
  const s = mt.summary
  const parsed = parseSummaryActionDateTime(item?.time)
  if (item?.isAllDay && parsed.date) return parsed.date
  return item?.time || s.noInfo
}

export function formatDraftSummaryActionTimeLabel(item, draft, mt = MAIL_TEXT.ko) {
  const s = mt.summary
  const saved = parseSummaryActionDateTime(item?.time)
  const date = draft?.date ?? saved.date
  const time = draft?.time ?? saved.time
  const isAllDay = draft?.isAllDay ?? item?.isAllDay === true
  if (isAllDay && date) return date
  if (date && time) return `${date} ${time}`
  return formatSummaryActionTimeLabel(item, mt) || s.noInfo
}

export function formatMailSummaryForCopy(summary, mt = MAIL_TEXT.ko) {
  if (!summary) return ''
  const s = mt.summary
  const scheduleRows = [
    [s.date, summary.schedule?.date],
    [s.time, summary.schedule?.time],
    [s.location, summary.schedule?.location],
    [s.participants, summary.schedule?.participants],
    [s.notes, summary.schedule?.notes],
  ]
  return [
    `${s.schedule}:`,
    ...scheduleRows.map(([label, value]) => `- ${label}: ${value || s.noInfo}`),
    '',
    s.keyPoints,
    ...(summary.keyPoints || [s.noInfo]).map(item => `- ${item}`),
    '',
    s.detail,
    summary.summary || s.noInfo,
    '',
    s.actions,
    ...(summary.actionItems || [{ task: s.noInfo, time: s.noInfo }])
      .map(item => `- ${item.task || s.noInfo}${item.time ? ` (${formatSummaryActionTimeLabel(item, mt)})` : ''}`),
  ].join('\n')
}
