import test from 'node:test'
import assert from 'node:assert/strict'
import { isCassandraUnavailableResponse } from '../src/lib/api.js'

test('recognizes the explicit Cassandra unavailable response code', () => {
  assert.equal(isCassandraUnavailableResponse(503, { code: 'CASSANDRA_UNAVAILABLE' }), true)
})

test('recognizes existing Cassandra 503 responses', () => {
  assert.equal(isCassandraUnavailableResponse(503, { error: 'Cassandra 연결이 필요합니다.' }), true)
})

test('does not show the Cassandra dialog for unrelated server errors', () => {
  assert.equal(isCassandraUnavailableResponse(500, { error: '서버 오류가 발생했습니다.' }), false)
})
