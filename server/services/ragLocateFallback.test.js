const test = require('node:test')
const assert = require('node:assert/strict')

// 순수 순위 함수 테스트에서 애플리케이션 DB 초기화가 실행되지 않게 한다.
const dbPath = require.resolve('../db')
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: async () => ({ rows: [] }) },
}

const {
  rankLocateReferences,
  deduplicateLocateReferences,
} = require('./ragLocateFallback')

test('자료 찾기는 파일명과 문서 종류가 일치하는 현재 채널 문서를 우선한다', () => {
  const refs = [
    { file_name: '정관(수정).pdf', document_kind: '', channel_id: 'other', score: 0.72 },
    { file_name: 'SC_주주명부-20260702.pdf', document_kind: 'shareholder_registry', channel_id: 'current', score: 0.79 },
  ]

  const ranked = rankLocateReferences(refs, {
    keywords: ['회사', '주주명부'],
    channelId: 'current',
  })

  assert.equal(ranked[0].file_name, 'SC_주주명부-20260702.pdf')
})

test('같은 파일 해시는 현재 정렬에서 먼저 나온 참조 하나만 유지한다', () => {
  const refs = [
    { post_id: 'current-post', file_hash: 'same-hash' },
    { post_id: 'stale-post', file_hash: 'same-hash' },
    { post_id: 'other-post', file_hash: 'other-hash' },
  ]

  assert.deepEqual(
    deduplicateLocateReferences(refs).map(ref => ref.post_id),
    ['current-post', 'other-post'],
  )
})
