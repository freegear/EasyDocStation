async function run(client, label, sql) {
  try {
    await client.query(sql)
    return true
  } catch (err) {
    if (err?.code === '42501') {
      console.warn(`⚠️ [Image2RAG schema] ${label} 건너뜀(테이블 owner 권한 필요): ${err.message}`)
      return false
    }
    throw err
  }
}

async function ensureImageRagSchema(client) {
  await run(client, 'create image_descriptions', `
    CREATE TABLE IF NOT EXISTS image_descriptions (
      id                    TEXT PRIMARY KEY,
      attachment_id         VARCHAR(50) NOT NULL,
      post_id               VARCHAR(50),
      comment_id            VARCHAR(50),
      channel_id            VARCHAR(50) NOT NULL DEFAULT '',
      owner_id              INTEGER,
      security_level        INTEGER NOT NULL DEFAULT 0,
      scope_metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
      file_hash             TEXT NOT NULL DEFAULT '',
      mime_type             TEXT,
      width                 INTEGER,
      height                INTEGER,
      schema_version        INTEGER NOT NULL DEFAULT 1,
      prompt_version        TEXT NOT NULL,
      model_provider        TEXT,
      model_name            TEXT,
      model_version         TEXT,
      summary               TEXT,
      description           TEXT,
      caption               TEXT,
      ocr_text              TEXT,
      analysis_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
      search_content        TEXT,
      analysis_status       TEXT NOT NULL DEFAULT 'pending'
                              CHECK (analysis_status IN ('pending','processing','completed','failed','deleted')),
      db_index_status       TEXT NOT NULL DEFAULT 'pending'
                              CHECK (db_index_status IN ('pending','indexed','failed','deleted')),
      rag_index_status      TEXT NOT NULL DEFAULT 'pending'
                              CHECK (rag_index_status IN ('pending','indexed','failed','deleted')),
      queue_priority        INTEGER NOT NULL DEFAULT 0,
      queue_source          TEXT NOT NULL DEFAULT 'legacy'
                              CHECK (queue_source IN ('upload','backfill','retry','legacy')),
      retryable             BOOLEAN NOT NULL DEFAULT TRUE,
      attempt_count         INTEGER NOT NULL DEFAULT 0,
      next_retry_at         TIMESTAMPTZ,
      last_error_code       TEXT,
      last_error_message    TEXT,
      worker_id             TEXT,
      processing_started_at TIMESTAMPTZ,
      completed_at          TIMESTAMPTZ,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (attachment_id)
    );
    CREATE INDEX IF NOT EXISTS idx_image_descriptions_attachment ON image_descriptions(attachment_id);
    CREATE INDEX IF NOT EXISTS idx_image_descriptions_retry
      ON image_descriptions(analysis_status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_image_descriptions_index_retry
      ON image_descriptions(db_index_status, rag_index_status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_image_descriptions_channel ON image_descriptions(channel_id);
    CREATE INDEX IF NOT EXISTS idx_image_descriptions_hash ON image_descriptions(file_hash);
    ALTER TABLE image_descriptions ADD COLUMN IF NOT EXISTS queue_priority INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE image_descriptions ADD COLUMN IF NOT EXISTS queue_source TEXT NOT NULL DEFAULT 'legacy';
    ALTER TABLE image_descriptions ADD COLUMN IF NOT EXISTS retryable BOOLEAN NOT NULL DEFAULT TRUE;
    UPDATE image_descriptions
       SET retryable=FALSE, next_retry_at=NULL
     WHERE analysis_status='failed'
       AND last_error_code IN (
         'IMAGE_FILE_NOT_FOUND','IMAGE_NOT_FILE','IMAGE_SIZE_LIMIT_EXCEEDED',
         'IMAGE_PIXEL_LIMIT_EXCEEDED','IMAGE_DECODE_FAILED','IMAGE_PROVIDER_UNSUPPORTED','IMAGE_VISION_REQUEST_FAILED'
       );
    CREATE INDEX IF NOT EXISTS idx_image_descriptions_queue
      ON image_descriptions(queue_priority DESC, updated_at ASC);
    ALTER TABLE image_descriptions DROP CONSTRAINT IF EXISTS image_descriptions_attachment_id_fkey;
  `)

  await run(client, 'create image_analysis_attempts', `
    CREATE TABLE IF NOT EXISTS image_analysis_attempts (
      id                   BIGSERIAL PRIMARY KEY,
      image_description_id TEXT NOT NULL REFERENCES image_descriptions(id) ON DELETE CASCADE,
      attempt_no           INTEGER NOT NULL,
      worker_id            TEXT,
      provider             TEXT,
      model_name           TEXT,
      status               TEXT NOT NULL,
      error_code           TEXT,
      error_message        TEXT,
      duration_ms          INTEGER,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at          TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_image_analysis_attempts_description
      ON image_analysis_attempts(image_description_id, attempt_no DESC);
  `)
}

module.exports = { ensureImageRagSchema }
