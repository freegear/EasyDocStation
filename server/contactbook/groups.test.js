const test = require('node:test')
const assert = require('node:assert/strict')
const { parseVCard } = require('./vcard')
const { normalizeMemberUid } = require('./groups')

test('iCloud vCard 3.0 그룹과 멤버 UID를 파싱한다', () => {
  const parsed = parseVCard('BEGIN:VCARD\r\nVERSION:3.0\r\nUID:group-1\r\nFN:5B2U\r\nX-ADDRESSBOOKSERVER-KIND:group\r\nX-ADDRESSBOOKSERVER-MEMBER:urn:uuid:CONTACT-1\r\nEND:VCARD\r\n')
  assert.equal(parsed.kind, 'group')
  assert.equal(parsed.displayName, '5B2U')
  assert.deepEqual(parsed.members, ['urn:uuid:CONTACT-1'])
})

test('vCard 4.0 표준 그룹 속성을 파싱한다', () => {
  const parsed = parseVCard('BEGIN:VCARD\r\nVERSION:4.0\r\nUID:group-2\r\nFN:Family\r\nKIND:group\r\nMEMBER:urn:uuid:contact-2\r\nEND:VCARD\r\n')
  assert.equal(parsed.kind, 'group')
  assert.deepEqual(parsed.members, ['urn:uuid:contact-2'])
})

test('그룹 멤버 UUID를 비교 형식으로 정규화한다', () => {
  assert.equal(normalizeMemberUid('URN:UUID:Contact-ABC'), 'contact-abc')
  assert.equal(normalizeMemberUid('mailto:person@example.com'), '')
})
