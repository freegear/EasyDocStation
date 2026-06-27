const express = require('express')
const crypto = require('crypto')
const nodemailer = require('nodemailer')
const requireAuth = require('../middleware/auth')
const { buildMailObjectKey, getMailStorage } = require('../mail/storage')
const repo = require('../mail/repository')
const { syncGmailAccount, discoverGmailFolders, syncGmailFolder } = require('../mail/gmailSync')
const { syncImapAccount, listImapFolders, syncImapFolder } = require('../mail/imapSync')
const { decryptSecret } = require('../lib/secrets')

const IMAP_PROVIDERS = ['naver', 'apple', 'imap', 'other']
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

function parseAddressInput(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item || '').trim()).filter(Boolean)
  }
  return String(value || '')
    .split(/[,\n;]/)
    .map(item => item.trim())
    .filter(Boolean)
}

function parseAddressObjects(value) {
  return parseAddressInput(value).map(item => {
    const match = String(item).match(/^(.*?)<([^<>]+)>$/)
    if (match) {
      return {
        name: match[1].replace(/^"|"$/g, '').trim(),
        email: match[2].trim(),
      }
    }
    return { name: '', email: String(item).trim() }
  }).filter(item => item.email)
}

function stripHtmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

// full=true 면 "아직 안 가져온 데이터 전부"를 동기화한다.
function parseFull(req) {
  return /^(1|true|yes|on)$/i.test(String(req.query.full ?? req.body?.full ?? ''))
}

// 계정의 전체 폴더(IMAP 메일함 / Gmail 사용자 라벨)를 발견해 mail_folders에 반영한다.
async function discoverAccountFolders({ tenantId, account }) {
  let folders = []
  if (account.provider === 'gmail') {
    folders = await discoverGmailFolders({ tenantId, account })
  } else if (IMAP_PROVIDERS.includes(account.provider)) {
    folders = await listImapFolders(account)
  }
  await repo.upsertFolders({ tenantId, account, folders })
  return folders
}

// 특정 폴더 1개의 메시지를 on-demand 동기화한다.
async function syncOneFolder({ tenantId, account, folder, limit, full }) {
  if (account.provider === 'gmail') {
    return syncGmailFolder({ tenantId, account, folder, limit, full })
  }
  if (IMAP_PROVIDERS.includes(account.provider)) {
    return syncImapFolder({ tenantId, account, folder, limit, full })
  }
  return { listed: 0, new: 0, saved: 0, failed: 1, errors: [{ id: account.id, error: `지원하지 않는 provider입니다: ${account.provider}` }] }
}

async function syncMailAccount({ tenantId, account, limit, full }) {
  if (account.provider === 'gmail') {
    return syncGmailAccount({ tenantId, account, limit, full })
  }
  if (IMAP_PROVIDERS.includes(account.provider)) {
    return syncImapAccount({ tenantId, account, limit, full })
  }
  return {
    listed: 0,
    new: 0,
    saved: 0,
    failed: 1,
    errors: [{ id: account.id, error: `지원하지 않는 provider입니다: ${account.provider}` }],
  }
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

router.get('/messages', async (req, res, next) => {
  try {
    const tenantId = String(req.query.tenantId || '').trim()
    const accountId = String(req.query.accountId || '').trim()
    const folderId = String(req.query.folderId || '').trim()
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10) || 50))
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0)

    if (!tenantId || !accountId) return res.status(400).json({ error: 'tenantId와 accountId가 필요합니다.' })
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }

    res.json(await repo.listMessages({
      tenantId,
      accountId,
      folderId,
      userId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
      limit,
      offset,
    }))
  } catch (err) {
    next(err)
  }
})

router.get('/messages/:id', async (req, res, next) => {
  try {
    const messageId = String(req.params.id || '').trim()
    const tenantId = String(req.query.tenantId || '').trim()
    if (!messageId || !tenantId) return res.status(400).json({ error: 'messageId와 tenantId가 필요합니다.' })
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }

    const message = await repo.getMessage({
      tenantId,
      messageId,
      userId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
    })
    if (!message) return res.status(404).json({ error: '메일을 찾을 수 없습니다.' })

    const markedRead = !message.is_read
      ? await repo.markMessageRead({
          tenantId,
          messageId,
          userId: req.user.id,
          isSiteAdmin: isSiteAdmin(req),
        })
      : null

    const storage = getMailStorage()
    let bodyHtml = ''
    let bodyText = ''
    if (message.body_html_object_key) {
      bodyHtml = (await storage.getObject(message.body_html_object_key)).toString('utf8')
    }
    if (message.body_text_object_key) {
      bodyText = (await storage.getObject(message.body_text_object_key)).toString('utf8')
    }
    res.json({
      ...message,
      is_read: true,
      read_status_changed: !!markedRead,
      body_html: bodyHtml,
      body_text: bodyText,
    })
  } catch (err) {
    next(err)
  }
})

router.patch('/messages/bulk', async (req, res, next) => {
  try {
    const tenantId = String(req.query.tenantId || req.body?.tenantId || '').trim()
    const action = String(req.body?.action || '').trim()
    const messageIds = Array.isArray(req.body?.messageIds)
      ? [...new Set(req.body.messageIds.map(id => String(id || '').trim()).filter(Boolean))]
      : []
    if (!tenantId || messageIds.length === 0) {
      return res.status(400).json({ error: 'tenantId와 messageIds가 필요합니다.' })
    }
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }

    const results = []
    for (const messageId of messageIds) {
      try {
        let message = null
        if (action === 'mark_unread') {
          message = await repo.updateMessageReadState({
            tenantId,
            messageId,
            userId: req.user.id,
            isSiteAdmin: isSiteAdmin(req),
            isRead: false,
          })
        } else if (action === 'move') {
          const targetFolderId = String(req.body?.targetFolderId || '').trim()
          if (!targetFolderId) return res.status(400).json({ error: 'targetFolderId가 필요합니다.' })
          message = await repo.moveMessageToFolder({
            tenantId,
            messageId,
            targetFolderId,
            userId: req.user.id,
            isSiteAdmin: isSiteAdmin(req),
          })
        } else if (action === 'delete') {
          message = await repo.deleteMessage({
            tenantId,
            messageId,
            userId: req.user.id,
            isSiteAdmin: isSiteAdmin(req),
          })
        } else {
          return res.status(400).json({ error: '지원하지 않는 메일 작업입니다.' })
        }
        results.push({ id: messageId, ok: !!message, message })
      } catch (err) {
        results.push({ id: messageId, ok: false, error: err.message })
      }
    }

    res.json({
      ok: results.some(item => item.ok),
      count: results.filter(item => item.ok).length,
      results,
    })
  } catch (err) {
    next(err)
  }
})

router.patch('/messages/:id', async (req, res, next) => {
  try {
    const messageId = String(req.params.id || '').trim()
    const tenantId = String(req.query.tenantId || req.body?.tenantId || '').trim()
    const action = String(req.body?.action || '').trim()
    if (!messageId || !tenantId) return res.status(400).json({ error: 'messageId와 tenantId가 필요합니다.' })
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }

    if (action === 'mark_unread') {
      const message = await repo.updateMessageReadState({
        tenantId,
        messageId,
        userId: req.user.id,
        isSiteAdmin: isSiteAdmin(req),
        isRead: false,
      })
      if (!message) return res.status(404).json({ error: '메일을 찾을 수 없습니다.' })
      return res.json({ ok: true, message })
    }

    if (action === 'move') {
      const targetFolderId = String(req.body?.targetFolderId || '').trim()
      if (!targetFolderId) return res.status(400).json({ error: 'targetFolderId가 필요합니다.' })
      const message = await repo.moveMessageToFolder({
        tenantId,
        messageId,
        targetFolderId,
        userId: req.user.id,
        isSiteAdmin: isSiteAdmin(req),
      })
      if (!message) return res.status(404).json({ error: '메일 또는 대상 폴더를 찾을 수 없습니다.' })
      return res.json({ ok: true, message })
    }

    if (action === 'delete') {
      const message = await repo.deleteMessage({
        tenantId,
        messageId,
        userId: req.user.id,
        isSiteAdmin: isSiteAdmin(req),
      })
      if (!message) return res.status(404).json({ error: '메일을 찾을 수 없습니다.' })
      return res.json({ ok: true, message })
    }

    return res.status(400).json({ error: '지원하지 않는 메일 작업입니다.' })
  } catch (err) {
    next(err)
  }
})

router.post('/accounts/:id/folders', async (req, res, next) => {
  try {
    const accountId = String(req.params.id || '').trim()
    const tenantId = String(req.query.tenantId || req.body?.tenantId || '').trim()
    const name = String(req.body?.name || '').trim()
    const parentFolderId = String(req.body?.parentFolderId || '').trim()
    if (!accountId || !tenantId || !name) {
      return res.status(400).json({ error: 'accountId, tenantId, name이 필요합니다.' })
    }
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
    const folder = await repo.createFolder({
      tenantId,
      account,
      name,
      parentFolderId: parentFolderId || null,
    })
    res.json({ ok: true, folder })
  } catch (err) {
    next(err)
  }
})

router.patch('/accounts/:id/folders/:folderId', async (req, res, next) => {
  try {
    const accountId = String(req.params.id || '').trim()
    const folderId = String(req.params.folderId || '').trim()
    const tenantId = String(req.query.tenantId || req.body?.tenantId || '').trim()
    if (!accountId || !folderId || !tenantId) {
      return res.status(400).json({ error: 'accountId, folderId, tenantId가 필요합니다.' })
    }
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    const folder = await repo.updateFolderColor({
      tenantId,
      accountId,
      folderId,
      colorKey: req.body?.colorKey,
      userId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
    })
    if (!folder) return res.status(404).json({ error: '폴더를 찾을 수 없습니다.' })
    res.json({ ok: true, folder })
  } catch (err) {
    next(err)
  }
})

router.delete('/accounts/:id/folders/:folderId', async (req, res, next) => {
  try {
    const accountId = String(req.params.id || '').trim()
    const folderId = String(req.params.folderId || '').trim()
    const tenantId = String(req.query.tenantId || req.body?.tenantId || '').trim()
    if (!accountId || !folderId || !tenantId) {
      return res.status(400).json({ error: 'accountId, folderId, tenantId가 필요합니다.' })
    }
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    const folder = await repo.deleteFolder({
      tenantId,
      accountId,
      folderId,
      userId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
    })
    if (!folder) return res.status(404).json({ error: '삭제할 수 있는 사용자 폴더를 찾을 수 없습니다.' })
    res.json({ ok: true, folderId: folder.id })
  } catch (err) {
    next(err)
  }
})

router.delete('/accounts/:id/folders/:folderId/trash', async (req, res, next) => {
  try {
    const accountId = String(req.params.id || '').trim()
    const folderId = String(req.params.folderId || '').trim()
    const tenantId = String(req.query.tenantId || req.body?.tenantId || '').trim()
    if (!accountId || !folderId || !tenantId) {
      return res.status(400).json({ error: 'accountId, folderId, tenantId가 필요합니다.' })
    }
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

    const result = await repo.purgeTrashFolder({
      tenantId,
      accountId,
      folderId,
      userId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
    })
    if (!result) return res.status(404).json({ error: '휴지통 폴더를 찾을 수 없습니다.' })

    await repo.recomputeUsage({ tenantId, accountId, userId: account.user_id })
    res.json({ ok: true, ...result })
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

router.put('/accounts/:id/imap', async (req, res, next) => {
  try {
    const accountId = String(req.params.id || '').trim()
    const body = req.body || {}
    const tenantId = String(body.tenantId || '').trim()
    const emailAddress = String(body.email_address || '').trim()
    const displayName = String(body.display_name || '').trim()
    const username = String(body.username || emailAddress).trim()
    const password = typeof body.password === 'string' ? body.password.trim() : ''
    const imapHost = String(body.imap_host || '').trim()
    const imapPort = Number.parseInt(body.imap_port, 10)
    const imapSecurity = String(body.imap_security || 'ssl').trim()
    const smtpHost = String(body.smtp_host || '').trim()
    const smtpPort = Number.parseInt(body.smtp_port, 10)
    const smtpSecurity = String(body.smtp_security || 'ssl').trim()

    if (!accountId || !tenantId) return res.status(400).json({ error: 'accountId와 tenantId가 필요합니다.' })
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    if (!emailAddress || !username) {
      return res.status(400).json({ error: '이메일과 사용자 이름이 필요합니다.' })
    }
    if (!imapHost || !imapPort || !smtpHost || !smtpPort) {
      return res.status(400).json({ error: 'IMAP/SMTP 서버와 포트가 필요합니다.' })
    }
    if (!['ssl', 'starttls', 'none'].includes(imapSecurity) || !['ssl', 'starttls', 'none'].includes(smtpSecurity)) {
      return res.status(400).json({ error: '보안 방식은 ssl, starttls, none 중 하나여야 합니다.' })
    }

    const updated = await repo.updateImapAccount({
      tenantId,
      accountId,
      userId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
      fields: {
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
    if (!updated) return res.status(404).json({ error: '메일 계정을 찾을 수 없습니다.' })
    res.json({ ok: true, account: updated })
  } catch (err) {
    next(err)
  }
})

router.post('/accounts/:id/send', async (req, res, next) => {
  try {
    const accountId = String(req.params.id || '').trim()
    const body = req.body || {}
    const tenantId = String(body.tenantId || '').trim()
    const to = parseAddressInput(body.to)
    const cc = parseAddressInput(body.cc)
    const bcc = parseAddressInput(body.bcc)
    const subject = String(body.subject || '').trim()
    const html = String(body.html || '').trim()
    const text = String(body.text || '').trim() || stripHtmlToText(html)

    if (!accountId || !tenantId) return res.status(400).json({ error: 'accountId와 tenantId가 필요합니다.' })
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    if (to.length === 0) return res.status(400).json({ error: '받는 사람을 입력해주세요.' })
    if (!subject && !text && !html) return res.status(400).json({ error: '제목 또는 본문을 입력해주세요.' })

    const account = await repo.getAccountForSync({
      tenantId,
      accountId,
      userId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
    })
    if (!account) return res.status(404).json({ error: '메일 계정을 찾을 수 없습니다.' })
    if (!account.smtp_host || !account.smtp_port) {
      return res.status(400).json({ error: 'SMTP 서버 설정이 없습니다.' })
    }
    if (!account.password_encrypted) {
      return res.status(400).json({ error: 'SMTP 전송용 암호가 저장되어 있지 않습니다. 계정 관리에서 앱 비밀번호를 저장해주세요.' })
    }

    const password = decryptSecret(account.password_encrypted)
    const secure = account.smtp_security === 'ssl'
    const transporter = nodemailer.createTransport({
      host: account.smtp_host,
      port: Number(account.smtp_port),
      secure,
      requireTLS: account.smtp_security === 'starttls',
      auth: {
        user: account.username || account.email_address,
        pass: password,
      },
    })

    const fromName = account.display_name || account.email_address
    const from = fromName && fromName !== account.email_address
      ? `"${String(fromName).replace(/"/g, '\\"')}" <${account.email_address}>`
      : account.email_address
    const info = await transporter.sendMail({
      from,
      to,
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
      subject: subject || '(제목 없음)',
      text: text || undefined,
      html: html || undefined,
    })

    res.json({ ok: true, messageId: info.messageId || null, accepted: info.accepted || [] })
  } catch (err) {
    next(err)
  }
})

router.post('/accounts/:id/drafts', async (req, res, next) => {
  try {
    const accountId = String(req.params.id || '').trim()
    const body = req.body || {}
    const tenantId = String(body.tenantId || '').trim()
    const draftId = String(body.draftId || '').trim()
    const to = parseAddressObjects(body.to)
    const cc = parseAddressObjects(body.cc)
    const bcc = parseAddressObjects(body.bcc)
    const subject = String(body.subject || '').trim()
    const html = String(body.html || '').trim()
    const text = String(body.text || '').trim() || stripHtmlToText(html)

    if (!accountId || !tenantId) return res.status(400).json({ error: 'accountId와 tenantId가 필요합니다.' })
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    if (!subject && !text && !html && to.length === 0 && cc.length === 0 && bcc.length === 0) {
      return res.status(400).json({ error: '임시 저장할 내용이 없습니다.' })
    }

    const account = await repo.getAccountForSync({
      tenantId,
      accountId,
      userId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
    })
    if (!account) return res.status(404).json({ error: '메일 계정을 찾을 수 없습니다.' })

    let providerMessageId = `local-draft-${crypto.randomUUID()}`
    if (draftId) {
      const existing = await repo.getMessage({
        tenantId,
        messageId: draftId,
        userId: req.user.id,
        isSiteAdmin: isSiteAdmin(req),
      })
      if (existing?.provider_message_id && existing.account_id === account.id) {
        providerMessageId = existing.provider_message_id
      }
    }

    const storage = getMailStorage()
    const bodyTextKey = buildMailObjectKey({
      storagePrefix: account.storage_prefix,
      tenantId,
      userId: account.user_id,
      accountId: account.id,
      providerMessageId,
      suffix: 'body.txt',
    })
    const bodyHtmlKey = buildMailObjectKey({
      storagePrefix: account.storage_prefix,
      tenantId,
      userId: account.user_id,
      accountId: account.id,
      providerMessageId,
      suffix: 'body.html',
    })
    await storage.saveObject(bodyTextKey, Buffer.from(text || '', 'utf8'))
    await storage.saveObject(bodyHtmlKey, Buffer.from(html || '', 'utf8'))

    const snippet = (text || stripHtmlToText(html) || subject || '').slice(0, 240)
    const draft = await repo.saveDraftMessage({
      tenantId,
      account,
      draftId,
      providerMessageId,
      subject,
      to,
      cc,
      bcc,
      snippet,
      objectKeys: { bodyText: bodyTextKey, bodyHtml: bodyHtmlKey },
      sizeBytes: Buffer.byteLength(text || '', 'utf8') + Buffer.byteLength(html || '', 'utf8'),
    })
    await repo.recomputeUsage({ tenantId, accountId: account.id, userId: account.user_id }).catch(() => {})
    res.json({ ok: true, draft })
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
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || req.body?.limit || '50', 10) || 50))

    await repo.setAccountSyncStatus({ tenantId, accountId, syncStatus: 'syncing' })
    try {
      const summary = await syncMailAccount({ tenantId, account, limit, full: parseFull(req) })
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

// 폴더 목록 발견/갱신 (IMAP 메일함 / Gmail 사용자 라벨 → mail_folders)
router.post('/accounts/:id/folders/sync', async (req, res, next) => {
  try {
    const accountId = String(req.params.id || '').trim()
    const tenantId = String(req.query.tenantId || req.body?.tenantId || '').trim()
    if (!tenantId) return res.status(400).json({ error: 'tenantId가 필요합니다.' })
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    const account = await repo.getAccountForSync({ tenantId, accountId, userId: req.user.id, isSiteAdmin: isSiteAdmin(req) })
    if (!account) return res.status(404).json({ error: '메일 계정을 찾을 수 없습니다.' })

    const folders = await discoverAccountFolders({ tenantId, account })
    res.json({ ok: true, count: folders.length, folders })
  } catch (err) {
    next(err)
  }
})

// 특정 폴더 1개의 메시지 on-demand 동기화
router.post('/accounts/:id/folders/:folderId/sync', async (req, res, next) => {
  try {
    const accountId = String(req.params.id || '').trim()
    const folderId = String(req.params.folderId || '').trim()
    const tenantId = String(req.query.tenantId || req.body?.tenantId || '').trim()
    if (!tenantId) return res.status(400).json({ error: 'tenantId가 필요합니다.' })
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    const account = await repo.getAccountForSync({ tenantId, accountId, userId: req.user.id, isSiteAdmin: isSiteAdmin(req) })
    if (!account) return res.status(404).json({ error: '메일 계정을 찾을 수 없습니다.' })
    const folder = await repo.getFolderById({ tenantId, accountId, folderId })
    if (!folder) return res.status(404).json({ error: '폴더를 찾을 수 없습니다.' })

    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || req.body?.limit || '50', 10) || 50))
    await repo.setAccountSyncStatus({ tenantId, accountId, syncStatus: 'syncing' })
    try {
      const summary = await syncOneFolder({ tenantId, account, folder, limit, full: parseFull(req) })
      await repo.setAccountSyncStatus({ tenantId, accountId, syncStatus: 'idle', lastSyncedAt: new Date(), lastError: null, status: 'connected' })
      res.json({ ok: true, folder: { id: folder.id, name: folder.name }, ...summary })
    } catch (syncErr) {
      await repo.setAccountSyncStatus({ tenantId, accountId, syncStatus: 'error', lastError: syncErr.message, status: syncErr.code === 'MAIL_REAUTH_REQUIRED' ? 'error' : undefined })
      if (syncErr.code === 'MAIL_REAUTH_REQUIRED') {
        return res.status(409).json({ error: syncErr.message, code: 'MAIL_REAUTH_REQUIRED' })
      }
      throw syncErr
    }
  } catch (err) {
    next(err)
  }
})

router.post('/sync-all', async (req, res, next) => {
  try {
    await repo.ensurePersonalTenant(req.user.id)
    await repo.syncTeamTenantsForUser(req.user.id)

    const tenantIdFilter = String(req.query.tenantId || req.body?.tenantId || '').trim()
    const full = parseFull(req)
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || req.body?.limit || '50', 10) || 50))
    const accounts = await repo.listAccounts({
      userId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
      tenantId: tenantIdFilter || null,
    })

    const summaries = []
    for (const accountRow of accounts) {
      if (!['gmail', 'naver', 'apple', 'imap', 'other'].includes(accountRow.provider)) continue
      const account = await repo.getAccountForSync({
        tenantId: accountRow.tenant_id,
        accountId: accountRow.id,
        userId: req.user.id,
        isSiteAdmin: isSiteAdmin(req),
      })
      if (!account) continue

      // 폴더 목록도 함께 갱신(실패해도 본문 동기화는 계속)
      try {
        await discoverAccountFolders({ tenantId: account.tenant_id, account })
      } catch (folderErr) {
        console.warn(`[mail] 폴더 발견 실패 (${account.email_address}):`, folderErr.message)
      }

      await repo.setAccountSyncStatus({ tenantId: account.tenant_id, accountId: account.id, syncStatus: 'syncing' })
      try {
        const summary = await syncMailAccount({ tenantId: account.tenant_id, account, limit, full })
        await repo.setAccountSyncStatus({
          tenantId: account.tenant_id,
          accountId: account.id,
          syncStatus: 'idle',
          lastSyncedAt: new Date(),
          lastError: null,
          status: 'connected',
        })
        summaries.push({ accountId: account.id, provider: account.provider, ok: true, ...summary })
      } catch (err) {
        await repo.setAccountSyncStatus({
          tenantId: account.tenant_id,
          accountId: account.id,
          syncStatus: 'error',
          lastError: err.message,
          status: err.code === 'MAIL_REAUTH_REQUIRED' ? 'error' : undefined,
        })
        summaries.push({ accountId: account.id, provider: account.provider, ok: false, error: err.message })
      }
    }

    res.json({ ok: true, accounts: summaries })
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
