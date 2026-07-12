// 폴더 업로드(데이터셋) 스키마
// 설계: MDfiles/UploadFolder.md — attachments를 소유권/보안등급/삭제의 기준 테이블로 두고,
// folder_documents는 특정 folder_datasets 안의 폴더 문맥을 나타내는 파생 메타데이터다.
// 모든 마이그레이션은 재실행 안전(idempotent)하며 boot 시 db.js initDb에서 호출된다.

async function run(client, label, sql) {
  try {
    await client.query(sql)
  } catch (err) {
    if (err && err.code === '42501') {
      console.warn(`⚠️ [Folder schema] ${label} 건너뜀(테이블 owner 권한 필요): ${err.message}`)
      return false
    }
    throw err
  }
  return true
}

async function ensureFolderDatasetSchema(client) {
  // ── 0단계: attachments 기준 테이블 보강 (UploadFolder.md 4.4 전제 조건) ──
  // owner_id: 원본의 최종 소유자. security_level: 보안등급 원천(정수, users.security_level과 동일 척도).
  // deleted_at: soft delete 시각. status에는 앱 레벨에서 'removed'/'deleted' 상태를 사용한다.
  await run(client, 'attachments 소유권/보안/삭제 컬럼', `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attachments' AND column_name='owner_id') THEN
        ALTER TABLE attachments ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attachments' AND column_name='security_level') THEN
        ALTER TABLE attachments ADD COLUMN security_level INTEGER NOT NULL DEFAULT 0;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attachments' AND column_name='deleted_at') THEN
        ALTER TABLE attachments ADD COLUMN deleted_at TIMESTAMPTZ;
      END IF;
    END $$;
  `)

  // ── folder_datasets: 폴더 업로드 단위의 상위 데이터셋 ──
  await run(client, 'create folder_datasets', `
    CREATE TABLE IF NOT EXISTS folder_datasets (
      id               VARCHAR(50) PRIMARY KEY,
      owner_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
      name             TEXT NOT NULL,
      root_folder      TEXT,
      access_scope     TEXT NOT NULL DEFAULT 'personal'
                         CHECK (access_scope IN ('all', 'team', 'channel', 'personal')),
      scope_team_id    VARCHAR(50) REFERENCES teams(id) ON DELETE SET NULL,
      scope_channel_id VARCHAR(50) REFERENCES channels(id) ON DELETE SET NULL,
      security_level   INTEGER NOT NULL DEFAULT 0,
      source_type      TEXT NOT NULL DEFAULT 'browser_upload'
                         CHECK (source_type IN ('browser_upload', 'server_path')),
      source_root_id   VARCHAR(50),
      source_sub_path  TEXT,
      source_root_path TEXT,
      status           TEXT NOT NULL DEFAULT 'pending',
      file_count       INTEGER NOT NULL DEFAULT 0,
      total_bytes      BIGINT  NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)

  // ── folder_upload_batches: 한 번의 등록 실행 단위(증분 재등록 지원) ──
  await run(client, 'create folder_upload_batches', `
    CREATE TABLE IF NOT EXISTS folder_upload_batches (
      id              VARCHAR(50) PRIMARY KEY,
      dataset_id      VARCHAR(50) NOT NULL REFERENCES folder_datasets(id) ON DELETE CASCADE,
      owner_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      file_count      INTEGER NOT NULL DEFAULT 0,
      completed_count INTEGER NOT NULL DEFAULT 0,
      failed_count    INTEGER NOT NULL DEFAULT 0,
      total_bytes     BIGINT  NOT NULL DEFAULT 0,
      started_at      TIMESTAMPTZ,
      finished_at     TIMESTAMPTZ,
      error_message   TEXT
    );
  `)

  // ── folder_documents: 폴더 내 파일 1건에 대응하는 파생 문서 메타데이터 ──
  await run(client, 'create folder_documents', `
    CREATE TABLE IF NOT EXISTS folder_documents (
      id                       VARCHAR(50) PRIMARY KEY,
      dataset_id               VARCHAR(50) NOT NULL REFERENCES folder_datasets(id) ON DELETE CASCADE,
      batch_id                 VARCHAR(50) REFERENCES folder_upload_batches(id) ON DELETE SET NULL,
      attachment_id            VARCHAR(50) REFERENCES attachments(id) ON DELETE SET NULL,
      owner_id                 INTEGER REFERENCES users(id) ON DELETE SET NULL,
      access_scope             TEXT,
      scope_team_id            VARCHAR(50),
      scope_channel_id         VARCHAR(50),
      security_level           INTEGER NOT NULL DEFAULT 0,
      effective_security_level INTEGER NOT NULL DEFAULT 0,
      file_name                TEXT,
      extension                TEXT,
      file_size                BIGINT NOT NULL DEFAULT 0,
      content_type             TEXT,
      hash                     TEXT,
      hash_algorithm           TEXT NOT NULL DEFAULT 'sha256',
      upload_status            TEXT NOT NULL DEFAULT 'pending',
      storage_status           TEXT NOT NULL DEFAULT 'temporary',
      temp_path                TEXT,
      storage_path             TEXT,
      root_folder              TEXT,
      relative_path            TEXT,
      folder_path              TEXT,
      parent_folder            TEXT,
      folder_keywords          JSONB NOT NULL DEFAULT '[]',
      folder_group_id          TEXT,
      sibling_files            JSONB NOT NULL DEFAULT '[]',
      created_at_original      TIMESTAMPTZ,
      modified_at_original     TIMESTAMPTZ,
      uploaded_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      training_status          TEXT NOT NULL DEFAULT 'pending',
      training_error           TEXT
    );
  `)

  // ── folder_relationships: 문서 간 폴더 기반 관계(4단계에서 채움) ──
  await run(client, 'create folder_relationships', `
    CREATE TABLE IF NOT EXISTS folder_relationships (
      id                 BIGSERIAL PRIMARY KEY,
      dataset_id         VARCHAR(50) NOT NULL REFERENCES folder_datasets(id) ON DELETE CASCADE,
      source_document_id VARCHAR(50) NOT NULL REFERENCES folder_documents(id) ON DELETE CASCADE,
      target_document_id VARCHAR(50) NOT NULL REFERENCES folder_documents(id) ON DELETE CASCADE,
      relation_type      TEXT NOT NULL
                           CHECK (relation_type IN ('same_folder', 'parent_child_folder', 'same_root_folder')),
      weight             NUMERIC(4,2) NOT NULL DEFAULT 1.0,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source_document_id, target_document_id, relation_type)
    );
  `)

  // ── 인덱스 ──
  await run(client, 'folder indexes', `
    CREATE INDEX IF NOT EXISTS idx_folder_datasets_owner        ON folder_datasets(owner_id);
    CREATE INDEX IF NOT EXISTS idx_folder_datasets_scope        ON folder_datasets(access_scope);
    CREATE INDEX IF NOT EXISTS idx_folder_batches_dataset       ON folder_upload_batches(dataset_id);
    CREATE INDEX IF NOT EXISTS idx_folder_documents_dataset     ON folder_documents(dataset_id);
    CREATE INDEX IF NOT EXISTS idx_folder_documents_attachment  ON folder_documents(attachment_id);
    CREATE INDEX IF NOT EXISTS idx_folder_documents_group       ON folder_documents(folder_group_id);
    CREATE INDEX IF NOT EXISTS idx_folder_documents_hash        ON folder_documents(hash);
    CREATE INDEX IF NOT EXISTS idx_folder_relationships_source  ON folder_relationships(source_document_id);
  `)
}

module.exports = { ensureFolderDatasetSchema }
