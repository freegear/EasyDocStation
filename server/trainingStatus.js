const db = require('./db')
const { deriveCombinedTrainingStatus } = require('./trainingStatusPolicy')

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
        body_status  VARCHAR(20) NOT NULL DEFAULT 'queued'
                       CHECK (body_status IN ('queued', 'training', 'completed', 'failed', 'timed_out')),
        started_at   TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        error_message TEXT,
        PRIMARY KEY (source_type, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_rag_training_jobs_status_updated
        ON rag_training_jobs(status, updated_at);
      ALTER TABLE rag_training_jobs ADD COLUMN IF NOT EXISTS body_status VARCHAR(20);
      UPDATE rag_training_jobs SET body_status=status WHERE body_status IS NULL;
      ALTER TABLE rag_training_jobs ALTER COLUMN body_status SET DEFAULT 'queued';
      ALTER TABLE rag_training_jobs ALTER COLUMN body_status SET NOT NULL;
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

async function persistStatus(type, id, bodyStatus, errorMessage = null) {
  if (!type || id == null) return
  const sourceType = normalizeType(type)
  const sourceId = String(id)
  const nowIso = new Date().toISOString()
  // completed는 본문 RAG 단계의 완료다. 이미지 단계까지 집계되기 전에는
  // 전체 상태를 training으로 유지하여 완료 배지가 먼저 표시되지 않게 한다.
  const aggregateStatus = bodyStatus === 'completed' ? 'training' : bodyStatus
  trainingState.set(buildKey(sourceType, sourceId), {
    status: aggregateStatus,
    bodyStatus,
    startedAt: bodyStatus === 'training' ? nowIso : undefined,
    completedAt: undefined,
    updatedAt: nowIso,
    errorMessage: errorMessage || null,
  })

  try {
    await ensureTrainingStatusSchema()
    await db.query(`
      INSERT INTO rag_training_jobs
        (source_type, source_id, status, body_status, started_at, completed_at, updated_at, error_message)
      VALUES ($1, $2, $4::VARCHAR, $3::VARCHAR,
        CASE WHEN $3::VARCHAR = 'training' THEN NOW() ELSE NULL END,
        NULL, NOW(), $5)
      ON CONFLICT (source_type, source_id) DO UPDATE SET
        status = EXCLUDED.status,
        body_status = EXCLUDED.body_status,
        started_at = CASE WHEN EXCLUDED.body_status = 'training' THEN NOW() ELSE rag_training_jobs.started_at END,
        completed_at = NULL,
        updated_at = NOW(),
        error_message = EXCLUDED.error_message
    `, [sourceType, sourceId, bodyStatus, aggregateStatus, errorMessage ? String(errorMessage).slice(0, 2000) : null])
  } catch (error) {
    console.error('[RAG] 학습 상태 DB 저장 실패:', error.message)
  }
}

function markTrainingStarted(type, id) {
  return persistStatus(type, id, 'training')
}

async function markTrainingCompleted(type, id) {
  await persistStatus(type, id, 'completed')
  return refreshTrainingStatus(type, id, { touch: true })
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

async function getImageTrainingAggregates(type, ids = []) {
  const sourceType = normalizeType(type)
  const sourceIds = [...new Set(ids.map(String).filter(Boolean))]
  const result = new Map()
  if (sourceIds.length === 0) return result

  const imagePredicate = `(LOWER(COALESCE(a.content_type,'')) LIKE 'image/%'
    OR COALESCE(a.filename,'') ~* '\\.(jpe?g|png|webp|gif|bmp)$')`
  const relationSql = sourceType === 'comment'
    ? `SELECT c.id::text AS source_id, ref.attachment_id
       FROM comments c
       CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(c.attachments, '[]'::jsonb)) AS ref(attachment_id)
       WHERE c.id::text = ANY($1::text[])`
    : `SELECT p.id::text AS source_id, ref.attachment_id
       FROM posts p
       CROSS JOIN LATERAL unnest(ARRAY[
         p.attachments_1, p.attachments_2, p.attachments_3, p.attachments_4, p.attachments_5,
         p.attachments_6, p.attachments_7, p.attachments_8, p.attachments_9, p.attachments_10
       ]::text[]) AS ref(attachment_id)
       WHERE p.id::text = ANY($1::text[]) AND ref.attachment_id IS NOT NULL`

  const rows = await db.query(
    `WITH source_images AS (${relationSql})
     SELECT si.source_id,
            COUNT(DISTINCT a.id)::int AS image_count,
            COUNT(DISTINCT a.id) FILTER (
              WHERE d.analysis_status='completed'
                AND d.db_index_status='indexed'
                AND d.rag_index_status='indexed'
            )::int AS completed_image_count,
            COUNT(DISTINCT a.id) FILTER (
              WHERE d.analysis_status='failed'
                AND d.retryable=FALSE
            )::int AS terminal_failed_image_count,
            MAX(d.last_error_message) FILTER (
              WHERE d.analysis_status='failed' OR d.db_index_status='failed' OR d.rag_index_status='failed'
            ) AS image_error
       FROM source_images si
       JOIN attachments a ON a.id=si.attachment_id AND ${imagePredicate}
       LEFT JOIN image_descriptions d ON d.attachment_id=a.id AND d.analysis_status <> 'deleted'
      GROUP BY si.source_id`,
    [sourceIds],
  )
  for (const row of rows.rows || []) result.set(String(row.source_id), row)
  return result
}

async function reconcileTrainingRows(sourceType, rows = [], { touch = false } = {}) {
  const imageAggregates = await getImageTrainingAggregates(sourceType, rows.map(row => row.source_id))
  for (const row of rows) {
    const sourceId = String(row.source_id)
    const images = imageAggregates.get(sourceId) || {}
    const status = deriveCombinedTrainingStatus({
      status: row.status,
      bodyStatus: row.body_status,
      imageCount: images.image_count,
      completedImageCount: images.completed_image_count,
      terminalFailedImageCount: images.terminal_failed_image_count,
    })
    const imageError = status === 'failed' && String(row.body_status || '') === 'completed'
      ? (images.image_error || '이미지 설명 또는 이미지 RAG 등록에 실패했습니다.')
      : null
    const errorMessage = imageError || (['failed', 'timed_out'].includes(status) ? row.error_message : null)

    if (status !== row.status || touch) {
      await db.query(
        `UPDATE rag_training_jobs
            SET status=$3::VARCHAR,
                completed_at=CASE WHEN $3::VARCHAR='completed' THEN COALESCE(completed_at,NOW()) ELSE NULL END,
                updated_at=NOW(),
                error_message=$4
          WHERE source_type=$1 AND source_id=$2`,
        [sourceType, sourceId, status, errorMessage],
      )
    }
    row.status = status
    row.completed_at = status === 'completed' ? (row.completed_at || new Date().toISOString()) : null
    row.error_message = errorMessage
    trainingState.set(buildKey(sourceType, sourceId), {
      status,
      bodyStatus: row.body_status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      updatedAt: new Date().toISOString(),
      errorMessage,
    })
  }
  return rows
}

async function getTrainingStatuses(type, ids = [], options = {}) {
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
      SELECT source_id, status, body_status, started_at, completed_at, error_message
      FROM rag_training_jobs
      WHERE source_type=$1 AND source_id = ANY($2)
    `, [sourceType, sourceIds])
    const reconciledRows = await reconcileTrainingRows(sourceType, rows.rows || [], options)
    for (const row of reconciledRows) {
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

async function refreshTrainingStatus(type, id, options = {}) {
  if (!type || id == null) return null
  const statuses = await getTrainingStatuses(type, [id], { ...options, touch: options.touch !== false })
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
  refreshTrainingStatus,
}
