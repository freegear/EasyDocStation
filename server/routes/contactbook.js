const express = require('express')
const crypto = require('crypto')
const pool = require('../db')
const requireAuth = require('../middleware/auth')
const { encryptSecret, decryptSecret } = require('../lib/secrets')
const { discover, listResources } = require('../contactbook/carddav')
const { parseVCard } = require('../contactbook/vcard')

const router = express.Router()
router.use(requireAuth)

const tenantFor = userId => `personal:${userId}`
function safeAccount(row) {
  const { credential_encrypted, username, ...safe } = row
  return safe
}
async function ownedAccount(userId, accountId) {
  const { rows } = await pool.query('SELECT * FROM contact_accounts WHERE id=$1 AND user_id=$2 AND tenant_id=$3', [accountId, userId, tenantFor(userId)])
  if (!rows[0]) { const error = new Error('주소록 계정을 찾을 수 없습니다.'); error.status = 404; throw error }
  return { ...rows[0], secret: decryptSecret(rows[0].credential_encrypted) }
}
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
  const result = await pool.query('DELETE FROM contact_accounts WHERE id=$1 AND user_id=$2 AND tenant_id=$3', [req.params.id, req.user.id, tenantFor(req.user.id)])
  if (!result.rowCount) return res.status(404).json({ error: '주소록 계정을 찾을 수 없습니다.' })
  res.json({ ok: true })
}))

router.post('/accounts/:id/sync', asyncRoute(async (req, res) => {
  const account = await ownedAccount(req.user.id, req.params.id)
  const books = await pool.query('SELECT * FROM contact_addressbooks WHERE account_id=$1 AND user_id=$2 AND selected_for_sync=true', [account.id, req.user.id])
  let imported = 0
  try {
    for (const book of books.rows) {
      const remote = await listResources(account, book.remote_url)
      const seen = []
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        for (const item of remote) {
          const parsed = parseVCard(item.vcard)
          const hash = crypto.createHash('sha256').update(item.vcard).digest('hex')
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
    res.json({ ok: true, imported })
  } catch (error) {
    await pool.query(`UPDATE contact_accounts SET status='SYNC_ERROR',last_sync_at=NOW(),last_error_message_safe=$1,updated_at=NOW() WHERE id=$2 AND user_id=$3`, [String(error.message).slice(0, 300), account.id, req.user.id])
    throw error
  }
}))

router.get('/contacts', asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase()
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))
  const offset = Math.max(0, Number(req.query.offset) || 0)
  const values = [req.user.id, tenantFor(req.user.id)]
  let filter = ''
  if (q) { values.push(`%${q}%`); filter = ` AND c.search_text LIKE $${values.length}` }
  values.push(limit, offset)
  const { rows } = await pool.query(`SELECT c.*, a.provider, a.display_name AS account_name, b.remote_display_name AS addressbook_name
    FROM contacts c JOIN contact_resources r ON r.id=c.contact_resource_id AND r.deleted_at IS NULL
    JOIN contact_accounts a ON a.id=r.account_id JOIN contact_addressbooks b ON b.id=r.addressbook_id
    WHERE c.user_id=$1 AND c.tenant_id=$2${filter} ORDER BY NULLIF(c.display_name,''),c.created_at
    LIMIT $${values.length - 1} OFFSET $${values.length}`, values)
  res.json({ contacts: rows, limit, offset })
}))

router.get('/contacts/:id', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(`SELECT c.*,a.provider,a.display_name AS account_name,b.remote_display_name AS addressbook_name
    FROM contacts c JOIN contact_resources r ON r.id=c.contact_resource_id AND r.deleted_at IS NULL
    JOIN contact_accounts a ON a.id=r.account_id JOIN contact_addressbooks b ON b.id=r.addressbook_id
    WHERE c.id=$1 AND c.user_id=$2 AND c.tenant_id=$3`, [req.params.id, req.user.id, tenantFor(req.user.id)])
  if (!rows[0]) return res.status(404).json({ error: '연락처를 찾을 수 없습니다.' })
  res.json(rows[0])
}))

router.use((error, _req, res, _next) => {
  console.error('[ContactBook]', error?.message || error)
  const status = Number(error?.status) || 500
  const safeMessage = status >= 500 ? 'ContactBook 처리 중 오류가 발생했습니다.' : error.message
  res.status(status).json({ error: safeMessage })
})

module.exports = router
