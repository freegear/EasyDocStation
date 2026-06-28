const crypto = require('crypto')
const { getRedisClient } = require('./redisClient')
const { getAiOptimizationConfig } = require('./aiOptimization')

function makeRequestId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')
}

async function enqueueTask(task, payload = {}, options = {}) {
  const cfg = getAiOptimizationConfig()
  if (!cfg.redis_enabled || !cfg.queue_enabled) {
    return { queued: false, disabled: true }
  }
  const client = await getRedisClient()
  if (!client) return { queued: false, error: 'redis_unavailable' }

  const requestId = options.requestId || makeRequestId()
  const payloadKey = `ai:payload:${requestId}`
  const stream = `ai:queue:${task}`
  const ttl = Number(options.payloadTtlSec || cfg.payload_ttl_sec || 300)
  await client.setEx(payloadKey, Math.max(1, ttl), JSON.stringify(payload))
  const streamId = await client.xAdd(stream, '*', {
    request_id: requestId,
    payload_key: payloadKey,
    route_key: String(options.routeKey || task),
    priority: String(options.priority || 'normal'),
    created_at: new Date().toISOString(),
  })
  return { queued: true, task, requestId, payloadKey, stream, streamId }
}

async function runQueueHealthcheck() {
  const cfg = getAiOptimizationConfig()
  if (!cfg.redis_enabled) return { ok: false, disabled: true, message: 'Redis 사용이 꺼져 있습니다.' }
  const client = await getRedisClient()
  if (!client) return { ok: false, message: 'Redis 연결 실패' }
  const stream = 'ai:queue:healthcheck'
  const streamId = await client.xAdd(stream, '*', { created_at: new Date().toISOString() })
  const length = await client.xLen(stream)
  return { ok: true, stream, streamId, length }
}

module.exports = {
  enqueueTask,
  runQueueHealthcheck,
}
