const test = require('node:test')
const assert = require('node:assert/strict')

const { resolveCalendarEventTitle } = require('./calendarTitle')
const { calendarEventEnd } = require('./calendarAction')

test('액션 아이템을 캘린더 이벤트 제목으로 사용한다', () => {
  const title = resolveCalendarEventTitle(
    { task: '하노이에서 만남 참석 준비 및 일정 확인' },
    { subject: '미팅' },
  )

  assert.equal(title, '하노이에서 만남 참석 준비 및 일정 확인')
})

test('액션 아이템이 비어 있을 때만 메일 제목을 사용한다', () => {
  assert.equal(resolveCalendarEventTitle({ task: '   ' }, { subject: '미팅' }), '미팅')
})

test('액션 아이템과 메일 제목이 모두 비어 있으면 기본 제목을 사용한다', () => {
  assert.equal(resolveCalendarEventTitle({}, {}), '메일 일정')
})

test('하루 종일 메일 일정은 시작일과 종료일이 같은 날짜다', () => {
  const start = new Date(2026, 6, 15, 0, 0, 0, 0)
  const end = calendarEventEnd(start, true)

  assert.notEqual(end, start)
  assert.equal(end.getTime(), start.getTime())
})

test('시간 지정 메일 일정은 기본 30분 일정이다', () => {
  const start = new Date(2026, 6, 15, 14, 0, 0, 0)
  const end = calendarEventEnd(start, false)

  assert.equal(end.getTime() - start.getTime(), 30 * 60 * 1000)
})
