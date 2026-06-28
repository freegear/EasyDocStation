const fs = require('fs')
const path = require('path')

const CONFIG_PATH = path.resolve(__dirname, '../config.json')
const ENV_PATH = path.resolve(__dirname, '.env')

const DEFAULT_AI_OPTIMIZATION = {
  redis_enabled: false,
  redis_url: 'redis://127.0.0.1:6379',
  cache_enabled: false,
  queue_enabled: false,
  vector_cache_enabled: false,
  dynamic_batching_enabled: false,
  load_aware_routing_enabled: false,
  default_ttl_sec: 3600,
  payload_ttl_sec: 300,
  result_ttl_sec: 3600,
  batch_max_size: 16,
  batch_max_wait_ms: 50,
  worker_heartbeat_sec: 5,
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (_) {
    return fallback
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
}

function toBool(value, fallback = false) {
  if (value === true || value === false) return value
  if (value == null || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

function toInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function normalizeAiOptimizationConfig(raw = {}) {
  const redisEnabled = toBool(raw.redis_enabled ?? raw.REDIS_ENABLED, DEFAULT_AI_OPTIMIZATION.redis_enabled)
  const queueEnabled = toBool(raw.queue_enabled ?? raw.REDIS_AI_QUEUE_ENABLED, DEFAULT_AI_OPTIMIZATION.queue_enabled)
  return {
    redis_enabled: redisEnabled,
    redis_url: String(raw.redis_url || raw.REDIS_URL || DEFAULT_AI_OPTIMIZATION.redis_url).trim() || DEFAULT_AI_OPTIMIZATION.redis_url,
    cache_enabled: redisEnabled && toBool(raw.cache_enabled ?? raw.REDIS_AI_CACHE_ENABLED, DEFAULT_AI_OPTIMIZATION.cache_enabled),
    queue_enabled: redisEnabled && queueEnabled,
    vector_cache_enabled: redisEnabled && toBool(raw.vector_cache_enabled ?? raw.REDIS_AI_VECTOR_CACHE_ENABLED, DEFAULT_AI_OPTIMIZATION.vector_cache_enabled),
    dynamic_batching_enabled: redisEnabled && queueEnabled && toBool(raw.dynamic_batching_enabled, DEFAULT_AI_OPTIMIZATION.dynamic_batching_enabled),
    load_aware_routing_enabled: redisEnabled && queueEnabled && toBool(raw.load_aware_routing_enabled, DEFAULT_AI_OPTIMIZATION.load_aware_routing_enabled),
    default_ttl_sec: toInt(raw.default_ttl_sec ?? raw.REDIS_AI_DEFAULT_TTL_SEC, DEFAULT_AI_OPTIMIZATION.default_ttl_sec, 1),
    payload_ttl_sec: toInt(raw.payload_ttl_sec ?? raw.REDIS_AI_PAYLOAD_TTL_SEC, DEFAULT_AI_OPTIMIZATION.payload_ttl_sec, 1),
    result_ttl_sec: toInt(raw.result_ttl_sec ?? raw.REDIS_AI_RESULT_TTL_SEC, DEFAULT_AI_OPTIMIZATION.result_ttl_sec, 1),
    batch_max_size: toInt(raw.batch_max_size ?? raw.AI_BATCH_MAX_SIZE, DEFAULT_AI_OPTIMIZATION.batch_max_size, 1, 256),
    batch_max_wait_ms: toInt(raw.batch_max_wait_ms ?? raw.AI_BATCH_MAX_WAIT_MS, DEFAULT_AI_OPTIMIZATION.batch_max_wait_ms, 0, 5000),
    worker_heartbeat_sec: toInt(raw.worker_heartbeat_sec ?? raw.AI_WORKER_HEARTBEAT_SEC, DEFAULT_AI_OPTIMIZATION.worker_heartbeat_sec, 1, 300),
  }
}

function getAiOptimizationConfig() {
  const config = readJson(CONFIG_PATH, {})
  if (config.redis_ai && typeof config.redis_ai === 'object') {
    return normalizeAiOptimizationConfig(config.redis_ai)
  }
  return normalizeAiOptimizationConfig({
    REDIS_ENABLED: process.env.REDIS_AI_CACHE_ENABLED || process.env.REDIS_AI_QUEUE_ENABLED || process.env.REDIS_AI_VECTOR_CACHE_ENABLED,
    REDIS_URL: process.env.REDIS_URL,
    REDIS_AI_CACHE_ENABLED: process.env.REDIS_AI_CACHE_ENABLED,
    REDIS_AI_QUEUE_ENABLED: process.env.REDIS_AI_QUEUE_ENABLED,
    REDIS_AI_VECTOR_CACHE_ENABLED: process.env.REDIS_AI_VECTOR_CACHE_ENABLED,
    REDIS_AI_DEFAULT_TTL_SEC: process.env.REDIS_AI_DEFAULT_TTL_SEC,
    REDIS_AI_PAYLOAD_TTL_SEC: process.env.REDIS_AI_PAYLOAD_TTL_SEC,
    REDIS_AI_RESULT_TTL_SEC: process.env.REDIS_AI_RESULT_TTL_SEC,
    AI_BATCH_MAX_SIZE: process.env.AI_BATCH_MAX_SIZE,
    AI_BATCH_MAX_WAIT_MS: process.env.AI_BATCH_MAX_WAIT_MS,
    AI_WORKER_HEARTBEAT_SEC: process.env.AI_WORKER_HEARTBEAT_SEC,
  })
}

function upsertEnvLine(source, key, value) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`^${escaped}=.*$`, 'm')
  const line = `${key}=${value}`
  if (regex.test(source)) return source.replace(regex, line)
  return source + (source.endsWith('\n') || source.length === 0 ? '' : '\n') + line + '\n'
}

function syncAiOptimizationEnv(config) {
  const normalized = normalizeAiOptimizationConfig(config)
  let envText = ''
  if (fs.existsSync(ENV_PATH)) envText = fs.readFileSync(ENV_PATH, 'utf8')
  let updated = envText
  updated = upsertEnvLine(updated, 'REDIS_URL', normalized.redis_url)
  updated = upsertEnvLine(updated, 'REDIS_AI_CACHE_ENABLED', normalized.cache_enabled ? 'true' : 'false')
  updated = upsertEnvLine(updated, 'REDIS_AI_QUEUE_ENABLED', normalized.queue_enabled ? 'true' : 'false')
  updated = upsertEnvLine(updated, 'REDIS_AI_VECTOR_CACHE_ENABLED', normalized.vector_cache_enabled ? 'true' : 'false')
  updated = upsertEnvLine(updated, 'REDIS_AI_DEFAULT_TTL_SEC', String(normalized.default_ttl_sec))
  updated = upsertEnvLine(updated, 'REDIS_AI_PAYLOAD_TTL_SEC', String(normalized.payload_ttl_sec))
  updated = upsertEnvLine(updated, 'REDIS_AI_RESULT_TTL_SEC', String(normalized.result_ttl_sec))
  updated = upsertEnvLine(updated, 'AI_BATCH_MAX_SIZE', String(normalized.batch_max_size))
  updated = upsertEnvLine(updated, 'AI_BATCH_MAX_WAIT_MS', String(normalized.batch_max_wait_ms))
  updated = upsertEnvLine(updated, 'AI_WORKER_HEARTBEAT_SEC', String(normalized.worker_heartbeat_sec))
  fs.writeFileSync(ENV_PATH, updated, 'utf8')
  return { path: ENV_PATH, synced: true }
}

function saveAiOptimizationConfig(payload = {}) {
  const current = readJson(CONFIG_PATH, {})
  const normalized = normalizeAiOptimizationConfig(payload)
  current.redis_ai = normalized
  writeJson(CONFIG_PATH, current)
  const envSync = syncAiOptimizationEnv(normalized)
  return { config: normalized, envSync }
}

module.exports = {
  DEFAULT_AI_OPTIMIZATION,
  normalizeAiOptimizationConfig,
  getAiOptimizationConfig,
  saveAiOptimizationConfig,
}
