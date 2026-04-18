const COMPLETED_VISIBLE_MS = 10 * 60 * 1000

const trainingState = new Map()

function buildKey(type, id) {
  return `${type}:${String(id)}`
}

function cleanupExpiredCompleted() {
  const now = Date.now()
  for (const [key, value] of trainingState.entries()) {
    if (value.status !== 'completed') continue
    const completedAtMs = Date.parse(value.completedAt || '')
    if (!Number.isFinite(completedAtMs)) {
      trainingState.delete(key)
      continue
    }
    if ((now - completedAtMs) >= COMPLETED_VISIBLE_MS) {
      trainingState.delete(key)
    }
  }
}

function markTrainingStarted(type, id) {
  if (!type || id == null) return
  const nowIso = new Date().toISOString()
  trainingState.set(buildKey(type, id), {
    status: 'training',
    startedAt: nowIso,
    updatedAt: nowIso,
  })
}

function markTrainingCompleted(type, id) {
  if (!type || id == null) return
  const nowIso = new Date().toISOString()
  trainingState.set(buildKey(type, id), {
    status: 'completed',
    completedAt: nowIso,
    updatedAt: nowIso,
  })
}

function clearTrainingStatus(type, id) {
  if (!type || id == null) return
  trainingState.delete(buildKey(type, id))
}

function getTrainingStatus(type, id) {
  if (!type || id == null) return null
  cleanupExpiredCompleted()
  const entry = trainingState.get(buildKey(type, id))
  if (!entry) return null
  if (entry.status === 'training') {
    return { training_status: 'training', training_completed_at: null }
  }
  if (entry.status === 'completed') {
    return { training_status: 'completed', training_completed_at: entry.completedAt || null }
  }
  return null
}

setInterval(cleanupExpiredCompleted, 60 * 1000).unref?.()

module.exports = {
  markTrainingStarted,
  markTrainingCompleted,
  clearTrainingStatus,
  getTrainingStatus,
}
