function dedupeOverlappingSegments(segments = [], options = {}) {
  const overlapSec = Number(options.overlapSec ?? 3)
  const normalized = (segments || []).filter(Boolean).map((segment) => ({
    ...segment,
    start_sec: Number(segment.start_sec ?? 0),
    end_sec: Number(segment.end_sec ?? 0),
    speaker_label: String(segment.speaker_label || 'SPEAKER_00'),
    text: String(segment.text || '').trim(),
  }))

  const deduped = []
  for (const segment of normalized) {
    const prev = [...deduped].reverse().find((candidate) => (
      candidate.speaker_label === segment.speaker_label &&
      candidate.text && segment.text &&
      candidate.text === segment.text &&
      segment.start_sec <= candidate.end_sec &&
      segment.start_sec >= candidate.end_sec - overlapSec
    ))
    const isOverlapping = Boolean(prev)

    if (isOverlapping) {
      prev.end_sec = Math.max(prev.end_sec, segment.end_sec)
      prev.start_sec = Math.min(prev.start_sec, segment.start_sec)
      continue
    }

    deduped.push(segment)
  }

  return deduped
}

module.exports = {
  dedupeOverlappingSegments,
}
