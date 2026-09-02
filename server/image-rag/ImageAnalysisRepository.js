const { ensureImageRagSchema } = require('./schema')
const { retryDelayMs } = require('./imageDescriptionFormatter')

class ImageAnalysisRepository {
  constructor(db) {
    this.db = db
    this.schemaReady = false
  }

  async ensureSchema() {
    if (this.schemaReady) return
    await ensureImageRagSchema(this.db)
    this.schemaReady = true
  }

  async enqueue(item, config, { forceAnalysis = false, resetAttempts = false, source = 'upload' } = {}) {
    const attachmentId = String(item?.attachmentId || item?.attachment_id || '').trim()
    if (!attachmentId) return { queued: false, reason: 'EMPTY_ATTACHMENT_ID' }
    await this.ensureSchema()
    const id = `image-description:${attachmentId}`
    const scopeMetadata = item?.scopeMetadata || item?.scope_metadata || {}
    const result = await this.db.query(
      `INSERT INTO image_descriptions (
         id, attachment_id, post_id, comment_id, channel_id, owner_id, security_level,
         scope_metadata, prompt_version, schema_version, analysis_status,
         db_index_status, rag_index_status, queue_priority, queue_source, next_retry_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'pending','pending','pending',$11,$12,NULL,NOW())
       ON CONFLICT (attachment_id) DO UPDATE SET
         post_id=EXCLUDED.post_id,
         comment_id=EXCLUDED.comment_id,
         channel_id=EXCLUDED.channel_id,
         owner_id=COALESCE(EXCLUDED.owner_id,image_descriptions.owner_id),
         security_level=EXCLUDED.security_level,
         scope_metadata=EXCLUDED.scope_metadata,
         prompt_version=EXCLUDED.prompt_version,
         schema_version=EXCLUDED.schema_version,
         queue_priority=GREATEST(image_descriptions.queue_priority,EXCLUDED.queue_priority),
         queue_source=CASE
           WHEN EXCLUDED.queue_priority >= image_descriptions.queue_priority THEN EXCLUDED.queue_source
           ELSE image_descriptions.queue_source
         END,
         analysis_status=CASE
           WHEN $13::boolean OR image_descriptions.prompt_version <> EXCLUDED.prompt_version
             THEN 'pending'
           WHEN image_descriptions.analysis_status='deleted' THEN 'pending'
           ELSE image_descriptions.analysis_status
         END,
         file_hash=CASE WHEN $13::boolean THEN '' ELSE image_descriptions.file_hash END,
         db_index_status='pending',
         rag_index_status='pending',
         attempt_count=CASE
           WHEN $13::boolean OR $14::boolean OR image_descriptions.analysis_status='deleted' OR image_descriptions.prompt_version <> EXCLUDED.prompt_version THEN 0
           ELSE image_descriptions.attempt_count END,
         retryable=TRUE,
         next_retry_at=NULL,
         last_error_code=NULL,
         last_error_message=NULL,
         updated_at=NOW()
       RETURNING id, attachment_id, analysis_status`,
      [
        id,
        attachmentId,
        String(item?.postId || item?.post_id || ''),
        String(item?.commentId || item?.comment_id || ''),
        String(item?.channelId || item?.channel_id || ''),
        item?.ownerId ?? item?.authorId ?? item?.owner_id ?? null,
        Number(item?.securityLevel ?? item?.security_level ?? 0) || 0,
        JSON.stringify(scopeMetadata),
        config.promptVersion,
        config.schemaVersion,
        Number(config.uploadPriority || 100),
        source === 'retry' ? 'retry' : 'upload',
        Boolean(forceAnalysis),
        Boolean(resetAttempts),
      ],
    )
    return { queued: true, ...result.rows?.[0] }
  }

  async enqueueMany(items, config, options = {}) {
    const results = []
    for (const item of Array.isArray(items) ? items : []) {
      try {
        results.push(await this.enqueue(item, config, options))
      } catch (error) {
        results.push({ queued: false, attachmentId: item?.attachmentId, error: error.message })
      }
    }
    return results
  }

  async enqueueBackfill(config, limit = 200) {
    if (limit <= 0) return 0
    await this.ensureSchema()
    const result = await this.db.query(
      `INSERT INTO image_descriptions (
         id, attachment_id, post_id, comment_id, channel_id, owner_id, security_level,
         prompt_version, schema_version, analysis_status, db_index_status, rag_index_status,
         queue_priority, queue_source
       )
       SELECT 'image-description:' || a.id, a.id, COALESCE(a.post_id,''), COALESCE(a.comment_id,''),
              COALESCE(a.channel_id,''), a.uploader_id,
              COALESCE(c.security_level,p.security_level,0), $1, $2, 'pending', 'pending', 'pending',
              $4, 'backfill'
       FROM attachments a
       LEFT JOIN image_descriptions d ON d.attachment_id=a.id
       LEFT JOIN posts p ON p.id=a.post_id
       LEFT JOIN comments c ON c.id=a.comment_id
       WHERE d.attachment_id IS NULL
         AND UPPER(COALESCE(a.status,''))='COMPLETED'
         AND (LOWER(COALESCE(a.content_type,'')) LIKE 'image/%'
              OR COALESCE(a.filename,'') ~* '\\.(jpe?g|png|webp|gif|bmp)$')
       ORDER BY a.created_at ASC
       LIMIT $3
       ON CONFLICT (attachment_id) DO NOTHING
       RETURNING attachment_id`,
      [config.promptVersion, config.schemaVersion, limit, Number(config.backfillPriority || 0)],
    )
    return result.rowCount || 0
  }

  async recoverStale(leaseTimeoutMs) {
    await this.ensureSchema()
    const seconds = Math.max(60, Math.floor(Number(leaseTimeoutMs || 600000) / 1000))
    const result = await this.db.query(
      `UPDATE image_descriptions
       SET analysis_status='pending', worker_id=NULL, processing_started_at=NULL,
           next_retry_at=NOW(), updated_at=NOW()
       WHERE analysis_status='processing'
         AND processing_started_at < NOW() - ($1::text || ' seconds')::interval`,
      [seconds],
    )
    return result.rowCount || 0
  }

  async claimNext(workerId) {
    await this.ensureSchema()
    const result = await this.db.query(
      `WITH candidate AS (
         SELECT id
         FROM image_descriptions
         WHERE (next_retry_at IS NULL OR next_retry_at <= NOW())
           AND (
             (analysis_status='deleted' AND rag_index_status IN ('pending','failed'))
             OR (
               analysis_status <> 'deleted'
               AND (
                 analysis_status='pending'
                 OR (analysis_status='failed' AND retryable=TRUE)
                 OR (analysis_status='completed' AND (db_index_status IN ('pending','failed') OR rag_index_status IN ('pending','failed')))
               )
             )
           )
         ORDER BY CASE WHEN analysis_status='deleted' THEN 0 ELSE 1 END,
                  queue_priority DESC,
                  CASE WHEN analysis_status='completed' THEN 0 ELSE 1 END,
                  updated_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE image_descriptions d
       SET analysis_status=CASE WHEN d.analysis_status IN ('completed','deleted') THEN d.analysis_status ELSE 'processing' END,
           attempt_count=d.attempt_count+1,
           worker_id=$1,
           processing_started_at=NOW(),
           next_retry_at=NULL,
           updated_at=NOW()
       FROM candidate
       WHERE d.id=candidate.id
       RETURNING d.*`,
      [workerId],
    )
    return result.rows?.[0] || null
  }

  async getSource(attachmentId) {
    const result = await this.db.query(
      `SELECT a.id, a.post_id, a.comment_id, a.channel_id, a.uploader_id, a.filename, a.storage_path,
              a.content_type, a.status, COALESCE(a.delete_status,'active') AS delete_status,
              COALESCE(c.security_level,p.security_level,0) AS source_security_level
       FROM attachments a
       LEFT JOIN posts p ON p.id=a.post_id
       LEFT JOIN comments c ON c.id=a.comment_id WHERE a.id=$1 LIMIT 1`,
      [attachmentId],
    ).catch(async error => {
      if (error?.code !== '42703') throw error
      return this.db.query(
        `SELECT a.id, a.post_id, a.comment_id, a.channel_id, a.uploader_id, a.filename, a.storage_path,
                a.content_type, a.status, 'active' AS delete_status,
                COALESCE(c.security_level,p.security_level,0) AS source_security_level
         FROM attachments a
         LEFT JOIN posts p ON p.id=a.post_id
         LEFT JOIN comments c ON c.id=a.comment_id WHERE a.id=$1 LIMIT 1`,
        [attachmentId],
      )
    })
    const source = result.rows?.[0] || null
    if (!source) return null
    const folderResult = await this.db.query(
      `SELECT id AS folder_document_id, dataset_id, access_scope, scope_team_id,
              scope_channel_id, owner_id, effective_security_level, relative_path,
              folder_path, parent_folder, folder_group_id,
              COALESCE(folder_keywords::text,'') AS folder_keywords_text
       FROM folder_documents WHERE attachment_id=$1 AND storage_status <> 'removed' LIMIT 1`,
      [attachmentId],
    ).catch(() => ({ rows: [] }))
    source.folder = folderResult.rows?.[0] || null
    return source
  }

  async markAnalysisCompleted(id, result, config) {
    await this.db.query(
      `UPDATE image_descriptions SET
         file_hash=$2, width=$3, height=$4, model_provider=$5, model_name=$6,
         summary=$7, description=$8, caption=$9, ocr_text=$10,
         analysis_json=$11::jsonb, search_content=$12, analysis_status='completed',
         last_error_code=NULL, last_error_message=NULL, completed_at=NOW(), updated_at=NOW(),
         prompt_version=$13, schema_version=$14
       WHERE id=$1`,
      [
        id, result.fileHash, result.width, result.height, result.modelProvider, result.modelName,
        result.analysis.summary, result.analysis.description, result.analysis.caption, result.ocrText,
        JSON.stringify(result.analysis), result.searchContent, config.promptVersion, config.schemaVersion,
      ],
    )
  }

  async updateSourceMetadata(id, source) {
    const folder = source.folder || {}
    const scopeMetadata = source.folder ? {
      access_scope: folder.access_scope || '',
      scope_team_id: folder.scope_team_id || '',
      scope_channel_id: folder.scope_channel_id || '',
      dataset_id: folder.dataset_id || '',
      folder_document_id: folder.folder_document_id || '',
      relative_path: folder.relative_path || '',
      folder_path: folder.folder_path || '',
      parent_folder: folder.parent_folder || '',
      folder_group_id: folder.folder_group_id || '',
      folder_keywords_text: folder.folder_keywords_text || '',
    } : {}
    await this.db.query(
      `UPDATE image_descriptions SET
         post_id=$2, comment_id=$3, channel_id=$4, owner_id=$5,
         security_level=COALESCE($6,security_level), mime_type=$7, scope_metadata=$8::jsonb, updated_at=NOW()
       WHERE id=$1`,
      [
        id,
        String(source.post_id || ''),
        String(source.comment_id || ''),
        String(source.channel_id || folder.scope_channel_id || ''),
        folder.owner_id ?? source.uploader_id ?? null,
        Number(source.folder ? (folder.effective_security_level || 0) : (source.source_security_level || 0)),
        source.content_type || '',
        JSON.stringify(scopeMetadata),
      ],
    )
    return scopeMetadata
  }

  async upsertSearchDocument(job, source) {
    await this.db.query(
      `INSERT INTO search_documents (
         id, source_type, source_id, post_id, comment_id, attachment_id, channel_id,
         author_id, file_name, content, security_level, created_at, updated_at
       ) VALUES ($1,'image_attachment',$2,$3,$4,$2,$5,$6,$7,$8,$9,NOW(),NOW())
       ON CONFLICT (id) DO UPDATE SET
         post_id=EXCLUDED.post_id, comment_id=EXCLUDED.comment_id,
         attachment_id=EXCLUDED.attachment_id, channel_id=EXCLUDED.channel_id,
         author_id=EXCLUDED.author_id, file_name=EXCLUDED.file_name,
         content=EXCLUDED.content, security_level=EXCLUDED.security_level, updated_at=NOW()`,
      [
        `image_attachment:${job.attachment_id}`,
        job.attachment_id,
        String(source.post_id || job.post_id || ''),
        String(source.comment_id || job.comment_id || ''),
        String(source.channel_id || source.folder?.scope_channel_id || job.channel_id || ''),
        source.folder?.owner_id ?? source.uploader_id ?? job.owner_id ?? null,
        source.filename || '',
        job.search_content || '',
        Number(source.folder?.effective_security_level ?? source.source_security_level ?? job.security_level ?? 0) || 0,
      ],
    )
    await this.setIndexStatus(job.id, 'db', 'indexed')
  }

  async setFolderTrainingStatus(source, status, error = null) {
    const folderDocumentId = source?.folder?.folder_document_id
    if (!folderDocumentId) return
    await this.db.query(
      `UPDATE folder_documents SET training_status=$2, training_error=$3 WHERE id=$1`,
      [folderDocumentId, status, error ? String(error.message || error).slice(0, 500) : null],
    ).catch(() => {})
  }

  async setIndexStatus(id, target, status, error = null) {
    const column = target === 'rag' ? 'rag_index_status' : 'db_index_status'
    await this.db.query(
      `UPDATE image_descriptions SET ${column}=$2,
         last_error_code=CASE WHEN $2='failed' THEN $3 ELSE last_error_code END,
         last_error_message=CASE WHEN $2='failed' THEN $4 ELSE last_error_message END,
         next_retry_at=CASE WHEN $2='failed' THEN NOW() + ($5::text || ' milliseconds')::interval ELSE NULL END,
         updated_at=NOW() WHERE id=$1`,
      [id, status, error?.code || null, String(error?.message || '').slice(0, 1000), retryDelayMs(1)],
    )
  }

  async markFailure(job, error, retryable = true) {
    const delay = retryDelayMs()
    await this.db.query(
      `UPDATE image_descriptions SET analysis_status='failed', worker_id=NULL,
         last_error_code=$2, last_error_message=$3,
         retryable=$4,
         next_retry_at=CASE WHEN $4 THEN NOW() + ($5::text || ' milliseconds')::interval ELSE NULL END,
         updated_at=NOW() WHERE id=$1`,
      [job.id, error?.code || 'IMAGE_ANALYSIS_FAILED', String(error?.message || error).slice(0, 1000), retryable, delay],
    )
  }

  async finishAttempt(job, { status, startedAt, error = null, provider = '', modelName = '' }) {
    await this.db.query(
      `INSERT INTO image_analysis_attempts (
         image_description_id, attempt_no, worker_id, provider, model_name, status,
         error_code, error_message, duration_ms, finished_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
      [
        job.id, job.attempt_count, job.worker_id || '', provider, modelName, status,
        error?.code || null, String(error?.message || '').slice(0, 1000), Date.now() - startedAt,
      ],
    ).catch(() => {})
  }

  async markDeleted(attachmentId) {
    await this.ensureSchema()
    await this.db.query(
      `INSERT INTO image_descriptions (
         id, attachment_id, post_id, comment_id, channel_id, owner_id,
         prompt_version, analysis_status, db_index_status, rag_index_status
       )
       SELECT 'image-description:' || a.id, a.id, COALESCE(a.post_id,''), COALESCE(a.comment_id,''),
              COALESCE(a.channel_id,''), a.uploader_id,
              'deletion-tombstone-v1', 'deleted', 'deleted', 'pending'
       FROM attachments a WHERE a.id=$1
       ON CONFLICT (attachment_id) DO NOTHING`,
      [attachmentId],
    ).catch(() => {})
    await this.db.query('DELETE FROM search_documents WHERE id=$1 OR attachment_id=$2', [
      `image_attachment:${attachmentId}`, attachmentId,
    ]).catch(() => {})
    await this.db.query(
      `UPDATE image_descriptions SET analysis_status='deleted', db_index_status='deleted',
         rag_index_status=CASE WHEN rag_index_status='deleted' THEN 'deleted' ELSE 'pending' END,
         attempt_count=CASE WHEN analysis_status='deleted' THEN attempt_count ELSE 0 END,
         next_retry_at=CASE WHEN analysis_status='deleted' THEN next_retry_at ELSE NOW() END,
         worker_id=NULL, processing_started_at=NULL, updated_at=NOW()
       WHERE attachment_id=$1`,
      [attachmentId],
    ).catch(() => {})
  }

  async markRagDeleteFailure(attachmentId, error) {
    await this.db.query(
      `UPDATE image_descriptions SET rag_index_status='failed',
         last_error_code=$2, last_error_message=$3,
         next_retry_at=NOW() + ($4::text || ' milliseconds')::interval,
         worker_id=NULL, processing_started_at=NULL, updated_at=NOW()
       WHERE attachment_id=$1`,
      [
        attachmentId,
        error?.code || 'IMAGE_RAG_DELETE_FAILED',
        String(error?.message || error).slice(0, 1000),
        retryDelayMs(1),
      ],
    ).catch(() => {})
  }

  async markRagDeleted(attachmentId) {
    await this.db.query(
      `UPDATE image_descriptions SET rag_index_status='deleted', next_retry_at=NULL,
         worker_id=NULL, processing_started_at=NULL, updated_at=NOW() WHERE attachment_id=$1`,
      [attachmentId],
    ).catch(() => {})
  }

  async getByAttachmentId(attachmentId) {
    await this.ensureSchema()
    const result = await this.db.query(
      `SELECT id, attachment_id, post_id, comment_id, channel_id, owner_id, security_level,
              summary, description, caption, ocr_text, analysis_json, analysis_status, db_index_status,
              rag_index_status, attempt_count, last_error_code, last_error_message,
              prompt_version, model_provider, model_name, completed_at, updated_at
       FROM image_descriptions WHERE attachment_id=$1 LIMIT 1`,
      [attachmentId],
    )
    return result.rows?.[0] || null
  }
}

module.exports = { ImageAnalysisRepository }
