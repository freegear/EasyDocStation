const test = require('node:test')
const assert = require('node:assert/strict')

const {
  calculateBackoffMs,
  isBackoffActive,
  readBoundedMs,
} = require('./schedulerPolicy')

test('calculateBackoffMs applies exponential delay and maximum cap', () => {
  const options = { baseMs: 5 * 60 * 1000, maxMs: 60 * 60 * 1000 }
  assert.equal(calculateBackoffMs(1, options), 5 * 60 * 1000)
  assert.equal(calculateBackoffMs(2, options), 10 * 60 * 1000)
  assert.equal(calculateBackoffMs(3, options), 20 * 60 * 1000)
  assert.equal(calculateBackoffMs(5, options), 60 * 60 * 1000)
  assert.equal(calculateBackoffMs(20, options), 60 * 60 * 1000)
})

test('isBackoffActive preserves retry state across scheduler process starts', () => {
  const now = new Date('2026-07-29T00:00:00.000Z')
  assert.equal(isBackoffActive({ sync_retry_after: '2026-07-29T00:05:00.000Z' }, now), true)
  assert.equal(isBackoffActive({ sync_retry_after: '2026-07-28T23:59:59.000Z' }, now), false)
  assert.equal(isBackoffActive({ sync_retry_after: null }, now), false)
})

test('readBoundedMs rejects invalid values and clamps valid values', () => {
  assert.equal(readBoundedMs('invalid', 300, { min: 100, max: 1000 }), 300)
  assert.equal(readBoundedMs('10', 300, { min: 100, max: 1000 }), 100)
  assert.equal(readBoundedMs('5000', 300, { min: 100, max: 1000 }), 1000)
})
