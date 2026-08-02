import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { dedupeOverlappingSegments } = require('../server/lib/meetingSttContext.js')

test('dedupes overlapping segments with the same speaker and nearly identical text', () => {
  const segments = [
    { start_sec: 0, end_sec: 4, speaker_label: 'SPEAKER_00', text: '오늘 회의는 진행됩니다.' },
    { start_sec: 3, end_sec: 7, speaker_label: 'SPEAKER_00', text: '오늘 회의는 진행됩니다.' },
    { start_sec: 8, end_sec: 12, speaker_label: 'SPEAKER_00', text: '다음 항목을 검토해 보겠습니다.' },
  ]

  const result = dedupeOverlappingSegments(segments, { overlapSec: 3 })

  assert.equal(result.length, 2)
  assert.equal(result[0].text, '오늘 회의는 진행됩니다.')
  assert.equal(result[1].text, '다음 항목을 검토해 보겠습니다.')
})

test('keeps distinct segments that do not overlap meaningfully', () => {
  const segments = [
    { start_sec: 0, end_sec: 4, speaker_label: 'SPEAKER_00', text: '첫 번째 발언입니다.' },
    { start_sec: 6, end_sec: 10, speaker_label: 'SPEAKER_00', text: '두 번째 발언입니다.' },
  ]

  const result = dedupeOverlappingSegments(segments, { overlapSec: 3 })

  assert.equal(result.length, 2)
})
