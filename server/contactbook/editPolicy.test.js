const test = require('node:test')
const assert = require('node:assert/strict')
const { canEditGoogleContact, canEditAppleContact, canEditContact, validateContactEdit } = require('./editPolicy')

test('all persisted Google resources are editable while non-Google resources stay locked', () => {
  assert.equal(canEditGoogleContact({ provider: 'GOOGLE', remote_uid: 'first-google-contact' }), true)
  assert.equal(canEditGoogleContact({ provider: 'GOOGLE', remote_uid: 'another-google-contact' }), true)
  assert.equal(canEditGoogleContact({ provider: 'GOOGLE', remote_uid: '' }), false)
  assert.equal(canEditGoogleContact({ provider: 'APPLE', remote_uid: 'apple-contact' }), false)
})

test('all persisted iCloud resources are editable while UID-less and generic resources stay locked', () => {
  assert.equal(canEditAppleContact({ provider: 'APPLE', remote_uid: '77F1AF06-4C43-472C-BF67-5CEA7258AC84' }), true)
  assert.equal(canEditAppleContact({ provider: 'APPLE', remote_uid: 'another-icloud-contact' }), true)
  assert.equal(canEditContact({ provider: 'APPLE', remote_uid: 'another-icloud-contact' }), true)
  assert.equal(canEditAppleContact({ provider: 'APPLE', remote_uid: '' }), false)
  assert.equal(canEditAppleContact({ provider: 'GENERIC_CARDDAV', remote_uid: 'generic-contact' }), false)
  assert.equal(canEditAppleContact({ provider: 'GOOGLE', remote_uid: 'google-contact' }), false)
})

test('contact edit requires a display name and normalizes text', () => {
  assert.equal(validateContactEdit({ displayName: '  장 재규  ', primaryPhone: ' 010 ' }).displayName, '장 재규')
  assert.throws(() => validateContactEdit({ displayName: ' ' }), /표시 이름/)
})
