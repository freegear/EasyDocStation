const WEEKDAY_INDEX = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 }
const KOREAN_WEEK_COUNTS = {
  한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10,
}

function formatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function validReferenceDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function mondayOfWeek(date) {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  return monday
}

function parseWeekOffset(modifier) {
  const normalized = String(modifier || '').replace(/\s+/g, '')
  if (normalized === '이번주') return 0
  if (normalized === '다음주' || normalized === '다음') return 1
  if (normalized === '다다음주') return 2
  if (normalized === '저번주' || normalized === '지난주') return -1

  const match = normalized.match(/^(\d+|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)주(후|뒤|전)$/)
  if (!match) return null
  const count = /^\d+$/.test(match[1]) ? Number(match[1]) : KOREAN_WEEK_COUNTS[match[1]]
  if (!Number.isSafeInteger(count) || count < 0) return null
  return match[2] === '전' ? -count : count
}

function resolveKoreanWeekdayDate(value, referenceDate) {
  const text = String(value || '').trim()
  const reference = validReferenceDate(referenceDate)
  if (!text || !reference) return ''
  const match = text.match(/(?:(다다음\s*주|다음\s*주|저번\s*주|지난\s*주|이번\s*주|(?:\d+|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*주\s*(?:후|뒤|전)|오는|지난|다음)\s*)?([월화수목금토일])요일/)
  if (!match) return ''

  const modifier = String(match[1] || '').replace(/\s+/g, '')
  const targetDay = WEEKDAY_INDEX[match[2]]
  let result
  const weekOffset = parseWeekOffset(modifier)
  if (weekOffset !== null) {
    result = mondayOfWeek(reference)
    result.setDate(result.getDate() + weekOffset * 7 + ((targetDay + 6) % 7))
  } else {
    let distance = (targetDay - reference.getDay() + 7) % 7
    if (modifier === '오는' && distance === 0) distance = 7
    if (modifier === '지난') distance = -((reference.getDay() - targetDay + 7) % 7 || 7)
    result = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() + distance)
  }
  return formatDate(result)
}

function normalizeCalendarDate(value, referenceDate) {
  const text = String(value || '').trim()
  const reference = validReferenceDate(referenceDate)
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  let year
  let month
  let day
  if (match) {
    year = Number(match[1]); month = Number(match[2]); day = Number(match[3])
  } else {
    match = text.match(/(?:(\d{4})년\s*)?(?:(\d{1,2})월\s*)?(\d{1,2})일/)
    if (!match) return resolveKoreanWeekdayDate(text, referenceDate)
    year = Number(match[1]) || reference?.getFullYear()
    month = Number(match[2]) || (reference ? reference.getMonth() + 1 : null)
    day = Number(match[3])
  }
  if (!year || !month || !day) return ''
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return ''
  return formatDate(date)
}

module.exports = { normalizeCalendarDate, resolveKoreanWeekdayDate, parseWeekOffset }
