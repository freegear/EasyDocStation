const cm = require('./connectionManager')
const { encryptSecret } = require('../lib/secrets')
const { DEFAULT_SCOPES } = require('./gmailOAuth')

// ---------------------------------------------------------------------------
// mailRepository
//
// 설계 원칙 #2/#3: 메일 DB 접근은 반드시 이 레이어를 통한다. 라우트/UI에는 SQL을
// 흩뿌리지 않는다. control plane(공용 DB)과 data plane(tenant DB)의 라우팅은
// connectionManager가 담당하고, 여기서는 의미 단위의 메서드만 노출한다.
// ---------------------------------------------------------------------------

// ===== control plane: tenants =============================================

async function ensurePersonalTenant(userId) {
  const control = cm.getControlPool()
  const { rows } = await control.query(
    `SELECT id, COALESCE(NULLIF(display_name, ''), name, username) AS name
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId],
  )
  const user = rows[0]
  if (!user) return null

  const tenantId = `personal-${userId}`
  await control.query(
    `INSERT INTO mail_tenants (id, name, type, owner_user_id, storage_prefix)
     VALUES ($1, $2, 'personal', $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           owner_user_id = EXCLUDED.owner_user_id,
           updated_at = NOW()`,
    [tenantId, `${user.name} 개인 공간`, userId, `tenants/${tenantId}`],
  )
  await control.query(
    `INSERT INTO mail_tenant_members (tenant_id, user_id, role)
     VALUES ($1, $2, 'owner')
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'owner'`,
    [tenantId, userId],
  )
  return tenantId
}

async function syncTeamTenantsForUser(userId) {
  const control = cm.getControlPool()
  await control.query(`
    INSERT INTO mail_tenants (id, name, type, source_team_id, storage_prefix)
    SELECT 'team-' || t.id, t.name, 'organization', t.id, 'tenants/team-' || t.id
    FROM teams t
    WHERE EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = t.id AND tm.user_id = $1)
       OR EXISTS (SELECT 1 FROM team_admins ta WHERE ta.team_id = t.id AND ta.user_id = $1)
    ON CONFLICT (source_team_id) DO UPDATE
      SET name = EXCLUDED.name,
          updated_at = NOW()
  `, [userId])

  await control.query(`
    INSERT INTO mail_tenant_members (tenant_id, user_id, role)
    SELECT 'team-' || ta.team_id, ta.user_id, 'admin'
    FROM team_admins ta
    WHERE ta.user_id = $1
    ON CONFLICT (tenant_id, user_id) DO UPDATE
      SET role = CASE
        WHEN mail_tenant_members.role = 'owner' THEN 'owner'
        ELSE EXCLUDED.role
      END
  `, [userId])

  await control.query(`
    INSERT INTO mail_tenant_members (tenant_id, user_id, role)
    SELECT 'team-' || tm.team_id, tm.user_id, 'member'
    FROM team_members tm
    WHERE tm.user_id = $1
    ON CONFLICT (tenant_id, user_id) DO NOTHING
  `, [userId])
}

async function listTenantsForUser({ userId, isSiteAdmin }) {
  const control = cm.getControlPool()
  const { rows } = await control.query(
    `SELECT mt.id,
            mt.name,
            mt.type,
            mt.owner_user_id,
            mt.source_team_id,
            mt.storage_mode,
            mt.db_connection_key,
            mt.storage_prefix,
            COALESCE(mtm.role, CASE WHEN $2::boolean THEN 'admin' ELSE 'member' END) AS role,
            mt.created_at,
            mt.updated_at
     FROM mail_tenants mt
     LEFT JOIN mail_tenant_members mtm
       ON mtm.tenant_id = mt.id AND mtm.user_id = $1
     WHERE $2::boolean = true OR mtm.user_id = $1
     ORDER BY
       CASE mt.type WHEN 'organization' THEN 0 WHEN 'project' THEN 1 ELSE 2 END,
       mt.name ASC`,
    [userId, isSiteAdmin],
  )
  return rows
}

function getTenantRouting(tenantId) {
  return cm.getTenantRouting(tenantId)
}

async function canAccessTenant({ userId, tenantId, isSiteAdmin }) {
  if (isSiteAdmin) return true
  const control = cm.getControlPool()
  const { rowCount } = await control.query(
    `SELECT 1
     FROM mail_tenant_members
     WHERE tenant_id = $1 AND user_id = $2
     LIMIT 1`,
    [tenantId, userId],
  )
  return rowCount > 0
}

async function isTenantManager({ userId, tenantId }) {
  const control = cm.getControlPool()
  const { rowCount } = await control.query(
    `SELECT 1 FROM mail_tenant_members
     WHERE tenant_id = $1 AND user_id = $2 AND role IN ('owner', 'admin')
     LIMIT 1`,
    [tenantId, userId],
  )
  return rowCount > 0
}

async function updateTenantStorageMode({ tenantId, storageMode, dbConnectionKey }) {
  const control = cm.getControlPool()
  const { rows } = await control.query(
    `UPDATE mail_tenants
     SET storage_mode = $1,
         db_connection_key = $2,
         updated_at = NOW()
     WHERE id = $3
     RETURNING id, name, type, storage_mode, db_connection_key, storage_prefix`,
    [storageMode, storageMode === 'dedicated_db' ? dbConnectionKey : null, tenantId],
  )
  return rows[0] || null
}

// ===== control plane: db connections ======================================

async function listDbConnections() {
  const control = cm.getControlPool()
  const { rows } = await control.query(
    `SELECT connection_key, label, provider, is_active, created_at, updated_at
     FROM mail_db_connections
     ORDER BY label ASC`,
  )
  return rows
}

async function upsertDbConnection({ connectionKey, label, connectionString, createdBy }) {
  const control = cm.getControlPool()
  const { rows } = await control.query(
    `INSERT INTO mail_db_connections (
       connection_key,
       label,
       provider,
       connection_string_encrypted,
       created_by,
       updated_at
     )
     VALUES ($1, $2, 'postgres', $3, $4, NOW())
     ON CONFLICT (connection_key)
     DO UPDATE SET label = EXCLUDED.label,
                   connection_string_encrypted = EXCLUDED.connection_string_encrypted,
                   is_active = true,
                   updated_at = NOW()
     RETURNING connection_key, label, provider, is_active, created_at, updated_at`,
    [connectionKey, label, encryptSecret(connectionString), createdBy],
  )
  return rows[0]
}

// ===== control plane: oauth states ========================================

async function createOAuthState({ state, provider, tenantId, userId, redirectTo }) {
  const control = cm.getControlPool()
  await control.query(
    `INSERT INTO mail_oauth_states (state, provider, tenant_id, user_id, redirect_to, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '15 minutes')`,
    [state, provider, tenantId, userId, redirectTo || null],
  )
}

async function cleanupOAuthStates() {
  const control = cm.getControlPool()
  await control.query(
    `DELETE FROM mail_oauth_states WHERE expires_at <= NOW() OR consumed_at IS NOT NULL`,
  )
}

// ===== data plane: gmail account write (transactional) ====================

async function upsertGmailAccountTx(client, oauthState, fields) {
  const result = await client.query(
    `INSERT INTO mail_accounts (
       tenant_id, user_id, provider, provider_account_id, email_address,
       display_name, scopes, access_token_encrypted, refresh_token_encrypted,
       token_expires_at, status, sync_status, updated_at
     )
     VALUES ($1, $2, 'gmail', $3, $4, $5, $6::jsonb, $7, $8, $9, 'connected', 'idle', NOW())
     ON CONFLICT (tenant_id, user_id, provider, email_address)
     DO UPDATE SET
       provider_account_id = EXCLUDED.provider_account_id,
       display_name = EXCLUDED.display_name,
       scopes = EXCLUDED.scopes,
       access_token_encrypted = EXCLUDED.access_token_encrypted,
       refresh_token_encrypted = COALESCE(EXCLUDED.refresh_token_encrypted, mail_accounts.refresh_token_encrypted),
       token_expires_at = EXCLUDED.token_expires_at,
       status = 'connected',
       sync_status = 'idle',
       updated_at = NOW()
     RETURNING id`,
    [
      oauthState.tenant_id,
      oauthState.user_id,
      fields.providerAccountId,
      fields.emailAddress,
      fields.displayName,
      JSON.stringify(fields.scopes),
      fields.accessTokenEnc,
      fields.refreshTokenEnc,
      fields.expiresAt,
    ],
  )
  return result.rows[0].id
}

async function upsertDefaultFoldersTx(client, oauthState, accountId) {
  const defaultFolders = [
    ['INBOX', '받은 편지함', 'inbox'],
    ['SENT', '보낸 메일', 'sent'],
    ['DRAFT', '임시 보관함', 'drafts'],
    ['TRASH', '휴지통', 'trash'],
  ]
  for (const [providerFolderId, name, type] of defaultFolders) {
    await client.query(
      `INSERT INTO mail_folders (tenant_id, user_id, account_id, provider_folder_id, name, type)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (account_id, provider_folder_id)
       DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type, updated_at = NOW()`,
      [oauthState.tenant_id, oauthState.user_id, accountId, providerFolderId, name, type],
    )
  }
}

async function upsertSyncStateTx(client, oauthState, accountId, historyId) {
  await client.query(
    `INSERT INTO mail_sync_state (account_id, tenant_id, user_id, provider, history_id, updated_at)
     VALUES ($1, $2, $3, 'gmail', $4, NOW())
     ON CONFLICT (account_id)
     DO UPDATE SET history_id = COALESCE(EXCLUDED.history_id, mail_sync_state.history_id), updated_at = NOW()`,
    [accountId, oauthState.tenant_id, oauthState.user_id, historyId || null],
  )
}

async function upsertProviderSyncStateTx(client, accountState, accountId, provider) {
  await client.query(
    `INSERT INTO mail_sync_state (account_id, tenant_id, user_id, provider, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (account_id)
     DO UPDATE SET provider = EXCLUDED.provider, updated_at = NOW()`,
    [accountId, accountState.tenant_id, accountState.user_id, provider],
  )
}

function deriveGmailAccountFields({ tokens, userInfo, gmailProfile }) {
  const accessToken = tokens.access_token
  if (!accessToken) throw new Error('Google OAuth 응답에 access_token이 없습니다.')

  const emailAddress = gmailProfile.emailAddress || userInfo.email
  if (!emailAddress) throw new Error('Google 계정 이메일을 확인하지 못했습니다.')

  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + Number(tokens.expires_in) * 1000)
    : null
  const scopes = String(tokens.scope || DEFAULT_SCOPES.join(' ')).split(/\s+/).filter(Boolean)

  return {
    providerAccountId: userInfo.id || gmailProfile.emailAddress || emailAddress,
    emailAddress,
    displayName: userInfo.name || emailAddress,
    scopes,
    accessTokenEnc: encryptSecret(accessToken),
    refreshTokenEnc: tokens.refresh_token ? encryptSecret(tokens.refresh_token) : null,
    expiresAt,
    historyId: gmailProfile.historyId || null,
  }
}

// Gmail OAuth 콜백을 완성한다.
//   - oauth state 검증/소비: control plane
//   - account/folders/sync 기록: tenant data plane
// shared_db tenant는 단일 트랜잭션, dedicated_db tenant는 control→tenant 2단계로 처리한다.
async function completeGmailOAuth({ state, tokens, userInfo, gmailProfile }) {
  const control = cm.getControlPool()

  // 1) tenant_id를 알아내기 위해 먼저 (잠금 없이) oauth state를 확인한다.
  const peek = await control.query(
    `SELECT tenant_id
     FROM mail_oauth_states
     WHERE state = $1 AND provider = 'gmail' AND consumed_at IS NULL AND expires_at > NOW()
     LIMIT 1`,
    [state],
  )
  if (!peek.rows[0]) return { ok: false, error: 'invalid_state' }

  const tenantId = peek.rows[0].tenant_id
  const { pool: tenantPool, sharesControlPool } = await cm.resolveTenant(tenantId)
  const fields = deriveGmailAccountFields({ tokens, userInfo, gmailProfile })

  const SELECT_STATE_FOR_UPDATE = `
    SELECT *
    FROM mail_oauth_states
    WHERE state = $1 AND provider = 'gmail' AND consumed_at IS NULL AND expires_at > NOW()
    FOR UPDATE`

  // shared_db: 모든 테이블이 같은 DB → 단일 트랜잭션으로 원자성 보장
  if (sharesControlPool) {
    const client = await control.connect()
    try {
      await client.query('BEGIN')
      const st = await client.query(SELECT_STATE_FOR_UPDATE, [state])
      const oauthState = st.rows[0]
      if (!oauthState) {
        await client.query('ROLLBACK')
        return { ok: false, error: 'invalid_state' }
      }
      const accountId = await upsertGmailAccountTx(client, oauthState, fields)
      await upsertDefaultFoldersTx(client, oauthState, accountId)
      await upsertSyncStateTx(client, oauthState, accountId, fields.historyId)
      await client.query(`UPDATE mail_oauth_states SET consumed_at = NOW() WHERE state = $1`, [state])
      await client.query('COMMIT')
      return { ok: true, tenantId, accountId }
    } catch (err) {
      try { await client.query('ROLLBACK') } catch (_) {}
      throw err
    } finally {
      client.release()
    }
  }

  // dedicated_db: control(state 소비) → tenant(데이터 기록) 2단계
  const controlClient = await control.connect()
  let oauthState
  try {
    await controlClient.query('BEGIN')
    const st = await controlClient.query(SELECT_STATE_FOR_UPDATE, [state])
    oauthState = st.rows[0]
    if (!oauthState) {
      await controlClient.query('ROLLBACK')
      return { ok: false, error: 'invalid_state' }
    }
    await controlClient.query(`UPDATE mail_oauth_states SET consumed_at = NOW() WHERE state = $1`, [state])
    await controlClient.query('COMMIT')
  } catch (err) {
    try { await controlClient.query('ROLLBACK') } catch (_) {}
    throw err
  } finally {
    controlClient.release()
  }

  const tenantClient = await tenantPool.connect()
  try {
    await tenantClient.query('BEGIN')
    const accountId = await upsertGmailAccountTx(tenantClient, oauthState, fields)
    await upsertDefaultFoldersTx(tenantClient, oauthState, accountId)
    await upsertSyncStateTx(tenantClient, oauthState, accountId, fields.historyId)
    await tenantClient.query('COMMIT')
    return { ok: true, tenantId, accountId }
  } catch (err) {
    try { await tenantClient.query('ROLLBACK') } catch (_) {}
    throw err
  } finally {
    tenantClient.release()
  }
}

async function upsertImapAccountTx(client, accountState, fields) {
  const result = await client.query(
    `INSERT INTO mail_accounts (
       tenant_id, user_id, provider, provider_account_id, email_address,
       display_name, username, password_encrypted,
       imap_host, imap_port, imap_security,
       smtp_host, smtp_port, smtp_security,
       status, sync_status, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'connected', 'idle', NOW())
     ON CONFLICT (tenant_id, user_id, provider, email_address)
     DO UPDATE SET
       provider_account_id = EXCLUDED.provider_account_id,
       display_name = EXCLUDED.display_name,
       username = EXCLUDED.username,
       password_encrypted = EXCLUDED.password_encrypted,
       imap_host = EXCLUDED.imap_host,
       imap_port = EXCLUDED.imap_port,
       imap_security = EXCLUDED.imap_security,
       smtp_host = EXCLUDED.smtp_host,
       smtp_port = EXCLUDED.smtp_port,
       smtp_security = EXCLUDED.smtp_security,
       status = 'connected',
       sync_status = 'idle',
       updated_at = NOW()
     RETURNING id`,
    [
      accountState.tenant_id,
      accountState.user_id,
      fields.provider,
      fields.emailAddress,
      fields.emailAddress,
      fields.displayName,
      fields.username,
      encryptSecret(fields.password),
      fields.imapHost,
      fields.imapPort,
      fields.imapSecurity,
      fields.smtpHost,
      fields.smtpPort,
      fields.smtpSecurity,
    ],
  )
  return result.rows[0].id
}

async function upsertImapAccount({ tenantId, userId, fields }) {
  const { pool } = await cm.resolveTenant(tenantId)
  const accountState = { tenant_id: tenantId, user_id: userId }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const accountId = await upsertImapAccountTx(client, accountState, fields)
    await upsertDefaultFoldersTx(client, accountState, accountId)
    await upsertProviderSyncStateTx(client, accountState, accountId, fields.provider)
    await client.query('COMMIT')
    return { tenantId, accountId }
  } catch (err) {
    try { await client.query('ROLLBACK') } catch (_) {}
    throw err
  } finally {
    client.release()
  }
}

async function updateImapAccount({ tenantId, accountId, userId, isSiteAdmin, fields }) {
  const passwordSet = typeof fields.password === 'string' && fields.password.length > 0
  const params = [
    fields.emailAddress,
    fields.displayName,
    fields.username,
    fields.imapHost,
    fields.imapPort,
    fields.imapSecurity,
    fields.smtpHost,
    fields.smtpPort,
    fields.smtpSecurity,
    tenantId,
    accountId,
    !!isSiteAdmin,
    userId,
  ]
  let passwordSql = ''
  if (passwordSet) {
    params.push(encryptSecret(fields.password))
    passwordSql = `, password_encrypted = $${params.length}`
  }

  const { rows } = await tenantQuery(
    tenantId,
    `UPDATE mail_accounts
     SET email_address = $1,
         provider_account_id = $1,
         display_name = $2,
         username = $3,
         imap_host = $4,
         imap_port = $5,
         imap_security = $6,
         smtp_host = $7,
         smtp_port = $8,
         smtp_security = $9,
         status = 'connected',
         sync_status = 'idle',
         updated_at = NOW()
         ${passwordSql}
     WHERE tenant_id = $10
       AND id = $11
       AND provider IN ('naver', 'apple', 'imap', 'other')
       AND ($12::boolean = true OR user_id = $13)
     RETURNING id, tenant_id, user_id, provider, provider_account_id,
               email_address, display_name, username,
               imap_host, imap_port, imap_security,
               smtp_host, smtp_port, smtp_security,
               status, sync_status, last_synced_at, created_at, updated_at`,
    params,
  )
  return rows[0] || null
}

// ===== data plane: accounts listing =======================================

const ACCOUNT_FOLDERS_SUBQUERY = `
  COALESCE((
    SELECT json_agg(json_build_object(
      'id', mf.id,
      'provider_folder_id', mf.provider_folder_id,
      'name', mf.name,
      'type', mf.type,
      'parent_folder_id', mf.parent_folder_id,
      'color_key', mf.color_key,
      'message_count', COALESCE((
        SELECT COUNT(*)
        FROM mail_messages mm
        WHERE mm.folder_id = mf.id
          AND mm.deleted_at IS NULL
      ), 0),
      'unread_count', COALESCE((
        SELECT COUNT(*)
        FROM mail_messages mm
        WHERE mm.folder_id = mf.id
          AND mm.deleted_at IS NULL
          AND mm.is_read = false
      ), 0)
    ) ORDER BY
      CASE
        WHEN mf.provider_folder_id = 'INBOX' OR mf.type = 'inbox' THEN 0
        WHEN mf.provider_folder_id = 'SENT' OR mf.type = 'sent' THEN 1
        WHEN mf.provider_folder_id = 'DRAFT' OR mf.type = 'drafts' THEN 2
        ELSE 3
      END,
      mf.name ASC)
    FROM mail_folders mf
    WHERE mf.account_id = ma.id
  ), '[]'::json) AS folders`

async function listAccounts({ userId, isSiteAdmin, tenantId }) {
  // dedicated_db tenant: 전용 DB에는 mail_tenants/members가 없으므로 단순 조회 후 이름만 합친다.
  if (tenantId) {
    const { pool, dedicated, routing } = await cm.resolveTenant(tenantId)
    if (dedicated) {
      const { rows } = await pool.query(
        `SELECT ma.id, ma.tenant_id, ma.user_id, ma.provider, ma.provider_account_id,
                ma.email_address, ma.display_name, ma.username,
                ma.imap_host, ma.imap_port, ma.imap_security,
                ma.smtp_host, ma.smtp_port, ma.smtp_security,
                ma.scopes, ma.status, ma.sync_status,
                ma.last_synced_at, ma.created_at, ma.updated_at,
                ${ACCOUNT_FOLDERS_SUBQUERY}
         FROM mail_accounts ma
         WHERE ma.tenant_id = $1
           AND ($2::boolean = true OR ma.user_id = $3)
         ORDER BY ma.email_address ASC`,
        [tenantId, isSiteAdmin, userId],
      )
      return rows.map(r => ({ ...r, tenant_name: routing.name }))
    }
  }

  // shared_db (또는 tenant 미지정): control DB에서 tenant 메타와 함께 조회
  const control = cm.getControlPool()
  const params = [userId, isSiteAdmin]
  let tenantFilter = ''
  if (tenantId) {
    params.push(tenantId)
    tenantFilter = `AND ma.tenant_id = $${params.length}`
  }

  const { rows } = await control.query(
    `SELECT ma.id,
            ma.tenant_id,
            mt.name AS tenant_name,
            ma.user_id,
            ma.provider,
            ma.provider_account_id,
            ma.email_address,
            ma.display_name,
            ma.username,
            ma.imap_host,
            ma.imap_port,
            ma.imap_security,
            ma.smtp_host,
            ma.smtp_port,
            ma.smtp_security,
            ma.scopes,
            ma.status,
            ma.sync_status,
            ma.last_synced_at,
            ma.created_at,
            ma.updated_at,
            ${ACCOUNT_FOLDERS_SUBQUERY}
     FROM mail_accounts ma
     JOIN mail_tenants mt ON mt.id = ma.tenant_id
     LEFT JOIN mail_tenant_members mtm
       ON mtm.tenant_id = ma.tenant_id AND mtm.user_id = $1
     WHERE ($2::boolean = true OR mtm.user_id = $1)
       AND ($2::boolean = true OR ma.user_id = $1)
       ${tenantFilter}
     ORDER BY mt.name ASC, ma.email_address ASC`,
    params,
  )
  return rows
}

async function listSyncableAccounts() {
  const control = cm.getControlPool()
  const { rows: tenants } = await control.query(
    `SELECT id, name, storage_prefix FROM mail_tenants ORDER BY id ASC`,
  )
  const all = []
  for (const tenant of tenants) {
    try {
      const { pool } = await cm.resolveTenant(tenant.id)
      const { rows } = await pool.query(
        `SELECT id, tenant_id, user_id, provider, email_address, display_name,
                username, password_encrypted, imap_host, imap_port, imap_security,
                smtp_host, smtp_port, smtp_security,
                access_token_encrypted, refresh_token_encrypted, token_expires_at, status
         FROM mail_accounts
         WHERE tenant_id = $1
           AND status = 'connected'
           AND provider IN ('gmail', 'naver', 'apple', 'imap', 'other')
         ORDER BY email_address ASC`,
        [tenant.id],
      )
      all.push(...rows.map(row => ({
        ...row,
        tenant_name: tenant.name,
        storage_prefix: tenant.storage_prefix,
      })))
    } catch (err) {
      console.warn(`[Mail sync] tenant 계정 조회 실패: ${tenant.id}`, err.message)
    }
  }
  return all
}

// ===== data plane: 동기화(sync) ==========================================

// tenantId로 라우팅된 풀에서 단발 쿼리를 실행한다.
async function tenantQuery(tenantId, text, params) {
  const { pool } = await cm.resolveTenant(tenantId)
  return pool.query(text, params)
}

// tenantId로 라우팅된 풀에서 트랜잭션을 실행한다.
async function withTenantTx(tenantId, fn) {
  const { pool } = await cm.resolveTenant(tenantId)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try { await client.query('ROLLBACK') } catch (_) {}
    throw err
  } finally {
    client.release()
  }
}

// 동기화에 필요한 계정 정보(암호화된 토큰 포함) + tenant storage_prefix를 반환한다.
async function getAccountForSync({ tenantId, accountId, userId, isSiteAdmin }) {
  const routing = await cm.getTenantRouting(tenantId)
  if (!routing) return null

  const { rows } = await tenantQuery(
    tenantId,
    `SELECT id, tenant_id, user_id, provider, email_address, display_name,
            username, password_encrypted, imap_host, imap_port, imap_security,
            smtp_host, smtp_port, smtp_security,
            access_token_encrypted, refresh_token_encrypted, token_expires_at, status
     FROM mail_accounts
     WHERE id = $1 AND tenant_id = $2 AND ($3::boolean = true OR user_id = $4)
     LIMIT 1`,
    [accountId, tenantId, !!isSiteAdmin, userId],
  )
  const account = rows[0]
  if (!account) return null
  return { ...account, storage_prefix: routing.storage_prefix }
}

async function updateAccountTokens({ tenantId, accountId, accessTokenEnc, expiresAt }) {
  await tenantQuery(
    tenantId,
    `UPDATE mail_accounts
     SET access_token_encrypted = $1, token_expires_at = $2, updated_at = NOW()
     WHERE id = $3`,
    [accessTokenEnc, expiresAt, accountId],
  )
}

async function setAccountSyncStatus({ tenantId, accountId, syncStatus, lastSyncedAt, lastError, status }) {
  await tenantQuery(
    tenantId,
    `UPDATE mail_accounts
     SET sync_status = $1,
         last_synced_at = COALESCE($2, last_synced_at),
         status = COALESCE($3, status),
         updated_at = NOW()
     WHERE id = $4`,
    [syncStatus, lastSyncedAt || null, status || null, accountId],
  )
  if (lastError !== undefined) {
    await tenantQuery(
      tenantId,
      `UPDATE mail_sync_state SET last_error = $1, updated_at = NOW() WHERE account_id = $2`,
      [lastError, accountId],
    )
  }
}

// 이미 적재된 provider_message_id 집합을 반환한다. (신규 메시지만 받기 위함)
async function getExistingProviderMessageIds({ tenantId, accountId, ids }) {
  if (!ids || ids.length === 0) return new Set()
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT provider_message_id FROM mail_messages
     WHERE account_id = $1 AND provider_message_id = ANY($2)`,
    [accountId, ids],
  )
  return new Set(rows.map(r => r.provider_message_id))
}

async function getExistingInternetMessageIds({ tenantId, accountId, ids }) {
  const cleanIds = [...new Set((ids || []).filter(Boolean))]
  if (cleanIds.length === 0) return new Set()
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT internet_message_id FROM mail_messages
     WHERE account_id = $1 AND internet_message_id = ANY($2)`,
    [accountId, cleanIds],
  )
  return new Set(rows.map(r => r.internet_message_id).filter(Boolean))
}

// 발견한 폴더 목록을 mail_folders에 일괄 upsert한다. (provider_folder_id 기준)
async function upsertFolders({ tenantId, account, folders }) {
  if (!Array.isArray(folders) || folders.length === 0) return 0
  return withTenantTx(tenantId, async (client) => {
    let count = 0
    for (const f of folders) {
      if (!f || !f.providerFolderId || !f.name) continue
      await client.query(
        `INSERT INTO mail_folders (tenant_id, user_id, account_id, provider_folder_id, name, type)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (account_id, provider_folder_id)
         DO UPDATE SET name = EXCLUDED.name,
                       type = CASE WHEN mail_folders.type = 'custom' THEN EXCLUDED.type ELSE mail_folders.type END,
                       updated_at = NOW()`,
        [tenantId, account.user_id, account.id, f.providerFolderId, f.name, f.type || 'custom'],
      )
      count += 1
    }
    return count
  })
}

// 폴더 1건 조회 (on-demand 동기화 시 provider_folder_id/type 확인용)
async function getFolderById({ tenantId, accountId, folderId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT id, account_id, provider_folder_id, name, type, parent_folder_id, color_key
     FROM mail_folders
     WHERE id = $1 AND account_id = $2
     LIMIT 1`,
    [folderId, accountId],
  )
  return rows[0] || null
}

async function createFolder({ tenantId, account, name, parentFolderId }) {
  const cleanName = String(name || '').trim()
  if (!cleanName) throw new Error('폴더 이름이 필요합니다.')
  return withTenantTx(tenantId, async (client) => {
    let parent = null
    if (parentFolderId) {
      const parentResult = await client.query(
        `SELECT id, provider_folder_id, type
         FROM mail_folders
         WHERE id = $1 AND account_id = $2
         LIMIT 1`,
        [parentFolderId, account.id],
      )
      parent = parentResult.rows[0] || null
      if (!parent) throw new Error('상위 폴더를 찾을 수 없습니다.')
    }
    const providerFolderId = parent
      ? `${parent.provider_folder_id}/${cleanName}`
      : `USER/${cleanName}`
    const { rows } = await client.query(
      `INSERT INTO mail_folders (tenant_id, user_id, account_id, provider_folder_id, name, type, parent_folder_id)
       VALUES ($1, $2, $3, $4, $5, 'custom', $6)
       ON CONFLICT (account_id, provider_folder_id)
       DO UPDATE SET name = EXCLUDED.name,
                     parent_folder_id = EXCLUDED.parent_folder_id,
                     updated_at = NOW()
       RETURNING id, account_id, provider_folder_id, name, type, parent_folder_id, color_key`,
      [tenantId, account.user_id, account.id, providerFolderId, cleanName, parent?.id || null],
    )
    return rows[0]
  })
}

async function updateFolderColor({ tenantId, accountId, folderId, colorKey, userId, isSiteAdmin }) {
  const { rows } = await tenantQuery(
    tenantId,
    `UPDATE mail_folders mf
     SET color_key = NULLIF($1, ''),
         updated_at = NOW()
     WHERE mf.id = $2
       AND mf.account_id = $3
       AND ($4::boolean = true OR mf.user_id = $5)
     RETURNING id, account_id, provider_folder_id, name, type, parent_folder_id, color_key`,
    [String(colorKey || '').trim(), folderId, accountId, !!isSiteAdmin, userId],
  )
  return rows[0] || null
}

async function deleteFolder({ tenantId, accountId, folderId, userId, isSiteAdmin }) {
  const { rows } = await tenantQuery(
    tenantId,
    `DELETE FROM mail_folders mf
     WHERE mf.id = $1
       AND mf.account_id = $2
       AND mf.type = 'custom'
       AND ($3::boolean = true OR mf.user_id = $4)
     RETURNING id`,
    [folderId, accountId, !!isSiteAdmin, userId],
  )
  return rows[0] || null
}

// account의 provider_folder_id → folder.id 매핑
async function getFolderMap({ tenantId, accountId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT id, provider_folder_id FROM mail_folders WHERE account_id = $1`,
    [accountId],
  )
  const map = {}
  for (const r of rows) map[r.provider_folder_id] = r.id
  return map
}

async function listMessages({ tenantId, accountId, folderId, userId, isSiteAdmin, limit = 50, offset = 0 }) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50))
  const safeOffset = Math.max(0, Number(offset) || 0)
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT mm.id,
            mm.tenant_id,
            mm.user_id,
            mm.account_id,
            mm.provider_message_id,
            mm.folder_id,
            mm.subject,
            mm.from_email,
            mm.from_name,
            mm.to_json,
            mm.cc_json,
            mm.bcc_json,
            mm.snippet,
            mm.received_at,
            mm.sent_at,
            mm.is_read,
            mm.is_starred,
            mm.has_attachments,
            mm.size_bytes,
            mm.created_at,
            mm.updated_at
     FROM mail_messages mm
     JOIN mail_accounts ma ON ma.id = mm.account_id
     WHERE mm.tenant_id = $1
       AND mm.account_id = $2
       AND ($3::text = '' OR mm.folder_id = $3)
       AND ($4::boolean = true OR mm.user_id = $5)
     ORDER BY COALESCE(mm.received_at, mm.sent_at, mm.created_at) DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    [tenantId, accountId, folderId || '', !!isSiteAdmin, userId],
  )
  return rows
}

async function getMessage({ tenantId, messageId, userId, isSiteAdmin }) {
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT mm.id,
            mm.tenant_id,
            mm.user_id,
            mm.account_id,
            mm.provider_message_id,
            mm.folder_id,
            mm.subject,
            mm.from_email,
            mm.from_name,
            mm.to_json,
            mm.cc_json,
            mm.bcc_json,
            mm.snippet,
            mm.received_at,
            mm.sent_at,
            mm.is_read,
            mm.is_starred,
            mm.has_attachments,
            mm.size_bytes,
            mm.raw_object_key,
            mm.body_text_object_key,
            mm.body_html_object_key,
            mm.created_at,
            mm.updated_at
     FROM mail_messages mm
     WHERE mm.tenant_id = $1
       AND mm.id = $2
       AND ($3::boolean = true OR mm.user_id = $4)
     LIMIT 1`,
    [tenantId, messageId, !!isSiteAdmin, userId],
  )
  return rows[0] || null
}

async function markMessageRead({ tenantId, messageId, userId, isSiteAdmin }) {
  const { rows } = await tenantQuery(
    tenantId,
    `UPDATE mail_messages
     SET is_read = true,
         updated_at = NOW()
     WHERE tenant_id = $1
       AND id = $2
       AND is_read = false
       AND ($3::boolean = true OR user_id = $4)
     RETURNING id`,
    [tenantId, messageId, !!isSiteAdmin, userId],
  )
  return rows[0] || null
}

async function updateMessageReadState({ tenantId, messageId, userId, isSiteAdmin, isRead }) {
  const { rows } = await tenantQuery(
    tenantId,
    `UPDATE mail_messages
     SET is_read = $5,
         updated_at = NOW()
     WHERE tenant_id = $1
       AND id = $2
       AND ($3::boolean = true OR user_id = $4)
     RETURNING id, account_id, folder_id, is_read`,
    [tenantId, messageId, !!isSiteAdmin, userId, !!isRead],
  )
  return rows[0] || null
}

async function moveMessageToFolder({ tenantId, messageId, targetFolderId, userId, isSiteAdmin }) {
  const { rows } = await tenantQuery(
    tenantId,
    `WITH target AS (
       SELECT id, account_id
       FROM mail_folders
       WHERE id = $3
       LIMIT 1
     )
     UPDATE mail_messages mm
     SET folder_id = target.id,
         updated_at = NOW()
     FROM target
     WHERE mm.tenant_id = $1
       AND mm.id = $2
       AND mm.account_id = target.account_id
       AND ($4::boolean = true OR mm.user_id = $5)
     RETURNING mm.id, mm.account_id, mm.folder_id, mm.is_read`,
    [tenantId, messageId, targetFolderId, !!isSiteAdmin, userId],
  )
  return rows[0] || null
}

async function deleteMessage({ tenantId, messageId, userId, isSiteAdmin }) {
  const { rows } = await tenantQuery(
    tenantId,
    `WITH msg AS (
       SELECT id, account_id, folder_id AS previous_folder_id, is_read
       FROM mail_messages
       WHERE tenant_id = $1
         AND id = $2
         AND ($3::boolean = true OR user_id = $4)
       LIMIT 1
     ),
     trash AS (
       SELECT id
       FROM mail_folders
       WHERE account_id = (SELECT account_id FROM msg)
         AND type = 'trash'
       ORDER BY CASE WHEN provider_folder_id = 'TRASH' THEN 0 ELSE 1 END, name ASC
       LIMIT 1
     )
     UPDATE mail_messages mm
     SET folder_id = CASE
           WHEN EXISTS (SELECT 1 FROM trash)
            AND msg.previous_folder_id IS DISTINCT FROM (SELECT id FROM trash)
           THEN (SELECT id FROM trash)
           ELSE mm.folder_id
         END,
         deleted_at = CASE
           WHEN EXISTS (SELECT 1 FROM trash)
            AND msg.previous_folder_id IS DISTINCT FROM (SELECT id FROM trash)
           THEN mm.deleted_at
           ELSE NOW()
         END,
         updated_at = NOW()
     FROM msg
     WHERE mm.id = msg.id
     RETURNING mm.id,
               mm.account_id,
               msg.previous_folder_id,
               mm.folder_id,
               mm.is_read,
               (SELECT id FROM trash) AS trash_folder_id,
               mm.deleted_at IS NOT NULL AS soft_deleted`,
    [tenantId, messageId, !!isSiteAdmin, userId],
  )
  return rows[0] || null
}

async function purgeTrashFolder({ tenantId, accountId, folderId, userId, isSiteAdmin }) {
  return withTenantTx(tenantId, async (client) => {
    const { rows: folderRows } = await client.query(
      `SELECT id, account_id, name, type
       FROM mail_folders
       WHERE tenant_id = $1
         AND account_id = $2
         AND id = $3
         AND type = 'trash'
       LIMIT 1`,
      [tenantId, accountId, folderId],
    )
    const folder = folderRows[0] || null
    if (!folder) return null

    const { rows } = await client.query(
      `DELETE FROM mail_messages mm
       WHERE mm.tenant_id = $1
         AND mm.account_id = $2
         AND mm.folder_id = $3
         AND ($4::boolean = true OR mm.user_id = $5)
       RETURNING mm.id, mm.is_read`,
      [tenantId, accountId, folderId, !!isSiteAdmin, userId],
    )

    return {
      folder,
      count: rows.length,
      unread_count: rows.filter(row => row.is_read === false).length,
    }
  })
}

// 파싱된 메시지 1건 + 첨부를 트랜잭션으로 저장한다. (object_key는 이미 스토리지에 기록된 상태)
async function saveSyncedMessage({ tenantId, account, parsed, folderId, objectKeys, attachments }) {
  return withTenantTx(tenantId, async (client) => {
    const msgResult = await client.query(
      `INSERT INTO mail_messages (
         tenant_id, user_id, account_id, provider_message_id, internet_message_id, folder_id,
         subject, from_email, from_name, to_json, cc_json, bcc_json, snippet,
         received_at, sent_at, is_read, is_starred, has_attachments, size_bytes,
         raw_object_key, body_text_object_key, body_html_object_key, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, NOW())
       ON CONFLICT (account_id, provider_message_id) DO UPDATE SET
         internet_message_id = COALESCE(EXCLUDED.internet_message_id, mail_messages.internet_message_id),
         folder_id = EXCLUDED.folder_id,
         subject = EXCLUDED.subject,
         from_email = EXCLUDED.from_email,
         from_name = EXCLUDED.from_name,
         to_json = EXCLUDED.to_json,
         cc_json = EXCLUDED.cc_json,
         bcc_json = EXCLUDED.bcc_json,
         snippet = EXCLUDED.snippet,
         received_at = EXCLUDED.received_at,
         sent_at = EXCLUDED.sent_at,
         is_read = EXCLUDED.is_read,
         is_starred = EXCLUDED.is_starred,
         has_attachments = EXCLUDED.has_attachments,
         size_bytes = EXCLUDED.size_bytes,
         raw_object_key = EXCLUDED.raw_object_key,
         body_text_object_key = EXCLUDED.body_text_object_key,
         body_html_object_key = EXCLUDED.body_html_object_key,
         updated_at = NOW()
       RETURNING id`,
      [
        tenantId, account.user_id, account.id, parsed.providerMessageId, parsed.internetMessageId || null, folderId || null,
        parsed.subject, parsed.fromEmail, parsed.fromName,
        JSON.stringify(parsed.to), JSON.stringify(parsed.cc), JSON.stringify(parsed.bcc),
        parsed.snippet, parsed.receivedAt, parsed.sentAt,
        parsed.isRead, parsed.isStarred, parsed.hasAttachments, parsed.sizeBytes,
        objectKeys.raw || null, objectKeys.bodyText || null, objectKeys.bodyHtml || null,
      ],
    )
    const messageId = msgResult.rows[0].id

    // 재동기화 멱등성: 기존 첨부를 지우고 다시 적재
    await client.query('DELETE FROM mail_attachments WHERE message_id = $1', [messageId])
    for (const att of (attachments || [])) {
      await client.query(
        `INSERT INTO mail_attachments (
           tenant_id, user_id, account_id, message_id, provider_attachment_id,
           filename, content_type, size_bytes, object_key
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          tenantId, account.user_id, account.id, messageId, att.providerAttachmentId || null,
          att.filename, att.contentType || null, att.sizeBytes || 0, att.objectKey,
        ],
      )
    }
    return messageId
  })
}

async function saveDraftMessage({
  tenantId,
  account,
  draftId,
  providerMessageId,
  subject,
  to,
  cc,
  bcc,
  snippet,
  objectKeys,
  sizeBytes,
}) {
  return withTenantTx(tenantId, async (client) => {
    const folderResult = await client.query(
      `INSERT INTO mail_folders (tenant_id, user_id, account_id, provider_folder_id, name, type)
       VALUES ($1, $2, $3, 'DRAFT', '임시 보관함', 'drafts')
       ON CONFLICT (account_id, provider_folder_id)
       DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type, updated_at = NOW()
       RETURNING id`,
      [tenantId, account.user_id, account.id],
    )
    const folderId = folderResult.rows[0].id
    const values = [
      subject || '(제목 없음)',
      JSON.stringify(to || []),
      JSON.stringify(cc || []),
      JSON.stringify(bcc || []),
      snippet || '',
      objectKeys.bodyText || null,
      objectKeys.bodyHtml || null,
      Number(sizeBytes || 0),
    ]

    if (draftId) {
      const updateResult = await client.query(
        `UPDATE mail_messages
         SET folder_id = $1,
             subject = $2,
             to_json = $3::jsonb,
             cc_json = $4::jsonb,
             bcc_json = $5::jsonb,
             snippet = $6,
             body_text_object_key = $7,
             body_html_object_key = $8,
             size_bytes = $9,
             is_read = true,
             updated_at = NOW()
         WHERE id = $10
           AND tenant_id = $11
           AND account_id = $12
           AND user_id = $13
         RETURNING id, provider_message_id, folder_id`,
        [folderId, ...values, draftId, tenantId, account.id, account.user_id],
      )
      if (updateResult.rows[0]) return updateResult.rows[0]
    }

    const insertResult = await client.query(
      `INSERT INTO mail_messages (
         tenant_id, user_id, account_id, provider_message_id, folder_id,
         subject, from_email, from_name, to_json, cc_json, bcc_json, snippet,
         received_at, sent_at, is_read, is_starred, has_attachments, size_bytes,
         body_text_object_key, body_html_object_key, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,NOW(),NULL,true,false,false,$13,$14,$15,NOW())
       ON CONFLICT (account_id, provider_message_id) DO UPDATE SET
         folder_id = EXCLUDED.folder_id,
         subject = EXCLUDED.subject,
         to_json = EXCLUDED.to_json,
         cc_json = EXCLUDED.cc_json,
         bcc_json = EXCLUDED.bcc_json,
         snippet = EXCLUDED.snippet,
         size_bytes = EXCLUDED.size_bytes,
         body_text_object_key = EXCLUDED.body_text_object_key,
         body_html_object_key = EXCLUDED.body_html_object_key,
         updated_at = NOW()
       RETURNING id, provider_message_id, folder_id`,
      [
        tenantId,
        account.user_id,
        account.id,
        providerMessageId,
        folderId,
        subject || '(제목 없음)',
        account.email_address,
        account.display_name || account.email_address,
        JSON.stringify(to || []),
        JSON.stringify(cc || []),
        JSON.stringify(bcc || []),
        snippet || '',
        Number(sizeBytes || 0),
        objectKeys.bodyText || null,
        objectKeys.bodyHtml || null,
      ],
    )
    return insertResult.rows[0]
  })
}

async function updateSyncState({ tenantId, accountId, historyId, markFullSync }) {
  await tenantQuery(
    tenantId,
    `UPDATE mail_sync_state
     SET history_id = COALESCE($1, history_id),
         last_partial_sync_at = NOW(),
         last_full_sync_at = CASE WHEN $2::boolean THEN NOW() ELSE last_full_sync_at END,
         last_error = NULL,
         updated_at = NOW()
     WHERE account_id = $3`,
    [historyId || null, !!markFullSync, accountId],
  )
}

// 메시지/첨부 합계로 mail_usage를 재계산한다.
async function recomputeUsage({ tenantId, accountId, userId }) {
  await tenantQuery(
    tenantId,
    `INSERT INTO mail_usage (tenant_id, user_id, account_id, message_count, message_bytes, attachment_bytes, total_bytes, updated_at)
     SELECT $1, $2, $3,
            COALESCE((SELECT COUNT(*) FROM mail_messages WHERE account_id = $3), 0),
            COALESCE((SELECT SUM(size_bytes) FROM mail_messages WHERE account_id = $3), 0),
            COALESCE((SELECT SUM(size_bytes) FROM mail_attachments WHERE account_id = $3), 0),
            COALESCE((SELECT SUM(size_bytes) FROM mail_messages WHERE account_id = $3), 0)
              + COALESCE((SELECT SUM(size_bytes) FROM mail_attachments WHERE account_id = $3), 0),
            NOW()
     ON CONFLICT (tenant_id, user_id, account_id) DO UPDATE SET
       message_count = EXCLUDED.message_count,
       message_bytes = EXCLUDED.message_bytes,
       attachment_bytes = EXCLUDED.attachment_bytes,
       total_bytes = EXCLUDED.total_bytes,
       updated_at = NOW()`,
    [tenantId, userId, accountId],
  )
}

module.exports = {
  // tenants
  ensurePersonalTenant,
  syncTeamTenantsForUser,
  listTenantsForUser,
  getTenantRouting,
  canAccessTenant,
  isTenantManager,
  updateTenantStorageMode,
  // db connections
  listDbConnections,
  upsertDbConnection,
  // oauth states
  createOAuthState,
  cleanupOAuthStates,
  // gmail oauth completion + accounts
  completeGmailOAuth,
  upsertImapAccount,
  updateImapAccount,
  listAccounts,
  listSyncableAccounts,
  // sync (data plane)
  tenantQuery,
  withTenantTx,
  getAccountForSync,
  updateAccountTokens,
  setAccountSyncStatus,
  getExistingProviderMessageIds,
  getExistingInternetMessageIds,
  getFolderMap,
  upsertFolders,
  getFolderById,
  createFolder,
  updateFolderColor,
  deleteFolder,
  listMessages,
  getMessage,
  markMessageRead,
  updateMessageReadState,
  moveMessageToFolder,
  deleteMessage,
  purgeTrashFolder,
  saveSyncedMessage,
  saveDraftMessage,
  updateSyncState,
  recomputeUsage,
}
