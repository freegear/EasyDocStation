const express = require('express')
const crypto = require('crypto')
const requireAuth = require('../middleware/auth')
const { getMailStorage } = require('../mail/storage')
const repo = require('../mail/repository')
const { syncGmailAccount } = require('../mail/gmailSync')
const {
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  getGoogleUserInfo,
  getGmailProfile,
} = require('../mail/gmailOAuth')
const {
  SETTING_KEYS,
  getPublicMailSettings,
  upsertMailSetting,
} = require('../mail/settings')

const router = express.Router()

// 라우트는 HTTP/권한/검증만 담당하고, DB 접근은 모두 mailRepository(repo)에 위임한다.
// (설계 원칙 #3: SQL을 라우트에 흩뿌리지 않는다)

function isSiteAdmin(req) {
  return req.user?.role === 'site_admin'
}

function getClientOrigin() {
  return String(process.env.CLIENT_ORIGIN || 'http://localhost:5173').replace(/\/+$/, '')
}

function redirectToMail(res, params = {}) {
  const url = new URL(getClientOrigin())
  url.searchParams.set('mail', params.status || 'connected')
  if (params.error) url.searchParams.set('mailError', params.error)
  return res.redirect(url.toString())
}

function requireSiteAdmin(req, res) {
  if (isSiteAdmin(req)) return true
  res.status(403).json({ error: '사이트 관리자 권한이 필요합니다.' })
  return false
}

router.get('/gmail/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '').trim()
    const state = String(req.query.state || '').trim()
    const googleError = String(req.query.error || '').trim()

    if (googleError) return redirectToMail(res, { status: 'error', error: googleError })
    if (!code || !state) return redirectToMail(res, { status: 'error', error: 'missing_code_or_state' })

    const tokens = await exchangeCodeForTokens(code)
    if (!tokens.access_token) throw new Error('Google OAuth 응답에 access_token이 없습니다.')

    const [userInfo, gmailProfile] = await Promise.all([
      getGoogleUserInfo(tokens.access_token).catch(() => ({})),
      getGmailProfile(tokens.access_token).catch(() => ({})),
    ])

    const result = await repo.completeGmailOAuth({ state, tokens, userInfo, gmailProfile })
    if (!result.ok) return redirectToMail(res, { status: 'error', error: result.error })
    return redirectToMail(res, { status: 'connected' })
  } catch (err) {
    if (err.message && err.message.includes('DATA_ENCRYPTION_KEY')) {
      console.error('[Mail Gmail OAuth] DATA_ENCRYPTION_KEY missing:', err.message)
      return redirectToMail(res, { status: 'error', error: 'encryption_key_missing' })
    }
    console.error('[Mail Gmail OAuth] callback failed:', err?.data || err?.message || err)
    return redirectToMail(res, { status: 'error', error: 'gmail_callback_failed' })
  }
})

router.use(requireAuth)

router.get('/gmail/auth-url', async (req, res, next) => {
  try {
    await repo.ensurePersonalTenant(req.user.id)
    await repo.syncTeamTenantsForUser(req.user.id)

    const requestedTenantId = String(req.query.tenantId || '').trim()
    const tenantId = requestedTenantId || `personal-${req.user.id}`
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }

    await repo.cleanupOAuthStates()
    const state = crypto.randomBytes(32).toString('base64url')
    await repo.createOAuthState({
      state,
      provider: 'gmail',
      tenantId,
      userId: req.user.id,
      redirectTo: String(req.query.redirectTo || '') || null,
    })

    res.json({
      authUrl: await buildGoogleAuthUrl({ state }),
      state,
      tenantId,
    })
  } catch (err) {
    next(err)
  }
})

router.get('/settings', async (req, res, next) => {
  try {
    if (!requireSiteAdmin(req, res)) return
    res.json(await getPublicMailSettings())
  } catch (err) {
    next(err)
  }
})

router.put('/settings', async (req, res, next) => {
  try {
    if (!requireSiteAdmin(req, res)) return
    const {
      google_client_id: googleClientId,
      google_client_secret: googleClientSecret,
      google_redirect_uri: googleRedirectUri,
    } = req.body || {}

    await upsertMailSetting({ key: SETTING_KEYS.googleClientId, value: googleClientId, isSecret: false, updatedBy: req.user.id })
    await upsertMailSetting({ key: SETTING_KEYS.googleClientSecret, value: googleClientSecret, isSecret: true, updatedBy: req.user.id })
    await upsertMailSetting({ key: SETTING_KEYS.googleRedirectUri, value: googleRedirectUri, isSecret: false, updatedBy: req.user.id })

    res.json(await getPublicMailSettings())
  } catch (err) {
    next(err)
  }
})

router.get('/tenants', async (req, res, next) => {
  try {
    await repo.ensurePersonalTenant(req.user.id)
    await repo.syncTeamTenantsForUser(req.user.id)
    res.json(await repo.listTenantsForUser({ userId: req.user.id, isSiteAdmin: isSiteAdmin(req) }))
  } catch (err) {
    next(err)
  }
})

router.put('/tenants/:id/storage-mode', async (req, res, next) => {
  try {
    const tenantId = String(req.params.id || '').trim()
    const storageMode = String(req.body?.storage_mode || 'shared_db').trim()
    const dbConnectionKey = String(req.body?.db_connection_key || '').trim() || null

    if (!['shared_db', 'dedicated_db'].includes(storageMode)) {
      return res.status(400).json({ error: 'storage_mode은 shared_db 또는 dedicated_db만 가능합니다.' })
    }
    if (storageMode === 'dedicated_db' && !dbConnectionKey) {
      return res.status(400).json({ error: 'dedicated_db에는 db_connection_key가 필요합니다.' })
    }

    if (!isSiteAdmin(req) && !(await repo.isTenantManager({ userId: req.user.id, tenantId }))) {
      return res.status(403).json({ error: '메일 tenant 관리자 권한이 필요합니다.' })
    }

    const updated = await repo.updateTenantStorageMode({ tenantId, storageMode, dbConnectionKey })
    if (!updated) return res.status(404).json({ error: '메일 tenant를 찾을 수 없습니다.' })
    res.json(updated)
  } catch (err) {
    next(err)
  }
})

router.post('/db-connections', async (req, res, next) => {
  try {
    if (!requireSiteAdmin(req, res)) return
    const connectionKey = String(req.body?.connection_key || '').trim()
    const label = String(req.body?.label || connectionKey).trim()
    const connectionString = String(req.body?.connection_string || '').trim()
    if (!connectionKey || !connectionString) {
      return res.status(400).json({ error: 'connection_key와 connection_string이 필요합니다.' })
    }

    res.json(await repo.upsertDbConnection({ connectionKey, label, connectionString, createdBy: req.user.id }))
  } catch (err) {
    next(err)
  }
})

router.get('/db-connections', async (req, res, next) => {
  try {
    if (!requireSiteAdmin(req, res)) return
    res.json(await repo.listDbConnections())
  } catch (err) {
    next(err)
  }
})

router.get('/accounts', async (req, res, next) => {
  try {
    const tenantId = String(req.query.tenantId || '').trim()
    if (tenantId && !(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    res.json(await repo.listAccounts({ userId: req.user.id, isSiteAdmin: isSiteAdmin(req), tenantId: tenantId || null }))
  } catch (err) {
    next(err)
  }
})

router.post('/accounts/imap', async (req, res, next) => {
  try {
    await repo.ensurePersonalTenant(req.user.id)
    await repo.syncTeamTenantsForUser(req.user.id)

    const body = req.body || {}
    const provider = String(body.provider || 'imap').trim()
    const requestedTenantId = String(body.tenantId || '').trim()
    const tenantId = requestedTenantId || `personal-${req.user.id}`
    const emailAddress = String(body.email_address || '').trim()
    const displayName = String(body.display_name || '').trim()
    const username = String(body.username || emailAddress).trim()
    const password = String(body.password || '').trim()
    const imapHost = String(body.imap_host || '').trim()
    const imapPort = Number.parseInt(body.imap_port, 10)
    const imapSecurity = String(body.imap_security || 'ssl').trim()
    const smtpHost = String(body.smtp_host || '').trim()
    const smtpPort = Number.parseInt(body.smtp_port, 10)
    const smtpSecurity = String(body.smtp_security || 'ssl').trim()

    if (!['naver', 'apple', 'imap', 'other'].includes(provider)) {
      return res.status(400).json({ error: '지원하지 않는 메일 provider입니다.' })
    }
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    if (!emailAddress || !username || !password) {
      return res.status(400).json({ error: '이메일, 사용자 이름, 암호가 필요합니다.' })
    }
    if (!imapHost || !imapPort || !smtpHost || !smtpPort) {
      return res.status(400).json({ error: 'IMAP/SMTP 서버와 포트가 필요합니다.' })
    }
    if (!['ssl', 'starttls', 'none'].includes(imapSecurity) || !['ssl', 'starttls', 'none'].includes(smtpSecurity)) {
      return res.status(400).json({ error: '보안 방식은 ssl, starttls, none 중 하나여야 합니다.' })
    }

    const result = await repo.upsertImapAccount({
      tenantId,
      userId: req.user.id,
      fields: {
        provider,
        emailAddress,
        displayName: displayName || emailAddress,
        username,
        password,
        imapHost,
        imapPort,
        imapSecurity,
        smtpHost,
        smtpPort,
        smtpSecurity,
      },
    })
    res.json({ ok: true, ...result })
  } catch (err) {
    next(err)
  }
})

// 수동 동기화: 해당 계정의 최신 메일을 받아 mail_messages/object 저장소에 적재한다.
router.post('/accounts/:id/sync', async (req, res, next) => {
  try {
    const accountId = String(req.params.id || '').trim()
    const tenantId = String(req.query.tenantId || req.body?.tenantId || '').trim()
    if (!tenantId) return res.status(400).json({ error: 'tenantId가 필요합니다.' })

    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }

    const account = await repo.getAccountForSync({
      tenantId,
      accountId,
      userId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
    })
    if (!account) return res.status(404).json({ error: '메일 계정을 찾을 수 없습니다.' })
    if (account.provider !== 'gmail') {
      return res.status(400).json({ error: `아직 지원하지 않는 provider입니다: ${account.provider}` })
    }

    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || req.body?.limit || '50', 10) || 50))

    await repo.setAccountSyncStatus({ tenantId, accountId, syncStatus: 'syncing' })
    try {
      const summary = await syncGmailAccount({ tenantId, account, limit })
      await repo.setAccountSyncStatus({
        tenantId,
        accountId,
        syncStatus: 'idle',
        lastSyncedAt: new Date(),
        lastError: null,
        status: 'connected',
      })
      res.json({ ok: true, ...summary })
    } catch (syncErr) {
      await repo.setAccountSyncStatus({
        tenantId,
        accountId,
        syncStatus: 'error',
        lastError: syncErr.message,
        status: syncErr.code === 'MAIL_REAUTH_REQUIRED' ? 'error' : undefined,
      })
      if (syncErr.code === 'MAIL_REAUTH_REQUIRED') {
        return res.status(409).json({ error: syncErr.message, code: 'MAIL_REAUTH_REQUIRED' })
      }
      throw syncErr
    }
  } catch (err) {
    next(err)
  }
})

router.get('/storage/info', async (req, res, next) => {
  try {
    const storage = getMailStorage()
    res.json({
      driver: storage.driver,
      basePath: storage.driver === 'local' ? storage.getBasePath() : null,
      objectKeyPattern: 'tenants/{tenant_id}/users/{user_id}/mail/{account_id}/...',
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
