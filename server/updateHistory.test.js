const test = require('node:test')
const assert = require('node:assert/strict')

const { normalizeUpdateHistory } = require('./updateHistory')

test('normalizes and semantically sorts update history', () => {
  const result = normalizeUpdateHistory({
    'EasyDocStation Version': '0.5.10',
    '0.5.9': 'older',
    '0.5.10': 'current',
    '0.4.20': 'oldest',
  })
  assert.equal(result.currentVersion, '0.5.10')
  assert.deepEqual(result.releases.map(item => item.version), ['0.5.10', '0.5.9', '0.4.20'])
  assert.equal(result.releases[0].current, true)
})

test('requires a release entry for the current version', () => {
  assert.throws(() => normalizeUpdateHistory({
    'EasyDocStation Version': '0.5.8',
    '0.5.7': 'old',
  }), /현재 버전 0\.5\.8/)
})

test('preserves newline descriptions', () => {
  const result = normalizeUpdateHistory({
    'EasyDocStation Version': '0.5.8',
    '0.5.8': 'line one\nline two',
  })
  assert.equal(result.releases[0].description, 'line one\nline two')
})
