const test = require('node:test')
const assert = require('node:assert/strict')
const { applyActionItemSummaryFallback } = require('./actionItemFallback')

test('추가로 확인된 조치 없음 대신 중요 내용 요약을 사용한다', () => {
  const result = applyActionItemSummaryFallback({
    summary: '임종윤은 차주 수요일에 법인 통장을 만들 예정임.',
    keyPoints: ['법인 통장 개설 예정'],
    actionItems: [{ task: '추가로 확인된 조치 없음', time: '확인된 내용 없음' }],
  })
  assert.deepEqual(result.actionItems, [{
    task: '임종윤은 차주 수요일에 법인 통장을 만들 예정임.',
    time: '확인된 내용 없음',
    taskSource: 'summary_fallback',
  }])
})

test('실질 액션과 placeholder가 함께 있으면 placeholder만 제거한다', () => {
  const result = applyActionItemSummaryFallback({
    summary: '요약',
    actionItems: [
      { task: '추가로 확인된 조치 없음', time: '확인된 내용 없음' },
      { task: '법인 통장 개설 준비', time: '2026-07-15' },
    ],
  })
  assert.deepEqual(result.actionItems, [{ task: '법인 통장 개설 준비', time: '2026-07-15' }])
})

test('중요 내용 요약이 없으면 첫 번째 중요 포인트를 사용한다', () => {
  const result = applyActionItemSummaryFallback({
    summary: '확인된 내용 없음',
    keyPoints: ['건담 제작 일정 확인'],
    actionItems: [],
  })
  assert.equal(result.actionItems[0].task, '건담 제작 일정 확인')
  assert.equal(result.actionItems[0].taskSource, 'summary_fallback')
})
