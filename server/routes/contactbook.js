const express = require('express')
const crypto = require('crypto')
const pool = require('../db')
const requireAuth = require('../middleware/auth')
const { encryptSecret, decryptSecret } = require('../lib/secrets')
const { discover, listResources, updateResource, getResource } = require('../contactbook/carddav')
const { parseVCard, updateVCard } = require('../contactbook/vcard')
const { canEditContact, validateContactEdit } = require('../contactbook/editPolicy')
const {
  createPkce, buildGoogleContactAuthUrl, exchangeGoogleContactCode,
  refreshGoogleContactToken, getGoogleIdentity, revokeGoogleToken,
} = require('../contactbook/googleOAuth')

const router = express.Router()
const refreshLocks = new Map()

const tenantFor = userId => `personal:${userId}`
function safeAccount(row) {
  const { credential_encrypted, oauth_access_token_encrypted, oauth_refresh_token_encrypted, oauth_subject, username, ...safe } = row
  return safe
}
function safeContact(row) {
  const { remote_uid, ...contact } = row
  return { ...contact, editable: canEditContact(row) }
}
function oauthRedirect(res, status, error = '') {
  const params = new URLSearchParams({ open: 'contactbook', contactbook_oauth: status })
  if (error) params.set('contactbook_error', error)
  return res.redirect(`/?${params}`)
}
function tokenExpiry(tokens) {
  return new Date(Date.now() + Math.max(60, Number(tokens.expires_in) || 3600) * 1000)
}
async function refreshOwnedGoogleAccount(row, force = false) {
  if (row.provider !== 'GOOGLE') return { ...row, secret: decryptSecret(row.credential_encrypted) }
  const expiresAt = row.oauth_token_expires_at ? new Date(row.oauth_token_expires_at).getTime() : 0
  const currentToken = decryptSecret(row.oauth_access_token_encrypted || row.credential_encrypted)
  if (!force && currentToken && expiresAt > Date.now() + 60000) return { ...row, secret: currentToken }
  if (!refreshLocks.has(row.id)) {
    refreshLocks.set(row.id, (async () => {
      const refreshToken = decryptSecret(row.oauth_refresh_token_encrypted)
      if (!refreshToken) throw new Error('Google 재인증이 필요합니다.')
      const tokens = await refreshGoogleContactToken(refreshToken)
      if (!tokens.access_token) throw new Error('Google access token 갱신에 실패했습니다.')
      const accessEncrypted = encryptSecret(tokens.access_token)
      await pool.query(`UPDATE contact_accounts SET credential_encrypted=$1,oauth_access_token_encrypted=$1,
        oauth_refresh_token_encrypted=COALESCE($2,oauth_refresh_token_encrypted),oauth_token_expires_at=$3,
        status='CONNECTED',last_error_message_safe=NULL,updated_at=NOW() WHERE id=$4 AND user_id=$5`, [
        accessEncrypted, tokens.refresh_token ? encryptSecret(tokens.refresh_token) : null, tokenExpiry(tokens), row.id, row.user_id,
      ])
      return tokens.access_token
    })().finally(() => refreshLocks.delete(row.id)))
  }
  try {
    return { ...row, secret: await refreshLocks.get(row.id) }
  } catch (error) {
    await pool.query("UPDATE contact_accounts SET status='AUTH_REQUIRED',last_error_message_safe='Google 재인증이 필요합니다.',updated_at=NOW() WHERE id=$1 AND user_id=$2", [row.id, row.user_id])
    error.status = 401
    throw error
  }
}
async function ownedAccount(userId, accountId) {
  const { rows } = await pool.query('SELECT * FROM contact_accounts WHERE id=$1 AND user_id=$2 AND tenant_id=$3', [accountId, userId, tenantFor(userId)])
  if (!rows[0]) { const error = new Error('주소록 계정을 찾을 수 없습니다.'); error.status = 404; throw error }
  return refreshOwnedGoogleAccount(rows[0])
}
async function persistContactSnapshot({ contactId, resourceId, userId, provider, remoteUid, vcard, etag, accountName, addressbookName }) {
  const parsed = parseVCard(vcard)
  const contentHash = crypto.createHash('sha256').update(vcard).digest('hex')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`UPDATE contact_resources SET etag=$1,raw_vcard_encrypted=$2,content_hash=$3,last_seen_at=NOW(),updated_at=NOW()
      WHERE id=$4 AND user_id=$5`, [etag, encryptSecret(vcard), contentHash, resourceId, userId])
    const updated = await client.query(`UPDATE contacts SET display_name=$1,given_name=$2,family_name=$3,nickname=$4,
      organization=$5,department=$6,job_title=$7,birthday=$8,note=$9,emails=$10,phones=$11,addresses=$12,urls=$13,
      search_text=$14,updated_at=NOW() WHERE id=$15 AND user_id=$16 RETURNING *`, [
      parsed.displayName, parsed.givenName, parsed.familyName, parsed.nickname, parsed.organization, parsed.department,
      parsed.jobTitle, parsed.birthday, parsed.note, JSON.stringify(parsed.emails), JSON.stringify(parsed.phones),
      JSON.stringify(parsed.addresses), JSON.stringify(parsed.urls), parsed.searchText, contactId, userId,
    ])
    await client.query('COMMIT')
    return safeContact({ ...updated.rows[0], etag, remote_uid: remoteUid, provider, account_name: accountName, addressbook_name: addressbookName })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

router.get('/oauth/google/callback', asyncRoute(async (req, res) => {
  const state = String(req.query.state || '').trim()
  const code = String(req.query.code || '').trim()
  const googleError = String(req.query.error || '').trim()
  if (!state) return oauthRedirect(res, 'error', 'missing_state')
  const consumed = await pool.query(`UPDATE contact_oauth_states SET consumed_at=NOW()
    WHERE state=$1 AND provider='GOOGLE' AND consumed_at IS NULL AND expires_at>NOW() RETURNING *`, [state])
  const oauthState = consumed.rows[0]
  if (!oauthState) return oauthRedirect(res, 'error', 'invalid_state')
  if (googleError || !code) return oauthRedirect(res, 'error', googleError || 'missing_code')
  try {
    const tokens = await exchangeGoogleContactCode(code, decryptSecret(oauthState.pkce_verifier_encrypted))
    if (!tokens.access_token) throw new Error('Google OAuth 응답에 access token이 없습니다.')
    const identity = await getGoogleIdentity(tokens.access_token)
    if (!identity.id || !identity.email) throw new Error('Google 계정 정보를 확인하지 못했습니다.')
    const candidate = {
      discovery_url: 'https://www.googleapis.com/.well-known/carddav', auth_type: 'OAUTH2',
      username: identity.email, secret: tokens.access_token,
    }
    const found = await discover(candidate)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      let existing
      if (oauthState.account_id) {
        existing = await client.query('SELECT * FROM contact_accounts WHERE id=$1 AND user_id=$2 AND tenant_id=$3 FOR UPDATE', [oauthState.account_id, oauthState.user_id, oauthState.tenant_id])
      } else {
        existing = await client.query("SELECT * FROM contact_accounts WHERE provider='GOOGLE' AND oauth_subject=$1 AND user_id=$2 AND tenant_id=$3 FOR UPDATE", [identity.id, oauthState.user_id, oauthState.tenant_id])
      }
      if (oauthState.account_id && !existing.rows[0]) throw new Error('재인증할 주소록 계정을 찾지 못했습니다.')
      const previousRefresh = existing.rows[0]?.oauth_refresh_token_encrypted || null
      const accessEncrypted = encryptSecret(tokens.access_token)
      const refreshEncrypted = tokens.refresh_token ? encryptSecret(tokens.refresh_token) : previousRefresh
      if (!refreshEncrypted) throw new Error('Google refresh token이 발급되지 않았습니다. 권한 동의를 다시 진행해 주세요.')
      let account
      if (existing.rows[0]) {
        account = await client.query(`UPDATE contact_accounts SET display_name=$1,account_identifier=$1,username=$1,
          discovery_url=$2,principal_url=$3,addressbook_home_url=$4,auth_type='OAUTH2',credential_encrypted=$5,
          oauth_access_token_encrypted=$5,oauth_refresh_token_encrypted=$6,oauth_token_expires_at=$7,
          oauth_scopes=$8,oauth_subject=$9,status='CONNECTED',last_error_message_safe=NULL,updated_at=NOW()
          WHERE id=$10 RETURNING *`, [identity.email, candidate.discovery_url, found.principalUrl, found.homeUrl,
          accessEncrypted, refreshEncrypted, tokenExpiry(tokens), String(tokens.scope || '').split(/\s+/).filter(Boolean), identity.id, existing.rows[0].id])
      } else {
        account = await client.query(`INSERT INTO contact_accounts
          (tenant_id,user_id,provider,display_name,account_identifier,discovery_url,principal_url,addressbook_home_url,
           auth_type,username,credential_encrypted,oauth_access_token_encrypted,oauth_refresh_token_encrypted,
           oauth_token_expires_at,oauth_scopes,oauth_subject,status)
          VALUES ($1,$2,'GOOGLE',$3,$3,$4,$5,$6,'OAUTH2',$3,$7,$7,$8,$9,$10,$11,'CONNECTED') RETURNING *`, [
          oauthState.tenant_id, oauthState.user_id, identity.email, candidate.discovery_url, found.principalUrl, found.homeUrl,
          accessEncrypted, refreshEncrypted, tokenExpiry(tokens), String(tokens.scope || '').split(/\s+/).filter(Boolean), identity.id,
        ])
      }
      for (const book of found.books) {
        await client.query(`INSERT INTO contact_addressbooks
          (tenant_id,user_id,account_id,remote_url,remote_display_name,supports_sync_collection,sync_token,ctag)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (account_id,remote_url) DO UPDATE SET remote_display_name=EXCLUDED.remote_display_name,
          supports_sync_collection=EXCLUDED.supports_sync_collection,sync_token=COALESCE(EXCLUDED.sync_token,contact_addressbooks.sync_token),
          ctag=COALESCE(EXCLUDED.ctag,contact_addressbooks.ctag),updated_at=NOW()`, [oauthState.tenant_id, oauthState.user_id,
          account.rows[0].id, book.remoteUrl, book.displayName, Boolean(book.syncToken), book.syncToken || null, book.ctag || null])
      }
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    return oauthRedirect(res, 'connected')
  } catch (error) {
    console.error('[ContactBook Google OAuth]', {
      message: error?.message || String(error),
      status: error?.status || null,
      method: error?.carddavMethod || null,
      host: error?.carddavHost || null,
      path: error?.carddavPath || null,
      authenticate: error?.carddavAuthenticate || null,
      response: error?.carddavResponse || null,
    })
    return oauthRedirect(res, 'error', 'google_callback_failed')
  }
}))

router.use(requireAuth)

router.post('/oauth/google/start', asyncRoute(async (req, res) => {
  const accountId = String(req.body?.accountId || '').trim() || null
  if (accountId) {
    const found = await pool.query("SELECT id FROM contact_accounts WHERE id=$1 AND user_id=$2 AND tenant_id=$3 AND provider='GOOGLE'", [accountId, req.user.id, tenantFor(req.user.id)])
    if (!found.rows[0]) return res.status(404).json({ error: 'Google 주소록 계정을 찾을 수 없습니다.' })
  }
  await pool.query('DELETE FROM contact_oauth_states WHERE expires_at<=NOW() OR consumed_at IS NOT NULL')
  const state = crypto.randomBytes(32).toString('base64url')
  const pkce = createPkce()
  await pool.query(`INSERT INTO contact_oauth_states
    (state,provider,purpose,tenant_id,user_id,account_id,pkce_verifier_encrypted,expires_at)
    VALUES ($1,'GOOGLE',$2,$3,$4,$5,$6,NOW()+INTERVAL '10 minutes')`, [state,
    accountId ? 'CONTACTBOOK_REAUTHORIZE' : 'CONTACTBOOK_CONNECT', tenantFor(req.user.id), req.user.id, accountId, encryptSecret(pkce.verifier)])
  res.json({ authUrl: await buildGoogleContactAuthUrl({ state, codeChallenge: pkce.challenge }) })
}))
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
}

router.get('/accounts', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT a.*, COUNT(b.id)::int AS addressbook_count
    FROM contact_accounts a LEFT JOIN contact_addressbooks b ON b.account_id=a.id AND b.user_id=a.user_id
    WHERE a.user_id=$1 AND a.tenant_id=$2 GROUP BY a.id ORDER BY a.created_at`, [req.user.id, tenantFor(req.user.id)])
  res.json(rows.map(safeAccount))
}))

router.post('/accounts', asyncRoute(async (req, res) => {
  const provider = String(req.body.provider || 'GENERIC_CARDDAV').toUpperCase()
  if (!['APPLE', 'GOOGLE', 'GENERIC_CARDDAV'].includes(provider)) return res.status(400).json({ error: '지원하지 않는 공급자입니다.' })
  if (provider === 'GOOGLE') return res.status(400).json({ error: 'Google 계정은 Google 계정으로 연결 버튼을 사용해 주세요.' })
  const secret = String(req.body.secret || '').trim()
  const username = String(req.body.username || '').trim()
  if (!secret || !username) return res.status(400).json({ error: '계정과 인증 정보를 입력해 주세요.' })
  const discoveryUrl = String(req.body.discoveryUrl || (provider === 'GOOGLE'
    ? 'https://www.googleapis.com/.well-known/carddav'
    : provider === 'APPLE' ? 'https://contacts.icloud.com/.well-known/carddav' : '')).trim()
  if (!discoveryUrl) return res.status(400).json({ error: 'CardDAV 서버 주소를 입력해 주세요.' })
  const authType = provider === 'GOOGLE' ? 'OAUTH2' : (provider === 'APPLE' ? 'APP_PASSWORD' : String(req.body.authType || 'BASIC'))
  const candidate = { discovery_url: discoveryUrl, auth_type: authType, username, secret }
  const found = await discover(candidate)
  const tenantId = tenantFor(req.user.id)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const inserted = await client.query(`INSERT INTO contact_accounts
      (tenant_id,user_id,provider,display_name,account_identifier,discovery_url,principal_url,addressbook_home_url,auth_type,username,credential_encrypted,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'CONNECTED') RETURNING *`, [
      tenantId, req.user.id, provider, String(req.body.displayName || username), username, discoveryUrl,
      found.principalUrl, found.homeUrl, authType, username, encryptSecret(secret),
    ])
    for (const book of found.books) {
      await client.query(`INSERT INTO contact_addressbooks
        (tenant_id,user_id,account_id,remote_url,remote_display_name,supports_sync_collection,sync_token,ctag)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (account_id,remote_url) DO NOTHING`, [
        tenantId, req.user.id, inserted.rows[0].id, book.remoteUrl, book.displayName, Boolean(book.syncToken), book.syncToken || null, book.ctag || null,
      ])
    }
    await client.query('COMMIT')
    res.status(201).json({ account: safeAccount(inserted.rows[0]), addressbooks: found.books })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))

router.delete('/accounts/:id', asyncRoute(async (req, res) => {
  const existingResult = await pool.query('SELECT * FROM contact_accounts WHERE id=$1 AND user_id=$2 AND tenant_id=$3', [req.params.id, req.user.id, tenantFor(req.user.id)])
  const existing = existingResult.rows[0]
  if (!existing) return res.status(404).json({ error: '주소록 계정을 찾을 수 없습니다.' })
  if (existing.provider === 'GOOGLE') {
    const token = decryptSecret(existing.oauth_refresh_token_encrypted) || decryptSecret(existing.oauth_access_token_encrypted || existing.credential_encrypted)
    await revokeGoogleToken(token).catch(error => console.warn('[ContactBook] Google token revoke failed:', error.message))
  }
  const result = await pool.query('DELETE FROM contact_accounts WHERE id=$1 AND user_id=$2 AND tenant_id=$3', [req.params.id, req.user.id, tenantFor(req.user.id)])
  if (!result.rowCount) return res.status(404).json({ error: '주소록 계정을 찾을 수 없습니다.' })
  res.json({ ok: true })
}))

router.post('/accounts/:id/sync', asyncRoute(async (req, res) => {
  let account = await ownedAccount(req.user.id, req.params.id)
  const books = await pool.query('SELECT * FROM contact_addressbooks WHERE account_id=$1 AND user_id=$2 AND selected_for_sync=true', [account.id, req.user.id])
  let imported = 0
  let failed = 0
  try {
    for (const book of books.rows) {
      let remote
      try {
        remote = await listResources(account, book.remote_url)
      } catch (error) {
        if (account.provider !== 'GOOGLE' || error.status !== 401) throw error
        account = await refreshOwnedGoogleAccount(account, true)
        remote = await listResources(account, book.remote_url)
      }
      const seen = []
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        for (const item of remote) {
          const hash = crypto.createHash('sha256').update(item.vcard).digest('hex')
          let parsed
          try {
            parsed = parseVCard(item.vcard)
          } catch {
            await client.query(`INSERT INTO contact_resources
              (tenant_id,user_id,account_id,addressbook_id,remote_href,remote_uid,etag,raw_vcard_encrypted,content_hash,deleted_at,last_seen_at)
              VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,NULL,NOW())
              ON CONFLICT (addressbook_id,remote_href) DO UPDATE SET etag=EXCLUDED.etag,
                raw_vcard_encrypted=EXCLUDED.raw_vcard_encrypted,content_hash=EXCLUDED.content_hash,deleted_at=NULL,last_seen_at=NOW(),updated_at=NOW()`,
            [account.tenant_id, req.user.id, account.id, book.id, item.href, item.etag || null, encryptSecret(item.vcard), hash])
            seen.push(item.href); failed += 1
            continue
          }
          const resource = await client.query(`INSERT INTO contact_resources
            (tenant_id,user_id,account_id,addressbook_id,remote_href,remote_uid,etag,raw_vcard_encrypted,content_hash,deleted_at,last_seen_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NOW())
            ON CONFLICT (addressbook_id,remote_href) DO UPDATE SET remote_uid=EXCLUDED.remote_uid,etag=EXCLUDED.etag,
              raw_vcard_encrypted=EXCLUDED.raw_vcard_encrypted,content_hash=EXCLUDED.content_hash,deleted_at=NULL,last_seen_at=NOW(),updated_at=NOW()
            RETURNING id`, [account.tenant_id, req.user.id, account.id, book.id, item.href, parsed.uid || null, item.etag || null, encryptSecret(item.vcard), hash])
          await client.query(`INSERT INTO contacts
            (tenant_id,user_id,contact_resource_id,display_name,given_name,family_name,nickname,organization,department,job_title,birthday,note,emails,phones,addresses,urls,search_text)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
            ON CONFLICT (contact_resource_id) DO UPDATE SET display_name=EXCLUDED.display_name,given_name=EXCLUDED.given_name,
              family_name=EXCLUDED.family_name,nickname=EXCLUDED.nickname,organization=EXCLUDED.organization,department=EXCLUDED.department,
              job_title=EXCLUDED.job_title,birthday=EXCLUDED.birthday,note=EXCLUDED.note,emails=EXCLUDED.emails,phones=EXCLUDED.phones,
              addresses=EXCLUDED.addresses,urls=EXCLUDED.urls,search_text=EXCLUDED.search_text,updated_at=NOW()`, [
            account.tenant_id, req.user.id, resource.rows[0].id, parsed.displayName, parsed.givenName, parsed.familyName, parsed.nickname,
            parsed.organization, parsed.department, parsed.jobTitle, parsed.birthday, parsed.note,
            JSON.stringify(parsed.emails), JSON.stringify(parsed.phones), JSON.stringify(parsed.addresses), JSON.stringify(parsed.urls), parsed.searchText,
          ])
          seen.push(item.href); imported += 1
        }
        if (seen.length) await client.query(`UPDATE contact_resources SET deleted_at=NOW(),updated_at=NOW()
          WHERE addressbook_id=$1 AND user_id=$2 AND deleted_at IS NULL AND NOT (remote_href = ANY($3::text[]))`, [book.id, req.user.id, seen])
        else await client.query('UPDATE contact_resources SET deleted_at=NOW(),updated_at=NOW() WHERE addressbook_id=$1 AND user_id=$2 AND deleted_at IS NULL', [book.id, req.user.id])
        await client.query('UPDATE contact_addressbooks SET last_full_sync_at=NOW(),updated_at=NOW() WHERE id=$1 AND user_id=$2', [book.id, req.user.id])
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    }
    await pool.query(`UPDATE contact_accounts SET status='CONNECTED',last_sync_at=NOW(),last_success_at=NOW(),last_error_message_safe=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2`, [account.id, req.user.id])
    res.json({ ok: true, imported, failed })
  } catch (error) {
    const status = account.provider === 'GOOGLE' && error.status === 401 ? 'AUTH_REQUIRED' : 'SYNC_ERROR'
    await pool.query(`UPDATE contact_accounts SET status=$1,last_sync_at=NOW(),last_error_message_safe=$2,updated_at=NOW() WHERE id=$3 AND user_id=$4`, [status, String(error.message).slice(0, 300), account.id, req.user.id])
    throw error
  }
}))

router.get('/contacts', asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase()
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100))
  const offset = Math.max(0, Number(req.query.offset) || 0)
  const values = [req.user.id, tenantFor(req.user.id)]
  let filter = ''
  if (q) { values.push(`%${q}%`); filter = ` AND c.search_text LIKE $${values.length}` }
  const countValues = [...values]
  const countResult = await pool.query(`SELECT COUNT(*)::int AS total
    FROM contacts c JOIN contact_resources r ON r.id=c.contact_resource_id AND r.deleted_at IS NULL
    WHERE c.user_id=$1 AND c.tenant_id=$2${filter}`, countValues)
  values.push(limit, offset)
  const { rows } = await pool.query(`SELECT c.*,r.etag,r.remote_uid,a.provider, a.display_name AS account_name, b.remote_display_name AS addressbook_name
    FROM contacts c JOIN contact_resources r ON r.id=c.contact_resource_id AND r.deleted_at IS NULL
    JOIN contact_accounts a ON a.id=r.account_id JOIN contact_addressbooks b ON b.id=r.addressbook_id
    WHERE c.user_id=$1 AND c.tenant_id=$2${filter}
    ORDER BY CASE
      WHEN NULLIF(BTRIM(COALESCE(NULLIF(c.family_name,''),c.display_name)),'') IS NULL THEN 3
      WHEN COALESCE(NULLIF(c.family_name,''),c.display_name) ~ '^[가-힣]' THEN 1
      WHEN COALESCE(NULLIF(c.family_name,''),c.display_name) ~ '^[A-Za-z]' THEN 2
      ELSE 0
    END,
    LOWER(COALESCE(NULLIF(c.family_name,''),c.display_name)) COLLATE "C",
    LOWER(c.display_name) COLLATE "C",c.created_at,c.id
    LIMIT $${values.length - 1} OFFSET $${values.length}`, values)
  const total = countResult.rows[0]?.total || 0
  res.json({ contacts: rows.map(safeContact), limit, offset, total, hasMore: offset + rows.length < total })
}))

router.get('/contacts/:id', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(`SELECT c.*,r.etag,r.remote_uid,a.provider,a.display_name AS account_name,b.remote_display_name AS addressbook_name
    FROM contacts c JOIN contact_resources r ON r.id=c.contact_resource_id AND r.deleted_at IS NULL
    JOIN contact_accounts a ON a.id=r.account_id JOIN contact_addressbooks b ON b.id=r.addressbook_id
    WHERE c.id=$1 AND c.user_id=$2 AND c.tenant_id=$3`, [req.params.id, req.user.id, tenantFor(req.user.id)])
  if (!rows[0]) return res.status(404).json({ error: '연락처를 찾을 수 없습니다.' })
  res.json(safeContact(rows[0]))
}))

router.patch('/contacts/:id', asyncRoute(async (req, res) => {
  const result = await pool.query(`SELECT c.*,r.remote_href,r.remote_uid,r.etag,r.raw_vcard_encrypted,
      r.account_id,r.addressbook_id,b.remote_url,b.remote_display_name AS addressbook_name,
      a.provider,a.user_id,a.tenant_id,a.display_name AS account_name
    FROM contacts c JOIN contact_resources r ON r.id=c.contact_resource_id AND r.deleted_at IS NULL
    JOIN contact_addressbooks b ON b.id=r.addressbook_id JOIN contact_accounts a ON a.id=r.account_id
    WHERE c.id=$1 AND c.user_id=$2 AND c.tenant_id=$3`, [req.params.id, req.user.id, tenantFor(req.user.id)])
  const row = result.rows[0]
  if (!row) return res.status(404).json({ error: '연락처를 찾을 수 없습니다.' })
  if (!canEditContact(row)) return res.status(403).json({ error: 'Google 또는 iCloud 주소록의 저장된 연락처만 편집할 수 있습니다.', code: 'CONTACT_EDIT_NOT_ALLOWED' })
  const submittedEtag = String(req.body?.etag || '').trim()
  if (!submittedEtag || submittedEtag !== row.etag) return res.status(409).json({ error: '연락처가 변경되었습니다. 새로고침 후 다시 시도해 주세요.', code: 'CONTACT_ETAG_STALE' })
  const fields = validateContactEdit(req.body)
  const desiredVCard = updateVCard(decryptSecret(row.raw_vcard_encrypted), fields)
  const resourceUrl = new URL(row.remote_href, row.remote_url).toString()
  let account = await ownedAccount(req.user.id, row.account_id)
  const put = async () => updateResource(account, resourceUrl, desiredVCard, row.etag)
  try {
    await put()
  } catch (error) {
    if (row.provider === 'GOOGLE' && error.status === 401) {
      account = await refreshOwnedGoogleAccount(account, true)
      await put()
    } else if (error.status === 412) {
      const latest = await getResource(account, resourceUrl)
      const latestEtag = latest.headers.get('etag') || row.etag
      const current = await persistContactSnapshot({ contactId: row.id, resourceId: row.contact_resource_id, userId: req.user.id,
        provider: row.provider, remoteUid: row.remote_uid, vcard: latest.xml, etag: latestEtag,
        accountName: row.account_name, addressbookName: row.addressbook_name })
      return res.status(409).json({ error: `${row.provider === 'APPLE' ? 'iCloud' : 'Google'} 주소록에서 같은 연락처가 먼저 변경되었습니다. 최신 내용을 불러왔으니 확인 후 다시 시도해 주세요.`, code: 'CONTACT_EDIT_CONFLICT', current })
    } else throw error
  }
  const confirmed = await getResource(account, resourceUrl)
  const confirmedVCard = confirmed.xml
  const confirmedEtag = confirmed.headers.get('etag') || row.etag
  res.json(await persistContactSnapshot({ contactId: row.id, resourceId: row.contact_resource_id, userId: req.user.id,
    provider: row.provider, remoteUid: row.remote_uid, vcard: confirmedVCard, etag: confirmedEtag,
    accountName: row.account_name, addressbookName: row.addressbook_name }))
}))

router.use((error, _req, res, _next) => {
  console.error('[ContactBook]', error?.message || error)
  const status = Number(error?.status) || 500
  const safeMessage = status >= 500 ? 'ContactBook 처리 중 오류가 발생했습니다.' : error.message
  res.status(status).json({ error: safeMessage })
})

module.exports = router
