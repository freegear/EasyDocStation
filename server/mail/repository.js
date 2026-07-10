const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const cm = require('./connectionManager')
const { encryptSecret } = require('../lib/secrets')
const { DEFAULT_SCOPES } = require('./gmailOAuth')
const { getMailStorage, getMailStorageBasePath } = require('./storage')

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

async function updateImapAccount({ tenantId, accountId, userId, fields }) {
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
       AND user_id = $12
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
      'is_local', mf.is_local,
      'sync_status', mf.sync_status,
      'deletable', mf.deletable,
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
      ), 0),
      'starred_count', COALESCE((
        SELECT COUNT(*)
        FROM mail_messages mm
        WHERE mm.folder_id = mf.id
          AND mm.deleted_at IS NULL
          AND mm.is_starred = true
      ), 0),
      'starred_unread_count', COALESCE((
        SELECT COUNT(*)
        FROM mail_messages mm
        WHERE mm.folder_id = mf.id
          AND mm.deleted_at IS NULL
          AND mm.is_starred = true
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
           AND ma.user_id = $2
         ORDER BY ma.email_address ASC`,
        [tenantId, userId],
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
       AND ma.user_id = $1
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
async function getAccountForSync({ tenantId, accountId, userId }) {
  const routing = await cm.getTenantRouting(tenantId)
  if (!routing) return null

  const { rows } = await tenantQuery(
    tenantId,
    `SELECT id, tenant_id, user_id, provider, email_address, display_name,
            username, password_encrypted, imap_host, imap_port, imap_security,
            smtp_host, smtp_port, smtp_security,
            access_token_encrypted, refresh_token_encrypted, token_expires_at, status
     FROM mail_accounts
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3
     LIMIT 1`,
    [accountId, tenantId, userId],
  )
  const account = rows[0]
  if (!account) return null
  return { ...account, storage_prefix: routing.storage_prefix }
}

// 계정 연결 해제(삭제). 계정 소유자 user_id 스코프로 확인한 뒤
// mail_accounts row를 지운다. FK ON DELETE CASCADE로 folders/messages/attachments/sync_state/usage가
// 자동 삭제되며, 디스크의 메일 객체(raw/본문/첨부) 파일도 함께 제거한다.
async function deleteAccount({ tenantId, accountId, userId }) {
  const account = await getAccountForSync({ tenantId, accountId, userId })
  if (!account) return null

  await deleteMessageSummariesForAccount({ tenantId, accountId, userId }).catch(() => 0)

  await tenantQuery(
    tenantId,
    `DELETE FROM mail_accounts
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [accountId, tenantId, userId],
  )

  try {
    const prefix = account.storage_prefix || `tenants/${tenantId}`
    const dir = path.join(getMailStorageBasePath(), prefix, 'users', String(account.user_id), 'mail', String(accountId))
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    console.warn('[Mail] 계정 삭제 - 저장소 파일 정리 실패:', err.message)
  }

  return { id: accountId, email_address: account.email_address }
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

// IMAP 폴더에 이미 저장된 메시지 수(provider_message_id = imap:<folder>:<uid>).
// 증분 동기화에서 "첫 동기화 여부"를 판단해 전체 스캔/윈도우 스캔을 고른다.
async function countSyncedImapMessages({ tenantId, accountId, providerFolderId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT COUNT(*)::int AS n FROM mail_messages
     WHERE account_id = $1 AND provider_message_id LIKE $2`,
    [accountId, `imap:${providerFolderId}:%`],
  )
  return rows[0]?.n || 0
}

// 발견한 폴더 목록을 mail_folders에 일괄 upsert한다. (provider_folder_id 기준)
async function upsertFolders({ tenantId, account, folders }) {
  if (!Array.isArray(folders) || folders.length === 0) return 0
  return withTenantTx(tenantId, async (client) => {
    let count = 0
    for (const f of folders) {
      if (!f || !f.providerFolderId || !f.name) continue
      await client.query(
        `INSERT INTO mail_folders (tenant_id, user_id, account_id, provider_folder_id, name, type, is_local)
         VALUES ($1, $2, $3, $4, $5, $6, FALSE)
         ON CONFLICT (account_id, provider_folder_id)
         DO UPDATE SET name = EXCLUDED.name,
                       type = CASE WHEN mail_folders.type = 'custom' THEN EXCLUDED.type ELSE mail_folders.type END,
                       is_local = FALSE,
                       sync_status = NULL,
                       updated_at = NOW()`,
        [tenantId, account.user_id, account.id, f.providerFolderId, f.name, f.type || 'custom'],
      )
      count += 1
    }
    // 부모 연결(두 번째 패스): 중첩 IMAP 메일함(예: Mailbox/2019)이 사이드바에 부모 아래로 보이도록
    // 발견된 서버 폴더(is_local=FALSE)마다 parent_folder_id를 "원하는 값"으로 정합한다. (MailService.md 22.3.2)
    //   - parentPath(=부모의 provider_folder_id)가 매칭되면 그 부모 id로 설정.
    //   - parentPath가 null(최상위)이거나 매칭 부모가 없으면(부모가 \Noselect라 발견에서 빠짐, 혹은
    //     서버에서 최상위로 이동) null로 비운다 → 오래된 부모 연결(stale)을 재발견 때 정리.
    // 스칼라 서브쿼리로 set/clear를 한 문장에 처리하고, IS DISTINCT FROM 가드로 불필요한 갱신을 막는다.
    // 로컬 서브 폴더(is_local=TRUE)는 발견 배치에 없으므로 이 패스가 건드리지 않는다.
    for (const f of folders) {
      if (!f || !f.providerFolderId) continue
      await client.query(
        `UPDATE mail_folders child
            SET parent_folder_id = (
                  SELECT parent.id FROM mail_folders parent
                   WHERE parent.account_id = child.account_id
                     AND parent.provider_folder_id = $3
                     AND parent.id <> child.id
                   LIMIT 1
                ),
                updated_at = NOW()
          WHERE child.account_id = $1
            AND child.provider_folder_id = $2
            AND child.is_local = FALSE
            AND child.parent_folder_id IS DISTINCT FROM (
                  SELECT parent.id FROM mail_folders parent
                   WHERE parent.account_id = child.account_id
                     AND parent.provider_folder_id = $3
                     AND parent.id <> child.id
                   LIMIT 1
                )`,
        [account.id, f.providerFolderId, f.parentPath || null],
      )
    }
    return count
  })
}

// 폴더 1건 조회 (on-demand 동기화 시 provider_folder_id/type 확인용)
async function getFolderById({ tenantId, accountId, folderId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT id, account_id, provider_folder_id, name, type, parent_folder_id, color_key, is_local, sync_status
     FROM mail_folders
     WHERE id = $1 AND account_id = $2
     LIMIT 1`,
    [folderId, accountId],
  )
  return rows[0] || null
}

async function getFolderByIdForUser({ tenantId, folderId, userId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT id, account_id, provider_folder_id, name, type, parent_folder_id, color_key, is_local, sync_status
     FROM mail_folders
     WHERE id = $1 AND user_id = $2
     LIMIT 1`,
    [folderId, userId],
  )
  return rows[0] || null
}

async function getFolderByTypeForAccount({ tenantId, accountId, type }) {
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT id, account_id, provider_folder_id, name, type, parent_folder_id, color_key, is_local, sync_status
     FROM mail_folders
     WHERE account_id = $1 AND type = $2
     ORDER BY CASE WHEN provider_folder_id = 'TRASH' THEN 0 ELSE 1 END, name ASC
     LIMIT 1`,
    [accountId, type],
  )
  return rows[0] || null
}

async function resolveFolderForAccount({ tenantId, accountId, folderId }) {
  const direct = await getFolderById({ tenantId, accountId, folderId })
  if (direct) return direct

  const { rows } = await tenantQuery(
    tenantId,
    `WITH configured AS (
       SELECT provider_folder_id, name, type, is_local
       FROM mail_folders
       WHERE id = $2
       LIMIT 1
     )
     SELECT f.id, f.account_id, f.provider_folder_id, f.name, f.type, f.parent_folder_id, f.color_key, f.is_local, f.sync_status
     FROM mail_folders f
     CROSS JOIN configured c
     WHERE f.account_id = $1
       AND (
         f.provider_folder_id = c.provider_folder_id
         OR (c.type <> 'custom' AND f.type = c.type)
         OR (c.is_local = true AND f.is_local = true AND f.name = c.name)
       )
     ORDER BY
       CASE
         WHEN f.provider_folder_id = c.provider_folder_id THEN 0
         WHEN c.type <> 'custom' AND f.type = c.type THEN 1
         ELSE 2
       END
     LIMIT 1`,
    [accountId, folderId],
  )
  return rows[0] || null
}

// 앱에서 만드는 폴더는 기본적으로 로컬 전용(is_local=true)이다.
// 서버(IMAP)에 실제 메일박스를 만들지 않으므로 동기화 대상이 아니며,
// provider_folder_id는 충돌·동기화와 무관한 합성 키('local:<uuid>')를 쓴다.
// 거울 폴더는 서버에서 발견될 때 upsertFolders로만 생성된다.
async function createFolder({ tenantId, account, name, parentFolderId, isLocal = true }) {
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
    const providerFolderId = isLocal
      ? `local:${randomUUID()}`
      : (parent ? `${parent.provider_folder_id}/${cleanName}` : `USER/${cleanName}`)
    const { rows } = await client.query(
      `INSERT INTO mail_folders (tenant_id, user_id, account_id, provider_folder_id, name, type, parent_folder_id, is_local)
       VALUES ($1, $2, $3, $4, $5, 'custom', $6, $7)
       ON CONFLICT (account_id, provider_folder_id)
       DO UPDATE SET name = EXCLUDED.name,
                     parent_folder_id = EXCLUDED.parent_folder_id,
                     updated_at = NOW()
       RETURNING id, account_id, provider_folder_id, name, type, parent_folder_id, color_key, is_local, sync_status`,
      [tenantId, account.user_id, account.id, providerFolderId, cleanName, parent?.id || null, !!isLocal],
    )
    return rows[0]
  })
}

// 거울 폴더의 동기화 상태 갱신. 'missing' = 서버에 메일박스 없음(자동 동기화 중단), null = 정상.
async function setFolderSyncStatus({ tenantId, accountId, folderId, syncStatus }) {
  await tenantQuery(
    tenantId,
    `UPDATE mail_folders
     SET sync_status = NULLIF($1, ''), updated_at = NOW()
     WHERE id = $2 AND account_id = $3`,
    [String(syncStatus || ''), folderId, accountId],
  )
}

// 폴더 삭제 가능 여부 학습. 프로바이더가 삭제를 거부하면 deletable=false로 저장해
// 이후 UI에서 삭제 메뉴를 비활성화한다. (folder_delete_error.md 2번)
async function setFolderDeletable({ tenantId, accountId, folderId, deletable }) {
  await tenantQuery(
    tenantId,
    `UPDATE mail_folders
     SET deletable = $1, updated_at = NOW()
     WHERE id = $2 AND account_id = $3`,
    [!!deletable, folderId, accountId],
  )
}

async function updateFolderColor({ tenantId, accountId, folderId, colorKey, userId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `UPDATE mail_folders mf
     SET color_key = NULLIF($1, ''),
         updated_at = NOW()
     WHERE mf.id = $2
       AND mf.account_id = $3
       AND mf.user_id = $4
     RETURNING id, account_id, provider_folder_id, name, type, parent_folder_id, color_key, is_local, sync_status`,
    [String(colorKey || '').trim(), folderId, accountId, userId],
  )
  return rows[0] || null
}

// 폴더 이름 변경 — 사용자 폴더(type='custom')만. IMAP처럼 프로바이더 경로가 곧
// 식별자인 경우 providerFolderId도 함께 갱신한다(Gmail은 라벨 id 불변이라 생략).
// tenant/account/user 스코프 필수(5원칙). (MailService.md 16.7)
async function renameFolder({ tenantId, accountId, folderId, name, providerFolderId, userId }) {
  const cleanName = String(name || '').trim()
  const { rows } = await tenantQuery(
    tenantId,
    `UPDATE mail_folders mf
     SET name = $1,
         provider_folder_id = COALESCE(NULLIF($2, ''), mf.provider_folder_id),
         updated_at = NOW()
     WHERE mf.id = $3
       AND mf.account_id = $4
       AND mf.user_id = $5
       AND mf.type = 'custom'
     RETURNING id, account_id, provider_folder_id, name, type, parent_folder_id, color_key, is_local, sync_status`,
    [cleanName, String(providerFolderId || '').trim(), folderId, accountId, userId],
  )
  return rows[0] || null
}

// 같은 계정 내 형제 폴더 중 대소문자 무시 동일 이름이 있는지(자신 제외) 확인. (중복 가드)
async function folderNameExists({ tenantId, accountId, name, excludeFolderId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT 1
     FROM mail_folders mf
     WHERE mf.account_id = $1
       AND LOWER(TRIM(mf.name)) = LOWER(TRIM($2))
       AND mf.id <> $3
     LIMIT 1`,
    [accountId, String(name || ''), String(excludeFolderId || '')],
  )
  return rows.length > 0
}

// 사용자 폴더(type='custom') 삭제. purgeMessages=true면 그 폴더의 메일 행도 함께 지운다.
//   - Gmail(라벨 삭제, 비파괴): purgeMessages=false → 메일 보존(folder_id는 FK로 NULL, 다음 동기화에서 재배치).
//   - IMAP(메일함 삭제, 파괴적): purgeMessages=true → 서버에서 이미 사라진 메일 행을 로컬에서도 삭제.
// (MailService.md 16.11)
async function deleteFolder({ tenantId, accountId, folderId, userId, purgeMessages = false }) {
  return withTenantTx(tenantId, async (client) => {
    const { rows: folderRows } = await client.query(
      `SELECT id, name, type FROM mail_folders
       WHERE id = $1 AND account_id = $2 AND type = 'custom' AND user_id = $3
       LIMIT 1`,
      [folderId, accountId, userId],
    )
    const folder = folderRows[0] || null
    if (!folder) return null

    let purgedCount = 0
    if (purgeMessages) {
      const { rows: msgRows } = await client.query(
        `DELETE FROM mail_messages
         WHERE tenant_id = $1 AND account_id = $2 AND folder_id = $3 AND user_id = $4
         RETURNING id`,
        [tenantId, accountId, folderId, userId],
      )
      purgedCount = msgRows.length
    }

    await client.query(
      `DELETE FROM mail_folders WHERE id = $1 AND account_id = $2 AND type = 'custom' AND user_id = $3`,
      [folderId, accountId, userId],
    )
    return { id: folder.id, name: folder.name, type: folder.type, purgedCount }
  })
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

// 각 메일에 부여된 스마트 폴더(태그) 배열을 JSON으로 붙이는 SELECT 조각. 리스트 카드 칩용(MailService.md 18.3).
// 세 목록 쿼리(listMessages/listUnifiedMessages/listSmartFolderMessages)가 공유한다. tenant/user 스코프 유지(5원칙).
const MESSAGE_TAGS_AGG = `COALESCE((
       SELECT json_agg(json_build_object('id', tsf.id, 'name', tsf.name, 'color_key', tsf.color_key) ORDER BY tsf.name ASC)
       FROM mail_message_tags tmt
       JOIN mail_smart_folders tsf ON tsf.id = tmt.smart_folder_id
       WHERE tmt.message_id = mm.id
         AND tmt.tenant_id  = mm.tenant_id
         AND tsf.user_id    = mm.user_id
     ), '[]'::json)`

async function listMessages({ tenantId, accountId, folderId, userId, limit = 50, offset = 0 }) {
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
            mm.updated_at,
            ${MESSAGE_TAGS_AGG} AS tags
     FROM mail_messages mm
     JOIN mail_accounts ma ON ma.id = mm.account_id
     WHERE mm.tenant_id = $1
       AND mm.account_id = $2
       AND ($3::text = '' OR mm.folder_id = $3)
       AND mm.user_id = $4
     ORDER BY COALESCE(mm.received_at, mm.sent_at, mm.created_at) DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    [tenantId, accountId, folderId || '', userId],
  )
  return rows
}

async function listUnifiedMessages({ tenantId, userId, key, folderType, folderName, unreadOnly = false, limit = 50, offset = 0 }) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50))
  const safeOffset = Math.max(0, Number(offset) || 0)
  const cleanKey = String(key || '').trim()
  const cleanType = String(folderType || '').trim()
  const cleanName = String(folderName || '').trim()
  const params = [tenantId, userId]
  const filters = [
    'mm.tenant_id = $1',
    'mm.user_id = $2',
    'mm.deleted_at IS NULL',
  ]
  if (unreadOnly) filters.push('mm.is_read = false')

  if (cleanKey === 'all') {
    filters.push(`NOT (
      mf.type = 'trash'
      OR UPPER(COALESCE(mf.provider_folder_id, '')) = 'TRASH'
      OR LOWER(TRIM(COALESCE(mf.name, ''))) = '휴지통'
    )`)
  } else if (cleanKey === 'starred') {
    filters.push('mm.is_starred = true')
  } else if (['inbox', 'sent', 'drafts', 'trash'].includes(cleanKey) && !cleanType) {
    params.push(cleanKey)
    filters.push(`mf.type = $${params.length}`)
  } else if (cleanType) {
    params.push(cleanType)
    filters.push(`mf.type = $${params.length}`)
  } else if (cleanName) {
    params.push(cleanName.toLowerCase())
    filters.push(`LOWER(TRIM(mf.name)) = $${params.length}`)
  }

  const { rows } = await tenantQuery(
    tenantId,
    `SELECT mm.id,
            mm.tenant_id,
            mm.user_id,
            mm.account_id,
            ma.provider,
            ma.email_address AS account_email,
            ma.display_name AS account_display_name,
            mm.provider_message_id,
            mm.folder_id,
            mf.name AS folder_name,
            mf.type AS folder_type,
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
            mm.updated_at,
            ${MESSAGE_TAGS_AGG} AS tags
     FROM mail_messages mm
     JOIN mail_accounts ma ON ma.id = mm.account_id
     LEFT JOIN mail_folders mf ON mf.id = mm.folder_id
     WHERE ${filters.join('\n       AND ')}
     ORDER BY COALESCE(mm.received_at, mm.sent_at, mm.created_at) DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params,
  )
  return rows
}

// ===== data plane: 스마트 폴더(태그 기반 통합) — MailService.md 13 ===========

// 스마트 폴더 목록 + 카운트. 카운트/열람은 휴지통·스팸·삭제 메일을 제외해 뷰와 일치시킨다(13.7).
async function listSmartFolders({ tenantId, userId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT sf.id,
            sf.tenant_id,
            sf.name,
            sf.color_key,
            sf.created_at,
            sf.updated_at,
            COALESCE(cnt.message_count, 0) AS message_count,
            COALESCE(cnt.unread_count, 0) AS unread_count
     FROM mail_smart_folders sf
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS message_count,
              COUNT(*) FILTER (WHERE mm.is_read = false) AS unread_count
       FROM mail_message_tags mt
       JOIN mail_messages mm ON mm.id = mt.message_id
       LEFT JOIN mail_folders mf ON mf.id = mm.folder_id
       WHERE mt.smart_folder_id = sf.id
         AND mm.deleted_at IS NULL
         AND COALESCE(mf.type, '') NOT IN ('trash', 'spam')
     ) cnt ON true
     WHERE sf.tenant_id = $1
       AND sf.user_id = $2
     ORDER BY sf.name ASC`,
    [tenantId, userId],
  )
  return rows
}

async function createSmartFolder({ tenantId, userId, name, colorKey = null }) {
  const cleanName = String(name || '').trim()
  if (!cleanName) throw new Error('스마트 폴더 이름이 필요합니다.')
  const { rows } = await tenantQuery(
    tenantId,
    `INSERT INTO mail_smart_folders (tenant_id, user_id, name, color_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, user_id, name) DO UPDATE
       SET updated_at = NOW()
     RETURNING id, tenant_id, name, color_key, created_at, updated_at`,
    [tenantId, userId, cleanName, String(colorKey || '').trim() || null],
  )
  return rows[0] || null
}

async function updateSmartFolder({ tenantId, userId, id, name, colorKey }) {
  const sets = []
  const params = [tenantId, userId, id]
  if (name !== undefined) {
    const cleanName = String(name || '').trim()
    if (!cleanName) throw new Error('스마트 폴더 이름이 필요합니다.')
    params.push(cleanName)
    sets.push(`name = $${params.length}`)
  }
  if (colorKey !== undefined) {
    params.push(String(colorKey || '').trim() || null)
    sets.push(`color_key = $${params.length}`)
  }
  if (sets.length === 0) return null
  const { rows } = await tenantQuery(
    tenantId,
    `UPDATE mail_smart_folders
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE tenant_id = $1 AND user_id = $2 AND id = $3
     RETURNING id, tenant_id, name, color_key, created_at, updated_at`,
    params,
  )
  return rows[0] || null
}

async function deleteSmartFolder({ tenantId, userId, id }) {
  const { rows } = await tenantQuery(
    tenantId,
    `DELETE FROM mail_smart_folders
     WHERE tenant_id = $1 AND user_id = $2 AND id = $3
     RETURNING id`,
    [tenantId, userId, id],
  )
  return rows[0] || null
}

// 태그 부여(멱등). 대상 메일이 이 tenant/user 소유인지 확인 후, 소유 메일만 태그한다.
async function tagMessagesToSmartFolder({ tenantId, userId, smartFolderId, messageIds }) {
  const ids = [...new Set((messageIds || []).map(id => String(id || '').trim()).filter(Boolean))]
  if (ids.length === 0) return { tagged: [] }
  // 스마트 폴더 소유 확인
  const folder = await tenantQuery(
    tenantId,
    `SELECT id FROM mail_smart_folders WHERE tenant_id = $1 AND user_id = $2 AND id = $3 LIMIT 1`,
    [tenantId, userId, smartFolderId],
  )
  if (!folder.rows[0]) return { tagged: [] }
  const { rows } = await tenantQuery(
    tenantId,
    `INSERT INTO mail_message_tags (tenant_id, user_id, smart_folder_id, message_id)
     SELECT mm.tenant_id, mm.user_id, $3, mm.id
     FROM mail_messages mm
     WHERE mm.tenant_id = $1
       AND mm.user_id = $2
       AND mm.id = ANY($4::text[])
     ON CONFLICT (tenant_id, smart_folder_id, message_id) DO NOTHING
     RETURNING message_id`,
    [tenantId, userId, smartFolderId, ids],
  )
  return { tagged: rows.map(r => r.message_id) }
}

async function untagMessagesFromSmartFolder({ tenantId, userId, smartFolderId, messageIds }) {
  const ids = [...new Set((messageIds || []).map(id => String(id || '').trim()).filter(Boolean))]
  if (ids.length === 0) return { untagged: [] }
  const { rows } = await tenantQuery(
    tenantId,
    `DELETE FROM mail_message_tags mt
     USING mail_smart_folders sf
     WHERE mt.smart_folder_id = sf.id
       AND sf.tenant_id = $1 AND sf.user_id = $2 AND sf.id = $3
       AND mt.message_id = ANY($4::text[])
     RETURNING mt.message_id`,
    [tenantId, userId, smartFolderId, ids],
  )
  return { untagged: rows.map(r => r.message_id) }
}

// 스마트 폴더 열람: 태그된 메일을 여러 계정에 걸쳐 조회. 휴지통·스팸·삭제 제외(13.7).
async function listSmartFolderMessages({ tenantId, userId, smartFolderId, limit = 50, offset = 0 }) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50))
  const safeOffset = Math.max(0, Number(offset) || 0)
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT mm.id,
            mm.tenant_id,
            mm.user_id,
            mm.account_id,
            ma.provider,
            ma.email_address AS account_email,
            ma.display_name AS account_display_name,
            mm.provider_message_id,
            mm.folder_id,
            mf.name AS folder_name,
            mf.type AS folder_type,
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
            mm.updated_at,
            ${MESSAGE_TAGS_AGG} AS tags
     FROM mail_message_tags mt
     JOIN mail_smart_folders sf ON sf.id = mt.smart_folder_id
     JOIN mail_messages mm ON mm.id = mt.message_id
     JOIN mail_accounts ma ON ma.id = mm.account_id
     LEFT JOIN mail_folders mf ON mf.id = mm.folder_id
     WHERE sf.tenant_id = $1
       AND sf.user_id = $2
       AND sf.id = $3
       AND mm.deleted_at IS NULL
       AND COALESCE(mf.type, '') NOT IN ('trash', 'spam')
     ORDER BY COALESCE(mm.received_at, mm.sent_at, mm.created_at) DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    [tenantId, userId, smartFolderId],
  )
  return rows
}

// 특정 메일이 속한 스마트 폴더(태그) 목록. 메일 상세 배지용.
async function listSmartFoldersForMessage({ tenantId, userId, messageId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT sf.id, sf.name, sf.color_key
     FROM mail_message_tags mt
     JOIN mail_smart_folders sf ON sf.id = mt.smart_folder_id
     WHERE sf.tenant_id = $1 AND sf.user_id = $2 AND mt.message_id = $3
     ORDER BY sf.name ASC`,
    [tenantId, userId, messageId],
  )
  return rows
}

// 시드 마이그레이션(1회, 멱등): 계정들의 커스텀 폴더 이름 → 동명 스마트 폴더 생성 + 그 폴더 메일 태그 일괄 부여.
//   - 시스템 폴더(type in inbox/sent/drafts/trash/archive/spam)는 제외.
//   - 이름은 normalize(소문자·공백 정규화)로 묶되, 표시명은 첫 등장 원본을 쓴다.
async function seedSmartFoldersFromCustomFolders({ tenantId, userId }) {
  return withTenantTx(tenantId, async (client) => {
    // 1) 커스텀 폴더 이름 집합(대표 표시명 = 최소 name) 수집
    const { rows: names } = await client.query(
      `SELECT MIN(mf.name) AS display_name,
              LOWER(TRIM(mf.name)) AS norm
       FROM mail_folders mf
       JOIN mail_accounts ma ON ma.id = mf.account_id
       WHERE mf.tenant_id = $1
         AND ma.user_id = $2
         AND mf.type = 'custom'
         AND TRIM(COALESCE(mf.name, '')) <> ''
       GROUP BY LOWER(TRIM(mf.name))`,
      [tenantId, userId],
    )
    let createdFolders = 0
    let taggedMessages = 0
    for (const row of names) {
      const displayName = String(row.display_name || '').trim()
      if (!displayName) continue
      // 2) 동명 스마트 폴더 생성(멱등)
      const { rows: sf } = await client.query(
        `INSERT INTO mail_smart_folders (tenant_id, user_id, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, user_id, name) DO UPDATE SET updated_at = NOW()
         RETURNING id, (xmax = 0) AS inserted`,
        [tenantId, userId, displayName],
      )
      const smartFolderId = sf[0].id
      if (sf[0].inserted) createdFolders += 1
      // 3) 같은 정규화 이름을 가진 커스텀 폴더의 메일을 태그(멱등)
      const { rows: tagged } = await client.query(
        `INSERT INTO mail_message_tags (tenant_id, user_id, smart_folder_id, message_id)
         SELECT mm.tenant_id, mm.user_id, $3, mm.id
         FROM mail_messages mm
         JOIN mail_folders mf ON mf.id = mm.folder_id
         WHERE mm.tenant_id = $1
           AND mm.user_id = $2
           AND mf.type = 'custom'
           AND LOWER(TRIM(mf.name)) = $4
           AND mm.deleted_at IS NULL
         ON CONFLICT (tenant_id, smart_folder_id, message_id) DO NOTHING
         RETURNING message_id`,
        [tenantId, userId, smartFolderId, row.norm],
      )
      taggedMessages += tagged.length
    }
    return { createdFolders, taggedMessages, folderNames: names.length }
  })
}

// 이중 휴지통 정리(1회, 멱등): iCloud처럼 실제 휴지통이 type='custom'으로 남은 잔재를
// 정규 휴지통(type='trash')으로 병합한다. 정규 휴지통이 없으면 잔재를 승격한다.
// 재동기화 전에 실행해야 provider_message_id 프리픽스(imap:<path>:<uid>) 변화로 인한 중복을 막는다.
// (MailService.md 17)
async function reconcileTrashFolders({ tenantId, userId }) {
  return withTenantTx(tenantId, async (client) => {
    // 1) 잔재 트래시 폴더 식별: 사용자 계정의 트래시-동치(provider_folder_id='TRASH' 또는 이름)이면서 type='custom'
    const { rows: residuals } = await client.query(
      `SELECT mf.id, mf.account_id, mf.provider_folder_id, mf.name
       FROM mail_folders mf
       JOIN mail_accounts ma ON ma.id = mf.account_id
       WHERE mf.tenant_id = $1
         AND ma.user_id = $2
         AND mf.type = 'custom'
         AND (
           UPPER(COALESCE(mf.provider_folder_id, '')) = 'TRASH'
           OR LOWER(TRIM(COALESCE(mf.name, ''))) IN ('휴지통', 'trash', 'deleted messages', 'deleted items', 'deleted', '지운 편지함')
         )`,
      [tenantId, userId],
    )

    let promoted = 0
    let movedMessages = 0
    let dedupedMessages = 0
    let removedResiduals = 0

    for (const res of residuals) {
      // 2) 같은 계정의 정규 휴지통(또는 TRASH 키 보유 폴더) 확보 — 잔재 자신은 제외, type='trash' 우선
      const { rows: canonRows } = await client.query(
        `SELECT id FROM mail_folders
         WHERE account_id = $1
           AND id <> $2
           AND (type = 'trash' OR UPPER(COALESCE(provider_folder_id, '')) = 'TRASH')
         ORDER BY (type = 'trash') DESC
         LIMIT 1`,
        [res.account_id, res.id],
      )
      const canonId = canonRows[0]?.id || null

      if (!canonId) {
        // 정규 없음 → 잔재를 승격. 메일 provider_message_id 프리픽스를 TRASH로 재작성.
        await client.query(
          `UPDATE mail_messages
           SET provider_message_id = 'imap:TRASH:' || substring(provider_message_id from '[^:]+$'),
               updated_at = NOW()
           WHERE account_id = $1 AND folder_id = $2 AND provider_message_id LIKE 'imap:%'`,
          [res.account_id, res.id],
        )
        await client.query(
          `UPDATE mail_folders
           SET type = 'trash', provider_folder_id = 'TRASH', name = '휴지통', updated_at = NOW()
           WHERE id = $1`,
          [res.id],
        )
        promoted += 1
        continue
      }

      // 3a) 충돌 사전 정리: 재작성했을 때 정규 폴더에 이미 같은 uid가 있으면 잔재 메일을 삭제
      //     (UNIQUE(account_id, provider_message_id) 위반 방지)
      const dup = await client.query(
        `DELETE FROM mail_messages resm
         WHERE resm.account_id = $1 AND resm.folder_id = $2 AND resm.provider_message_id LIKE 'imap:%'
           AND EXISTS (
             SELECT 1 FROM mail_messages canm
             WHERE canm.account_id = $1 AND canm.folder_id = $3
               AND canm.provider_message_id = 'imap:TRASH:' || substring(resm.provider_message_id from '[^:]+$')
           )
         RETURNING resm.id`,
        [res.account_id, res.id, canonId],
      )
      dedupedMessages += dup.rows.length

      // 3b) 나머지 메일을 정규 폴더로 이동 + provider_message_id 재작성
      const mv = await client.query(
        `UPDATE mail_messages
         SET folder_id = $3,
             provider_message_id = CASE
               WHEN provider_message_id LIKE 'imap:%'
               THEN 'imap:TRASH:' || substring(provider_message_id from '[^:]+$')
               ELSE provider_message_id END,
             updated_at = NOW()
         WHERE account_id = $1 AND folder_id = $2
         RETURNING id`,
        [res.account_id, res.id, canonId],
      )
      movedMessages += mv.rows.length

      // 4) 빈 잔재 폴더 삭제
      await client.query(`DELETE FROM mail_folders WHERE id = $1`, [res.id])
      removedResiduals += 1
    }

    return { residuals: residuals.length, promoted, movedMessages, dedupedMessages, removedResiduals }
  })
}

async function getMessage({ tenantId, messageId, userId }) {
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
       AND mm.user_id = $3
     LIMIT 1`,
    [tenantId, messageId, userId],
  )
  return rows[0] || null
}

async function getMessageSummary({ tenantId, userId, messageId, targetLanguage = 'ko' }) {
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT id,
            tenant_id,
            user_id,
            account_id,
            message_id,
            provider_message_id,
            summary_json,
            raw_text,
            model,
            prompt_version,
            target_language,
            source_language,
            translated,
            translated_text,
            clean_body_text,
            fact_list_json,
            pipeline_version,
            fallback_used,
            quality_flags,
            summary_version,
            generated_at,
            updated_at
     FROM mail_message_summaries
     WHERE tenant_id = $1
       AND user_id = $2
       AND message_id = $3
       AND target_language = $4
     LIMIT 1`,
    [tenantId, userId, messageId, String(targetLanguage || 'ko')],
  )
  return rows[0] || null
}

async function upsertMessageSummary({
  tenantId,
  userId,
  accountId,
  messageId,
  providerMessageId = null,
  summary,
  rawText = '',
  model = '',
  promptVersion = 'mail-summary-json-v1',
  targetLanguage = 'ko',
  sourceLanguage = 'unknown',
  translated = false,
  translatedText = '',
  cleanBodyText = '',
  factList = [],
  pipelineVersion = 'mail-summary-pipeline-v2',
  fallbackUsed = false,
  qualityFlags = [],
}) {
  const { rows } = await tenantQuery(
    tenantId,
    `INSERT INTO mail_message_summaries (
       id, tenant_id, user_id, account_id, message_id, provider_message_id,
       summary_json, raw_text, model, prompt_version,
       target_language, source_language, translated, translated_text,
       clean_body_text, fact_list_json, pipeline_version, fallback_used, quality_flags,
       summary_version,
       generated_at, updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6,
       $7::jsonb, $8, $9, $10,
       $11, $12, $13, $14,
       $15, $16::jsonb, $17, $18, $19::jsonb,
       1,
       NOW(), NOW()
     )
     ON CONFLICT (tenant_id, user_id, message_id, target_language) DO UPDATE
       SET account_id = EXCLUDED.account_id,
           provider_message_id = EXCLUDED.provider_message_id,
           summary_json = EXCLUDED.summary_json,
           raw_text = EXCLUDED.raw_text,
           model = EXCLUDED.model,
           prompt_version = EXCLUDED.prompt_version,
           source_language = EXCLUDED.source_language,
           translated = EXCLUDED.translated,
           translated_text = EXCLUDED.translated_text,
           clean_body_text = EXCLUDED.clean_body_text,
           fact_list_json = EXCLUDED.fact_list_json,
           pipeline_version = EXCLUDED.pipeline_version,
           fallback_used = EXCLUDED.fallback_used,
           quality_flags = EXCLUDED.quality_flags,
           summary_version = mail_message_summaries.summary_version + 1,
           updated_at = NOW()
     RETURNING id,
               tenant_id,
               user_id,
               account_id,
               message_id,
               provider_message_id,
               summary_json,
               raw_text,
               model,
               prompt_version,
               target_language,
               source_language,
               translated,
               translated_text,
               clean_body_text,
               fact_list_json,
               pipeline_version,
               fallback_used,
               quality_flags,
               summary_version,
               generated_at,
               updated_at`,
    [
      randomUUID(),
      tenantId,
      userId,
      accountId,
      messageId,
      providerMessageId || null,
      JSON.stringify(summary || {}),
      String(rawText || ''),
      String(model || ''),
      String(promptVersion || 'mail-summary-json-v1'),
      String(targetLanguage || 'ko'),
      String(sourceLanguage || 'unknown'),
      !!translated,
      String(translatedText || ''),
      String(cleanBodyText || ''),
      JSON.stringify(Array.isArray(factList) ? factList : []),
      String(pipelineVersion || 'mail-summary-pipeline-v2'),
      !!fallbackUsed,
      JSON.stringify(Array.isArray(qualityFlags) ? qualityFlags : []),
    ],
  )
  return rows[0] || null
}

async function updateMessageSummaryJson({
  tenantId,
  userId,
  messageId,
  targetLanguage = 'ko',
  summary,
}) {
  const { rows } = await tenantQuery(
    tenantId,
    `UPDATE mail_message_summaries
     SET summary_json = $5::jsonb,
         summary_version = summary_version + 1,
         updated_at = NOW()
     WHERE tenant_id = $1
       AND user_id = $2
       AND message_id = $3
       AND target_language = $4
     RETURNING id,
               tenant_id,
               user_id,
               account_id,
               message_id,
               provider_message_id,
               summary_json,
               raw_text,
               model,
               prompt_version,
               target_language,
               source_language,
               translated,
               translated_text,
               clean_body_text,
               fact_list_json,
               pipeline_version,
               fallback_used,
               quality_flags,
               summary_version,
               generated_at,
               updated_at`,
    [
      tenantId,
      userId,
      messageId,
      String(targetLanguage || 'ko'),
      JSON.stringify(summary || {}),
    ],
  )
  return rows[0] || null
}

async function deleteMessageSummary({ tenantId, userId, messageId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `DELETE FROM mail_message_summaries
     WHERE tenant_id = $1
       AND user_id = $2
       AND message_id = $3
     RETURNING id`,
    [tenantId, userId, messageId],
  )
  return rows[0] || null
}

async function deleteMessageSummariesForAccount({ tenantId, userId, accountId }) {
  const { rowCount } = await tenantQuery(
    tenantId,
    `DELETE FROM mail_message_summaries
     WHERE tenant_id = $1
       AND user_id = $2
       AND account_id = $3`,
    [tenantId, userId, accountId],
  )
  return rowCount
}

async function markMessageRead({ tenantId, messageId, userId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `UPDATE mail_messages
     SET is_read = true,
         updated_at = NOW()
     WHERE tenant_id = $1
       AND id = $2
       AND is_read = false
       AND user_id = $3
     RETURNING id`,
    [tenantId, messageId, userId],
  )
  return rows[0] || null
}

async function updateMessageReadState({ tenantId, messageId, userId, isRead }) {
  const { rows } = await tenantQuery(
    tenantId,
    `UPDATE mail_messages
     SET is_read = $4,
         updated_at = NOW()
     WHERE tenant_id = $1
       AND id = $2
       AND user_id = $3
     RETURNING id, account_id, folder_id, is_read`,
    [tenantId, messageId, userId, !!isRead],
  )
  return rows[0] || null
}

// 중요(별표) 토글 — is_starred 일괄 설정. (MailService.md 14.5)
async function setMessagesStarred({ tenantId, userId, messageIds, starred }) {
  const ids = [...new Set((messageIds || []).map(id => String(id || '').trim()).filter(Boolean))]
  if (ids.length === 0) return []
  const { rows } = await tenantQuery(
    tenantId,
    `UPDATE mail_messages
     SET is_starred = $3,
         updated_at = NOW()
     WHERE tenant_id = $1
       AND user_id = $2
       AND id = ANY($4::text[])
     RETURNING id, is_starred`,
    [tenantId, userId, !!starred, ids],
  )
  return rows
}

async function moveMessageToFolder({ tenantId, messageId, targetFolderId, userId, providerMessageId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `WITH target AS (
       SELECT id, account_id
       FROM mail_folders
       WHERE id = $3 AND user_id = $4
       LIMIT 1
     )
     UPDATE mail_messages mm
     SET folder_id = target.id,
         provider_message_id = COALESCE($5, mm.provider_message_id),
         updated_at = NOW()
     FROM target
     WHERE mm.tenant_id = $1
       AND mm.id = $2
       AND mm.account_id = target.account_id
       AND mm.user_id = $4
     RETURNING mm.id, mm.account_id, mm.folder_id, mm.is_read`,
    [tenantId, messageId, targetFolderId, userId, String(providerMessageId || '').trim() || null],
  )
  return rows[0] || null
}

async function moveMessageToAccountFolder({ tenantId, messageId, targetAccountId, targetFolderId, userId, providerMessageId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `WITH target AS (
       SELECT id, account_id
       FROM mail_folders
       WHERE id = $4
         AND account_id = $3
         AND user_id = $5
       LIMIT 1
     ),
     moved AS (
       UPDATE mail_messages mm
       SET account_id = target.account_id,
           folder_id = target.id,
           provider_message_id = COALESCE($6, mm.provider_message_id),
           updated_at = NOW()
       FROM target
       WHERE mm.tenant_id = $1
         AND mm.id = $2
         AND mm.user_id = $5
       RETURNING mm.id, mm.account_id, mm.folder_id, mm.is_read
     ),
     moved_attachments AS (
       UPDATE mail_attachments ma
       SET account_id = $3
       WHERE ma.tenant_id = $1
         AND ma.message_id = $2
         AND ma.user_id = $5
       RETURNING ma.id
     )
     SELECT * FROM moved`,
    [tenantId, messageId, targetAccountId, targetFolderId, userId, String(providerMessageId || '').trim() || null],
  )
  return rows[0] || null
}

async function deleteMessage({ tenantId, messageId, userId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `WITH msg AS (
       SELECT id, account_id, folder_id AS previous_folder_id, is_read
       FROM mail_messages
       WHERE tenant_id = $1
         AND id = $2
         AND user_id = $3
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
    [tenantId, messageId, userId],
  )
  return rows[0] || null
}

async function purgeTrashFolder({ tenantId, accountId, folderId, userId }) {
  const result = await withTenantTx(tenantId, async (client) => {
    // 휴지통 판정을 프론트 isMailTrashFolder와 맞춘다. iCloud처럼 실제 휴지통이
    // type='custom'(provider_folder_id='Trash')으로 분류된 계정도 비울 수 있게 한다.
    // 라우트가 특정 folderId로 좁혀 호출하므로 이 완화는 그 폴더 1개에만 적용된다. (MailService.md 15)
    const { rows: folderRows } = await client.query(
      `SELECT id, account_id, name, type
       FROM mail_folders
       WHERE tenant_id = $1
         AND account_id = $2
         AND id = $3
         AND (
           type = 'trash'
           OR UPPER(COALESCE(provider_folder_id, '')) = 'TRASH'
           OR LOWER(TRIM(COALESCE(name, ''))) = '휴지통'
         )
       LIMIT 1`,
      [tenantId, accountId, folderId],
    )
    const folder = folderRows[0] || null
    if (!folder) return null

    // 하드 삭제 전, 스토리지 blob 정리를 위해 첨부의 object_key를 먼저 수집한다.
    // (mail_attachments는 message_id ON DELETE CASCADE로 아래 DELETE 시 함께 지워지므로, 삭제 전에 조회해야 한다.)
    const { rows: attachmentRows } = await client.query(
      `SELECT ma.object_key
       FROM mail_attachments ma
       JOIN mail_messages mm ON mm.id = ma.message_id
       WHERE ma.tenant_id = $1
         AND ma.account_id = $2
         AND mm.folder_id = $3
         AND ma.user_id = $4`,
      [tenantId, accountId, folderId, userId],
    )

    const { rows } = await client.query(
      `DELETE FROM mail_messages mm
       WHERE mm.tenant_id = $1
         AND mm.account_id = $2
         AND mm.folder_id = $3
         AND mm.user_id = $4
       RETURNING mm.id, mm.is_read, mm.raw_object_key, mm.body_text_object_key, mm.body_html_object_key`,
      [tenantId, accountId, folderId, userId],
    )

    const objectKeys = []
    for (const row of rows) {
      if (row.raw_object_key) objectKeys.push(row.raw_object_key)
      if (row.body_text_object_key) objectKeys.push(row.body_text_object_key)
      if (row.body_html_object_key) objectKeys.push(row.body_html_object_key)
    }
    for (const att of attachmentRows) {
      if (att.object_key) objectKeys.push(att.object_key)
    }

    return {
      folder,
      count: rows.length,
      unread_count: rows.filter(row => row.is_read === false).length,
      objectKeys,
    }
  })

  if (!result) return null

  // DB 커밋 후 스토리지 blob을 정리한다(고아 객체 방지). 개별 삭제 실패는 무시(베스트 에포트) —
  // DB 행은 이미 지워졌으므로 스토리지 실패로 전체를 되돌리지 않는다.
  const storage = getMailStorage()
  let purgedObjects = 0
  for (const key of result.objectKeys) {
    try {
      await storage.deleteObject(key)
      purgedObjects += 1
    } catch (err) {
      console.error(`[Mail purgeTrash] 스토리지 객체 삭제 실패 key=${key}: ${err.message}`)
    }
  }

  return {
    folder: result.folder,
    count: result.count,
    unread_count: result.unread_count,
    purged_objects: purgedObjects,
  }
}

// 파싱된 메시지 1건 + 첨부를 트랜잭션으로 저장한다. (object_key는 이미 스토리지에 기록된 상태)
async function saveSyncedMessage({ tenantId, account, parsed, folderId, objectKeys, attachments }) {
  return withTenantTx(tenantId, async (client) => {
    const msgResult = await client.query(
      `INSERT INTO mail_messages (
         tenant_id, user_id, account_id, provider_message_id, internet_message_id, provider_thread_id, folder_id,
         subject, from_email, from_name, to_json, cc_json, bcc_json, snippet,
         received_at, sent_at, is_read, is_starred, has_attachments, size_bytes,
         raw_object_key, body_text_object_key, body_html_object_key, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23, NOW())
       ON CONFLICT (account_id, provider_message_id) DO UPDATE SET
         internet_message_id = COALESCE(EXCLUDED.internet_message_id, mail_messages.internet_message_id),
         provider_thread_id = COALESCE(EXCLUDED.provider_thread_id, mail_messages.provider_thread_id),
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
         is_starred = mail_messages.is_starred OR EXCLUDED.is_starred,
         has_attachments = EXCLUDED.has_attachments,
         size_bytes = EXCLUDED.size_bytes,
         raw_object_key = EXCLUDED.raw_object_key,
         body_text_object_key = EXCLUDED.body_text_object_key,
         body_html_object_key = EXCLUDED.body_html_object_key,
         updated_at = NOW()
       RETURNING id`,
      [
        tenantId, account.user_id, account.id, parsed.providerMessageId, parsed.internetMessageId || null, parsed.threadId || parsed.providerThreadId || null, folderId || null,
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

async function getAccountById({ tenantId, accountId, userId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT id, tenant_id, user_id, provider, email_address, display_name, status
     FROM mail_accounts
     WHERE tenant_id = $1
       AND id = $2
       AND user_id = $3
     LIMIT 1`,
    [tenantId, accountId, userId],
  )
  return rows[0] || null
}

async function getMessageForAgentic({ tenantId, messageId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT mm.id,
            mm.tenant_id,
            mm.user_id,
            mm.account_id,
            ma.email_address AS account_email,
            mm.folder_id,
            mf.provider_folder_id AS folder_provider_id,
            mf.type AS folder_type,
            mm.provider_message_id,
            mm.provider_thread_id,
            mm.internet_message_id,
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
            mm.has_attachments,
            mm.raw_object_key,
            mm.body_text_object_key,
            mm.body_html_object_key,
            mm.created_at
     FROM mail_messages mm
     JOIN mail_accounts ma ON ma.id = mm.account_id
     LEFT JOIN mail_folders mf ON mf.id = mm.folder_id
     WHERE mm.tenant_id = $1 AND mm.id = $2
     LIMIT 1`,
    [tenantId, messageId],
  )
  return rows[0] || null
}

async function getMessagesForAgenticBatch({ tenantId, messageIds }) {
  const ids = Array.from(new Set((messageIds || []).map(id => String(id || '').trim()).filter(Boolean)))
  if (!tenantId || ids.length === 0) return []
  const out = []
  const chunkSize = 1000
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize)
    const { rows } = await tenantQuery(
      tenantId,
      `SELECT mm.id,
              mm.tenant_id,
              mm.user_id,
              mm.account_id,
              ma.email_address AS account_email,
              mm.folder_id,
              mf.provider_folder_id AS folder_provider_id,
              mf.type AS folder_type,
              mm.provider_message_id,
              mm.provider_thread_id,
              mm.internet_message_id,
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
              mm.has_attachments,
              mm.raw_object_key,
              mm.body_text_object_key,
              mm.body_html_object_key,
              mm.created_at
       FROM mail_messages mm
       JOIN mail_accounts ma ON ma.id = mm.account_id
       LEFT JOIN mail_folders mf ON mf.id = mm.folder_id
       WHERE mm.tenant_id = $1 AND mm.id = ANY($2::text[])`,
      [tenantId, chunk],
    )
    out.push(...rows)
  }
  return out
}

// ===== 발신 도메인 파비콘 캐시(전역, control 풀) ==========================
async function getDomainFavicon(domain) {
  const key = String(domain || '').trim().toLowerCase()
  if (!key) return null
  const { rows } = await cm.getControlPool().query(
    `SELECT domain, content_type, image, status, fetched_at
     FROM mail_domain_favicons
     WHERE domain = $1
     LIMIT 1`,
    [key],
  )
  return rows[0] || null
}

async function upsertDomainFavicon({ domain, contentType = null, image = null, status = 'ok' }) {
  const key = String(domain || '').trim().toLowerCase()
  if (!key) return null
  const { rows } = await cm.getControlPool().query(
    `INSERT INTO mail_domain_favicons (domain, content_type, image, status, fetched_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (domain) DO UPDATE
       SET content_type = EXCLUDED.content_type,
           image        = EXCLUDED.image,
           status       = EXCLUDED.status,
           fetched_at   = NOW(),
           updated_at   = NOW()
     RETURNING domain, content_type, image, status, fetched_at`,
    [key, contentType, image, status],
  )
  return rows[0] || null
}

async function listMessageAttachments({ tenantId, messageId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT id, provider_attachment_id, filename, content_type, size_bytes, object_key
     FROM mail_attachments
     WHERE tenant_id = $1 AND message_id = $2
     ORDER BY created_at ASC, id ASC`,
    [tenantId, messageId],
  )
  return rows
}

// 단건 첨부 조회(다운로드용). 비관리자는 본인 소유 첨부만 접근 가능.
async function getMessageAttachment({ tenantId, messageId, attachmentId, userId, isSiteAdmin }) {
  const params = [tenantId, messageId, attachmentId]
  let userFilter = ''
  if (!isSiteAdmin) {
    params.push(userId)
    userFilter = `AND user_id = $4`
  }
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT id, message_id, filename, content_type, size_bytes, object_key
     FROM mail_attachments
     WHERE tenant_id = $1 AND message_id = $2 AND id = $3 ${userFilter}
     LIMIT 1`,
    params,
  )
  return rows[0] || null
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.map(item => String(item || '').trim()).filter(Boolean)
}

function normalizeMailClawFields(fields = {}) {
  return {
    name: String(fields.name || '').trim() || 'MailClaw',
    enabled: fields.enabled !== false,
    sender_check_enabled: !!fields.sender_check_enabled,
    sender_conditions: normalizeStringArray(fields.sender_conditions),
    cc_check_enabled: !!fields.cc_check_enabled,
    cc_conditions: normalizeStringArray(fields.cc_conditions),
    keyword_check_enabled: !!fields.keyword_check_enabled,
    keyword_conditions: normalizeStringArray(fields.keyword_conditions),
    ai_analysis_enabled: !!fields.ai_analysis_enabled,
    important_mail_enabled: !!fields.important_mail_enabled,
    forward_enabled: !!fields.forward_enabled,
    forward_addresses: normalizeStringArray(fields.forward_addresses),
    move_folder_enabled: !!fields.move_folder_enabled,
    target_folder_id: String(fields.target_folder_id || '').trim() || null,
    tag_smart_folder_enabled: !!fields.tag_smart_folder_enabled,
    tag_smart_folder_id: String(fields.tag_smart_folder_id || '').trim() || null,
    tag_archive_enabled: !!fields.tag_archive_enabled,
  }
}

const DEFAULT_MAILCLAW_TRASH_RULE_NAME = 'MailClaw 휴지통 이동'
const LEGACY_MAILCLAW_TRASH_RULE_NAME = 'MailClaw #5 휴지통 이동'

async function findDefaultTrashFolderForUser(client, { tenantId, userId }) {
  const { rows } = await client.query(
    `SELECT mf.id
     FROM mail_folders mf
     JOIN mail_accounts ma ON ma.id = mf.account_id
     WHERE mf.tenant_id = $1
       AND mf.user_id = $2
       AND (
         mf.type = 'trash'
         OR mf.provider_folder_id = 'TRASH'
         OR TRIM(mf.name) = '휴지통'
       )
     ORDER BY ma.created_at ASC NULLS LAST, mf.created_at ASC NULLS LAST, mf.name ASC
     LIMIT 1`,
    [tenantId, userId],
  )
  return rows[0]?.id || null
}

async function ensureDefaultMailClawTrashRule({ tenantId, userId }) {
  if (!tenantId || !userId) return null
  return withTenantTx(tenantId, async (client) => {
    const targetFolderId = await findDefaultTrashFolderForUser(client, { tenantId, userId })
    if (!targetFolderId) return null

    const exact = await client.query(
      `SELECT *
       FROM mailclaw_rules
       WHERE tenant_id = $1
         AND owner_user_id = $2
         AND name = $3
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
      [tenantId, userId, DEFAULT_MAILCLAW_TRASH_RULE_NAME],
    )
    if (exact.rows[0]) return exact.rows[0]

    const legacy = await client.query(
      `UPDATE mailclaw_rules
       SET name = $4,
           move_folder_enabled = true,
           target_folder_id = COALESCE(target_folder_id, $3),
           updated_at = NOW()
       WHERE id = (
         SELECT id
         FROM mailclaw_rules
         WHERE tenant_id = $1
           AND owner_user_id = $2
           AND name = $5
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1
       )
       RETURNING *`,
      [tenantId, userId, targetFolderId, DEFAULT_MAILCLAW_TRASH_RULE_NAME, LEGACY_MAILCLAW_TRASH_RULE_NAME],
    )
    if (legacy.rows[0]) return legacy.rows[0]

    const inserted = await client.query(
      `INSERT INTO mailclaw_rules (
         tenant_id, owner_user_id, name, enabled,
         sender_check_enabled, sender_conditions,
         cc_check_enabled, cc_conditions,
         keyword_check_enabled, keyword_conditions,
         ai_analysis_enabled, important_mail_enabled, forward_enabled, forward_addresses,
         move_folder_enabled, target_folder_id
       )
       VALUES ($1,$2,$3,true,false,'[]'::jsonb,false,'[]'::jsonb,false,'[]'::jsonb,false,false,false,'[]'::jsonb,true,$4)
       RETURNING *`,
      [tenantId, userId, DEFAULT_MAILCLAW_TRASH_RULE_NAME, targetFolderId],
    )
    return inserted.rows[0] || null
  })
}

async function registerSenderToDefaultMailClawTrashRule({ tenantId, userId, senderEmail }) {
  const normalizedSender = String(senderEmail || '').trim().toLowerCase()
  if (!tenantId || !userId || !normalizedSender) return null

  const ensured = await ensureDefaultMailClawTrashRule({ tenantId, userId })
  if (!ensured) return null

  return withTenantTx(tenantId, async (client) => {
    const targetFolderId = ensured.target_folder_id || await findDefaultTrashFolderForUser(client, { tenantId, userId })
    if (!targetFolderId) return null
    const current = await client.query(
      `SELECT sender_conditions
       FROM mailclaw_rules
       WHERE tenant_id = $1
         AND owner_user_id = $2
         AND id = $3
       LIMIT 1`,
      [tenantId, userId, ensured.id],
    )
    const existing = normalizeStringArray(current.rows[0]?.sender_conditions)
    const nextByEmail = new Map(existing.map(item => [item.toLowerCase(), item]))
    nextByEmail.set(normalizedSender, normalizedSender)
    const senderConditions = Array.from(nextByEmail.values())
    const { rows } = await client.query(
      `UPDATE mailclaw_rules
       SET name = $4,
           enabled = true,
           sender_check_enabled = true,
           sender_conditions = $5::jsonb,
           move_folder_enabled = true,
           target_folder_id = COALESCE(target_folder_id, $6),
           updated_at = NOW()
       WHERE tenant_id = $1
         AND owner_user_id = $2
         AND id = $3
       RETURNING *`,
      [
        tenantId,
        userId,
        ensured.id,
        DEFAULT_MAILCLAW_TRASH_RULE_NAME,
        JSON.stringify(senderConditions),
        targetFolderId,
      ],
    )
    return rows[0] || null
  })
}

async function listMailClawRules({ tenantId, userId, isSiteAdmin }) {
  await ensureDefaultMailClawTrashRule({ tenantId, userId })
  const params = [tenantId, userId, !!isSiteAdmin]
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT mcr.id,
            mcr.tenant_id,
            mcr.owner_user_id,
            mcr.name,
            mcr.enabled,
            mcr.sender_check_enabled,
            mcr.sender_conditions,
            mcr.cc_check_enabled,
            mcr.cc_conditions,
            mcr.keyword_check_enabled,
            mcr.keyword_conditions,
            mcr.ai_analysis_enabled,
            mcr.important_mail_enabled,
            mcr.forward_enabled,
            mcr.forward_addresses,
            mcr.move_folder_enabled,
            mcr.target_folder_id,
            mf.name AS target_folder_name,
            mcr.tag_smart_folder_enabled,
            mcr.tag_smart_folder_id,
            msf.name AS tag_smart_folder_name,
            mcr.tag_archive_enabled,
            mcr.created_at,
            mcr.updated_at
     FROM mailclaw_rules mcr
     LEFT JOIN mail_folders mf ON mf.id = mcr.target_folder_id
     LEFT JOIN mail_smart_folders msf ON msf.id = mcr.tag_smart_folder_id
     WHERE mcr.tenant_id = $1
       AND ($3::boolean = true OR mcr.owner_user_id = $2)
     ORDER BY mcr.updated_at DESC, mcr.created_at DESC`,
    params,
  )
  return rows
}

async function listEnabledMailClawRules({ tenantId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT id,
            tenant_id,
            owner_user_id,
            name,
            enabled,
            sender_check_enabled,
            sender_conditions,
            cc_check_enabled,
            cc_conditions,
            keyword_check_enabled,
            keyword_conditions,
            ai_analysis_enabled,
            important_mail_enabled,
            forward_enabled,
            forward_addresses,
            move_folder_enabled,
            target_folder_id,
            tag_smart_folder_enabled,
            tag_smart_folder_id,
            tag_archive_enabled
     FROM mailclaw_rules
     WHERE tenant_id = $1
       AND enabled = true
     ORDER BY created_at ASC`,
    [tenantId],
  )
  return rows
}

async function getMailClawRule({ tenantId, id, userId, isSiteAdmin }) {
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT id,
            tenant_id,
            owner_user_id,
            name,
            enabled,
            sender_check_enabled,
            sender_conditions,
            cc_check_enabled,
            cc_conditions,
            keyword_check_enabled,
            keyword_conditions,
            ai_analysis_enabled,
            important_mail_enabled,
            forward_enabled,
            forward_addresses,
            move_folder_enabled,
            target_folder_id,
            tag_smart_folder_enabled,
            tag_smart_folder_id,
            tag_archive_enabled
     FROM mailclaw_rules
     WHERE tenant_id = $1
       AND id = $2
       AND ($4::boolean = true OR owner_user_id = $3)
     LIMIT 1`,
    [tenantId, id, userId, !!isSiteAdmin],
  )
  return rows[0] || null
}

async function createMailClawRule({ tenantId, ownerUserId, fields }) {
  const f = normalizeMailClawFields(fields)
  const { rows } = await tenantQuery(
    tenantId,
    `INSERT INTO mailclaw_rules (
       tenant_id, owner_user_id, name, enabled,
       sender_check_enabled, sender_conditions,
       cc_check_enabled, cc_conditions,
       keyword_check_enabled, keyword_conditions,
       ai_analysis_enabled, important_mail_enabled, forward_enabled, forward_addresses,
       move_folder_enabled, target_folder_id,
       tag_smart_folder_enabled, tag_smart_folder_id, tag_archive_enabled
     )
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19)
     RETURNING *`,
    [
      tenantId,
      ownerUserId,
      f.name,
      f.enabled,
      f.sender_check_enabled,
      JSON.stringify(f.sender_conditions),
      f.cc_check_enabled,
      JSON.stringify(f.cc_conditions),
      f.keyword_check_enabled,
      JSON.stringify(f.keyword_conditions),
      f.ai_analysis_enabled,
      f.important_mail_enabled,
      f.forward_enabled,
      JSON.stringify(f.forward_addresses),
      f.move_folder_enabled,
      f.target_folder_id,
      f.tag_smart_folder_enabled,
      f.tag_smart_folder_id,
      f.tag_archive_enabled,
    ],
  )
  return rows[0]
}

async function updateMailClawRule({ tenantId, id, ownerUserId, isSiteAdmin, fields }) {
  const f = normalizeMailClawFields(fields)
  const { rows } = await tenantQuery(
    tenantId,
    `UPDATE mailclaw_rules
     SET name = $4,
         enabled = $5,
         sender_check_enabled = $6,
         sender_conditions = $7::jsonb,
         cc_check_enabled = $8,
         cc_conditions = $9::jsonb,
         keyword_check_enabled = $10,
         keyword_conditions = $11::jsonb,
         ai_analysis_enabled = $12,
         important_mail_enabled = $13,
         forward_enabled = $14,
         forward_addresses = $15::jsonb,
         move_folder_enabled = $16,
         target_folder_id = $17,
         tag_smart_folder_enabled = $19,
         tag_smart_folder_id = $20,
         tag_archive_enabled = $21,
         updated_at = NOW()
     WHERE tenant_id = $1
       AND id = $2
       AND ($3::boolean = true OR owner_user_id = $18)
     RETURNING *`,
    [
      tenantId,
      id,
      !!isSiteAdmin,
      f.name,
      f.enabled,
      f.sender_check_enabled,
      JSON.stringify(f.sender_conditions),
      f.cc_check_enabled,
      JSON.stringify(f.cc_conditions),
      f.keyword_check_enabled,
      JSON.stringify(f.keyword_conditions),
      f.ai_analysis_enabled,
      f.important_mail_enabled,
      f.forward_enabled,
      JSON.stringify(f.forward_addresses),
      f.move_folder_enabled,
      f.target_folder_id,
      ownerUserId,
      f.tag_smart_folder_enabled,
      f.tag_smart_folder_id,
      f.tag_archive_enabled,
    ],
  )
  return rows[0] || null
}

async function deleteMailClawRule({ tenantId, id, ownerUserId, isSiteAdmin }) {
  const { rows } = await tenantQuery(
    tenantId,
    `DELETE FROM mailclaw_rules
     WHERE tenant_id = $1
       AND id = $2
       AND ($3::boolean = true OR owner_user_id = $4)
       AND name <> $5
     RETURNING id`,
    [tenantId, id, !!isSiteAdmin, ownerUserId, DEFAULT_MAILCLAW_TRASH_RULE_NAME],
  )
  return rows[0] || null
}

async function tryCreateMailClawExecutionLog({ tenantId, ruleId, messageId, matched = true, force = false }) {
  if (force) {
    const { rows } = await tenantQuery(
      tenantId,
      `INSERT INTO mailclaw_execution_logs (tenant_id, rule_id, message_id, matched, status, action_results, error_message)
       VALUES ($1, $2, $3, $4, 'pending', '[]'::jsonb, NULL)
       ON CONFLICT (rule_id, message_id) DO UPDATE
       SET matched = EXCLUDED.matched,
           status = 'pending',
           action_results = '[]'::jsonb,
           error_message = NULL,
           created_at = NOW(),
           updated_at = NOW()
       RETURNING id`,
      [tenantId, ruleId, messageId, !!matched],
    )
    return rows[0] || null
  }
  const { rows } = await tenantQuery(
    tenantId,
    `INSERT INTO mailclaw_execution_logs (tenant_id, rule_id, message_id, matched, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (rule_id, message_id) DO NOTHING
     RETURNING id`,
    [tenantId, ruleId, messageId, !!matched],
  )
  return rows[0] || null
}

async function finishMailClawExecutionLog({ tenantId, id, status, actionResults = [], errorMessage = null }) {
  const { rows } = await tenantQuery(
    tenantId,
    `UPDATE mailclaw_execution_logs
     SET status = $3,
         action_results = $4::jsonb,
         error_message = $5,
         updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2
     RETURNING *`,
    [tenantId, id, status, JSON.stringify(actionResults || []), errorMessage || null],
  )
  return rows[0] || null
}

async function listMailClawExecutionLogs({ tenantId, ruleId, userId, isSiteAdmin, limit = 50 }) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50))
  const params = [tenantId, userId, !!isSiteAdmin]
  let ruleFilter = ''
  if (ruleId) {
    params.push(ruleId)
    ruleFilter = `AND mcl.rule_id = $${params.length}`
  }
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT mcl.id,
            mcl.tenant_id,
            mcl.rule_id,
            mcr.name AS rule_name,
            mcl.message_id,
            mm.subject,
            mm.from_email,
            mcl.status,
            mcl.matched,
            mcl.action_results,
            mcl.error_message,
            mcl.created_at,
            mcl.updated_at
     FROM mailclaw_execution_logs mcl
     JOIN mailclaw_rules mcr ON mcr.id = mcl.rule_id
     LEFT JOIN mail_messages mm ON mm.id = mcl.message_id
     WHERE mcl.tenant_id = $1
       AND ($3::boolean = true OR mcr.owner_user_id = $2)
       ${ruleFilter}
     ORDER BY mcl.created_at DESC
     LIMIT ${safeLimit}`,
    params,
  )
  return rows
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
  deleteAccount,
  updateAccountTokens,
  setAccountSyncStatus,
  getExistingProviderMessageIds,
  getExistingInternetMessageIds,
  countSyncedImapMessages,
  getFolderMap,
  upsertFolders,
  getFolderById,
  getFolderByIdForUser,
  getFolderByTypeForAccount,
  resolveFolderForAccount,
  createFolder,
  setFolderSyncStatus,
  setFolderDeletable,
  updateFolderColor,
  renameFolder,
  folderNameExists,
  deleteFolder,
  listMessages,
  listUnifiedMessages,
  // smart folders (태그 기반 통합 — MailService.md 13)
  listSmartFolders,
  createSmartFolder,
  updateSmartFolder,
  deleteSmartFolder,
  tagMessagesToSmartFolder,
  untagMessagesFromSmartFolder,
  listSmartFolderMessages,
  listSmartFoldersForMessage,
  seedSmartFoldersFromCustomFolders,
  reconcileTrashFolders,
  getMessage,
  getMessageSummary,
  upsertMessageSummary,
  updateMessageSummaryJson,
  deleteMessageSummary,
  deleteMessageSummariesForAccount,
  markMessageRead,
  updateMessageReadState,
  setMessagesStarred,
  moveMessageToFolder,
  moveMessageToAccountFolder,
  deleteMessage,
  purgeTrashFolder,
  saveSyncedMessage,
  saveDraftMessage,
  updateSyncState,
  recomputeUsage,
  getAccountById,
  getMessageForAgentic,
  getMessagesForAgenticBatch,
  getDomainFavicon,
  upsertDomainFavicon,
  listMessageAttachments,
  getMessageAttachment,
  // MailClaw
  listMailClawRules,
  ensureDefaultMailClawTrashRule,
  registerSenderToDefaultMailClawTrashRule,
  listEnabledMailClawRules,
  getMailClawRule,
  createMailClawRule,
  updateMailClawRule,
  deleteMailClawRule,
  tryCreateMailClawExecutionLog,
  finishMailClawExecutionLog,
  listMailClawExecutionLogs,
}
