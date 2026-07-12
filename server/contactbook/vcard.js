function unfold(text) {
  return String(text || '').replace(/\r?\n[ \t]/g, '')
}

function decodeValue(value) {
  return String(value || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim()
}

function parseVCard(raw) {
  const fields = new Map()
  for (const line of unfold(raw).split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator < 1) continue
    const lhs = line.slice(0, separator)
    const value = decodeValue(line.slice(separator + 1))
    const [name, ...params] = lhs.split(';')
    const key = name.toUpperCase().split('.').pop()
    const entry = { value, params: params.join(';') }
    fields.set(key, [...(fields.get(key) || []), entry])
  }
  const all = key => (fields.get(key) || [])
  const first = key => all(key)[0]?.value || ''
  const structuredName = first('N').split(';')
  const org = first('ORG').split(';')
  const typed = key => all(key).map(item => ({
    value: item.value,
    type: (/TYPE=([^;:]+)/i.exec(item.params)?.[1] || '').split(',')[0].toLowerCase(),
  })).filter(item => item.value)
  const displayName = first('FN') || [structuredName[1], structuredName[0]].filter(Boolean).join(' ') || first('EMAIL')
  const result = {
    uid: first('UID'), displayName,
    givenName: structuredName[1] || '', familyName: structuredName[0] || '',
    nickname: first('NICKNAME'), organization: org[0] || '', department: org[1] || '',
    jobTitle: first('TITLE'), birthday: first('BDAY'), note: first('NOTE'),
    emails: typed('EMAIL'), phones: typed('TEL'), addresses: typed('ADR'), urls: typed('URL'),
  }
  result.searchText = [displayName, result.givenName, result.familyName, result.nickname,
    result.organization, result.department, result.jobTitle,
    ...result.emails.map(x => x.value), ...result.phones.map(x => x.value)]
    .join(' ').toLowerCase()
  return result
}

module.exports = { parseVCard }
