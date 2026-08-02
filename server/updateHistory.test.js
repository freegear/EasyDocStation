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
  assert.deepEqual(result.releases[0].descriptionItems, ['line one\nline two'])
  assert.equal(result.releases[0].descriptionType, 'text')
})

test('accepts an array of release notes and preserves item order', () => {
  const result = normalizeUpdateHistory({
    'EasyDocStation Version': '0.5.16',
    '0.5.16': [
      '게시글, 댓글 프린트 기능을 추가 함.',
      '이미지가 한 페이지를 넘기면 한 페이지에 맞춤.',
      '테스트용 글',
    ],
    '0.5.15': '이전 버전',
  })
  assert.equal(result.releases[0].descriptionType, 'list')
  assert.deepEqual(result.releases[0].descriptionItems, [
    '게시글, 댓글 프린트 기능을 추가 함.',
    '이미지가 한 페이지를 넘기면 한 페이지에 맞춤.',
    '테스트용 글',
  ])
  assert.equal(result.releases[0].description, '게시글, 댓글 프린트 기능을 추가 함.\n이미지가 한 페이지를 넘기면 한 페이지에 맞춤.\n테스트용 글')
})

test('rejects empty or non-string release note array items', () => {
  assert.throws(() => normalizeUpdateHistory({
    'EasyDocStation Version': '0.5.16',
    '0.5.16': ['정상 항목', '  '],
  }), /문자열 또는 문자열 배열/)
  assert.throws(() => normalizeUpdateHistory({
    'EasyDocStation Version': '0.5.16',
    '0.5.16': ['정상 항목', 123],
  }), /문자열 또는 문자열 배열/)
})
