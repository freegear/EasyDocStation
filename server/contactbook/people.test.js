const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizePhone, normalizeEmail } = require('./people')

test('한국 전화번호 표시 형식을 E.164로 통일한다', () => {
  assert.equal(normalizePhone('010-1234-5678').normalized, '+821012345678')
  assert.equal(normalizePhone('+82 10 1234 5678').normalized, '+821012345678')
  assert.equal(normalizePhone('821012345678').normalized, '+821012345678')
})

test('내선은 비교 번호에서 분리한다', () => {
  assert.deepEqual(normalizePhone('02-1234-5678 ext. 42'), { normalized: '+82212345678', extension: '42' })
})

test('너무 짧거나 긴 번호는 자동 연결에 사용하지 않는다', () => {
  assert.equal(normalizePhone('1234').normalized, '')
  assert.equal(normalizePhone('+1234567890123456').normalized, '')
})

test('이메일 주소의 공백과 대소문자를 정규화한다', () => {
  assert.equal(normalizeEmail('  Person.Name+work@Example.COM '), 'person.name+work@example.com')
})

test('이메일 별칭 문자는 제거하지 않는다', () => {
  assert.notEqual(normalizeEmail('person.name@gmail.com'), normalizeEmail('personname@gmail.com'))
  assert.notEqual(normalizeEmail('person+work@gmail.com'), normalizeEmail('person@gmail.com'))
})

test('유효하지 않은 이메일은 자동 연결에 사용하지 않는다', () => {
  assert.equal(normalizeEmail('person'), '')
  assert.equal(normalizeEmail('@example.com'), '')
  assert.equal(normalizeEmail('person@example'), '')
})
