const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeCalendarDate } = require('./calendarDateNormalizer')

test('수신일 이후 가장 빠른 요일을 계산한다', () => {
  assert.equal(normalizeCalendarDate('월요일', '2026-07-11T12:00:00+09:00'), '2026-07-13')
})
test('수신일과 같은 요일은 당일이다', () => {
  assert.equal(normalizeCalendarDate('월요일', '2026-07-13T12:00:00+09:00'), '2026-07-13')
})
test('오는 요일은 같은 요일이면 7일 뒤다', () => {
  assert.equal(normalizeCalendarDate('오는 월요일', '2026-07-13T12:00:00+09:00'), '2026-07-20')
})
test('다음 주 요일은 다음 주에서 계산한다', () => {
  assert.equal(normalizeCalendarDate('다음 주 수요일', '2026-07-11T12:00:00+09:00'), '2026-07-15')
})
test('다음주 화요일처럼 공백이 없는 표현도 수신 시각 기준으로 계산한다', () => {
  assert.equal(normalizeCalendarDate('다음주 화요일', '2026-07-11T12:00:00+09:00'), '2026-07-14')
})
test('명시 날짜는 요일보다 우선한다', () => {
  assert.equal(normalizeCalendarDate('7월 22일 월요일', '2026-07-11T12:00:00+09:00'), '2026-07-22')
})

test('월요일부터 일요일까지 모든 요일을 같은 규칙으로 계산한다', () => {
  const expected = {
    월요일: '2026-07-13', 화요일: '2026-07-14', 수요일: '2026-07-15', 목요일: '2026-07-16',
    금요일: '2026-07-17', 토요일: '2026-07-18', 일요일: '2026-07-19',
  }
  for (const [weekday, date] of Object.entries(expected)) {
    assert.equal(normalizeCalendarDate(`다음 주 ${weekday}`, '2026-07-11T15:38:18+09:00'), date)
  }
})

test('숫자로 지정한 임의 주차 후의 요일을 계산한다', () => {
  assert.equal(normalizeCalendarDate('2주 후 목요일에 봅시다', '2026-07-11T15:38:18+09:00'), '2026-07-23')
  assert.equal(normalizeCalendarDate('3주뒤 일요일에 점검합니다', '2026-07-11T15:38:18+09:00'), '2026-08-02')
})

test('숫자로 지정한 과거 주차의 요일을 계산한다', () => {
  assert.equal(normalizeCalendarDate('2주 전 금요일 자료', '2026-07-15T15:38:18+09:00'), '2026-07-03')
})

test('한글 수사로 지정한 주차와 띄어쓰기 변형을 계산한다', () => {
  assert.equal(normalizeCalendarDate('두 주 후 목요일', '2026-07-11T15:38:18+09:00'), '2026-07-23')
  assert.equal(normalizeCalendarDate('세주뒤 일요일', '2026-07-11T15:38:18+09:00'), '2026-08-02')
  assert.equal(normalizeCalendarDate('네 주 전 금요일', '2026-07-15T15:38:18+09:00'), '2026-06-19')
})

test('이번 주와 지난주 표현을 계산한다', () => {
  assert.equal(normalizeCalendarDate('이번 주 일요일', '2026-07-15T15:38:18+09:00'), '2026-07-19')
  assert.equal(normalizeCalendarDate('지난주 화요일', '2026-07-15T15:38:18+09:00'), '2026-07-07')
})
