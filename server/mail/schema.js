async function run(client, label, sql) {
  try {
    await client.query(sql)
  } catch (err) {
    if (err && err.code === '42501') {
      console.warn(`⚠️ [Mail schema] ${label} 건너뜀(테이블 owner 권한 필요): ${err.message}`)
      return false
    }
    throw err
  }
  return true
}

// ---------------------------------------------------------------------------
// 메일 스키마는 공용 DB(control plane)와 tenant 데이터(data plane)로 나뉜다.
//   - control plane : tenants / members / settings / db_connections / oauth_states
//                     → 항상 공용(메인) DB에만 존재한다.
//   - data plane    : accounts / folders / messages / attachments / sync / usage
//                     → shared_db tenant는 공용 DB, dedicated_db tenant는 전용 DB에 둔다.
//
// dedicated_db 전용 DB에는 users/teams/mail_tenants 테이블이 없으므로,
// data plane 스키마를 standalone 모드로 만들 때는 cross-plane FK를 제거한다.
// ---------------------------------------------------------------------------

// control plane FK(REFERENCES users / mail_tenants)는 standalone DB에서는 생략한다.
function controlFk(clause, standalone) {
  return standalone ? '' : clause
}

async function ensureMailControlSchema(client) {
  await run(client, 'create mail tenants', `
    CREATE TABLE IF NOT EXISTS mail_tenants (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      type           TEXT NOT NULL CHECK (type IN ('organization', 'project', 'personal')),
      owner_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      source_team_id VARCHAR(50) REFERENCES teams(id) ON DELETE CASCADE,
      storage_mode   TEXT NOT NULL DEFAULT 'shared_db' CHECK (storage_mode IN ('shared_db', 'dedicated_db')),
      db_connection_key TEXT,
      storage_prefix TEXT NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source_team_id)
    );

    CREATE TABLE IF NOT EXISTS mail_tenant_members (
      tenant_id  TEXT NOT NULL REFERENCES mail_tenants(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_mail_tenant_members_user ON mail_tenant_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_mail_tenants_source_team ON mail_tenants(source_team_id);
  `)

  await run(client, 'mail tenant routing columns', `
    ALTER TABLE mail_tenants
      ADD COLUMN IF NOT EXISTS storage_mode TEXT NOT NULL DEFAULT 'shared_db';
    ALTER TABLE mail_tenants
      ADD COLUMN IF NOT EXISTS db_connection_key TEXT;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'mail_tenants_storage_mode_check'
      ) THEN
        ALTER TABLE mail_tenants
          ADD CONSTRAINT mail_tenants_storage_mode_check
          CHECK (storage_mode IN ('shared_db', 'dedicated_db'));
      END IF;
    END $$;
  `)

  await run(client, 'create mail service settings and db connections', `
    CREATE TABLE IF NOT EXISTS mail_service_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      is_secret  BOOLEAN NOT NULL DEFAULT false,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mail_db_connections (
      connection_key              TEXT PRIMARY KEY,
      label                       TEXT NOT NULL,
      provider                    TEXT NOT NULL DEFAULT 'postgres' CHECK (provider IN ('postgres')),
      connection_string_encrypted TEXT NOT NULL,
      is_active                   BOOLEAN NOT NULL DEFAULT true,
      created_by                  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)

  await run(client, 'create mail oauth states', `
    CREATE TABLE IF NOT EXISTS mail_oauth_states (
      state       TEXT PRIMARY KEY,
      provider    TEXT NOT NULL,
      tenant_id   TEXT NOT NULL REFERENCES mail_tenants(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      redirect_to TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_mail_oauth_states_user ON mail_oauth_states(user_id);
    CREATE INDEX IF NOT EXISTS idx_mail_oauth_states_expires ON mail_oauth_states(expires_at);
  `)

  // 발신 도메인별 파비콘 캐시(전역). tenant와 무관하게 도메인 단위로 1회만 받아 재사용한다.
  //   status='ok'   : image/content_type 유효
  //   status='failed': 받아오기 실패(재시도 폭주 방지용 음성 캐시)
  await run(client, 'create mail domain favicons', `
    CREATE TABLE IF NOT EXISTS mail_domain_favicons (
      domain       TEXT PRIMARY KEY,
      content_type TEXT,
      image        BYTEA,
      status       TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'failed')),
      fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)
}

// data plane: shared_db tenant는 메인 DB(standalone=false), dedicated_db 전용 DB는 standalone=true.
async function ensureMailDataSchema(client, { standalone = false } = {}) {
  const tenantFk = controlFk('REFERENCES mail_tenants(id) ON DELETE CASCADE', standalone)
  const userFk = controlFk('REFERENCES users(id) ON DELETE CASCADE', standalone)
  const usageUserFk = controlFk('REFERENCES users(id) ON DELETE CASCADE', standalone)

  await run(client, 'create mail accounts', `
    CREATE TABLE IF NOT EXISTS mail_accounts (
      id                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      tenant_id                TEXT NOT NULL ${tenantFk},
      user_id                  INTEGER NOT NULL ${userFk},
      provider                 TEXT NOT NULL CHECK (provider IN ('gmail', 'naver', 'apple', 'imap', 'other')),
      provider_account_id      TEXT,
      email_address            TEXT NOT NULL,
      display_name             TEXT,
      username                 TEXT,
      password_encrypted       TEXT,
      imap_host                TEXT,
      imap_port                INTEGER,
      imap_security            TEXT CHECK (imap_security IN ('ssl', 'starttls', 'none')),
      smtp_host                TEXT,
      smtp_port                INTEGER,
      smtp_security            TEXT CHECK (smtp_security IN ('ssl', 'starttls', 'none')),
      scopes                   JSONB NOT NULL DEFAULT '[]',
      access_token_encrypted   TEXT,
      refresh_token_encrypted  TEXT,
      token_expires_at         TIMESTAMPTZ,
      status                   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'error', 'disabled')),
      sync_status              TEXT NOT NULL DEFAULT 'idle' CHECK (sync_status IN ('idle', 'syncing', 'error')),
      last_synced_at           TIMESTAMPTZ,
      sync_failure_count       INTEGER NOT NULL DEFAULT 0,
      sync_retry_after         TIMESTAMPTZ,
      last_sync_attempt_at     TIMESTAMPTZ,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, user_id, provider, email_address)
    );

    CREATE INDEX IF NOT EXISTS idx_mail_accounts_tenant ON mail_accounts(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_mail_accounts_user ON mail_accounts(user_id);
  `)

  await run(client, 'mail account imap smtp columns', `
    ALTER TABLE mail_accounts
      ADD COLUMN IF NOT EXISTS username TEXT;
    ALTER TABLE mail_accounts
      ADD COLUMN IF NOT EXISTS password_encrypted TEXT;
    ALTER TABLE mail_accounts
      ADD COLUMN IF NOT EXISTS imap_host TEXT;
    ALTER TABLE mail_accounts
      ADD COLUMN IF NOT EXISTS imap_port INTEGER;
    ALTER TABLE mail_accounts
      ADD COLUMN IF NOT EXISTS imap_security TEXT;
    ALTER TABLE mail_accounts
      ADD COLUMN IF NOT EXISTS smtp_host TEXT;
    ALTER TABLE mail_accounts
      ADD COLUMN IF NOT EXISTS smtp_port INTEGER;
    ALTER TABLE mail_accounts
      ADD COLUMN IF NOT EXISTS smtp_security TEXT;
  `)

  await run(client, 'mail account sync backoff columns', `
    ALTER TABLE mail_accounts
      ADD COLUMN IF NOT EXISTS sync_failure_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE mail_accounts
      ADD COLUMN IF NOT EXISTS sync_retry_after TIMESTAMPTZ;
    ALTER TABLE mail_accounts
      ADD COLUMN IF NOT EXISTS last_sync_attempt_at TIMESTAMPTZ;
  `)

  await run(client, 'create mail folders messages attachments', `
    CREATE TABLE IF NOT EXISTS mail_folders (
      id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      tenant_id          TEXT NOT NULL ${tenantFk},
      user_id            INTEGER NOT NULL ${userFk},
      account_id         TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
      provider_folder_id TEXT NOT NULL,
      name               TEXT NOT NULL,
      type               TEXT NOT NULL DEFAULT 'custom' CHECK (type IN ('inbox', 'sent', 'drafts', 'trash', 'archive', 'spam', 'custom')),
      parent_folder_id   TEXT REFERENCES mail_folders(id) ON DELETE CASCADE,
      color_key          TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (account_id, provider_folder_id)
    );

    CREATE TABLE IF NOT EXISTS mail_messages (
      id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      tenant_id             TEXT NOT NULL ${tenantFk},
      user_id               INTEGER NOT NULL ${userFk},
      account_id            TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
      provider_message_id   TEXT NOT NULL,
      internet_message_id   TEXT,
      folder_id             TEXT REFERENCES mail_folders(id) ON DELETE SET NULL,
      subject               TEXT NOT NULL DEFAULT '',
      from_email            TEXT,
      from_name             TEXT,
      to_json               JSONB NOT NULL DEFAULT '[]',
      cc_json               JSONB NOT NULL DEFAULT '[]',
      bcc_json              JSONB NOT NULL DEFAULT '[]',
      snippet               TEXT NOT NULL DEFAULT '',
      provider_thread_id    TEXT,
      received_at           TIMESTAMPTZ,
      sent_at               TIMESTAMPTZ,
      is_read               BOOLEAN NOT NULL DEFAULT false,
      is_starred            BOOLEAN NOT NULL DEFAULT false,
      has_attachments       BOOLEAN NOT NULL DEFAULT false,
      size_bytes            BIGINT NOT NULL DEFAULT 0,
      raw_object_key        TEXT,
      body_text_object_key  TEXT,
      body_html_object_key  TEXT,
      deleted_at            TIMESTAMPTZ,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (account_id, provider_message_id)
    );

    CREATE TABLE IF NOT EXISTS mail_attachments (
      id                     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      tenant_id              TEXT NOT NULL ${tenantFk},
      user_id                INTEGER NOT NULL ${userFk},
      account_id             TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
      message_id             TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
      provider_attachment_id TEXT,
      filename               TEXT NOT NULL,
      content_type           TEXT,
      content_id             TEXT,
      disposition            TEXT,
      size_bytes             BIGINT NOT NULL DEFAULT 0,
      object_key             TEXT NOT NULL,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_mail_folders_account ON mail_folders(account_id);
    CREATE INDEX IF NOT EXISTS idx_mail_messages_account_received ON mail_messages(account_id, received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mail_messages_account_internet_id ON mail_messages(account_id, internet_message_id);
    CREATE INDEX IF NOT EXISTS idx_mail_messages_tenant_user ON mail_messages(tenant_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_mail_attachments_message ON mail_attachments(message_id);
  `)

  await run(client, 'mail attachment image metadata columns', `
    ALTER TABLE mail_attachments
      ADD COLUMN IF NOT EXISTS content_id TEXT;
    ALTER TABLE mail_attachments
      ADD COLUMN IF NOT EXISTS disposition TEXT;
  `)

  // 메일 요약 결과 캐시(메일 상세 재진입 시 즉시 표시). 원본 메일과 분리된 AI 메타데이터다.
  await run(client, 'create mail message summaries', `
    CREATE TABLE IF NOT EXISTS mail_message_summaries (
      id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      tenant_id           TEXT NOT NULL ${tenantFk},
      user_id             INTEGER NOT NULL ${userFk},
      account_id          TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
      message_id          TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
      provider_message_id TEXT,
      summary_json        JSONB NOT NULL,
      raw_text            TEXT NOT NULL DEFAULT '',
      model               TEXT NOT NULL DEFAULT '',
      prompt_version      TEXT NOT NULL DEFAULT 'mail-summary-json-v1',
      target_language     TEXT NOT NULL DEFAULT 'ko',
      source_language     TEXT NOT NULL DEFAULT 'unknown',
      translated          BOOLEAN NOT NULL DEFAULT false,
      translated_text     TEXT NOT NULL DEFAULT '',
      clean_body_text     TEXT NOT NULL DEFAULT '',
      fact_list_json      JSONB NOT NULL DEFAULT '[]',
      pipeline_version    TEXT NOT NULL DEFAULT 'mail-summary-pipeline-v2',
      fallback_used       BOOLEAN NOT NULL DEFAULT false,
      quality_flags       JSONB NOT NULL DEFAULT '[]',
      summary_version     INTEGER NOT NULL DEFAULT 1,
      generated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, user_id, message_id, target_language)
    );

    CREATE INDEX IF NOT EXISTS idx_mail_message_summaries_message
      ON mail_message_summaries(tenant_id, user_id, message_id);
    CREATE INDEX IF NOT EXISTS idx_mail_message_summaries_account
      ON mail_message_summaries(tenant_id, user_id, account_id);
  `)

  await run(client, 'mail message summary language columns', `
    ALTER TABLE mail_message_summaries
      ADD COLUMN IF NOT EXISTS target_language TEXT NOT NULL DEFAULT 'ko';
    ALTER TABLE mail_message_summaries
      ADD COLUMN IF NOT EXISTS source_language TEXT NOT NULL DEFAULT 'unknown';
    ALTER TABLE mail_message_summaries
      ADD COLUMN IF NOT EXISTS translated BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE mail_message_summaries
      ADD COLUMN IF NOT EXISTS translated_text TEXT NOT NULL DEFAULT '';
    ALTER TABLE mail_message_summaries
      ADD COLUMN IF NOT EXISTS clean_body_text TEXT NOT NULL DEFAULT '';
    ALTER TABLE mail_message_summaries
      ADD COLUMN IF NOT EXISTS fact_list_json JSONB NOT NULL DEFAULT '[]';
    ALTER TABLE mail_message_summaries
      ADD COLUMN IF NOT EXISTS pipeline_version TEXT NOT NULL DEFAULT 'mail-summary-pipeline-v2';
    ALTER TABLE mail_message_summaries
      ADD COLUMN IF NOT EXISTS fallback_used BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE mail_message_summaries
      ADD COLUMN IF NOT EXISTS quality_flags JSONB NOT NULL DEFAULT '[]';

    ALTER TABLE mail_message_summaries
      DROP CONSTRAINT IF EXISTS mail_message_summaries_tenant_id_user_id_message_id_key;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_message_summaries_lang_unique
      ON mail_message_summaries(tenant_id, user_id, message_id, target_language);
  `)

  await run(client, 'mail folder metadata columns', `
    ALTER TABLE mail_folders
      ADD COLUMN IF NOT EXISTS parent_folder_id TEXT REFERENCES mail_folders(id) ON DELETE CASCADE;
    ALTER TABLE mail_folders
      ADD COLUMN IF NOT EXISTS color_key TEXT;
  `)

  // 거울/로컬 폴더 분리:
  //  - is_local=true  : 로컬 전용 폴더(앱에서 만든 분류용). IMAP 메일박스가 없으며 동기화하지 않는다.
  //  - is_local=false : 거울 폴더(서버에서 발견된 실제 메일박스). 서버가 정본이며 동기화한다.
  //  - sync_status='missing' : 거울 폴더인데 서버에 메일박스가 사라진 상태(stale). 자동 동기화 중단.
  await run(client, 'mail folder local/sync columns', `
    ALTER TABLE mail_folders
      ADD COLUMN IF NOT EXISTS is_local BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE mail_folders
      ADD COLUMN IF NOT EXISTS sync_status TEXT;
  `)

  // deletable=false : 프로바이더가 삭제를 거부한 폴더(네이버 자동분류함, 서버 예약 메일함 등).
  //   flags/specialUse로는 일반 custom 폴더와 구별되지 않으므로, 삭제 시도가 서버에서 거부되면
  //   그 사실을 학습해 저장하고 이후 UI에서 삭제 메뉴를 비활성화한다. (folder_delete_error.md 2번)
  await run(client, 'mail folder deletable column', `
    ALTER TABLE mail_folders
      ADD COLUMN IF NOT EXISTS deletable BOOLEAN NOT NULL DEFAULT TRUE;
  `)

  await run(client, 'mail message internet id column', `
    ALTER TABLE mail_messages
      ADD COLUMN IF NOT EXISTS internet_message_id TEXT;
    ALTER TABLE mail_messages
      ADD COLUMN IF NOT EXISTS provider_thread_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_mail_messages_account_internet_id
      ON mail_messages(account_id, internet_message_id);
    CREATE INDEX IF NOT EXISTS idx_mail_messages_account_thread
      ON mail_messages(account_id, provider_thread_id);
  `)

  await run(client, 'create mail sync and usage', `
    CREATE TABLE IF NOT EXISTS mail_sync_state (
      account_id          TEXT PRIMARY KEY REFERENCES mail_accounts(id) ON DELETE CASCADE,
      tenant_id           TEXT NOT NULL ${tenantFk},
      user_id             INTEGER NOT NULL ${userFk},
      provider            TEXT NOT NULL,
      history_id          TEXT,
      cursor_token        TEXT,
      last_full_sync_at   TIMESTAMPTZ,
      last_partial_sync_at TIMESTAMPTZ,
      last_error          TEXT,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mail_usage (
      tenant_id        TEXT NOT NULL ${tenantFk},
      user_id          INTEGER ${usageUserFk},
      account_id       TEXT REFERENCES mail_accounts(id) ON DELETE CASCADE,
      message_count    BIGINT NOT NULL DEFAULT 0,
      message_bytes    BIGINT NOT NULL DEFAULT 0,
      attachment_bytes BIGINT NOT NULL DEFAULT 0,
      total_bytes      BIGINT NOT NULL DEFAULT 0,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, user_id, account_id)
    );

    CREATE INDEX IF NOT EXISTS idx_mail_usage_tenant ON mail_usage(tenant_id);
  `)

  const ownerFk = controlFk('REFERENCES users(id) ON DELETE CASCADE', standalone)
  await run(client, 'create mailclaw tables', `
    CREATE TABLE IF NOT EXISTS mailclaw_rules (
      id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      tenant_id             TEXT NOT NULL ${tenantFk},
      owner_user_id          INTEGER NOT NULL ${ownerFk},
      name                  TEXT NOT NULL,
      enabled               BOOLEAN NOT NULL DEFAULT true,
      sender_check_enabled  BOOLEAN NOT NULL DEFAULT false,
      sender_conditions     JSONB NOT NULL DEFAULT '[]',
      recipient_check_enabled BOOLEAN NOT NULL DEFAULT false,
      recipient_conditions  JSONB NOT NULL DEFAULT '[]',
      cc_check_enabled      BOOLEAN NOT NULL DEFAULT false,
      cc_conditions         JSONB NOT NULL DEFAULT '[]',
      keyword_check_enabled BOOLEAN NOT NULL DEFAULT false,
      keyword_conditions    JSONB NOT NULL DEFAULT '[]',
      ai_analysis_enabled   BOOLEAN NOT NULL DEFAULT false,
      important_mail_enabled BOOLEAN NOT NULL DEFAULT false,
      forward_enabled       BOOLEAN NOT NULL DEFAULT false,
      forward_addresses     JSONB NOT NULL DEFAULT '[]',
      move_folder_enabled   BOOLEAN NOT NULL DEFAULT false,
      target_folder_id      TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mailclaw_execution_logs (
      id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      tenant_id     TEXT NOT NULL ${tenantFk},
      rule_id       TEXT NOT NULL REFERENCES mailclaw_rules(id) ON DELETE CASCADE,
      message_id    TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
      status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'partial_failed', 'failed', 'skipped')),
      matched       BOOLEAN NOT NULL DEFAULT false,
      action_results JSONB NOT NULL DEFAULT '[]',
      error_message TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (rule_id, message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_mailclaw_rules_tenant_owner ON mailclaw_rules(tenant_id, owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_mailclaw_rules_enabled ON mailclaw_rules(tenant_id, enabled);
    CREATE INDEX IF NOT EXISTS idx_mailclaw_logs_rule ON mailclaw_execution_logs(rule_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mailclaw_logs_message ON mailclaw_execution_logs(message_id);
  `)

  await run(client, 'mailclaw recipient condition columns', `
    ALTER TABLE mailclaw_rules
      ADD COLUMN IF NOT EXISTS recipient_check_enabled BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE mailclaw_rules
      ADD COLUMN IF NOT EXISTS recipient_conditions JSONB NOT NULL DEFAULT '[]';
  `)

  // MailClaw 규칙에 "스마트 폴더 태그 부여" 액션(+각 계정 내 아카이브 옵션)을 추가한다. (MailService.md 13.6)
  await run(client, 'mailclaw smart folder tag action columns', `
    ALTER TABLE mailclaw_rules
      ADD COLUMN IF NOT EXISTS tag_smart_folder_enabled BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE mailclaw_rules
      ADD COLUMN IF NOT EXISTS tag_smart_folder_id TEXT;
    ALTER TABLE mailclaw_rules
      ADD COLUMN IF NOT EXISTS tag_archive_enabled BOOLEAN NOT NULL DEFAULT false;
  `)

  // MailClaw 규칙에 "중요 메일 등록" 액션을 추가한다. 매칭된 메일의 로컬 중요 표시(is_starred)를 켠다.
  await run(client, 'mailclaw important mail action column', `
    ALTER TABLE mailclaw_rules
      ADD COLUMN IF NOT EXISTS important_mail_enabled BOOLEAN NOT NULL DEFAULT false;
  `)

  // 통합 메일함 태그 기반 스마트 폴더 (MailService.md 13)
  //  - mail_smart_folders  : (tenant, user) 스코프의 태그 정의. 특정 account/folder에 묶이지 않는다.
  //  - mail_message_tags   : 메일 ↔ 스마트 폴더 다대다. 로컬 전용 메타데이터(동기화가 건드리지 않음).
  await run(client, 'create mail smart folders', `
    CREATE TABLE IF NOT EXISTS mail_smart_folders (
      id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      tenant_id  TEXT NOT NULL ${tenantFk},
      user_id    INTEGER NOT NULL ${userFk},
      name       TEXT NOT NULL,
      color_key  TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, user_id, name)
    );

    CREATE TABLE IF NOT EXISTS mail_message_tags (
      tenant_id       TEXT NOT NULL ${tenantFk},
      user_id         INTEGER NOT NULL ${userFk},
      smart_folder_id TEXT NOT NULL REFERENCES mail_smart_folders(id) ON DELETE CASCADE,
      message_id      TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, smart_folder_id, message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_mail_smart_folders_tenant_user ON mail_smart_folders(tenant_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_mail_message_tags_folder ON mail_message_tags(tenant_id, smart_folder_id);
    CREATE INDEX IF NOT EXISTS idx_mail_message_tags_message ON mail_message_tags(tenant_id, message_id);
    CREATE INDEX IF NOT EXISTS idx_mail_message_tags_user_message ON mail_message_tags(tenant_id, user_id, message_id);
  `)

  await run(client, 'create mail agentic tables', `
    CREATE TABLE IF NOT EXISTS mail_agentic_watch_targets (
      id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      tenant_id           TEXT NOT NULL ${tenantFk},
      owner_user_id        INTEGER NOT NULL ${ownerFk},
      target_type          TEXT NOT NULL,
      account_id           TEXT,
      email_address        TEXT,
      account_conditions   JSONB NOT NULL DEFAULT '[]',
      keyword_conditions   JSONB NOT NULL DEFAULT '[]',
      subject_conditions   JSONB NOT NULL DEFAULT '[]',
      condition_match_type TEXT NOT NULL DEFAULT 'contains',
      subject_match_type   TEXT,
      subject_pattern      TEXT,
      sender_pattern       TEXT,
      enabled              BOOLEAN NOT NULL DEFAULT true,
      notify_telegram      BOOLEAN NOT NULL DEFAULT true,
      auto_create_todos    BOOLEAN NOT NULL DEFAULT true,
      rag_enabled          BOOLEAN NOT NULL DEFAULT true,
      analysis_enabled     BOOLEAN NOT NULL DEFAULT true,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mail_agentic_threads (
      id                     TEXT PRIMARY KEY,
      tenant_id              TEXT NOT NULL ${tenantFk},
      watch_target_id         TEXT NOT NULL REFERENCES mail_agentic_watch_targets(id) ON DELETE CASCADE,
      account_id              TEXT,
      provider_thread_id      TEXT,
      normalized_subject      TEXT NOT NULL,
      participant_fingerprint TEXT,
      first_message_at        TIMESTAMPTZ,
      last_message_at         TIMESTAMPTZ,
      last_message_id         TEXT,
      status                  TEXT NOT NULL DEFAULT 'active',
      last_rag_trained_at     TIMESTAMPTZ,
      last_analyzed_at        TIMESTAMPTZ,
      last_notified_at        TIMESTAMPTZ,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mail_agentic_thread_messages (
      thread_id       TEXT NOT NULL REFERENCES mail_agentic_threads(id) ON DELETE CASCADE,
      message_id      TEXT NOT NULL,
      tenant_id       TEXT NOT NULL,
      account_id      TEXT,
      direction       TEXT,
      rag_status      TEXT NOT NULL DEFAULT 'pending',
      content_hash    TEXT,
      attachment_hash TEXT,
      rag_trained_at  TIMESTAMPTZ,
      analyzed        BOOLEAN NOT NULL DEFAULT false,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (thread_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS mail_agentic_thread_reports (
      thread_id             TEXT PRIMARY KEY REFERENCES mail_agentic_threads(id) ON DELETE CASCADE,
      tenant_id             TEXT NOT NULL,
      summary               TEXT NOT NULL DEFAULT '',
      important_issues      JSONB NOT NULL DEFAULT '[]',
      progress_summary      JSONB NOT NULL DEFAULT '[]',
      action_items          JSONB NOT NULL DEFAULT '[]',
      todo_items            JSONB NOT NULL DEFAULT '[]',
      decisions             JSONB NOT NULL DEFAULT '[]',
      risks                 JSONB NOT NULL DEFAULT '[]',
      open_questions        JSONB NOT NULL DEFAULT '[]',
      last_message_id       TEXT,
      learned_message_count INTEGER NOT NULL DEFAULT 0,
      source_message_ids    JSONB NOT NULL DEFAULT '[]',
      analysis_version      INTEGER NOT NULL DEFAULT 1,
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mail_agentic_todos (
      id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      tenant_id         TEXT NOT NULL,
      thread_id         TEXT NOT NULL REFERENCES mail_agentic_threads(id) ON DELETE CASCADE,
      action_item_id    TEXT,
      owner_user_id     INTEGER,
      title             TEXT NOT NULL,
      description       TEXT,
      due_at            TIMESTAMPTZ,
      priority          TEXT NOT NULL DEFAULT 'normal',
      status            TEXT NOT NULL DEFAULT 'open',
      source_message_id TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mail_agentic_events (
      id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      tenant_id     TEXT NOT NULL,
      thread_id     TEXT,
      message_id    TEXT,
      event_type    TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      payload       JSONB NOT NULL DEFAULT '{}',
      error_message TEXT,
      retry_count   INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_mail_agentic_watch_targets_tenant
      ON mail_agentic_watch_targets(tenant_id, enabled);
    CREATE INDEX IF NOT EXISTS idx_mail_agentic_threads_target
      ON mail_agentic_threads(watch_target_id, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mail_agentic_thread_messages_status
      ON mail_agentic_thread_messages(tenant_id, rag_status);
    CREATE INDEX IF NOT EXISTS idx_mail_agentic_events_pending
      ON mail_agentic_events(tenant_id, status, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_agentic_todos_dedupe
      ON mail_agentic_todos(thread_id, action_item_id)
      WHERE action_item_id IS NOT NULL;
  `)
}

async function backfillMailTenants(client) {
  await run(client, 'backfill mail tenants from teams/users', `
    INSERT INTO mail_tenants (id, name, type, source_team_id, storage_prefix)
    SELECT 'team-' || t.id, t.name, 'organization', t.id, 'tenants/team-' || t.id
    FROM teams t
    ON CONFLICT (source_team_id) DO UPDATE
      SET name = EXCLUDED.name,
          updated_at = NOW();

    INSERT INTO mail_tenant_members (tenant_id, user_id, role)
    SELECT 'team-' || ta.team_id, ta.user_id, 'admin'
    FROM team_admins ta
    ON CONFLICT (tenant_id, user_id) DO UPDATE
      SET role = CASE
        WHEN mail_tenant_members.role = 'owner' THEN 'owner'
        ELSE EXCLUDED.role
      END;

    INSERT INTO mail_tenant_members (tenant_id, user_id, role)
    SELECT 'team-' || tm.team_id, tm.user_id, 'member'
    FROM team_members tm
    ON CONFLICT (tenant_id, user_id) DO NOTHING;

    INSERT INTO mail_tenants (id, name, type, owner_user_id, storage_prefix)
    SELECT 'personal-' || u.id, COALESCE(NULLIF(u.display_name, ''), u.name, u.username) || ' 개인 공간', 'personal', u.id, 'tenants/personal-' || u.id
    FROM users u
    ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name,
          owner_user_id = EXCLUDED.owner_user_id,
          updated_at = NOW();

    INSERT INTO mail_tenant_members (tenant_id, user_id, role)
    SELECT 'personal-' || u.id, u.id, 'owner'
    FROM users u
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'owner';
  `)
}

// 메인(공용) DB 전체 스키마: control plane + shared_db tenant용 data plane + backfill
async function ensureMailSchema(client) {
  await ensureMailControlSchema(client)
  await ensureMailDataSchema(client, { standalone: false })
  await backfillMailTenants(client)
}

module.exports = {
  ensureMailSchema,
  ensureMailControlSchema,
  ensureMailDataSchema,
  backfillMailTenants,
}
