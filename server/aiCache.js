const crypto = require('crypto')
const { getRedisClient } = require('./redisClient')
const { getAiOptimizationConfig } = require('./aiOptimization')
const metrics = require('./aiMetrics')

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function hashPayload(payload) {
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex')
}

function buildCacheKey(task, payload, version = 'v1') {
  return `ai:cache:${task}:${version}:${hashPayload(payload)}`
}

async function getCachedJson(task, payload, options = {}) {
  const cfg = getAiOptimizationConfig()
  if (!cfg.redis_enabled || !cfg.cache_enabled) return { hit: false, disabled: true }
  const key = options.key || buildCacheKey(task, payload, options.version || 'v1')
  try {
    const client = await getRedisClient()
    if (!client) {
      metrics.recordCacheError(task)
      return { hit: false, key, error: 'redis_unavailable' }
    }
    const raw = await client.get(key)
    const hit = raw != null
    metrics.recordCache(task, hit)
    if (!hit) return { hit: false, key }
    return { hit: true, key, value: JSON.parse(raw) }
  } catch (err) {
    metrics.recordCacheError(task)
    return { hit: false, key, error: err.message }
  }
}

async function setCachedJson(task, payload, value, options = {}) {
  const cfg = getAiOptimizationConfig()
  if (!cfg.redis_enabled || !cfg.cache_enabled) return { saved: false, disabled: true }
  const key = options.key || buildCacheKey(task, payload, options.version || 'v1')
  const ttl = Number(options.ttlSec || cfg.default_ttl_sec || 3600)
  try {
    const client = await getRedisClient()
    if (!client) return { saved: false, key, error: 'redis_unavailable' }
    await client.setEx(key, Math.max(1, ttl), JSON.stringify(value))
    return { saved: true, key, ttl }
  } catch (err) {
    metrics.recordCacheError(task)
    return { saved: false, key, error: err.message }
  }
}

module.exports = {
  stableStringify,
  hashPayload,
  buildCacheKey,
  getCachedJson,
  setCachedJson,
}
