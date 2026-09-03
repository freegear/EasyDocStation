const MAIL_SEARCH_FIELDS = new Set(['from', 'to', 'cc', 'subject', 'all', 'file'])

function normalizeSearchText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function normalizeEmail(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase()
}

function isEmailAddress(value) {
  const email = normalizeEmail(value)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function normalizeAddressList(value) {
  const rows = Array.isArray(value) ? value : []
  return rows.map(item => {
    if (typeof item === 'string') return { name: '', email: normalizeEmail(item) }
    return {
      name: normalizeSearchText(item?.name || item?.displayName || ''),
      email: normalizeEmail(item?.email || item?.address || ''),
    }
  }).filter(item => item.email || item.name)
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}

function buildMailSearchDocument({ subject, fromEmail, fromName, to, cc, bodyText, bodyHtml }) {
  const normalizedTo = normalizeAddressList(to)
  const normalizedCc = normalizeAddressList(cc)
  const cleanSubject = normalizeSearchText(subject)
  const cleanFromEmail = normalizeEmail(fromEmail)
  const cleanFromName = normalizeSearchText(fromName)
  const cleanBody = normalizeSearchText([bodyText, stripHtml(bodyHtml)].filter(Boolean).join(' '))
  const allText = normalizeSearchText([
    cleanFromName,
    cleanFromEmail,
    ...normalizedTo.flatMap(item => [item.name, item.email]),
    ...normalizedCc.flatMap(item => [item.name, item.email]),
    cleanSubject,
    cleanBody,
  ].filter(Boolean).join(' '))
  return {
    fromEmail: cleanFromEmail,
    toEmails: normalizedTo.map(item => item.email).filter(Boolean),
    ccEmails: normalizedCc.map(item => item.email).filter(Boolean),
    subjectText: cleanSubject,
    allText,
  }
}

function validateMailSearchInput(field, query) {
  const cleanField = String(field || 'all').trim().toLowerCase()
  const rawQuery = String(query || '').normalize('NFKC').trim()
  if (!MAIL_SEARCH_FIELDS.has(cleanField)) {
    const error = new Error('지원하지 않는 메일 검색 범위입니다.')
    error.status = 400
    error.code = 'INVALID_MAIL_SEARCH_FIELD'
    throw error
  }
  if (!rawQuery) {
    const error = new Error('검색어를 입력해주세요.')
    error.status = 400
    error.code = 'MAIL_SEARCH_QUERY_REQUIRED'
    throw error
  }
  if (rawQuery.length > 500) {
    const error = new Error('검색어는 500자까지 입력할 수 있습니다.')
    error.status = 400
    error.code = 'MAIL_SEARCH_QUERY_TOO_LONG'
    throw error
  }
  if (['from', 'to', 'cc'].includes(cleanField) && !isEmailAddress(rawQuery)) {
    const error = new Error('정확한 이메일 주소를 입력해주세요.')
    error.status = 400
    error.code = 'INVALID_MAIL_SEARCH_EMAIL'
    throw error
  }
  return {
    field: cleanField,
    query: ['from', 'to', 'cc'].includes(cleanField) ? normalizeEmail(rawQuery) : normalizeSearchText(rawQuery),
  }
}

module.exports = {
  MAIL_SEARCH_FIELDS,
  normalizeSearchText,
  normalizeEmail,
  isEmailAddress,
  buildMailSearchDocument,
  validateMailSearchInput,
}
