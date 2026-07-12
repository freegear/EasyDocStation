const state = {
  started_at: new Date().toISOString(),
  tasks: {},
  experiments: [],
  // GPU 학습 스케줄링 메트릭 (MDfiles/GpuScheduling.md 3단계 관측성)
  gpu: {
    training_yield_count: 0,      // 학습이 대화형/물리 게이트에 양보한 횟수
    training_admit_rejected: 0,   // admit 판정에서 거절된 누적 횟수
    training_forced: 0,           // 기아 방지로 강제 진행한 횟수(5단계)
    training_batches: 0,          // 실행된 학습 단위(파일 배치) 수
    train_wait_ms: [],            // 학습 단위별 대기 시간
    last_status: null,            // 최근 nvidia-smi/게이트 상태 스냅샷
  },
}

function ensureTask(task) {
  const key = String(task || 'unknown')
  if (!state.tasks[key]) {
    state.tasks[key] = {
      cache_hit: 0,
      cache_miss: 0,
      cache_error: 0,
      gpu_call_count: 0,
      request_count: 0,
      error_count: 0,
      timeout_count: 0,
      latencies_ms: [],
      queue_wait_ms: [],
      batch_sizes: [],
      dead_letter_count: 0,
    }
  }
  return state.tasks[key]
}

function pushBounded(arr, value, limit = 1000) {
  const n = Number(value)
  if (!Number.isFinite(n)) return
  arr.push(n)
  if (arr.length > limit) arr.splice(0, arr.length - limit)
}

function percentile(values, p) {
  const arr = [...(values || [])].filter(Number.isFinite).sort((a, b) => a - b)
  if (!arr.length) return 0
  const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1))
  return arr[idx]
}

function avg(values) {
  const arr = [...(values || [])].filter(Number.isFinite)
  if (!arr.length) return 0
  return arr.reduce((sum, v) => sum + v, 0) / arr.length
}

function inc(task, field, amount = 1) {
  const item = ensureTask(task)
  item[field] = Number(item[field] || 0) + amount
}

function recordCache(task, hit) {
  inc(task, hit ? 'cache_hit' : 'cache_miss')
}

function recordCacheError(task) {
  inc(task, 'cache_error')
}

function recordGpuCall(task, count = 1) {
  inc(task, 'gpu_call_count', count)
}

function recordRequest(task, latencyMs, { error = false, timeout = false } = {}) {
  const item = ensureTask(task)
  item.request_count += 1
  pushBounded(item.latencies_ms, latencyMs)
  if (error) item.error_count += 1
  if (timeout) item.timeout_count += 1
}

function recordQueue(task, { waitMs, batchSize } = {}) {
  const item = ensureTask(task)
  pushBounded(item.queue_wait_ms, waitMs)
  pushBounded(item.batch_sizes, batchSize)
}

// ── GPU 학습 스케줄링 메트릭 (3단계 관측성) ──
function recordTrainingSlot({ waitedMs = 0, forced = false, rejectedCount = 0 } = {}) {
  state.gpu.training_batches += 1
  if (waitedMs > 0 || rejectedCount > 0) state.gpu.training_yield_count += 1
  state.gpu.training_admit_rejected += Number(rejectedCount || 0)
  if (forced) state.gpu.training_forced += 1
  pushBounded(state.gpu.train_wait_ms, waitedMs)
}

function setGpuStatus(status = {}) {
  state.gpu.last_status = { ...status, recorded_at: new Date().toISOString() }
}

function summarizeGpu() {
  return {
    training_yield_count: Number(state.gpu.training_yield_count || 0),
    training_admit_rejected: Number(state.gpu.training_admit_rejected || 0),
    training_forced: Number(state.gpu.training_forced || 0),
    training_batches: Number(state.gpu.training_batches || 0),
    avg_train_wait_ms: avg(state.gpu.train_wait_ms),
    p95_train_wait_ms: percentile(state.gpu.train_wait_ms, 95),
    last_status: state.gpu.last_status,
  }
}

function addExperiment(result = {}) {
  const row = { ...result, created_at: new Date().toISOString() }
  state.experiments.unshift(row)
  if (state.experiments.length > 50) state.experiments.pop()
  return row
}

function summarizeTask(item) {
  const hit = Number(item.cache_hit || 0)
  const miss = Number(item.cache_miss || 0)
  const totalCache = hit + miss
  const requestCount = Number(item.request_count || 0)
  return {
    cache_hit: hit,
    cache_miss: miss,
    cache_hit_rate: totalCache > 0 ? hit / totalCache : 0,
    cache_miss_rate: totalCache > 0 ? miss / totalCache : 0,
    cache_error: Number(item.cache_error || 0),
    gpu_call_count: Number(item.gpu_call_count || 0),
    request_count: requestCount,
    error_count: Number(item.error_count || 0),
    error_rate: requestCount > 0 ? Number(item.error_count || 0) / requestCount : 0,
    timeout_count: Number(item.timeout_count || 0),
    p50_latency_ms: percentile(item.latencies_ms, 50),
    p95_latency_ms: percentile(item.latencies_ms, 95),
    p99_latency_ms: percentile(item.latencies_ms, 99),
    avg_queue_wait_ms: avg(item.queue_wait_ms),
    avg_batch_size: avg(item.batch_sizes),
    dead_letter_count: Number(item.dead_letter_count || 0),
  }
}

function snapshot() {
  return {
    started_at: state.started_at,
    generated_at: new Date().toISOString(),
    tasks: Object.fromEntries(Object.entries(state.tasks).map(([task, item]) => [task, summarizeTask(item)])),
    experiments: state.experiments,
    gpu_scheduling: summarizeGpu(),
  }
}

function resetMetrics() {
  state.started_at = new Date().toISOString()
  state.tasks = {}
  state.experiments = []
  state.gpu = {
    training_yield_count: 0,
    training_admit_rejected: 0,
    training_forced: 0,
    training_batches: 0,
    train_wait_ms: [],
    last_status: null,
  }
}

module.exports = {
  inc,
  recordCache,
  recordCacheError,
  recordGpuCall,
  recordRequest,
  recordQueue,
  recordTrainingSlot,
  setGpuStatus,
  addExperiment,
  snapshot,
  resetMetrics,
}
