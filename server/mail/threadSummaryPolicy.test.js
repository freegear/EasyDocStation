const test = require('node:test')
const assert = require('node:assert/strict')
const { buildWeightedThreadContext, calculateThreadWeights } = require('./threadSummaryPolicy')

test('t1 t2 t3과 나머지 메일 가중치를 정책대로 계산한다', () => {
  const weights = calculateThreadWeights(5)
  assert.deepEqual(weights.slice(0, 3), [0.5, 0.3, 0.1])
  assert.ok(Math.abs(weights.slice(3).reduce((a, b) => a + b, 0) - 0.1) < 1e-12)
  assert.ok(weights[3] > weights[4])
})

test('메일을 최신순으로 정렬하고 90일 범위를 적용한다', () => {
  const context = buildWeightedThreadContext([
    { id: 'old', received_at: '2026-01-01' },
    { id: 't2', received_at: '2026-07-10' },
    { id: 't1', received_at: '2026-07-11' },
  ])
  assert.deepEqual(context.map(item => item.id), ['t1', 't2'])
})
