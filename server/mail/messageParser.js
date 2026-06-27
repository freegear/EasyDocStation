// Gmail users.messages.get(format=full) 응답을 정규화한다. (순수 함수, DB/네트워크 의존 없음)

function decodeBase64Url(data) {
  if (!data) return Buffer.alloc(0)
  return Buffer.from(String(data), 'base64url')
}

function getHeader(headers, name) {
  const lower = name.toLowerCase()
  const found = (headers || []).find(h => String(h.name).toLowerCase() === lower)
  return found ? found.value : ''
}

// "Name <a@b.com>, other@c.com" → [{ name, email }]
function parseAddressList(value) {
  if (!value) return []
  const parts = []
  let buf = ''
  let depth = 0
  let quoted = false
  for (const ch of String(value)) {
    if (ch === '"') quoted = !quoted
    if (!quoted && (ch === '<' || ch === '(')) depth++
    if (!quoted && (ch === '>' || ch === ')')) depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0 && !quoted) {
      parts.push(buf)
      buf = ''
    } else {
      buf += ch
    }
  }
  if (buf.trim()) parts.push(buf)

  return parts.map(raw => {
    const s = raw.trim()
    const m = s.match(/^(.*?)<([^>]+)>$/)
    if (m) {
      return {
        name: m[1].trim().replace(/^"|"$/g, '').trim(),
        email: m[2].trim(),
      }
    }
    return { name: '', email: s.replace(/^"|"$/g, '').trim() }
  }).filter(a => a.email)
}

function parseDate(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

// payload 트리를 순회하며 본문(text/plain, text/html)과 첨부를 수집한다.
function walkParts(node, acc) {
  if (!node) return
  const mime = String(node.mimeType || '').toLowerCase()
  const filename = node.filename || ''
  const body = node.body || {}

  if (filename && body.attachmentId) {
    acc.attachments.push({
      providerAttachmentId: body.attachmentId,
      filename,
      contentType: node.mimeType || 'application/octet-stream',
      sizeBytes: Number(body.size || 0),
    })
  } else if (mime === 'text/plain' && body.data && acc.bodyText == null) {
    acc.bodyText = decodeBase64Url(body.data).toString('utf8')
  } else if (mime === 'text/html' && body.data && acc.bodyHtml == null) {
    acc.bodyHtml = decodeBase64Url(body.data).toString('utf8')
  }

  if (Array.isArray(node.parts)) {
    for (const child of node.parts) walkParts(child, acc)
  }
}

function parseGmailMessage(message) {
  const payload = message.payload || {}
  const headers = payload.headers || []
  const labelIds = message.labelIds || []

  const acc = { bodyText: null, bodyHtml: null, attachments: [] }
  walkParts(payload, acc)

  const from = parseAddressList(getHeader(headers, 'From'))[0] || { name: '', email: '' }

  return {
    providerMessageId: message.id,
    threadId: message.threadId || null,
    labelIds,
    subject: getHeader(headers, 'Subject') || '',
    fromEmail: from.email || null,
    fromName: from.name || null,
    to: parseAddressList(getHeader(headers, 'To')),
    cc: parseAddressList(getHeader(headers, 'Cc')),
    bcc: parseAddressList(getHeader(headers, 'Bcc')),
    snippet: message.snippet || '',
    receivedAt: message.internalDate ? new Date(Number(message.internalDate)) : null,
    sentAt: parseDate(getHeader(headers, 'Date')),
    isRead: !labelIds.includes('UNREAD'),
    isStarred: labelIds.includes('STARRED'),
    hasAttachments: acc.attachments.length > 0,
    sizeBytes: Number(message.sizeEstimate || 0),
    bodyText: acc.bodyText,
    bodyHtml: acc.bodyHtml,
    attachments: acc.attachments,
  }
}

module.exports = {
  parseGmailMessage,
  parseAddressList,
  decodeBase64Url,
}
