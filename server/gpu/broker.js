// GPU 브로커 워커 (MDfiles/GpuScheduling.md 4단계)
//
// ai:queue:training 스트림을 소비하는 "유일한" GPU 학습 디스패처.
// 소비자 그룹(XREADGROUP)으로 워커 재기동 시에도 미처리 잡이 유실되지 않는다.
// admit·양보 판정은 trainBatchDirect 내부의 gpuGate.waitForTrainingSlot 이 담당한다.
//
// 활성 조건: gpu_scheduling.broker_enabled AND redis_ai.queue_enabled.
//   둘 중 하나라도 꺼져 있으면 no-op(학습은 ragTrainer 의 직접 경로로 처리).
//   → 기존 시스템을 깨지 않는 opt-in 구조.
//
// 전용 Redis 연결: BLOCK 명령이 공유 커넥션(대화형 리스 read/write)을 막지 않도록
//   base.duplicate() 한 별도 커넥션을 쓴다.

const { getRedisClient } = require('../redisClient')
const { getAiOptimizationConfig } = require('../aiOptimization')
const gpuGate = require('./gpuGate')

const STREAM = 'ai:queue:training'
const GROUP = 'gpu-broker'

let running = false
let dedicated = null
let consumerName = ''

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

async function ensureGroup(client) {
  try {
    await client.xGroupCreate(STREAM, GROUP, '0', { MKSTREAM: true })
  } catch (e) {
    if (!String(e?.message || '').includes('BUSYGROUP')) throw e
  }
}

function startBroker() {
  const cfg = gpuGate.gpuConfig()
  const aiCfg = getAiOptimizationConfig()
  if (!cfg.broker_enabled) return { started: false, reason: 'broker_disabled' }
  if (!aiCfg.redis_enabled || !aiCfg.queue_enabled) return { started: false, reason: 'queue_disabled' }
  if (running) return { started: true, already: true }
  running = true
  consumerName = `broker-${process.pid}`
  loop().catch(e => {
    console.error('[GPU Broker] loop 종료:', e.message)
    running = false
    try { dedicated?.quit?.() } catch (_) {}
    dedicated = null
    setTimeout(startBroker, 5000)
  })
  console.log('[GPU Broker] 시작됨 (consumer=%s)', consumerName)
  return { started: true }
}

function stopBroker() {
  running = false
  try { dedicated?.quit?.() } catch (_) {}
  dedicated = null
}

async function loop() {
  // 지연 require: ragTrainer → aiQueue, broker → ragTrainer 의 로드시점 순환을 피한다.
  const { trainBatchDirect } = require('../folder/ragTrainer')

  const base = await getRedisClient()
  if (!base) { running = false; setTimeout(startBroker, 5000); return }
  dedicated = base.duplicate()
  dedicated.on('error', err => console.warn('[GPU Broker] redis error:', err.message))
  await dedicated.connect()
  await ensureGroup(dedicated)

  while (running) {
    let reply = null
    try {
      reply = await dedicated.xReadGroup(
        GROUP, consumerName,
        [{ key: STREAM, id: '>' }],
        { COUNT: 1, BLOCK: 5000 },
      )
    } catch (e) {
      console.warn('[GPU Broker] xReadGroup 오류:', e.message)
      await sleep(1000)
      continue
    }
    if (!reply) continue
    // node-redis v4: [{ name, messages: [{ id, message }] }]
    const streams = Array.isArray(reply) ? reply : Object.values(reply)
    for (const s of streams) {
      const messages = s?.messages || []
      for (const m of messages) {
        await handleMessage(dedicated, m, trainBatchDirect)
      }
    }
  }
}

async function handleMessage(client, m, trainBatchDirect) {
  const id = m?.id
  const fields = m?.message || {}
  const payloadKey = fields.payload_key
  try {
    let documents = []
    if (payloadKey) {
      const raw = await client.get(payloadKey)
      if (raw) {
        const parsed = JSON.parse(raw)
        documents = Array.isArray(parsed.documents) ? parsed.documents : []
      }
    }
    if (documents.length) {
      await trainBatchDirect(documents)
    }
    await client.xAck(STREAM, GROUP, id)
    if (payloadKey) { try { await client.del(payloadKey) } catch (_) {} }
  } catch (e) {
    console.error('[GPU Broker] 잡 처리 실패(pending 유지, 재처리 예정):', e.message)
    // ack 하지 않음 → 소비자 그룹 pending 에 남아 재기동/재처리된다(멱등 전제).
    await sleep(1000)
  }
}

module.exports = { startBroker, stopBroker }
