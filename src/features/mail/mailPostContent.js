import { MAIL_TEXT } from './mailText'

export function buildMailDeepLinkClient(message, targetLanguage = 'ko') {
  if (typeof window === 'undefined' || !message?.id || !message?.tenant_id) return ''
  const url = new URL(window.location.origin)
  url.searchParams.set('mailMessageId', String(message.id))
  url.searchParams.set('mailTenantId', String(message.tenant_id))
  url.searchParams.set('mailTargetLanguage', String(targetLanguage || 'ko'))
  return url.toString()
}

function mailScheduleValue(value, noInfo) {
  const text = String(value ?? '').trim()
  return text && text !== noInfo ? text : noInfo
}

export function buildMailPostContent(message, summary, mt = MAIL_TEXT.ko, deepLink = '') {
  if (!message) return ''
  const s = mt.summary
  const from = [message.from_name, message.from_email].filter(Boolean).join(' ').trim()
  const date = message.received_at ? new Date(message.received_at).toLocaleString() : ''
  const lines = [`## ${message.subject || mt.noSubject}`, '']
  if (from) lines.push(`**${mt.from}** ${from}  `)
  if (date) lines.push(`**${mt.date}** ${date}`)
  lines.push('')

  if (summary) {
    const sc = summary.schedule || {}
    lines.push(`### ${s.schedule}`, '')
    lines.push('| ' + s.date + ' | ' + s.time + ' | ' + s.location + ' | ' + s.participants + ' | ' + s.notes + ' |')
    lines.push('|---|---|---|---|---|')
    lines.push('| ' + [sc.date, sc.time, sc.location, sc.participants, sc.notes]
      .map(v => mailScheduleValue(v, s.noInfo)).join(' | ') + ' |')
    lines.push('')
    lines.push(`### ${s.keyPoints}`, '')
    ;(summary.keyPoints || [s.noInfo]).forEach(item => lines.push(`- ${item}`))
    lines.push('')
    lines.push(`### ${s.detail}`, '', summary.summary || s.noInfo, '')
    lines.push(`### ${s.actions}`, '')
    ;(summary.actionItems || [{ task: s.noInfo, time: s.noInfo }]).forEach(item => {
      const time = mailScheduleValue(item.time, s.noInfo)
      lines.push(`- ${item.task || s.noInfo}${time !== s.noInfo ? ` — ${time}` : ''}`)
    })
  } else {
    lines.push(String(message.body_text || message.snippet || '').trim())
  }

  if (deepLink) {
    lines.push('', '---', '', `👉 [${mt.postDialog.openOriginalMail}](${deepLink})`)
  }
  return lines.join('\n').trim()
}

export function buildMailCardData(message, summary, deepLink, targetLanguage = 'ko') {
  const from = [message?.from_name, message?.from_email].filter(Boolean).join(' ').trim()
  const date = message?.received_at ? new Date(message.received_at).toLocaleString() : ''
  return {
    v: 1,
    subject: message?.subject || '',
    from,
    date,
    messageId: String(message?.id || ''),
    tenantId: String(message?.tenant_id || ''),
    targetLanguage: targetLanguage || 'ko',
    deepLink: deepLink || '',
    summary: summary || null,
    bodyHtml: String(message?.body_html || ''),
    bodyText: String(message?.body_text || message?.snippet || ''),
  }
}
