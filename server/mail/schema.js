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

  await run(client, 'create mail folders messages attachments', `
    CREATE TABLE IF NOT EXISTS mail_folders (
      id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      tenant_id          TEXT NOT NULL ${tenantFk},
      user_id            INTEGER NOT NULL ${userFk},
      account_id         TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
      provider_folder_id TEXT NOT NULL,
      name               TEXT NOT NULL,
      type               TEXT NOT NULL DEFAULT 'custom' CHECK (type IN ('inbox', 'sent', 'drafts', 'trash', 'archive', 'spam', 'custom')),
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

  await run(client, 'mail message internet id column', `
    ALTER TABLE mail_messages
      ADD COLUMN IF NOT EXISTS internet_message_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_mail_messages_account_internet_id
      ON mail_messages(account_id, internet_message_id);
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
