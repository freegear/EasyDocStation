const ICAL = require('ical.js')

function decodeBytes(buffer, charset = 'utf-8') {
  const normalized = String(charset || 'utf-8').trim().toLowerCase().replace(/^utf8$/, 'utf-8')
  try { return new TextDecoder(normalized).decode(buffer) } catch { return new TextDecoder('utf-8').decode(buffer) }
}

function decodeQuotedPrintable(value, charset) {
  const bytes = []
  for (let index = 0; index < value.length; index += 1) {
    const match = /^=([0-9a-f]{2})/i.exec(value.slice(index))
    if (match) { bytes.push(Number.parseInt(match[1], 16)); index += 2 } else bytes.push(...Buffer.from(value[index]))
  }
  return decodeBytes(Uint8Array.from(bytes), charset)
}

function decodeLegacyEncodings(raw) {
  const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n')
  const output = []
  for (let index = 0; index < lines.length; index += 1) {
    const separator = lines[index].indexOf(':')
    if (separator < 1) { output.push(lines[index]); continue }
    const originalLhs = lines[index].slice(0, separator)
    const lhsParts = originalLhs.split(';')
    const bareTypes = lhsParts.slice(1).filter(part => part && !part.includes('='))
    const lhs = bareTypes.length
      ? [lhsParts[0], ...lhsParts.slice(1).filter(part => !bareTypes.includes(part)), `TYPE=${bareTypes.join(',')}`].join(';')
      : originalLhs
    const encoding = /(?:^|;)ENCODING=(?:"?)(QUOTED-PRINTABLE|B|BASE64)(?:"?)(?=;|$)/i.exec(lhs)?.[1]?.toUpperCase()
    if (!encoding) { output.push(`${lhs}:${lines[index].slice(separator + 1)}`); continue }
    const propertyName = lhs.split(';')[0].split('.').pop().toUpperCase()
    if (['PHOTO', 'LOGO', 'SOUND', 'KEY'].includes(propertyName)) { output.push(lines[index]); continue }
    const charset = /(?:^|;)CHARSET=(?:"?)([^;" ]+)(?:"?)(?=;|$)/i.exec(lhs)?.[1] || 'utf-8'
    let encoded = lines[index].slice(separator + 1)
    if (encoding === 'QUOTED-PRINTABLE') {
      while (encoded.endsWith('=') && index + 1 < lines.length) encoded = encoded.slice(0, -1) + lines[++index]
    }
    const cleanLhs = lhs
      .replace(/;ENCODING=(?:"?)(?:QUOTED-PRINTABLE|B|BASE64)(?:"?)(?=;|$)/ig, '')
      .replace(/;CHARSET=(?:"?)[^;" ]+(?:"?)(?=;|$)/ig, '')
    const decoded = encoding === 'QUOTED-PRINTABLE'
      ? decodeQuotedPrintable(encoded, charset)
      : decodeBytes(Buffer.from(encoded.replace(/\s/g, ''), 'base64'), charset)
    output.push(`${cleanLhs}:${decoded}`)
  }
  return output.join('\n')
}

function normalizeVCard(raw) {
  return decodeResidualXmlReferences(decodeLegacyEncodings(raw)).replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n')
}

function parameterValues(property, name) {
  const value = property.getParameter(name)
  return (Array.isArray(value) ? value : value ? [value] : []).map(item => String(item).toLowerCase())
}

function propertyGroup(property) {
  const json = property.toJSON()
  return String(json?.[1]?.group || '')
}

function decodeResidualXmlReferences(value) {
  const predefined = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' }
  return String(value == null ? '' : value).replace(/&(?:#x([0-9a-f]+)|#(\d+)|(quot|apos|amp|lt|gt));/gi, (matched, hex, decimal, named) => {
    if (named) return predefined[named.toLowerCase()]
    const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10)
    if (!Number.isInteger(codePoint) || codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return matched
    return String.fromCodePoint(codePoint)
  })
}

function cleanValue(value) {
  return decodeResidualXmlReferences(value).replace(/\r/g, '').trim()
}

function structured(value) {
  return Array.isArray(value) ? value.map(cleanValue) : cleanValue(value).split(';')
}

function parseVCard(raw) {
  const component = new ICAL.Component(ICAL.parse(normalizeVCard(raw)))
  const first = name => cleanValue(component.getFirstPropertyValue(name))
  const structuredName = structured(component.getFirstPropertyValue('n') || [])
  const org = structured(component.getFirstPropertyValue('org') || [])
  const labels = new Map(component.getAllProperties('x-ablabel').map(property => [propertyGroup(property), cleanValue(property.getFirstValue())]))
  const typed = name => component.getAllProperties(name).map(property => {
    const types = parameterValues(property, 'type')
    const group = propertyGroup(property)
    let value = cleanValue(property.getFirstValue())
    if (name === 'tel') value = value.replace(/^tel:/i, '')
    return {
      value,
      type: types.find(type => !['pref', 'internet'].includes(type)) || types[0] || '',
      types,
      label: labels.get(group) || '',
      preferred: types.includes('pref') || String(property.getParameter('pref') || '') === '1',
    }
  }).filter(item => item.value)
  const emails = typed('email')
  const phones = typed('tel')
  const kind = (first('kind') || first('x-addressbookserver-kind') || 'individual').toLowerCase()
  const members = [
    ...component.getAllProperties('member'),
    ...component.getAllProperties('x-addressbookserver-member'),
  ].map(property => cleanValue(property.getFirstValue())).filter(Boolean)
  const displayName = first('fn') || [structuredName[1], structuredName[0]].filter(Boolean).join(' ') || emails[0]?.value || ''
  const result = {
    uid: first('uid'), displayName, kind, members,
    givenName: structuredName[1] || '', familyName: structuredName[0] || '',
    nickname: first('nickname'), organization: org[0] || '', department: org[1] || '',
    jobTitle: first('title'), birthday: first('bday'), note: first('note'),
    emails, phones, addresses: typed('adr'), urls: typed('url'),
  }
  result.searchText = [displayName, result.givenName, result.familyName, result.nickname,
    result.organization, result.department, result.jobTitle,
    ...result.emails.map(x => x.value), ...result.phones.map(x => x.value)]
    .join(' ').toLowerCase()
  return result
}

function updateFirstProperty(component, name, value) {
  const property = component.getFirstProperty(name)
  if (!value) {
    if (property) component.removeProperty(property)
    return
  }
  if (property) property.setValue(value)
  else component.addPropertyWithValue(name, value)
}

function updateVCard(raw, fields) {
  const component = new ICAL.Component(ICAL.parse(normalizeVCard(raw)))
  const currentName = structured(component.getFirstPropertyValue('n') || [])
  const currentOrg = structured(component.getFirstPropertyValue('org') || [])
  component.updatePropertyWithValue('fn', cleanValue(fields.displayName))
  component.updatePropertyWithValue('n', [cleanValue(fields.familyName), cleanValue(fields.givenName), ...currentName.slice(2, 5)])
  if (fields.organization || fields.department || component.getFirstProperty('org')) {
    component.updatePropertyWithValue('org', [cleanValue(fields.organization), cleanValue(fields.department), ...currentOrg.slice(2)])
  }
  updateFirstProperty(component, 'title', cleanValue(fields.jobTitle))
  updateFirstProperty(component, 'nickname', cleanValue(fields.nickname))
  updateFirstProperty(component, 'note', cleanValue(fields.note))
  updateFirstProperty(component, 'email', cleanValue(fields.primaryEmail))
  updateFirstProperty(component, 'tel', cleanValue(fields.primaryPhone))
  return component.toString()
}

module.exports = { parseVCard, updateVCard }
