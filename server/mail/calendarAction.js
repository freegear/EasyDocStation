const { randomUUID } = require('crypto')
const db = require('../db')

const SOURCE_TYPE = 'mail_summary_action_item'
let sourceColumnMigrationPromise = null

function pad2(value) {
  return String(value).padStart(2, '0')
}

function parseDateParts(date) {
  const dateMatch = String(date || '').trim().match(/^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\.?$/)
  if (!dateMatch) return null
  return {
    year: Number(dateMatch[1]),
    month: Number(dateMatch[2]),
    day: Number(dateMatch[3]),
  }
}

function parseDateTime(date, time) {
  const dateParts = parseDateParts(date)
  const timeMatch = String(time || '').trim().match(/^(\d{2}):(\d{2})$/)
  if (!dateParts || !timeMatch) return null

  const { year, month, day } = dateParts
  const hour24 = Number(timeMatch[1])
  const minute = Number(timeMatch[2])
  const dateObj = new Date(year, month - 1, day, hour24, minute, 0, 0)
  if (
    dateObj.getFullYear() !== year ||
    dateObj.getMonth() !== month - 1 ||
    dateObj.getDate() !== day ||
    dateObj.getHours() !== hour24 ||
    dateObj.getMinutes() !== minute
  ) {
    return null
  }
  return dateObj
}

function parseDateOnly(date) {
  const dateParts = parseDateParts(date)
  if (!dateParts) return null

  const { year, month, day } = dateParts
  const dateObj = new Date(year, month - 1, day, 0, 0, 0, 0)
  if (
    dateObj.getFullYear() !== year ||
    dateObj.getMonth() !== month - 1 ||
    dateObj.getDate() !== day
  ) {
    return null
  }
  return dateObj
}

function toCalendarDt(dateObj) {
  const hour24 = dateObj.getHours()
  const hour12 = hour24 % 12 || 12
  return {
    year: dateObj.getFullYear(),
    month: dateObj.getMonth() + 1,
    day: dateObj.getDate(),
    ampm: hour24 < 12 ? '오전' : '오후',
    hour: hour12,
    minute: dateObj.getMinutes(),
  }
}

function compactText(value, fallback = '') {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text || fallback
}

function formatAddress(name, email) {
  const displayName = compactText(name)
  const address = compactText(email)
  if (displayName && address) return `${displayName} <${address}>`
  return displayName || address
}

function getClientOrigin() {
  return String(process.env.CLIENT_ORIGIN || 'http://localhost:5173').replace(/\/+$/, '')
}

function buildMailDeepLink({ message, targetLanguage = 'ko' }) {
  const url = new URL(getClientOrigin())
  url.searchParams.set('mailMessageId', String(message?.id || ''))
  url.searchParams.set('mailTenantId', String(message?.tenant_id || ''))
  url.searchParams.set('mailTargetLanguage', String(targetLanguage || 'ko'))
  return url.toString()
}

async function ensureMailSummarySourceColumns() {
  if (!sourceColumnMigrationPromise) {
    sourceColumnMigrationPromise = db.query(`
      ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT '';
      ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS source_message_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS source_summary_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS source_action_index INTEGER;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_events_mail_action_unique
        ON calendar_events(owner_id, source_type, source_message_id, source_summary_id, source_action_index)
        WHERE source_type = 'mail_summary_action_item';
    `).catch(err => {
      sourceColumnMigrationPromise = null
      throw err
    })
  }
  return sourceColumnMigrationPromise
}

async function upsertMailSummaryActionCalendarEvent({
  userId,
  message,
  summaryRow,
  actionIndex,
  actionItem,
  date,
  time,
  isAllDay = false,
  targetLanguage = 'ko',
}) {
  await ensureMailSummarySourceColumns()
  const start = isAllDay ? parseDateOnly(date) : parseDateTime(date, time)
  if (!start) {
    const err = new Error('INVALID_ACTION_ITEM_DATETIME')
    err.statusCode = 400
    throw err
  }

  const end = isAllDay
    ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 0, 0, 0, 0)
    : new Date(start.getTime() + 30 * 60 * 1000)
  const title = compactText(message?.subject, compactText(actionItem?.task, '메일 액션 아이템'))
  const actionText = compactText(actionItem?.task)
  const from = formatAddress(message?.from_name, message?.from_email)
  const mailLink = buildMailDeepLink({ message, targetLanguage })
  const memo = [
    '메일 요약 액션 아이템에서 생성된 일정입니다.',
    message?.subject ? `제목: ${message.subject}` : '',
    actionText ? `액션 아이템: ${actionText}` : '',
    from ? `보낸 사람: ${from}` : '',
    message?.received_at ? `메일 날짜: ${message.received_at}` : '',
    summaryRow?.summary_json?.summary ? `요약: ${summaryRow.summary_json.summary}` : '',
    '',
    '원본 메일 링크:',
    mailLink,
  ].filter(Boolean).join('\n')

  const sourceMessageId = String(message?.id || '')
  const sourceSummaryId = String(summaryRow?.id || '')
  const params = [userId, SOURCE_TYPE, sourceMessageId, sourceSummaryId, Number(actionIndex)]
  const existing = await db.query(
    `SELECT id
     FROM calendar_events
     WHERE owner_id = $1
       AND source_type = $2
       AND source_message_id = $3
       AND source_summary_id = $4
       AND source_action_index = $5
     LIMIT 1`,
    params,
  )

  const eventValues = {
    title,
    color: '#4f46e5',
    allDay: isAllDay === true,
    startDt: toCalendarDt(start),
    endDt: toCalendarDt(end),
    repeat: 'none',
    invitees: [],
    memo,
    securityLevel: 0,
    remindDt: {},
    remindRepeat: 'none',
  }

  if (existing.rows[0]) {
    const { rows } = await db.query(
      `UPDATE calendar_events
       SET title = $1,
           color = $2,
           all_day = $3,
           start_dt = $4,
           end_dt = $5,
           repeat = $6,
           invitees = $7,
           memo = $8,
           security_level = $9,
           remind_dt = $10,
           remind_repeat = $11,
           updated_at = NOW()
       WHERE owner_id = $12 AND id = $13
       RETURNING *`,
      [
        eventValues.title,
        eventValues.color,
        eventValues.allDay,
        JSON.stringify(eventValues.startDt),
        JSON.stringify(eventValues.endDt),
        eventValues.repeat,
        JSON.stringify(eventValues.invitees),
        eventValues.memo,
        eventValues.securityLevel,
        JSON.stringify(eventValues.remindDt),
        eventValues.remindRepeat,
        userId,
        existing.rows[0].id,
      ],
    )
    return serializeCalendarEvent(rows[0])
  }

  const { rows } = await db.query(
    `INSERT INTO calendar_events (
       id, owner_id, title, color, all_day, start_dt, end_dt, repeat, invitees, memo,
       security_level, remind_dt, remind_repeat, series_id,
       source_type, source_message_id, source_summary_id, source_action_index,
       created_at, updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14,
       $15, $16, $17, $18,
       NOW(), NOW()
     )
     RETURNING *`,
    [
      randomUUID(),
      userId,
      eventValues.title,
      eventValues.color,
      eventValues.allDay,
      JSON.stringify(eventValues.startDt),
      JSON.stringify(eventValues.endDt),
      eventValues.repeat,
      JSON.stringify(eventValues.invitees),
      eventValues.memo,
      eventValues.securityLevel,
      JSON.stringify(eventValues.remindDt),
      eventValues.remindRepeat,
      null,
      SOURCE_TYPE,
      sourceMessageId,
      sourceSummaryId,
      Number(actionIndex),
    ],
  )
  return serializeCalendarEvent(rows[0])
}

function serializeCalendarEvent(row) {
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    allDay: row.all_day === true,
    startDt: row.start_dt || {},
    endDt: row.end_dt || {},
    sourceType: row.source_type || '',
    sourceMessageId: row.source_message_id || '',
    sourceSummaryId: row.source_summary_id || '',
    sourceActionIndex: Number.isInteger(row.source_action_index) ? row.source_action_index : null,
  }
}

function formatActionTime(date, time, isAllDay = false) {
  const start = isAllDay ? parseDateOnly(date) : parseDateTime(date, time)
  if (!start) return ''
  const dateText = `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`
  if (isAllDay) return dateText
  return `${dateText} ${pad2(start.getHours())}:${pad2(start.getMinutes())}`
}

module.exports = {
  formatActionTime,
  upsertMailSummaryActionCalendarEvent,
}
