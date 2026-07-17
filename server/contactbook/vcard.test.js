const test = require('node:test')
const assert = require('node:assert/strict')
const { parseVCard, updateVCard } = require('./vcard')
const { decodeXmlCharacterReferences } = require('./carddav')

test('iCloud XML line references do not leak into contact values', () => {
  const encoded = 'BEGIN:VCARD&#13;&#10;VERSION:3.0&#13;&#10;N:박;찬종;;;&#13;&#10;FN:#박찬종&#13;&#10;EMAIL;TYPE=INTERNET:cjpark@idecca.com&#13;&#10;TEL;TYPE=CELL:01089530119&#13;&#10;END:VCARD&#13;&#10;'
  const contact = parseVCard(decodeXmlCharacterReferences(encoded))
  assert.equal(contact.displayName, '#박찬종')
  assert.equal(contact.emails[0].value, 'cjpark@idecca.com')
  assert.equal(contact.phones[0].value, '01089530119')
  assert.equal(contact.searchText.includes('&#13;'), false)
})

test('decodes predefined XML references before parsing vCard values', () => {
  const encoded = 'BEGIN:VCARD&#13;&#10;VERSION:3.0&#13;&#10;FN:&quot;PH-CMYK Colour Co., Ltd&quot;&#13;&#10;ORG:A&amp;B&#13;&#10;END:VCARD&#13;&#10;'
  const contact = parseVCard(decodeXmlCharacterReferences(encoded))
  assert.equal(contact.displayName, '"PH-CMYK Colour Co., Ltd"')
  assert.equal(contact.organization, 'A&B')
})

test('decodes XML references exactly once to preserve literal entity text', () => {
  assert.equal(decodeXmlCharacterReferences('&amp;quot;'), '&quot;')
  assert.equal(decodeXmlCharacterReferences('&amp;amp;'), '&amp;')
})

test('decodes residual XML references in double-encoded vCard values', () => {
  const raw = ['BEGIN:VCARD', 'VERSION:3.0', 'N:장;경훈_IT&amp;T 대표이사;;;', 'FN:경훈_IT&amp;T 대표이사 장', 'ORG:IT&amp;T;', 'END:VCARD'].join('\r\n')
  const contact = parseVCard(raw)
  assert.equal(contact.displayName, '경훈_IT&T 대표이사 장')
  assert.equal(contact.givenName, '경훈_IT&T 대표이사')
  assert.equal(contact.familyName, '장')
  assert.equal(contact.organization, 'IT&T')
})

test('preserves Apple grouped labels, multiple types and preferred flag', () => {
  const raw = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Jane Doe', 'item1.EMAIL;TYPE=INTERNET,WORK,PREF:jane@example.com', 'item1.X-ABLabel:회사', 'TEL;TYPE=CELL;VALUE=uri:tel:+821012345678', 'END:VCARD'].join('\r\n')
  const contact = parseVCard(raw)
  assert.deepEqual(contact.emails[0].types, ['internet', 'work', 'pref'])
  assert.equal(contact.emails[0].label, '회사')
  assert.equal(contact.emails[0].preferred, true)
  assert.equal(contact.phones[0].value, '+821012345678')
})

test('decodes legacy quoted-printable UTF-8 values', () => {
  const raw = ['BEGIN:VCARD', 'VERSION:3.0', 'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=ED=99=8D=EA=B8=B8=EB=8F=99', 'EMAIL:test@example.com', 'END:VCARD'].join('\r\n')
  assert.equal(parseVCard(raw).displayName, '홍길동')
})

test('uses email when a contact has no FN or N', () => {
  const raw = ['BEGIN:VCARD', 'VERSION:4.0', 'EMAIL:only@example.com', 'END:VCARD'].join('\r\n')
  assert.equal(parseVCard(raw).displayName, 'only@example.com')
})

test('accepts legacy bare type parameters found in iCloud vCards', () => {
  const raw = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Legacy Contact', 'ADR;LABEL;WORK;PREF:Office address', 'END:VCARD'].join('\r\n')
  const contact = parseVCard(raw)
  assert.deepEqual(contact.addresses[0].types, ['label', 'work', 'pref'])
})

test('updates editable fields while preserving UID, parameters and unknown properties', () => {
  const raw = ['BEGIN:VCARD', 'VERSION:3.0', 'N:;장 재규 부회장님;;;', 'FN:장 재규 부회장님', 'UID:7244f7440e133efa', 'TEL;TYPE=HOME,PREF:010-5544-3277', 'X-PILOT-KEEP:yes', 'END:VCARD'].join('\r\n')
  const updated = updateVCard(raw, { displayName: '장 재규 부회장', familyName: '장', givenName: '재규', primaryPhone: '010-5544-3277' })
  const parsed = parseVCard(updated)
  assert.equal(parsed.displayName, '장 재규 부회장')
  assert.equal(parsed.familyName, '장')
  assert.equal(parsed.givenName, '재규')
  assert.equal(parsed.phones[0].value, '010-5544-3277')
  assert.match(updated, /UID:7244f7440e133efa/)
  assert.match(updated, /TEL;TYPE=HOME,PREF:/)
  assert.match(updated, /X-PILOT-KEEP:yes/)
})
