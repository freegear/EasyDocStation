export function normalizeAddressList(value) {
  if (!Array.isArray(value)) return []
  return value
    .map(item => ({
      name: String(item?.name || '').trim(),
      email: String(item?.email || item?.address || '').trim(),
    }))
    .filter(item => item.name || item.email)
}

export function formatAddress(address) {
  if (!address?.email) return address?.name || ''
  return address.name ? `${address.name} <${address.email}>` : address.email
}

export function addressListToInput(value) {
  return normalizeAddressList(value).map(formatAddress).join(', ')
}

export function addressListToSearchText(value) {
  return normalizeAddressList(value)
    .map(item => `${item.name} ${item.email}`.trim())
    .join(' ')
}

export function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function textToDraftHtml(value) {
  const lines = String(value || '').split(/\r?\n/)
  if (!lines.length) return ''
  return lines.map(line => `<p>${escapeHtml(line) || '<br>'}</p>`).join('')
}

export function getDraftComposeData(message, accountId) {
  const text = message?.body_text || message?.snippet || ''
  return {
    draftId: message?.id || '',
    accountId: message?.account_id || accountId || '',
    to: addressListToInput(message?.to_json),
    cc: addressListToInput(message?.cc_json),
    bcc: addressListToInput(message?.bcc_json),
    subject: message?.subject || '',
    html: message?.body_html || textToDraftHtml(text),
    text,
  }
}

export function addSubjectPrefix(subject, prefix) {
  const value = String(subject || '').trim() || '(제목 없음)'
  const pattern = new RegExp(`^${prefix.replace(':', '')}\\s*:`, 'i')
  return pattern.test(value) ? value : `${prefix} ${value}`
}

export function normalizeMailThreadSubject(subject) {
  let value = String(subject || '').trim()
  let previous
  do {
    previous = value
    value = value.replace(/^\s*(re|fw|fwd)\s*:\s*/i, '')
  } while (value !== previous)
  return value.replace(/\s+/g, ' ').trim()
}

export function uniqueAddresses(addresses, excludedEmails = new Set()) {
  const seen = new Set()
  return normalizeAddressList(addresses).filter(address => {
    const email = String(address.email || '').trim().toLowerCase()
    const key = email || String(address.name || '').trim().toLowerCase()
    if (!key || excludedEmails.has(email) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function formatOriginalDate(message) {
  const value = message?.received_at || message?.sent_at || message?.created_at || ''
  if (!value) return '-'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return String(value)
  }
}

export function buildOriginalMessageHtml(message, mode) {
  const from = formatAddress({ name: message?.from_name || '', email: message?.from_email || '' }) || '-'
  const to = addressListToInput(message?.to_json) || '-'
  const cc = addressListToInput(message?.cc_json)
  const subject = message?.subject || '(제목 없음)'
  const body = message?.body_html || textToDraftHtml(message?.body_text || message?.snippet || '')
  const title = mode === 'forward' ? '-----Forwarded Message-----' : '-----Original Message-----'
  const ccLine = cc ? `<br><b>Cc:</b> ${escapeHtml(cc)}` : ''

  return [
    '<p><br></p>',
    `<p>${escapeHtml(title)}<br>`,
    `<b>From:</b> ${escapeHtml(from)}<br>`,
    `<b>To:</b> ${escapeHtml(to)}${ccLine}<br>`,
    `<b>Date:</b> ${escapeHtml(formatOriginalDate(message))}<br>`,
    `<b>Subject:</b> ${escapeHtml(subject)}</p>`,
    '<div>',
    body,
    '</div>',
  ].join('')
}

export function getMailActionComposeData(message, action, accountId) {
  const from = uniqueAddresses([{ name: message?.from_name || '', email: message?.from_email || '' }])
  const originalTo = normalizeAddressList(message?.to_json)
  const originalCc = normalizeAddressList(message?.cc_json)
  const isForward = action === 'forward'
  const isReplyAll = action === 'replyAll'

  return {
    accountId: message?.account_id || accountId || '',
    draftId: '',
    to: isForward
      ? ''
      : addressListToInput(isReplyAll ? uniqueAddresses([...from, ...originalTo]) : from),
    cc: isReplyAll ? addressListToInput(uniqueAddresses(originalCc)) : '',
    bcc: '',
    subject: addSubjectPrefix(message?.subject, isForward ? 'FWD:' : 'RE:'),
    html: buildOriginalMessageHtml(message, isForward ? 'forward' : 'reply'),
    text: '',
    focusEmptyTop: true,
  }
}
