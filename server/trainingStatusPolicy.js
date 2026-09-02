function deriveCombinedTrainingStatus({
  status = '',
  bodyStatus = '',
  imageCount = 0,
  completedImageCount = 0,
  terminalFailedImageCount = 0,
} = {}) {
  const body = String(bodyStatus || status || 'training')
  const current = String(status || body)
  const totalImages = Math.max(0, Number(imageCount) || 0)
  const completedImages = Math.max(0, Number(completedImageCount) || 0)
  const terminalFailures = Math.max(0, Number(terminalFailedImageCount) || 0)

  if (body === 'failed' || body === 'timed_out') return body
  if (body !== 'completed') return body === 'queued' ? 'queued' : 'training'

  if (totalImages === 0 || completedImages === totalImages) return 'completed'
  if (terminalFailures > 0) return 'failed'
  if (current === 'timed_out') return 'timed_out'
  return 'training'
}

module.exports = { deriveCombinedTrainingStatus }
