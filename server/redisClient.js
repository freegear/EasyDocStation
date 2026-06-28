const { createClient } = require('redis')
const { getAiOptimizationConfig } = require('./aiOptimization')

let client = null
let connecting = null
let lastError = null

function getRedisUrl() {
  return getAiOptimizationConfig().redis_url
}

async function getRedisClient() {
  const cfg = getAiOptimizationConfig()
  if (!cfg.redis_enabled) return null
  if (client?.isOpen) return client
  if (connecting) return connecting

  client = createClient({ url: cfg.redis_url })
  client.on('error', (err) => {
    lastError = err
    console.warn('[Redis] client error:', err.message)
  })
  connecting = client.connect()
    .then(() => client)
    .catch((err) => {
      lastError = err
      try { client?.destroy?.() } catch (_) {}
      client = null
      return null
    })
    .finally(() => {
      connecting = null
    })
  return connecting
}

async function pingRedis() {
  const startedAt = Date.now()
  const cfg = getAiOptimizationConfig()
  if (!cfg.redis_enabled) {
    return { ok: false, disabled: true, url: cfg.redis_url, message: 'Redis 사용이 꺼져 있습니다.' }
  }
  const c = await getRedisClient()
  if (!c) {
    return {
      ok: false,
      disabled: false,
      url: cfg.redis_url,
      message: lastError?.message || 'Redis 연결 실패',
      latency_ms: Date.now() - startedAt,
    }
  }
  try {
    const pong = await c.ping()
    return { ok: pong === 'PONG', url: cfg.redis_url, message: pong, latency_ms: Date.now() - startedAt }
  } catch (err) {
    lastError = err
    return { ok: false, url: cfg.redis_url, message: err.message, latency_ms: Date.now() - startedAt }
  }
}

function getRedisStatus() {
  const cfg = getAiOptimizationConfig()
  return {
    enabled: cfg.redis_enabled,
    url: cfg.redis_url,
    connected: Boolean(client?.isOpen),
    last_error: lastError?.message || '',
  }
}

module.exports = {
  getRedisClient,
  getRedisUrl,
  getRedisStatus,
  pingRedis,
}
