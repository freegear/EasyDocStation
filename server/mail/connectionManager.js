const { Pool } = require('pg')
const controlPool = require('../db')
const { decryptSecret } = require('../lib/secrets')
const { ensureMailDataSchema } = require('./schema')

// ---------------------------------------------------------------------------
// tenant routing 런타임 계층.
//
// 설계 원칙 #5: tenant routing 정보(mail_tenants.storage_mode / db_connection_key)를
// 기준으로 메일 "데이터 평면(data plane)" 접근이 어떤 DB로 갈지 결정한다.
//
//   - control plane (tenants / members / settings / db_connections / oauth_states)
//       → 항상 공용(메인) DB = controlPool
//   - data plane (accounts / folders / messages / ...)
//       → shared_db  : controlPool 재사용
//       → dedicated_db: db_connection_key로 mail_db_connections에서 연결 문자열을 복호화해
//                       전용 Pool을 생성/캐시하고, 최초 1회 data plane 스키마를 보장한다.
//
// 이 구조 덕분에 라우트/리포지토리는 "tenantId" 만 넘기면 되고,
// 나중에 특정 tenant만 dedicated_db로 플래그를 바꿔도 코드 변경이 필요 없다.
// ---------------------------------------------------------------------------

// connection_key -> { pool, ready: Promise }
const dedicatedPools = new Map()

function getControlPool() {
  return controlPool
}

async function getTenantRouting(tenantId) {
  if (!tenantId) return null
  const { rows } = await controlPool.query(
    `SELECT id, name, type, storage_mode, db_connection_key, storage_prefix
     FROM mail_tenants
     WHERE id = $1
     LIMIT 1`,
    [tenantId],
  )
  return rows[0] || null
}

async function createDedicatedPool(connectionKey) {
  const { rows } = await controlPool.query(
    `SELECT connection_string_encrypted, is_active
     FROM mail_db_connections
     WHERE connection_key = $1
     LIMIT 1`,
    [connectionKey],
  )
  const conn = rows[0]
  if (!conn) throw new Error(`mail_db_connection을 찾을 수 없습니다: ${connectionKey}`)
  if (!conn.is_active) throw new Error(`mail_db_connection이 비활성 상태입니다: ${connectionKey}`)

  const connectionString = decryptSecret(conn.connection_string_encrypted)
  if (!connectionString) {
    throw new Error(`연결 문자열 복호화에 실패했습니다(DATA_ENCRYPTION_KEY 확인): ${connectionKey}`)
  }

  const pool = new Pool({ connectionString })
  pool.on('error', (err) => {
    console.error(`[mail dedicated pool ${connectionKey}] connection error:`, err.message)
  })

  // 전용 DB에는 data plane 스키마만(standalone) 최초 1회 보장한다.
  const ready = (async () => {
    const client = await pool.connect()
    try {
      try {
        await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";')
      } catch (e) {
        console.warn(`[mail dedicated pool ${connectionKey}] pgcrypto 확장 생성 권한 없음:`, e.message)
      }
      await ensureMailDataSchema(client, { standalone: true })
    } finally {
      client.release()
    }
  })()

  return { pool, ready }
}

async function getDedicatedPool(connectionKey) {
  if (!connectionKey) {
    throw new Error('dedicated_db tenant에는 db_connection_key가 필요합니다.')
  }

  let entry = dedicatedPools.get(connectionKey)
  if (!entry) {
    entry = await createDedicatedPool(connectionKey)
    dedicatedPools.set(connectionKey, entry)
  }

  try {
    await entry.ready
  } catch (err) {
    // 스키마 부트스트랩 실패 시 캐시를 비워 다음 요청에서 재시도할 수 있게 한다.
    dedicatedPools.delete(connectionKey)
    try { await entry.pool.end() } catch (_) {}
    throw err
  }

  return entry.pool
}

// tenantId -> 데이터 평면 접근에 사용할 Pool
async function getTenantPool(tenantId) {
  const routing = await getTenantRouting(tenantId)
  if (!routing) throw new Error(`메일 tenant를 찾을 수 없습니다: ${tenantId}`)
  if (routing.storage_mode === 'dedicated_db') {
    return getDedicatedPool(routing.db_connection_key)
  }
  return controlPool
}

// dedicated tenant 인지 여부 + 같은 풀을 공유하는지(=shared_db) 판별용 헬퍼
async function resolveTenant(tenantId) {
  const routing = await getTenantRouting(tenantId)
  if (!routing) throw new Error(`메일 tenant를 찾을 수 없습니다: ${tenantId}`)
  const dedicated = routing.storage_mode === 'dedicated_db'
  const pool = dedicated ? await getDedicatedPool(routing.db_connection_key) : controlPool
  return { routing, pool, dedicated, sharesControlPool: pool === controlPool }
}

async function closeAllDedicatedPools() {
  const entries = Array.from(dedicatedPools.values())
  dedicatedPools.clear()
  await Promise.all(entries.map(e => e.pool.end().catch(() => {})))
}

module.exports = {
  getControlPool,
  getTenantRouting,
  getTenantPool,
  getDedicatedPool,
  resolveTenant,
  closeAllDedicatedPools,
}
