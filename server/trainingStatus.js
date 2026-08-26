const db = require('./db')

const COMPLETED_VISIBLE_MS = 10 * 60 * 1000
const TRAINING_TIMEOUT_MS = Math.max(
  60 * 1000,
  Number.parseInt(process.env.RAG_TRAINING_STATUS_TIMEOUT_MS || '', 10) || 30 * 60 * 1000,
)

// DB 장애 중에도 현재 프로세스의 표시가 동작하도록 유지하는 짧은 호환 캐시.
// 정상 경로에서는 PostgreSQL의 rag_training_jobs가 단일 기준(source of truth)이다.
const trainingState = new Map()
let schemaPromise = null

function buildKey(type, id) {
  return `${type}:${String(id)}`
}

function normalizeType(type) {
  return type === 'comment' ? 'comment' : 'post'
}

function ensureTrainingStatusSchema() {
  if (!schemaPromise) {
    schemaPromise = db.query(`
      CREATE TABLE IF NOT EXISTS rag_training_jobs (
        source_type  VARCHAR(20) NOT NULL CHECK (source_type IN ('post', 'comment')),
        source_id    VARCHAR(100) NOT NULL,
        status       VARCHAR(20) NOT NULL CHECK (status IN ('queued', 'training', 'completed', 'failed', 'timed_out')),
        started_at   TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        error_message TEXT,
        PRIMARY KEY (source_type, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_rag_training_jobs_status_updated
        ON rag_training_jobs(status, updated_at);
    `).catch(async (error) => {
      // db.js의 시작 마이그레이션과 최초 요청이 동시에 CREATE TABLE을 실행하면
      // PostgreSQL 내부 타입 생성이 경합할 수 있다. 상대 쪽 생성이 끝났는지 확인한다.
      if (error?.code === '23505') {
        const existing = await db.query("SELECT to_regclass('public.rag_training_jobs') AS table_name")
        if (existing.rows?.[0]?.table_name) return
      }
      schemaPromise = null
      throw error
    })
  }
  return schemaPromise
}

async function persistStatus(type, id, status, errorMessage = null) {
  if (!type || id == null) return
  const sourceType = normalizeType(type)
  const sourceId = String(id)
  const nowIso = new Date().toISOString()
  trainingState.set(buildKey(sourceType, sourceId), {
    status,
    startedAt: status === 'training' ? nowIso : undefined,
    completedAt: status === 'completed' ? nowIso : undefined,
    updatedAt: nowIso,
    errorMessage: errorMessage || null,
  })

  try {
    await ensureTrainingStatusSchema()
    await db.query(`
      INSERT INTO rag_training_jobs
        (source_type, source_id, status, started_at, completed_at, updated_at, error_message)
      VALUES ($1, $2, $3::VARCHAR,
        CASE WHEN $3::VARCHAR = 'training' THEN NOW() ELSE NULL END,
        CASE WHEN $3::VARCHAR = 'completed' THEN NOW() ELSE NULL END,
        NOW(), $4)
      ON CONFLICT (source_type, source_id) DO UPDATE SET
        status = EXCLUDED.status,
        started_at = CASE WHEN EXCLUDED.status = 'training' THEN NOW() ELSE rag_training_jobs.started_at END,
        completed_at = CASE WHEN EXCLUDED.status = 'completed' THEN NOW() ELSE NULL END,
        updated_at = NOW(),
        error_message = EXCLUDED.error_message
    `, [sourceType, sourceId, status, errorMessage ? String(errorMessage).slice(0, 2000) : null])
  } catch (error) {
    console.error('[RAG] 학습 상태 DB 저장 실패:', error.message)
  }
}

function markTrainingStarted(type, id) {
  return persistStatus(type, id, 'training')
}

function markTrainingCompleted(type, id) {
  return persistStatus(type, id, 'completed')
}

function markTrainingFailed(type, id, error) {
  return persistStatus(type, id, 'failed', error?.message || error || 'RAG 학습에 실패했습니다.')
}

function clearTrainingStatus(type, id) {
  if (!type || id == null) return Promise.resolve()
  trainingState.delete(buildKey(normalizeType(type), id))
  return ensureTrainingStatusSchema()
    .then(() => db.query('DELETE FROM rag_training_jobs WHERE source_type=$1 AND source_id=$2', [normalizeType(type), String(id)]))
    .catch(error => console.error('[RAG] 학습 상태 삭제 실패:', error.message))
}

function formatStatus(entry) {
  if (!entry) return null
  const status = String(entry.status || '')
  const completedAt = entry.completed_at || entry.completedAt || null
  if (status === 'completed' && completedAt) {
    const age = Date.now() - new Date(completedAt).getTime()
    if (Number.isFinite(age) && age >= COMPLETED_VISIBLE_MS) return null
  }
  return {
    training_status: status,
    training_completed_at: completedAt,
    training_error: entry.error_message || entry.errorMessage || null,
  }
}

async function getTrainingStatuses(type, ids = []) {
  const sourceType = normalizeType(type)
  const sourceIds = [...new Set(ids.map(String).filter(Boolean))]
  const result = new Map()
  if (sourceIds.length === 0) return result

  try {
    await ensureTrainingStatusSchema()
    await db.query(`
      UPDATE rag_training_jobs
      SET status='timed_out', completed_at=NOW(), updated_at=NOW(),
          error_message=COALESCE(error_message, '학습 제한 시간을 초과했습니다.')
      WHERE source_type=$1 AND source_id = ANY($2)
        AND status IN ('queued', 'training')
        AND updated_at < NOW() - ($3 * INTERVAL '1 millisecond')
    `, [sourceType, sourceIds, TRAINING_TIMEOUT_MS])
    const rows = await db.query(`
      SELECT source_id, status, completed_at, error_message
      FROM rag_training_jobs
      WHERE source_type=$1 AND source_id = ANY($2)
    `, [sourceType, sourceIds])
    for (const row of rows.rows || []) {
      const formatted = formatStatus(row)
      if (formatted) result.set(String(row.source_id), formatted)
    }
    return result
  } catch (error) {
    console.error('[RAG] 학습 상태 DB 조회 실패:', error.message)
    for (const id of sourceIds) {
      const formatted = formatStatus(trainingState.get(buildKey(sourceType, id)))
      if (formatted) result.set(id, formatted)
    }
    return result
  }
}

async function getTrainingStatus(type, id) {
  if (!type || id == null) return null
  const statuses = await getTrainingStatuses(type, [id])
  return statuses.get(String(id)) || null
}

module.exports = {
  ensureTrainingStatusSchema,
  markTrainingStarted,
  markTrainingCompleted,
  markTrainingFailed,
  clearTrainingStatus,
  getTrainingStatus,
  getTrainingStatuses,
}
