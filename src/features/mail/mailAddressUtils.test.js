import test from 'node:test'
import assert from 'node:assert/strict'

import { isValidEmailAddress, parseAddressInput, serializeAddressInput } from './mailAddressUtils.js'

test('parseAddressInput parses plain and named recipients', () => {
  assert.deepEqual(
    parseAddressInput('홍길동 <hong@example.com>, kim@example.com'),
    [
      { name: '홍길동', email: 'hong@example.com' },
      { name: '', email: 'kim@example.com' },
    ],
  )
})

test('parseAddressInput preserves commas in a quoted display name', () => {
  assert.deepEqual(
    parseAddressInput('"Doe, Jane" <jane@example.com>; bob@example.com'),
    [
      { name: 'Doe, Jane', email: 'jane@example.com' },
      { name: '', email: 'bob@example.com' },
    ],
  )
})

test('recipient serialization remains compatible with the mail API', () => {
  assert.equal(
    serializeAddressInput([{ name: '장지영', email: 'jang@example.com' }, { email: 'kim@example.com' }]),
    '장지영 <jang@example.com>, kim@example.com',
  )
})

test('email validation rejects incomplete addresses', () => {
  assert.equal(isValidEmailAddress('valid@example.com'), true)
  assert.equal(isValidEmailAddress('missing-at.example.com'), false)
  assert.equal(isValidEmailAddress('missing-domain@'), false)
})
