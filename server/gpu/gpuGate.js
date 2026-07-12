// GPU 학습 스케줄링 게이트 (설계: MDfiles/GpuScheduling.md §3.1)
//
// 두 계층으로 "지금 학습을 돌려도 되는가"를 판정한다.
//  - 논리 게이트(주): 검색·답변 등 대화형 작업이 진행 중이면 학습은 양보한다.
//      대화형 경로가 Redis 리스 키(gpu:interactive:active)를 TTL 하트비트로 갱신하고,
//      학습은 매 파일 단위 시작 전 이 키를 확인한다.
//  - 물리 게이트(보조): nvidia-smi 로 GPU util/mem 임계치를 확인한다. 브로커가 모르는
//      외부 GPU 사용(Ollama 포함)까지 커버한다. 결과는 짧게 캐시해 nvidia-smi 폭주를 막는다.
//
// 안전 원칙:
//  - gate_enabled=false(또는 env EASYDOC_GPU_GATE=off)면 게이트 전체 무시 → 기존 fire-and-forget 동작.
//  - Redis 미가동이면 논리 게이트는 "바쁨 아님"으로 폴백(학습이 완전히 멈추지 않게).
//  - nvidia-smi 부재/실패면 물리 게이트도 "바쁨 아님"으로 폴백 + 로깅.

const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { getRedisClient } = require('../redisClient')

const CONFIG_PATH = path.resolve(__dirname, '../../config.json')
const INTERACTIVE_KEY = 'gpu:interactive:active'

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch (_) { return {} }
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

// 설정은 config.json 의 gpu_scheduling 블록 + 환경변수에서 읽는다.
// redis_ai(aiOptimization) 흐름과 분리해 저위험으로 둔다.
function gpuConfig() {
  const raw = readConfig().gpu_scheduling || {}
  const envGateOff = String(process.env.EASYDOC_GPU_GATE || '').trim().toLowerCase() === 'off'
  return {
    gate_enabled: !envGateOff && toBool(raw.gate_enabled ?? process.env.EASYDOC_GPU_GATE_ENABLED, true),
    util_max_percent: toInt(raw.util_max_percent ?? process.env.EASYDOC_GPU_UTIL_MAX, 80, 1, 100),
    mem_max_percent: toInt(raw.mem_max_percent ?? process.env.EASYDOC_GPU_MEM_MAX, 85, 1, 100),
    gate_cache_ms: toInt(raw.gate_cache_ms ?? process.env.EASYDOC_GPU_GATE_CACHE_MS, 2000, 0, 60000),
    train_yield_batch: toInt(raw.train_yield_batch ?? process.env.EASYDOC_TRAIN_YIELD_BATCH, 1, 1, 1000),
    train_backoff_ms: toInt(raw.train_backoff_ms ?? process.env.EASYDOC_TRAIN_BACKOFF_MS, 500, 50, 60000),
    train_backoff_max_ms: toInt(raw.train_backoff_max_ms ?? process.env.EASYDOC_TRAIN_BACKOFF_MAX_MS, 15000, 500, 600000),
    interactive_lease_ttl_sec: toInt(raw.interactive_lease_ttl_sec ?? process.env.EASYDOC_INTERACTIVE_LEASE_TTL_SEC, 10, 2, 600),
    // 5단계 기아 방지: 이 시간을 넘겨 대기하면 1단위 강제 진행(0이면 무제한 대기).
    max_yield_wait_sec: toInt(raw.max_yield_wait_sec ?? process.env.EASYDOC_MAX_YIELD_WAIT_SEC, 120, 0, 86400),
    // 4단계 브로커 큐 사용 여부.
    broker_enabled: toBool(raw.broker_enabled ?? process.env.EASYDOC_GPU_BROKER_ENABLED, false),
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

// ── 물리 게이트: nvidia-smi ────────────────────────────────────
let _physCache = { at: 0, busy: false, info: null }

function queryNvidiaSmi() {
  return new Promise(resolve => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 3000 },
      (err, stdout) => {
        if (err) { resolve(null); return }
        const lines = String(stdout || '').trim().split('\n').filter(Boolean)
        if (!lines.length) { resolve(null); return }
        // 다중 GPU면 가장 바쁜 값 기준으로 본다.
        let util = 0, memUsed = 0, memTotal = 0
        for (const ln of lines) {
          const [u, mu, mt] = ln.split(',').map(s => Number(String(s).trim()))
          if (Number.isFinite(u)) util = Math.max(util, u)
          if (Number.isFinite(mu)) memUsed = Math.max(memUsed, mu)
          if (Number.isFinite(mt)) memTotal = Math.max(memTotal, mt)
        }
        resolve({ util, mem_used: memUsed, mem_total: memTotal })
      },
    )
  })
}

async function readGpuInfo() {
  const cfg = gpuConfig()
  if (Date.now() - _physCache.at < cfg.gate_cache_ms) return _physCache.info
  const info = await queryNvidiaSmi().catch(() => null)
  let busy = false
  if (info) {
    const memPct = info.mem_total > 0 ? (info.mem_used / info.mem_total) * 100 : 0
    busy = info.util >= cfg.util_max_percent || memPct >= cfg.mem_max_percent
    info.mem_percent = Math.round(memPct)
  }
  // info=null(nvidia-smi 없음/실패)이면 busy=false 폴백(학습 정지 방지).
  _physCache = { at: Date.now(), busy, info }
  return info
}

async function isGpuPhysicallyBusy() {
  const cfg = gpuConfig()
  if (!cfg.gate_enabled) return false
  await readGpuInfo()
  return _physCache.busy
}

// ── 논리 게이트: 대화형 리스 ───────────────────────────────────
async function markInteractiveBusy(ttlSec) {
  const cfg = gpuConfig()
  if (!cfg.gate_enabled) return
  try {
    const client = await getRedisClient()
    if (!client) return
    const ttl = Math.max(2, toInt(ttlSec, cfg.interactive_lease_ttl_sec, 2, 600))
    await client.set(INTERACTIVE_KEY, String(Date.now()), { EX: ttl })
  } catch (_) { /* 리스 실패는 무시(검색/답변 진행 우선) */ }
}

async function isInteractiveActive() {
  const cfg = gpuConfig()
  if (!cfg.gate_enabled) return false
  try {
    const client = await getRedisClient()
    if (!client) return false  // Redis 미가동 → 논리 게이트 off
    return Boolean(await client.get(INTERACTIVE_KEY))
  } catch (_) {
    return false
  }
}

// 오래 걸리는 대화형 작업(Ollama 답변 생성 등)을 리스로 감싼다.
// 실행 동안 주기적으로 리스를 갱신하고, 종료 시 자동 해제(TTL 만료)한다.
async function withInteractiveLease(fn, ttlSec) {
  const cfg = gpuConfig()
  if (!cfg.gate_enabled) return fn()
  const ttl = Math.max(2, toInt(ttlSec, cfg.interactive_lease_ttl_sec, 2, 600))
  await markInteractiveBusy(ttl)
  const timer = setInterval(() => { markInteractiveBusy(ttl).catch(() => {}) }, Math.max(1000, Math.floor((ttl * 1000) / 2)))
  if (timer.unref) timer.unref()
  try {
    return await fn()
  } finally {
    clearInterval(timer)
  }
}

// ── 종합 판정 ─────────────────────────────────────────────────
async function canAdmitTraining() {
  const cfg = gpuConfig()
  if (!cfg.gate_enabled) return true
  if (await isInteractiveActive()) return false
  if (await isGpuPhysicallyBusy()) return false
  return true
}

// 학습 1단위 시작 전 호출. admit 될 때까지 지수 백오프로 대기한다.
// 5단계 기아 방지: max_yield_wait_sec 초과 시 forced=true 로 강제 진행.
// 반환: { admitted, waitedMs, forced, rejectedCount }
async function waitForTrainingSlot({ onWait } = {}) {
  const cfg = gpuConfig()
  if (!cfg.gate_enabled) return { admitted: true, waitedMs: 0, forced: false, rejectedCount: 0 }
  const startedAt = Date.now()
  let backoff = cfg.train_backoff_ms
  let waited = 0
  let rejectedCount = 0
  // 첫 판정
  if (await canAdmitTraining()) return { admitted: true, waitedMs: 0, forced: false, rejectedCount: 0 }
  while (true) {
    rejectedCount += 1
    if (cfg.max_yield_wait_sec > 0 && (Date.now() - startedAt) >= cfg.max_yield_wait_sec * 1000) {
      return { admitted: true, waitedMs: waited, forced: true, rejectedCount }
    }
    if (typeof onWait === 'function') { try { onWait(waited, rejectedCount) } catch (_) {} }
    await sleep(backoff)
    waited += backoff
    backoff = Math.min(cfg.train_backoff_max_ms, Math.floor(backoff * 1.8))
    if (await canAdmitTraining()) return { admitted: true, waitedMs: waited, forced: false, rejectedCount }
  }
}

// 관리 페이지용 현재 상태 스냅샷.
async function getGpuStatus() {
  const cfg = gpuConfig()
  const info = await readGpuInfo().catch(() => null)
  let interactiveActive = false
  try { interactiveActive = await isInteractiveActive() } catch (_) {}
  return {
    gate_enabled: cfg.gate_enabled,
    broker_enabled: cfg.broker_enabled,
    util_max_percent: cfg.util_max_percent,
    mem_max_percent: cfg.mem_max_percent,
    interactive_active: interactiveActive,
    physically_busy: _physCache.busy,
    nvidia_smi: info || null,
    nvidia_smi_available: Boolean(info),
    generated_at: new Date().toISOString(),
  }
}

module.exports = {
  gpuConfig,
  isGpuPhysicallyBusy,
  markInteractiveBusy,
  isInteractiveActive,
  withInteractiveLease,
  canAdmitTraining,
  waitForTrainingSlot,
  getGpuStatus,
}
