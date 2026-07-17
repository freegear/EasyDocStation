const express = require('express')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const nodemailer = require('nodemailer')
const multer = require('multer')
const requireAuth = require('../middleware/auth')
const db = require('../db')
const { client, isConnected } = require('../cassandra')
const { getDatabasePath } = require('../databasePaths')
const { buildMailObjectKey, getMailStorage } = require('../mail/storage')
const repo = require('../mail/repository')
const { ACCESS_DENIED_MESSAGE, canAccessChannel } = require('../lib/channelAccess')
const { syncGmailAccount, discoverGmailFolders, syncGmailFolder } = require('../mail/gmailSync')
const { syncImapAccount, listImapFolders, syncImapFolder } = require('../mail/imapSync')
const { decryptSecret } = require('../lib/secrets')
const { enqueueMessageSynced } = require('../mail/agentic/worker')
const { executeMailClawRuleForMessage, executeMailClawRuleForMessages, getMailClawSummaryStatus } = require('../mail/mailClaw')
const { moveMessageOnProvider } = require('../mail/providerMove')
const { renameFolderOnProvider, deleteFolderOnProvider } = require('../mail/providerRename')
const { summarizeMail, normalizeLanguage } = require('../mail/mailSummary')
const { formatActionTime, upsertMailSummaryActionCalendarEvent } = require('../mail/calendarAction')
const { isAttachmentPreviewCandidate, resolveAttachmentPreview } = require('../mail/attachmentPreview')
const { analyzeMailImages, formatImageAnalysisForSummary } = require('../mail/imageOcr')
const { extractRemoteImageCandidates, fetchRemoteImage } = require('../mail/remoteImages')
const contentDisposition = require('content-disposition')

// 첨부 파일명을 Content-Disposition 헤더로 안전 변환한다.
// content-disposition은 filename에 basename()을 적용하므로, 파일명에 포함된 경로 구분자('/', '\\')를
// 미리 '_'로 바꿔 앞부분이 잘리는 것을 막는다(브라우저도 다운로드 시 '/'를 '_'로 정화한다).
// 라이브러리가 RFC 5987/2231에 맞게 홑따옴표 등 예약문자를 처리하므로 한글 파일명이 깨지지 않는다.
function attachmentDisposition(filename, type) {
  const safeName = String(filename || 'attachment').replace(/[\\/\r\n]/g, '_')
  return contentDisposition(safeName, { type })
}

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
  getAttachmentPolicy,
  serializeAttachmentPolicy,
  updateAttachmentPolicy,
} = require('../mail/settings')

const router = express.Router()

// 라우트는 HTTP/권한/검증만 담당하고, DB 접근은 모두 mailRepository(repo)에 위임한다.
// (설계 원칙 #3: SQL을 라우트에 흩뿌리지 않는다)

function isSiteAdmin(req) {
  return req.user?.role === 'site_admin'
}

function readConfigSafe() {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../config.json'), 'utf8'))
  } catch {
    return {}
  }
}

function getPostAttachmentStorageBase() {
  const storageBase = getDatabasePath(readConfigSafe(), 'ObjectFile Path')
  if (!fs.existsSync(storageBase)) fs.mkdirSync(storageBase, { recursive: true })
  return storageBase
}

function sanitizePostAttachmentFilename(value, fallback = 'attachment') {
  const cleaned = String(value || '')
    .replace(/[\\/]/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
  return cleaned || fallback
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

function serializeMessageSummary(row) {
  if (!row) return { summary: null, summary_meta: null }
  return {
    summary: row.summary_json || null,
    summary_meta: {
      generated_at: row.generated_at || null,
      updated_at: row.updated_at || null,
      summary_version: Number(row.summary_version || 1),
      prompt_version: row.prompt_version || 'mail-summary-json-v1',
      target_language: row.target_language || 'ko',
      source_language: row.source_language || 'unknown',
      translated: !!row.translated,
      pipeline_version: row.pipeline_version || 'mail-summary-pipeline-v2',
      fallback_used: !!row.fallback_used,
      quality_flags: Array.isArray(row.quality_flags) ? row.quality_flags : [],
    },
  }
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

// 첨부파일 정책 (MailService.md 10.8)
// 조회는 인증된 사용자 모두 가능(작성 화면 강제용), 편집은 사이트 관리자만.
router.get('/attachment-policy', async (req, res, next) => {
  try {
    res.json(serializeAttachmentPolicy(await getAttachmentPolicy()))
  } catch (err) {
    next(err)
  }
})

router.put('/attachment-policy', async (req, res, next) => {
  try {
    if (!requireSiteAdmin(req, res)) return
    const policy = await updateAttachmentPolicy({ fields: req.body || {}, updatedBy: req.user.id })
    res.json(serializeAttachmentPolicy(policy))
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

// ===== 스마트 폴더(태그 기반 통합) — MailService.md 13 =========================

// 공용 가드: tenantId 필수 + 접근 권한. 통과 시 tenantId 반환, 실패 시 응답 종료하고 null 반환.
async function requireSmartFolderTenant(req, res) {
  const tenantId = String(req.query.tenantId || req.body?.tenantId || '').trim()
  if (!tenantId) {
    res.status(400).json({ error: 'tenantId가 필요합니다.' })
    return null
  }
  if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
    res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    return null
  }
  return tenantId
}

router.get('/smart-folders', async (req, res, next) => {
  try {
    const tenantId = await requireSmartFolderTenant(req, res)
    if (!tenantId) return
    res.json(await repo.listSmartFolders({ tenantId, userId: req.user.id }))
  } catch (err) {
    next(err)
  }
})

router.post('/smart-folders', async (req, res, next) => {
  try {
    const tenantId = await requireSmartFolderTenant(req, res)
    if (!tenantId) return
    const folder = await repo.createSmartFolder({
      tenantId,
      userId: req.user.id,
      name: req.body?.name,
      colorKey: req.body?.colorKey || req.body?.color_key,
    })
    res.status(201).json(folder)
  } catch (err) {
    next(err)
  }
})

router.patch('/smart-folders/:id', async (req, res, next) => {
  try {
    const tenantId = await requireSmartFolderTenant(req, res)
    if (!tenantId) return
    const folder = await repo.updateSmartFolder({
      tenantId,
      userId: req.user.id,
      id: String(req.params.id || '').trim(),
      name: req.body?.name,
      colorKey: (req.body?.colorKey ?? req.body?.color_key),
    })
    if (!folder) return res.status(404).json({ error: '스마트 폴더를 찾을 수 없습니다.' })
    res.json(folder)
  } catch (err) {
    next(err)
  }
})

router.delete('/smart-folders/:id', async (req, res, next) => {
  try {
    const tenantId = await requireSmartFolderTenant(req, res)
    if (!tenantId) return
    const removed = await repo.deleteSmartFolder({ tenantId, userId: req.user.id, id: String(req.params.id || '').trim() })
    if (!removed) return res.status(404).json({ error: '스마트 폴더를 찾을 수 없습니다.' })
    res.json({ ok: true, id: removed.id })
  } catch (err) {
    next(err)
  }
})

// 태그 부여(드롭/컨텍스트 공용). archive=true면 각 메일을 자기 계정 내 보관함으로도 이동(13.5).
router.post('/smart-folders/:id/messages', async (req, res, next) => {
  try {
    const tenantId = await requireSmartFolderTenant(req, res)
    if (!tenantId) return
    const smartFolderId = String(req.params.id || '').trim()
    const messageIds = Array.isArray(req.body?.messageIds) ? req.body.messageIds : []
    const archive = req.body?.archive === true || req.body?.archive === 'true'
    const result = await repo.tagMessagesToSmartFolder({ tenantId, userId: req.user.id, smartFolderId, messageIds })

    let archived = []
    if (archive && result.tagged.length > 0) {
      archived = await archiveMessagesWithinOwnAccounts({ tenantId, userId: req.user.id, messageIds: result.tagged })
    }
    res.json({ ok: true, tagged: result.tagged, archived })
  } catch (err) {
    next(err)
  }
})

router.delete('/smart-folders/:id/messages', async (req, res, next) => {
  try {
    const tenantId = await requireSmartFolderTenant(req, res)
    if (!tenantId) return
    const smartFolderId = String(req.params.id || '').trim()
    const messageIds = Array.isArray(req.body?.messageIds) ? req.body.messageIds : []
    const result = await repo.untagMessagesFromSmartFolder({ tenantId, userId: req.user.id, smartFolderId, messageIds })
    res.json({ ok: true, untagged: result.untagged })
  } catch (err) {
    next(err)
  }
})

// 시드 마이그레이션(1회, 멱등): 이름-집계 커스텀 폴더 → 동명 스마트 폴더 + 태그.
router.post('/smart-folders/seed', async (req, res, next) => {
  try {
    const tenantId = await requireSmartFolderTenant(req, res)
    if (!tenantId) return
    const result = await repo.seedSmartFoldersFromCustomFolders({ tenantId, userId: req.user.id })
    res.json({ ok: true, ...result })
  } catch (err) {
    next(err)
  }
})

// 이중 휴지통 정리(멱등). 재동기화 전에 실행해야 중복을 막는다. (MailService.md 17)
router.post('/reconcile-trash', async (req, res, next) => {
  try {
    const tenantId = await requireSmartFolderTenant(req, res)
    if (!tenantId) return
    const result = await repo.reconcileTrashFolders({ tenantId, userId: req.user.id })
    res.json({ ok: true, ...result })
  } catch (err) {
    next(err)
  }
})

router.get('/mailclaw/rules', async (req, res, next) => {
  try {
    const tenantId = String(req.query.tenantId || '').trim()
    if (!tenantId) return res.status(400).json({ error: 'tenantId가 필요합니다.' })
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    res.json(await repo.listMailClawRules({ tenantId, userId: req.user.id, isSiteAdmin: isSiteAdmin(req) }))
  } catch (err) {
    next(err)
  }
})

router.post('/mailclaw/rules', async (req, res, next) => {
  try {
    const tenantId = String(req.body?.tenantId || '').trim()
    if (!tenantId) return res.status(400).json({ error: 'tenantId가 필요합니다.' })
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    res.status(201).json(await repo.createMailClawRule({ tenantId, ownerUserId: req.user.id, fields: req.body || {} }))
  } catch (err) {
    next(err)
  }
})

router.post('/mailclaw/trash-rule/register-sender', async (req, res, next) => {
  try {
    const tenantId = String(req.body?.tenantId || '').trim()
    const senderEmail = String(req.body?.senderEmail || '').trim()
    if (!tenantId || !senderEmail) return res.status(400).json({ error: 'tenantId와 senderEmail이 필요합니다.' })
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    const rule = await repo.registerSenderToDefaultMailClawTrashRule({
      tenantId,
      userId: req.user.id,
      senderEmail,
    })
    if (!rule) return res.status(404).json({ error: '휴지통 폴더를 찾을 수 없습니다.' })
    res.json(rule)
  } catch (err) {
    next(err)
  }
})

router.put('/mailclaw/rules/:id', async (req, res, next) => {
  try {
    const tenantId = String(req.body?.tenantId || req.query.tenantId || '').trim()
    const id = String(req.params.id || '').trim()
    if (!tenantId || !id) return res.status(400).json({ error: 'tenantId와 rule id가 필요합니다.' })
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    const rule = await repo.updateMailClawRule({
      tenantId,
      id,
      ownerUserId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
      fields: req.body || {},
    })
    if (!rule) return res.status(404).json({ error: 'MailClaw 규칙을 찾을 수 없습니다.' })
    res.json(rule)
  } catch (err) {
    next(err)
  }
})

router.delete('/mailclaw/rules/:id', async (req, res, next) => {
  try {
    const tenantId = String(req.query.tenantId || req.body?.tenantId || '').trim()
    const id = String(req.params.id || '').trim()
    if (!tenantId || !id) return res.status(400).json({ error: 'tenantId와 rule id가 필요합니다.' })
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    const deleted = await repo.deleteMailClawRule({
      tenantId,
      id,
      ownerUserId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
    })
    if (!deleted) return res.status(404).json({ error: 'MailClaw 규칙을 찾을 수 없습니다.' })
    res.json({ ok: true, id: deleted.id })
  } catch (err) {
    next(err)
  }
})

router.post('/mailclaw/rules/:id/apply-message', async (req, res, next) => {
  try {
    const tenantId = String(req.body?.tenantId || req.query.tenantId || '').trim()
    const ruleId = String(req.params.id || '').trim()
    const messageId = String(req.body?.messageId || '').trim()
    if (!tenantId || !ruleId || !messageId) {
      return res.status(400).json({ error: 'tenantId, rule id, messageId가 필요합니다.' })
    }
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    const result = await executeMailClawRuleForMessage({
      tenantId,
      ruleId,
      messageId,
      userId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
      force: /^(1|true|yes|on)$/i.test(String(req.body?.force || '')),
    })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// 폴더 전체 적용: messageIds 배열을 한 번에 받아 서버측에서 처리하고,
// 진행 상황을 NDJSON(줄 단위 JSON)으로 스트리밍한다.
router.post('/mailclaw/rules/:id/apply-messages', async (req, res) => {
  const tenantId = String(req.body?.tenantId || req.query.tenantId || '').trim()
  const ruleId = String(req.params.id || '').trim()
  const messageIds = Array.isArray(req.body?.messageIds) ? req.body.messageIds : []
  const force = /^(1|true|yes|on)$/i.test(String(req.body?.force || ''))

  try {
    if (!tenantId || !ruleId) return res.status(400).json({ error: 'tenantId와 rule id가 필요합니다.' })
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
  } catch (err) {
    return res.status(500).json({ error: err.message || '적용 준비 중 오류가 발생했습니다.' })
  }

  res.status(200)
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('X-Accel-Buffering', 'no') // nginx 프록시 버퍼링 방지
  res.flushHeaders?.()

  const write = (obj) => {
    if (res.writableEnded) return
    res.write(`${JSON.stringify(obj)}\n`)
  }

  try {
    const summary = await executeMailClawRuleForMessages({
      tenantId,
      ruleId,
      messageIds,
      userId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
      force,
      onProgress: (progress) => write({ type: 'progress', ...progress }),
    })
    write({ type: 'done', ...summary })
  } catch (err) {
    write({ type: 'error', error: err.message || 'MailClaw 적용 중 오류가 발생했습니다.' })
  } finally {
    res.end()
  }
})

// ===== 발신 도메인 파비콘 ==================================================
// 2단계 공개 접미사(eTLD). 여기에 해당하면 등록 도메인은 마지막 3개 라벨로 본다.
// (예: danal.co.kr, foo.co.uk) 없으면 마지막 2개 라벨(zzzz.com)로 본다.
const TWO_LEVEL_TLDS = new Set([
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 're.kr', 'pe.kr', 'ac.kr', 'hs.kr', 'ms.kr', 'es.kr', 'sc.kr', 'kg.kr',
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'net.uk',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'com.br', 'com.tw', 'com.hk', 'com.sg', 'com.mx', 'co.in',
])

// 서브도메인을 등록 도메인(eTLD+1)으로 축약한다.
//   a.b.zzzz.com   -> zzzz.com
//   x.y.danal.co.kr -> danal.co.kr
function registrableDomain(d) {
  const parts = d.split('.').filter(Boolean)
  if (parts.length <= 2) return d
  const lastTwo = parts.slice(-2).join('.')
  if (TWO_LEVEL_TLDS.has(lastTwo)) return parts.slice(-3).join('.')
  return lastTwo
}

// 등록 도메인만으로 해결되지 않는 특수 케이스를 다른 도메인의 파비콘으로 대체한다.
// (키는 등록 도메인 기준. 예: registrar.amazon 은 amazon.com 파비콘을 사용)
const FAVICON_DOMAIN_ALIASES = {
  'registrar.amazon': 'amazon.com',
}

function normalizeFaviconDomain(raw) {
  let d = String(raw || '').trim().toLowerCase()
  if (!d) return ''
  if (d.includes('@')) d = d.split('@').pop()            // 이메일이 통째로 오면 도메인만
  d = d.replace(/^https?:\/\//, '').split('/')[0].split(':')[0]
  // 유효한 공개 도메인만 허용 (이상 입력/내부 호스트 차단)
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return ''
  d = registrableDomain(d)                               // 서브도메인 → 등록 도메인
  if (FAVICON_DOMAIN_ALIASES[d]) d = FAVICON_DOMAIN_ALIASES[d] // 별칭 override
  return d
}

const FAVICON_RETRY_MS = 7 * 24 * 60 * 60 * 1000 // 실패 도메인 재시도 간격
const faviconInFlight = new Map()                // 동일 도메인 동시 요청 dedupe

async function fetchFaviconOnce(host) {
  // Google s2 파비콘 서비스로 대상 사이트의 파비콘을 받아온다.
  // (임의 URL을 직접 호출하지 않으므로 내부망 SSRF 위험이 없다.)
  const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`
  const resp = await fetch(url, { redirect: 'follow' })
  if (!resp.ok) throw new Error(`favicon fetch ${resp.status}`)
  const contentType = resp.headers.get('content-type') || 'image/png'
  if (!/^image\//i.test(contentType)) throw new Error('not an image')
  const buf = Buffer.from(await resp.arrayBuffer())
  if (!buf.length) throw new Error('empty favicon')
  return { contentType, image: buf }
}

async function fetchFaviconFromWeb(domain) {
  // 기본 도메인에서 못 가져오면 www. 접두어를 붙인 주소로 재시도한다.
  // (예: mobilians.co.kr 은 실패하지만 www.mobilians.co.kr 은 성공)
  const candidates = domain.startsWith('www.') ? [domain] : [domain, `www.${domain}`]
  let lastErr
  for (const host of candidates) {
    try {
      return await fetchFaviconOnce(host)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr || new Error('favicon fetch failed')
}

// DB에 등록된 파비콘이 있으면 사용, 없으면 웹에서 받아 DB에 저장 후 사용.
async function resolveDomainFavicon(domain) {
  const existing = await repo.getDomainFavicon(domain)
  if (existing) {
    if (existing.status === 'ok' && existing.image) return existing
    const age = Date.now() - new Date(existing.fetched_at).getTime()
    if (existing.status === 'failed' && age < FAVICON_RETRY_MS) return existing // 음성 캐시
  }
  if (faviconInFlight.has(domain)) return faviconInFlight.get(domain)
  const task = (async () => {
    try {
      const { contentType, image } = await fetchFaviconFromWeb(domain)
      return await repo.upsertDomainFavicon({ domain, contentType, image, status: 'ok' })
    } catch {
      return await repo.upsertDomainFavicon({ domain, status: 'failed' })
    } finally {
      faviconInFlight.delete(domain)
    }
  })()
  faviconInFlight.set(domain, task)
  return task
}

router.get('/favicon', async (req, res) => {
  const domain = normalizeFaviconDomain(req.query.domain)
  if (!domain) return res.status(400).end()
  try {
    const row = await resolveDomainFavicon(domain)
    if (row?.status === 'ok' && row.image) {
      res.setHeader('Content-Type', row.content_type || 'image/png')
      res.setHeader('Cache-Control', 'public, max-age=604800')
      return res.end(row.image)
    }
    return res.status(404).end()
  } catch (err) {
    return res.status(404).end()
  }
})

router.get('/mailclaw/logs', async (req, res, next) => {
  try {
    const tenantId = String(req.query.tenantId || '').trim()
    const ruleId = String(req.query.ruleId || '').trim()
    if (!tenantId) return res.status(400).json({ error: 'tenantId가 필요합니다.' })
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    res.json(await repo.listMailClawExecutionLogs({
      tenantId,
      ruleId: ruleId || null,
      userId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
      limit: req.query.limit,
    }))
  } catch (err) {
    next(err)
  }
})

router.get('/messages/unclassified-count', async (req, res, next) => {
  try {
    const tenantId = String(req.query.tenantId || '').trim()
    if (!tenantId) return res.status(400).json({ error: 'tenantId가 필요합니다.' })
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    res.json(await repo.countUnclassifiedMessages({ tenantId, userId: req.user.id }))
  } catch (err) {
    next(err)
  }
})

router.get('/messages', async (req, res, next) => {
  try {
    const tenantId = String(req.query.tenantId || '').trim()
    const accountId = String(req.query.accountId || '').trim()
    const folderId = String(req.query.folderId || '').trim()
    const scope = String(req.query.scope || '').trim()
    const unifiedKey = String(req.query.unifiedKey || '').trim()
    const folderType = String(req.query.folderType || '').trim()
    const folderName = String(req.query.folderName || '').trim()
    const unreadOnly = /^(1|true|yes|on)$/i.test(String(req.query.unreadOnly || req.query.unread_only || ''))
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10) || 50))
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0)

    if (!tenantId) return res.status(400).json({ error: 'tenantId가 필요합니다.' })
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }

    if (scope === 'unified') {
      return res.json(await repo.listUnifiedMessages({
        tenantId,
        userId: req.user.id,
        isSiteAdmin: isSiteAdmin(req),
        key: unifiedKey,
        folderType,
        folderName,
        unreadOnly,
        limit,
        offset,
      }))
    }

    if (scope === 'smart') {
      const smartFolderId = String(req.query.smartFolderId || '').trim()
      if (!smartFolderId) return res.status(400).json({ error: 'smartFolderId가 필요합니다.' })
      return res.json(await repo.listSmartFolderMessages({
        tenantId,
        userId: req.user.id,
        smartFolderId,
        limit,
        offset,
      }))
    }

    if (!accountId) return res.status(400).json({ error: 'accountId가 필요합니다.' })
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
    const targetLanguage = normalizeLanguage(req.query.targetLanguage || req.query.language || 'ko')
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
    // 첨부 목록 포함 (내부 object_key는 노출하지 않는다)
    const attachmentRows = await repo.listMessageAttachments({ tenantId, messageId })
    const attachments = attachmentRows.map(a => ({
      id: a.id,
      filename: a.filename,
      content_type: a.content_type,
      size_bytes: Number(a.size_bytes) || 0,
      preview_available: isAttachmentPreviewCandidate({ filename: a.filename, contentType: a.content_type }),
    }))
    const savedSummary = await repo.getMessageSummary({
      tenantId,
      messageId,
      userId: req.user.id,
      targetLanguage,
    })
    const summaryPayload = serializeMessageSummary(savedSummary)
    const remoteCandidates = extractRemoteImageCandidates(bodyHtml).filter(item => !item.tracking)
    const savedRemoteHashes = new Set(attachmentRows
      .map(item => String(item.provider_attachment_id || ''))
      .filter(value => value.startsWith('remote:'))
      .map(value => value.slice(7)))
    res.json({
      ...message,
      is_read: true,
      read_status_changed: !!markedRead,
      body_html: bodyHtml,
      body_text: bodyText,
      attachments,
      remote_image_analysis: {
        status: remoteCandidates.length === 0
          ? 'none'
          : remoteCandidates.every(item => savedRemoteHashes.has(item.id)) ? 'completed' : 'approval_required',
        candidateIds: remoteCandidates.filter(item => !savedRemoteHashes.has(item.id)).map(item => item.id),
        candidateCount: remoteCandidates.length,
      },
      ...summaryPayload,
    })
  } catch (err) {
    next(err)
  }
})

router.post('/messages/:id/remote-images/analyze', async (req, res, next) => {
  try {
    const messageId = String(req.params.id || '').trim()
    const tenantId = String(req.body?.tenantId || '').trim()
    const requestedIds = new Set((Array.isArray(req.body?.candidateIds) ? req.body.candidateIds : [])
      .map(value => String(value || '').trim()).filter(Boolean))
    if (!messageId || !tenantId) return res.status(400).json({ error: 'messageId와 tenantId가 필요합니다.' })
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    const message = await repo.getMessage({ tenantId, messageId, userId: req.user.id, isSiteAdmin: isSiteAdmin(req) })
    if (!message) return res.status(404).json({ error: '메일을 찾을 수 없습니다.' })
    if (!message.body_html_object_key) return res.json({ ok: true, analyzed: 0, skipped: 0 })

    const storage = getMailStorage()
    const bodyHtml = (await storage.getObject(message.body_html_object_key)).toString('utf8')
    const candidates = extractRemoteImageCandidates(bodyHtml)
      .filter(item => !item.tracking && (requestedIds.size === 0 || requestedIds.has(item.id)))
    if (requestedIds.size && candidates.length !== requestedIds.size) {
      return res.status(400).json({ error: '메일 본문에 없는 외부 이미지 후보가 포함되었습니다.' })
    }
    const failures = []
    let analyzed = 0
    for (const candidate of candidates.slice(0, 10)) {
      try {
        const fetched = await fetchRemoteImage(candidate.url)
        const contentHash = crypto.createHash('sha256').update(fetched.buffer).digest('hex')
        const objectKey = buildMailObjectKey({
          tenantId,
          userId: message.user_id,
          accountId: message.account_id,
          providerMessageId: message.provider_message_id,
          suffix: `remote-images/${candidate.id}/${contentHash}.${fetched.extension}`,
        })
        await storage.saveObject(objectKey, fetched.buffer)
        await repo.saveRemoteImageAttachment({
          tenantId, message, sourceUrlHash: candidate.id, contentType: fetched.contentType,
          sizeBytes: fetched.buffer.length, objectKey, hostname: fetched.finalHostname,
        })
        analyzed += 1
      } catch (error) {
        failures.push({ candidateId: candidate.id, error: error.message })
      }
    }
    if (!analyzed && failures.length) {
      return res.status(422).json({ error: '외부 이미지를 안전하게 가져오지 못했습니다.', failures })
    }
    res.json({ ok: true, analyzed, failed: failures.length, failures })
  } catch (err) {
    next(err)
  }
})

// MailClaw 같은 백그라운드 작업이 만든 요약을 본문 전체 재조회 없이 확인한다.
router.get('/messages/:id/summary', async (req, res, next) => {
  try {
    const messageId = String(req.params.id || '').trim()
    const tenantId = String(req.query.tenantId || '').trim()
    const targetLanguage = normalizeLanguage(req.query.targetLanguage || req.query.language || 'ko')
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
    const savedSummary = await repo.getMessageSummary({
      tenantId,
      messageId,
      userId: req.user.id,
      targetLanguage,
    })
    const summaryPayload = serializeMessageSummary(savedSummary)
    const automationStatus = savedSummary
      ? null
      : await getMailClawSummaryStatus({ tenantId, messageId })
    res.json({ ...summaryPayload, automationStatus })
  } catch (err) {
    next(err)
  }
})

router.post('/messages/:id/summary', async (req, res, next) => {
  try {
    const messageId = String(req.params.id || '').trim()
    const tenantId = String(req.body?.tenantId || req.query.tenantId || '').trim()
    const targetLanguage = normalizeLanguage(req.body?.targetLanguage || req.query.targetLanguage || req.body?.language || 'ko')
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

    const storage = getMailStorage()
    let bodyText = ''
    if (message.body_text_object_key) {
      bodyText = (await storage.getObject(message.body_text_object_key)).toString('utf8')
    }
    if (!bodyText && message.body_html_object_key) {
      const bodyHtml = (await storage.getObject(message.body_html_object_key)).toString('utf8')
      bodyText = stripHtmlToText(bodyHtml)
    }
    if (!bodyText && !message.snippet && !message.subject) {
      return res.status(400).json({ error: '요약할 메일 내용이 없습니다.' })
    }

    const imageResults = await analyzeMailImages({
      tenantId,
      attachments: await repo.listMessageAttachments({ tenantId, messageId }),
      storage,
      visionModel: req.body?.model,
    })
    const imageAnalysisText = formatImageAnalysisForSummary(imageResults)
    if (imageAnalysisText) {
      bodyText = [bodyText, imageAnalysisText].filter(Boolean).join('\n\n')
    }

    const threadMessages = await repo.listMessageThreadContext({
      tenantId, userId: req.user.id, message, targetLanguage,
    })

    const result = await summarizeMail({
      message,
      bodyText,
      threadMessages,
      model: req.body?.model,
      targetLanguage,
    })
    const savedSummary = await repo.upsertMessageSummary({
      tenantId,
      userId: req.user.id,
      accountId: message.account_id,
      messageId: message.id,
      providerMessageId: message.provider_message_id,
      summary: result.summary,
      rawText: result.rawText || '',
      model: result.model || '',
      promptVersion: 'mail-summary-json-v2',
      targetLanguage: result.targetLanguage || targetLanguage,
      sourceLanguage: result.sourceLanguage || 'unknown',
      translated: !!result.translated,
      translatedText: result.translatedText || '',
      cleanBodyText: result.cleanBodyText || '',
      factList: result.factList || [],
      pipelineVersion: result.pipelineVersion || 'mail-summary-pipeline-v2',
      fallbackUsed: !!result.fallbackUsed,
      qualityFlags: result.qualityFlags || [],
    })
    const summaryPayload = serializeMessageSummary(savedSummary)
    res.json({
      ok: true,
      messageId,
      tenantId,
      ...summaryPayload,
    })
  } catch (err) {
    if (err.message === 'MAIL_TRANSLATION_FAILED') {
      return res.status(502).json({
        error: '메일을 기준 언어로 번역하지 못해 요약을 생성하지 못했습니다.',
      })
    }
    if (err.code === 'ECONNREFUSED' || err.message === 'OLLAMA_TIMEOUT') {
      return res.status(503).json({
        error: 'Ollama 서버 연결에 실패했습니다. 요약 기능을 사용하려면 Ollama 서버 상태를 확인하세요.',
      })
    }
    next(err)
  }
})

router.patch('/messages/:id/summary/action-items/:actionIndex/time', async (req, res, next) => {
  try {
    const messageId = String(req.params.id || '').trim()
    const actionIndex = Number(req.params.actionIndex)
    const tenantId = String(req.body?.tenantId || req.query.tenantId || '').trim()
    const targetLanguage = normalizeLanguage(req.body?.targetLanguage || req.query.targetLanguage || req.body?.language || 'ko')
    const date = String(req.body?.date || '').trim()
    const time = String(req.body?.time || '').trim()
    const isAllDay = req.body?.isAllDay === true || req.body?.isAllDay === 'true'

    if (!messageId || !tenantId) return res.status(400).json({ error: 'messageId와 tenantId가 필요합니다.' })
    if (!Number.isInteger(actionIndex) || actionIndex < 0) {
      return res.status(400).json({ error: '액션 아이템 번호가 올바르지 않습니다.' })
    }
    const actionTime = formatActionTime(date, time, isAllDay)
    if (!actionTime) return res.status(400).json({ error: '날짜와 시간 형식이 올바르지 않습니다.' })
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

    const savedSummary = await repo.getMessageSummary({
      tenantId,
      messageId,
      userId: req.user.id,
      targetLanguage,
    })
    if (!savedSummary?.summary_json) return res.status(404).json({ error: '저장된 요약을 찾을 수 없습니다.' })

    const summary = JSON.parse(JSON.stringify(savedSummary.summary_json || {}))
    if (!Array.isArray(summary.actionItems) || !summary.actionItems[actionIndex]) {
      return res.status(404).json({ error: '액션 아이템을 찾을 수 없습니다.' })
    }

    const previousItem = summary.actionItems[actionIndex]
    const actionItem = typeof previousItem === 'string'
      ? {
          task: previousItem, time: actionTime, date, clockTime: isAllDay ? null : time,
          timeSource: 'user', isAllDay,
          calendarCandidateKey: `mail_summary:${tenantId}:${messageId}:${actionIndex}`,
        }
      : {
          ...previousItem, time: actionTime, date, clockTime: isAllDay ? null : time,
          timeSource: 'user', isAllDay,
          calendarCandidateKey: previousItem.calendarCandidateKey || `mail_summary:${tenantId}:${messageId}:${actionIndex}`,
        }

    let calendarEvent = null
    if (actionItem.calendarEventId) {
      calendarEvent = await upsertMailSummaryActionCalendarEvent({
        userId: req.user.id, message, summaryRow: savedSummary, actionIndex, actionItem,
        date, time, isAllDay, targetLanguage,
      })
      actionItem.calendarEventId = calendarEvent.id
    }
    summary.actionItems[actionIndex] = actionItem

    const updatedSummary = await repo.updateMessageSummaryJson({
      tenantId,
      userId: req.user.id,
      messageId,
      targetLanguage,
      summary,
    })
    const summaryPayload = serializeMessageSummary(updatedSummary)
    res.json({
      ok: true,
      messageId,
      tenantId,
      actionIndex,
      calendarEvent,
      ...summaryPayload,
    })
  } catch (err) {
    if (err.message === 'INVALID_ACTION_ITEM_DATETIME') {
      return res.status(400).json({ error: '날짜와 시간 형식이 올바르지 않습니다.' })
    }
    next(err)
  }
})

router.post('/messages/:id/summary/calendar-event', async (req, res, next) => {
  try {
    const messageId = String(req.params.id || '').trim()
    const tenantId = String(req.body?.tenantId || '').trim()
    const targetLanguage = normalizeLanguage(req.body?.targetLanguage || 'ko')
    const actionIndex = Number(req.body?.actionIndex)
    if (!messageId || !tenantId) return res.status(400).json({ error: 'messageId와 tenantId가 필요합니다.' })
    if (!Number.isInteger(actionIndex) || actionIndex < 0) return res.status(400).json({ error: '액션 아이템 번호가 올바르지 않습니다.' })
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    const message = await repo.getMessage({ tenantId, messageId, userId: req.user.id, isSiteAdmin: isSiteAdmin(req) })
    if (!message) return res.status(404).json({ error: '메일을 찾을 수 없습니다.' })
    const savedSummary = await repo.getMessageSummary({ tenantId, messageId, userId: req.user.id, targetLanguage })
    if (!savedSummary?.summary_json) return res.status(404).json({ error: '저장된 요약을 찾을 수 없습니다.' })
    const summary = JSON.parse(JSON.stringify(savedSummary.summary_json))
    const previousItem = summary.actionItems?.[actionIndex]
    if (!previousItem) return res.status(404).json({ error: '액션 아이템을 찾을 수 없습니다.' })
    const actionItem = typeof previousItem === 'string' ? { task: previousItem, time: '' } : { ...previousItem }
    const parsed = String(actionItem.time || '').match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/)
    if (!parsed) return res.status(400).json({ error: '날짜를 먼저 지정해주세요.' })
    const date = actionItem.date || parsed[1]
    const time = actionItem.clockTime ?? parsed[2] ?? ''
    const isAllDay = actionItem.isAllDay === true || !time
    const calendarEvent = await upsertMailSummaryActionCalendarEvent({
      userId: req.user.id, message, summaryRow: savedSummary, actionIndex, actionItem,
      date, time, isAllDay, targetLanguage,
    })
    actionItem.date = date
    actionItem.clockTime = isAllDay ? null : time
    actionItem.isAllDay = isAllDay
    actionItem.calendarEventId = calendarEvent.id
    actionItem.calendarCandidateKey = calendarEvent.deduplicationKey
    summary.actionItems[actionIndex] = actionItem
    const updatedSummary = await repo.updateMessageSummaryJson({ tenantId, userId: req.user.id, messageId, targetLanguage, summary })
    res.json({ ok: true, calendarEvent, created: true, deduplicationKey: calendarEvent.deduplicationKey, ...serializeMessageSummary(updatedSummary) })
  } catch (err) {
    if (err.message === 'INVALID_ACTION_ITEM_DATETIME') return res.status(400).json({ error: '날짜와 시간 형식이 올바르지 않습니다.' })
    next(err)
  }
})

router.patch('/messages/:id/summary/action-items/:actionIndex/task', async (req, res, next) => {
  try {
    const messageId = String(req.params.id || '').trim()
    const actionIndex = Number(req.params.actionIndex)
    const tenantId = String(req.body?.tenantId || '').trim()
    const targetLanguage = normalizeLanguage(req.body?.targetLanguage || 'ko')
    const task = String(req.body?.task || '').trim()
    if (!messageId || !tenantId) return res.status(400).json({ error: 'messageId와 tenantId가 필요합니다.' })
    if (!Number.isInteger(actionIndex) || actionIndex < 0) return res.status(400).json({ error: '액션 아이템 번호가 올바르지 않습니다.' })
    if (!task) return res.status(400).json({ error: '액션 아이템 내용을 입력해주세요.' })
    if (task.length > 500) return res.status(400).json({ error: '액션 아이템 내용은 500자 이내로 입력해주세요.' })
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    const message = await repo.getMessage({ tenantId, messageId, userId: req.user.id, isSiteAdmin: isSiteAdmin(req) })
    if (!message) return res.status(404).json({ error: '메일을 찾을 수 없습니다.' })
    const savedSummary = await repo.getMessageSummary({ tenantId, messageId, userId: req.user.id, targetLanguage })
    if (!savedSummary?.summary_json) return res.status(404).json({ error: '저장된 요약을 찾을 수 없습니다.' })
    const summary = JSON.parse(JSON.stringify(savedSummary.summary_json))
    const previousItem = summary.actionItems?.[actionIndex]
    if (!previousItem) return res.status(404).json({ error: '액션 아이템을 찾을 수 없습니다.' })
    const actionItem = typeof previousItem === 'string'
      ? { task, time: '' }
      : { ...previousItem, task }
    summary.actionItems[actionIndex] = actionItem
    const updatedSummary = await repo.updateMessageSummaryJson({ tenantId, userId: req.user.id, messageId, targetLanguage, summary })
    let calendarEvent = null
    if (actionItem.calendarEventId) {
      const parsed = String(actionItem.time || '').match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/)
      if (parsed) {
        const date = actionItem.date || parsed[1]
        const time = actionItem.clockTime ?? parsed[2] ?? ''
        const isAllDay = actionItem.isAllDay === true || !time
        calendarEvent = await upsertMailSummaryActionCalendarEvent({
          userId: req.user.id, message, summaryRow: updatedSummary, actionIndex, actionItem,
          date, time, isAllDay, targetLanguage,
        })
      }
    }
    res.json({ ok: true, messageId, actionIndex, calendarEvent, ...serializeMessageSummary(updatedSummary) })
  } catch (err) {
    next(err)
  }
})

// 첨부 다운로드: object_key로 스토리지에서 읽어 스트리밍한다.
router.get('/messages/:id/attachments/:attId', async (req, res, next) => {
  try {
    const messageId = String(req.params.id || '').trim()
    const attachmentId = String(req.params.attId || '').trim()
    const tenantId = String(req.query.tenantId || '').trim()
    if (!messageId || !attachmentId || !tenantId) {
      return res.status(400).json({ error: 'tenantId, messageId, attachmentId가 필요합니다.' })
    }
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    const att = await repo.getMessageAttachment({
      tenantId,
      messageId,
      attachmentId,
      userId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
    })
    if (!att) return res.status(404).json({ error: '첨부파일을 찾을 수 없습니다.' })

    const buffer = await getMailStorage().getObject(att.object_key)
    const filename = att.filename || 'attachment'
    // 비ASCII(한글)·홑따옴표 등 예약문자를 RFC 5987/2231에 맞게 안전 처리 (content-disposition 라이브러리 사용)
    res.setHeader('Content-Type', att.content_type || 'application/octet-stream')
    res.setHeader('Content-Length', buffer.length)
    res.setHeader('Content-Disposition', attachmentDisposition(filename, 'attachment'))
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    return res.end(buffer)
  } catch (err) {
    next(err)
  }
})

// 첨부 미리보기: 실제 파일 signature와 크기를 검사해 안전한 형식만 inline으로 제공한다.
router.get('/messages/:id/attachments/:attId/preview', async (req, res, next) => {
  try {
    const messageId = String(req.params.id || '').trim()
    const attachmentId = String(req.params.attId || '').trim()
    const tenantId = String(req.query.tenantId || '').trim()
    if (!messageId || !attachmentId || !tenantId) {
      return res.status(400).json({ error: 'tenantId, messageId, attachmentId가 필요합니다.' })
    }
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    const att = await repo.getMessageAttachment({
      tenantId,
      messageId,
      attachmentId,
      userId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
    })
    if (!att) return res.status(404).json({ error: '첨부파일을 찾을 수 없습니다.' })

    const buffer = await getMailStorage().getObject(att.object_key)
    const preview = resolveAttachmentPreview({
      buffer,
      filename: att.filename,
      declaredContentType: att.content_type,
    })
    if (!preview.allowed) {
      return res.status(preview.status).json({ error: preview.reason, code: preview.code })
    }

    const filename = att.filename || 'attachment'
    // 비ASCII(한글)·홑따옴표 등 예약문자를 RFC 5987/2231에 맞게 안전 처리 (content-disposition 라이브러리 사용)
    res.setHeader('Content-Type', preview.contentType)
    res.setHeader('Content-Length', preview.buffer.length)
    res.setHeader('Content-Disposition', attachmentDisposition(filename, 'inline'))
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' blob: data:; style-src 'unsafe-inline'; sandbox")
    res.setHeader('X-Mail-Attachment-Preview-Kind', preview.kind)
    return res.end(preview.buffer)
  } catch (err) {
    next(err)
  }
})

// 메일 첨부를 게시글/댓글 첨부로 복사한다. 게시글/댓글 생성 자체는 기존 /posts API가 담당한다.
router.post('/messages/:id/post-attachments', async (req, res, next) => {
  try {
    const messageId = String(req.params.id || '').trim()
    const tenantId = String(req.body?.tenantId || req.query.tenantId || '').trim()
    const channelId = String(req.body?.channelId || '').trim()
    const requestedIds = Array.isArray(req.body?.attachmentIds)
      ? [...new Set(req.body.attachmentIds.map(id => String(id || '').trim()).filter(Boolean))]
      : []

    if (!messageId || !tenantId || !channelId) {
      return res.status(400).json({ error: 'tenantId, channelId, messageId가 필요합니다.' })
    }
    if (requestedIds.length > 10) {
      return res.status(400).json({ error: '첨부파일은 최대 10개까지만 가능합니다.' })
    }
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    if (!(await canAccessChannel(db, req.user, channelId))) {
      return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })
    }

    const message = await repo.getMessage({ tenantId, messageId, userId: req.user.id, isSiteAdmin: isSiteAdmin(req) })
    if (!message) return res.status(404).json({ error: '메일을 찾을 수 없습니다.' })

    const allAttachments = await repo.listMessageAttachments({ tenantId, messageId })
    const selected = requestedIds.length
      ? allAttachments.filter(att => requestedIds.includes(String(att.id)))
      : allAttachments.slice(0, 10)
    if (selected.length !== (requestedIds.length || selected.length)) {
      return res.status(404).json({ error: '복사할 메일 첨부파일을 찾을 수 없습니다.' })
    }
    if (selected.length > 10) {
      return res.status(400).json({ error: '첨부파일은 최대 10개까지만 가능합니다.' })
    }

    const storage = getMailStorage()
    const postStorageBase = getPostAttachmentStorageBase()
    const copied = []
    for (const source of selected) {
      const buffer = await storage.getObject(source.object_key)
      const id = crypto.randomUUID()
      const filename = sanitizePostAttachmentFilename(source.filename, `mail-attachment-${copied.length + 1}`)
      const safeChannelId = sanitizePostAttachmentFilename(channelId, 'unknown')
      const storagePath = path.join(safeChannelId, id, filename)
      const fullPath = path.join(postStorageBase, storagePath)
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true })
      await fs.promises.writeFile(fullPath, buffer)

      const contentType = source.content_type || 'application/octet-stream'
      const size = Number(source.size_bytes) || buffer.length
      if (isConnected()) {
        await client.execute(
          `INSERT INTO attachments (id, filename, content_type, size, status, storage_path, uploader_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, filename, contentType, size, 'COMPLETED', storagePath, req.user.id, new Date()],
          { prepare: true },
        )
      }
      await db.query(
        `INSERT INTO attachments (id, filename, content_type, size, status, storage_path, uploader_id, channel_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [id, filename, contentType, size, 'COMPLETED', storagePath, req.user.id, channelId],
      )
      copied.push({ id, filename, content_type: contentType, size })
    }

    res.json({ attachments: copied })
  } catch (err) {
    next(err)
  }
})

// 메일 이동(컨텍스트 메뉴 '이동' + 드래그&드롭 공통).
// 같은 계정이면 기존대로 폴더만 갱신하고, 다른 계정이면 프로바이더에서 실제 이동 후 계정까지 옮긴다.
// (MailService.md 11.5.1 — 계정 간 이동 정식 지원. 교차 계정은 현재 IMAP↔IMAP만 지원)
async function performMessageMove({ tenantId, messageId, targetFolderId, userId }) {
  const targetFolder = await repo.getFolderByIdForUser({ tenantId, folderId: targetFolderId, userId })
  if (!targetFolder) return null

  const message = await repo.getMessage({ tenantId, messageId, userId })
  if (!message) return null

  // 같은 계정 이동: DB 폴더만 갱신(기존 동작 유지).
  if (!targetFolder.account_id || targetFolder.account_id === message.account_id) {
    return repo.moveMessageToFolder({ tenantId, messageId, targetFolderId: targetFolder.id, userId })
  }

  // 계정 간 이동: 프로바이더에서 실제 이동(복사+원본 정리) 후 로컬 account_id/folder_id를 갱신한다.
  const account = await repo.getAccountForSync({ tenantId, accountId: message.account_id, userId })
  if (!account) return null
  const providerMove = await moveMessageOnProvider({ tenantId, account, message, targetFolder })
  return repo.moveMessageToAccountFolder({
    tenantId,
    messageId,
    targetAccountId: targetFolder.account_id,
    targetFolderId: targetFolder.id,
    userId,
    providerMessageId: providerMove?.providerMessageId,
  })
}

// 메일 삭제 = "계정의 휴지통으로 이동"을 프로바이더에 반영한다. (MailService.md 11 / 16.11)
// 로컬만 삭제하면 서버 INBOX에 원본이 남아 재동기화 시 되살아나므로, IMAP/Gmail에서 실제로
// 휴지통으로 옮겨 서버에서 제거한다. 이미 휴지통이거나 대상이 없으면 로컬 처리로 폴백한다.
async function performMessageDelete({ tenantId, messageId, userId }) {
  const message = await repo.getMessage({ tenantId, messageId, userId })
  if (!message) return null

  const trashFolder = await repo.getFolderByTypeForAccount({ tenantId, accountId: message.account_id, type: 'trash' })
  const account = await repo.getAccountForSync({ tenantId, accountId: message.account_id, userId })

  // 이미 휴지통이거나(=영구삭제 단계, 별도), 휴지통/계정 정보가 없으면 로컬 처리로 폴백.
  const alreadyInTrash = trashFolder && message.folder_id === trashFolder.id
  if (!trashFolder || !account || alreadyInTrash) {
    return repo.deleteMessage({ tenantId, messageId, userId })
  }

  // 프로바이더에서 실제 휴지통 이동(서버 원본 제거). skip되면(로컬 전용 등) 로컬 처리로 폴백.
  let providerMove
  try {
    providerMove = await moveMessageOnProvider({ tenantId, account, message, targetFolder: trashFolder })
  } catch (err) {
    if (err?.code === 'LOCAL_ORPHAN_CANDIDATE') {
      const removed = await repo.softDeleteLocalOrphanMessage({ tenantId, messageId, userId })
      if (removed) {
        console.warn('[mail delete] local orphan removed automatically', {
          tenantId,
          userId,
          messageId,
          reason: 'missing_source_mailbox_and_message_id',
          remoteChanged: false,
        })
      }
      return removed
    }
    if (err?.code === 'IMAP_MESSAGE_NOT_FOUND') {
      console.warn('[mail delete] remote message missing; applying local fallback', {
        tenantId,
        userId,
        messageId,
        code: err.code,
      })
      return repo.deleteMessage({ tenantId, messageId, userId })
    }
    throw err
  }
  if (providerMove?.skipped) {
    return repo.deleteMessage({ tenantId, messageId, userId })
  }

  // 로컬 정합: 휴지통으로 이동 + (IMAP은 UID가 바뀌므로) provider_message_id 갱신.
  const moved = await repo.moveMessageToFolder({
    tenantId,
    messageId,
    targetFolderId: trashFolder.id,
    userId,
    providerMessageId: providerMove?.providerMessageId,
  })
  if (!moved) return null
  // 삭제 결과 형태를 기존 deleteMessage와 맞춘다(프론트 낙관적 갱신 호환).
  return {
    id: moved.id,
    account_id: moved.account_id,
    previous_folder_id: message.folder_id,
    folder_id: moved.folder_id,
    is_read: moved.is_read,
    trash_folder_id: trashFolder.id,
    soft_deleted: false,
  }
}

// 스마트 폴더 아카이브(13.5): 각 메일을 "자기 계정 안의" 보관함(type='archive')으로 이동한다.
// 계정 간 이동(providerMove)은 타지 않는다. 보관함이 없는 계정은 조용히 건너뛴다. 하드 삭제 없음.
async function archiveMessagesWithinOwnAccounts({ tenantId, userId, messageIds }) {
  const archived = []
  const archiveFolderCache = new Map() // account_id -> folder|null
  for (const messageId of messageIds) {
    try {
      const message = await repo.getMessage({ tenantId, messageId, userId })
      if (!message) continue
      let archiveFolder = archiveFolderCache.get(message.account_id)
      if (archiveFolder === undefined) {
        archiveFolder = await repo.getFolderByTypeForAccount({ tenantId, accountId: message.account_id, type: 'archive' })
        archiveFolderCache.set(message.account_id, archiveFolder || null)
      }
      if (!archiveFolder?.id) continue // 보관함 없는 계정은 태그만 유지
      if (message.folder_id === archiveFolder.id) continue // 이미 보관함
      const moved = await performMessageMove({ tenantId, messageId, targetFolderId: archiveFolder.id, userId })
      if (moved) archived.push(messageId)
    } catch (err) {
      // 개별 실패는 건너뛴다(부분 적용 허용). 태그는 이미 부여됨.
      console.warn(`[smart-folder archive] ${messageId} 실패: ${err.message}`)
    }
  }
  return archived
}

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

    // 중요(별표) 토글은 단일 배치 UPDATE로 처리한다. (MailService.md 14.5)
    if (action === 'star' || action === 'unstar') {
      const updated = await repo.setMessagesStarred({
        tenantId,
        userId: req.user.id,
        messageIds,
        starred: action === 'star',
      })
      const okSet = new Set(updated.map(row => String(row.id)))
      return res.json({
        ok: okSet.size > 0,
        count: okSet.size,
        results: messageIds.map(id => ({ id, ok: okSet.has(String(id)) })),
      })
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
          message = await performMessageMove({
            tenantId,
            messageId,
            targetFolderId,
            userId: req.user.id,
          })
        } else if (action === 'delete') {
          message = await performMessageDelete({
            tenantId,
            messageId,
            userId: req.user.id,
          })
        } else {
          return res.status(400).json({ error: '지원하지 않는 메일 작업입니다.' })
        }
        if (action === 'delete' && !message) {
          console.warn('[mail delete] failed', {
            tenantId,
            userId: req.user.id,
            messageId,
            code: 'message_not_found_or_not_deleted',
            error: '메일을 찾을 수 없거나 삭제 결과가 반환되지 않았습니다.',
          })
        }
        results.push({ id: messageId, ok: !!message, message })
      } catch (err) {
        if (action === 'delete') {
          console.warn('[mail delete] failed', {
            tenantId,
            userId: req.user.id,
            messageId,
            code: err?.code || 'delete_failed',
            error: err?.message || '알 수 없는 삭제 오류',
          })
        }
        results.push({
          id: messageId,
          ok: false,
          error: err?.message || '알 수 없는 삭제 오류',
          code: err?.code || 'delete_failed',
          canDeleteLocally: err?.code === 'LOCAL_ORPHAN_CANDIDATE',
        })
      }
    }

    if (action === 'delete') {
      const failed = results.filter(item => !item.ok)
      if (failed.length > 0) {
        console.warn('[mail delete] bulk completed', {
          tenantId,
          userId: req.user.id,
          requested: results.length,
          succeeded: results.length - failed.length,
          failed: failed.length,
        })
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
      const message = await performMessageMove({
        tenantId,
        messageId,
        targetFolderId,
        userId: req.user.id,
      })
      if (!message) return res.status(404).json({ error: '메일 또는 대상 폴더를 찾을 수 없습니다.' })
      return res.json({ ok: true, message })
    }

    if (action === 'delete') {
      const message = await performMessageDelete({
        tenantId,
        messageId,
        userId: req.user.id,
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
    // 앱에서 만드는 폴더는 기본적으로 로컬 전용(서버 IMAP 미동기화)이다.
    const isLocal = req.body?.isLocal === undefined ? true : !!req.body.isLocal
    const folder = await repo.createFolder({
      tenantId,
      account,
      name,
      parentFolderId: parentFolderId || null,
      isLocal,
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

    // 이름 변경 요청이면 먼저 처리한다. (MailService.md 16)
    let folder = null
    if (req.body?.name !== undefined) {
      const newName = String(req.body.name || '').trim()
      if (!newName) return res.status(400).json({ error: '폴더 이름을 입력하세요.' })
      if (newName.length > 225) return res.status(400).json({ error: '폴더 이름이 너무 깁니다. (최대 225자)' })
      if (/[\r\n\t\x00-\x1f]/.test(newName)) return res.status(400).json({ error: '폴더 이름에 사용할 수 없는 문자가 있습니다.' })

      const current = await repo.getFolderById({ tenantId, accountId, folderId })
      if (!current) return res.status(404).json({ error: '폴더를 찾을 수 없습니다.' })
      if (current.type !== 'custom') {
        return res.status(409).json({ error: '시스템 폴더는 이름을 변경할 수 없습니다.' })
      }
      if (await repo.folderNameExists({ tenantId, accountId, name: newName, excludeFolderId: folderId })) {
        return res.status(409).json({ error: '같은 이름의 폴더가 이미 있습니다.' })
      }

      // 로컬 전용 폴더는 DB만, 프로바이더 폴더는 프로바이더 먼저 변경 후 로컬 정합.
      let providerFolderId = ''
      if (!current.is_local) {
        const account = await repo.getAccountForSync({
          tenantId,
          accountId,
          userId: req.user.id,
          isSiteAdmin: isSiteAdmin(req),
        })
        if (!account) return res.status(404).json({ error: '메일 계정을 찾을 수 없습니다.' })
        const applied = await renameFolderOnProvider({ tenantId, account, folder: current, newName })
        if (applied && applied.skipped) {
          return res.status(400).json({ error: '이 계정 유형은 폴더 이름 변경을 지원하지 않습니다.' })
        }
        providerFolderId = applied?.providerFolderId || ''
      }

      folder = await repo.renameFolder({
        tenantId,
        accountId,
        folderId,
        name: newName,
        providerFolderId,
        userId: req.user.id,
      })
      if (!folder) return res.status(404).json({ error: '이름을 변경할 수 있는 사용자 폴더를 찾을 수 없습니다.' })
    }

    // 색상 변경 요청이 함께/단독으로 오면 처리한다.
    if (req.body?.colorKey !== undefined) {
      folder = await repo.updateFolderColor({
        tenantId,
        accountId,
        folderId,
        colorKey: req.body.colorKey,
        userId: req.user.id,
        isSiteAdmin: isSiteAdmin(req),
      })
    }

    if (!folder) return res.status(400).json({ error: '변경할 내용이 없습니다. (name 또는 colorKey 필요)' })
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

    const current = await repo.getFolderById({ tenantId, accountId, folderId })
    if (!current) return res.status(404).json({ error: '삭제할 수 있는 사용자 폴더를 찾을 수 없습니다.' })
    if (current.type !== 'custom') {
      return res.status(409).json({ error: '시스템 폴더는 삭제할 수 없습니다.' })
    }

    // 로컬 전용 폴더는 로컬만, 프로바이더 폴더는 프로바이더 먼저 삭제 후 로컬 정합. (MailService.md 16.11)
    // Gmail(라벨 삭제, 비파괴): 메일 보존. IMAP(메일함 삭제, 파괴적): 로컬 메일 행도 삭제.
    let destructive = false
    if (!current.is_local) {
      const account = await repo.getAccountForSync({
        tenantId,
        accountId,
        userId: req.user.id,
        isSiteAdmin: isSiteAdmin(req),
      })
      if (!account) return res.status(404).json({ error: '메일 계정을 찾을 수 없습니다.' })
      const applied = await deleteFolderOnProvider({ tenantId, account, folder: current })
      if (applied && applied.rejected) {
        // 서버가 삭제를 거부(예약 메일함 등)한 경우: 500 대신 명확한 안내를 준다.
        // 서버 거부(server_rejected)는 학습해 두었다가 이후 UI에서 삭제 메뉴를 막는다.
        // (has_children은 하위 폴더 정리 후 삭제 가능하므로 학습하지 않는다.)
        if (applied.reason === 'server_rejected') {
          await repo.setFolderDeletable({ tenantId, accountId, folderId, deletable: false }).catch(() => {})
        }
        // reason을 함께 내려 프론트가 영구 거부(server_rejected)와 하위 정리로 풀리는(has_children)을 구분한다.
        return res.status(409).json({
          error: applied.message || '이 메일함은 서버에서 삭제할 수 없습니다.',
          reason: applied.reason || 'server_rejected',
          children: applied.children || [],
        })
      }
      if (applied && applied.skipped) {
        return res.status(400).json({ error: '이 계정 유형은 폴더 삭제를 지원하지 않습니다.' })
      }
      destructive = !!applied?.destructive
    }

    const folder = await repo.deleteFolder({
      tenantId,
      accountId,
      folderId,
      userId: req.user.id,
      purgeMessages: destructive,
    })
    if (!folder) return res.status(404).json({ error: '삭제할 수 있는 사용자 폴더를 찾을 수 없습니다.' })

    await repo.recomputeUsage({ tenantId, accountId, userId: req.user.id }).catch(() => {})
    res.json({ ok: true, folderId: folder.id, purgedMessages: folder.purgedCount || 0, destructive })
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

// 계정 연결 해제(삭제): 소유자(또는 site_admin)만. mail_accounts row + 동기화 데이터 + 디스크 객체 제거.
router.delete('/accounts/:id', async (req, res, next) => {
  try {
    const accountId = String(req.params.id || '').trim()
    const tenantId = String(req.query.tenantId || req.body?.tenantId || '').trim()
    if (!accountId || !tenantId) return res.status(400).json({ error: 'accountId와 tenantId가 필요합니다.' })
    if (!(await repo.canAccessTenant({ userId: req.user.id, tenantId, isSiteAdmin: isSiteAdmin(req) }))) {
      return res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
    }
    const result = await repo.deleteAccount({
      tenantId,
      accountId,
      userId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
    })
    if (!result) return res.status(404).json({ error: '메일 계정을 찾을 수 없습니다.' })
    res.json({ ok: true, deleted: result })
  } catch (err) {
    next(err)
  }
})

// 메일 보내기 첨부: multipart/form-data 를 메모리에 받는다.
// 상한값은 첨부 정책(MailService.md 10.8)에서 요청 시점에 읽어 동적으로 적용한다.

// multer는 파일명을 latin1로 디코딩하므로 UTF-8(한글)로 복원한다.
function decodeMulterFilename(name) {
  try {
    return Buffer.from(String(name || ''), 'latin1').toString('utf8')
  } catch {
    return String(name || '')
  }
}

function fileExtensionOf(filename) {
  const m = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${n}B`
}

// SMTP 타임아웃 (MailService.md 10.9). 네트워크 정지 시 무한 대기 대신 명확히 실패시킨다.
const SMTP_CONNECTION_TIMEOUT_MS = 15 * 1000  // TCP 연결 수립
const SMTP_GREETING_TIMEOUT_MS = 15 * 1000    // 서버 인사(220) 대기
const SMTP_SOCKET_TIMEOUT_MS = 60 * 1000      // 데이터 전송 중 무응답 (대용량 업로드 고려)

// nodemailer 전송 오류를 사용자 친화적 상태코드/메시지로 변환한다. (MailService.md 10.9)
function mapSmtpSendError(err, policy) {
  const code = err.code || ''
  const responseCode = err.responseCode || 0
  // 메시지 크기 초과: Gmail 등은 552-5.3.4 로 거부한다.
  if (code === 'EMESSAGE' || responseCode === 552 || /size limit|exceeded .*size|too large/i.test(err.message || '')) {
    const cap = policy ? `약 ${policy.maxTotalMb}MB` : '약 25MB'
    return { status: 413, message: `메일 크기가 메일 제공자 한도를 초과했습니다. 첨부 용량을 줄여주세요. (제공자 한도는 인코딩 포함이라 원본 기준 ${cap}보다 작아야 할 수 있습니다)` }
  }
  // 타임아웃/연결 실패
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION' || /timeout|timed out/i.test(err.message || '')) {
    return { status: 504, message: '메일 서버 응답이 지연되어 전송을 완료하지 못했습니다. 네트워크 상태를 확인하고 다시 시도해주세요.' }
  }
  // 인증 실패
  if (code === 'EAUTH' || responseCode === 535) {
    return { status: 401, message: '메일 서버 인증에 실패했습니다. 앱 비밀번호를 확인해주세요.' }
  }
  // 수신 거부
  if (code === 'EENVELOPE' || responseCode === 550) {
    return { status: 400, message: '받는 사람 주소가 거부되었습니다. 주소를 확인해주세요.' }
  }
  return { status: 502, message: '메일 전송에 실패했습니다. 잠시 후 다시 시도해주세요.' }
}

// 정책 로드 → 동적 limits 로 multer 실행 → 정책을 req 에 실어 라우트에서 확장자/합계 최종 검증.
async function handleMailSendUpload(req, res, next) {
  let policy
  try {
    policy = await getAttachmentPolicy()
  } catch (err) {
    return next(err)
  }
  req.mailAttachPolicy = policy
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: policy.maxFileBytes, files: policy.maxFiles },
  })
  upload.array('attachments', policy.maxFiles)(req, res, (err) => {
    if (!err) return next()
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? `첨부파일 1개의 용량이 너무 큽니다. (최대 ${policy.maxFileMb}MB)`
      : err.code === 'LIMIT_FILE_COUNT'
        ? `첨부파일 개수가 너무 많습니다. (최대 ${policy.maxFiles}개)`
        : err.message || '첨부파일 업로드에 실패했습니다.'
    return res.status(413).json({ error: msg })
  })
}

router.post('/accounts/:id/send', handleMailSendUpload, async (req, res, next) => {
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

    // 업로드된 첨부 준비 (전송용 + 저장용 공통)
    const policy = req.mailAttachPolicy || (await getAttachmentPolicy())
    const uploadedFiles = Array.isArray(req.files) ? req.files : []
    const preparedAttachments = uploadedFiles.map(f => ({
      filename: decodeMulterFilename(f.originalname),
      content: f.buffer,
      contentType: f.mimetype || null,
      size: f.size || f.buffer.length,
    }))
    // 최종 방어: 차단 확장자 거부
    if (policy.blockedExtensions.length) {
      const blocked = preparedAttachments.find(a => policy.blockedExtensions.includes(fileExtensionOf(a.filename)))
      if (blocked) {
        return res.status(415).json({ error: `허용되지 않는 파일 형식입니다: ${blocked.filename}` })
      }
    }
    const totalAttachBytes = preparedAttachments.reduce((sum, a) => sum + a.size, 0)
    if (totalAttachBytes > policy.maxTotalBytes) {
      return res.status(413).json({ error: `첨부파일 합계 용량이 초과되었습니다. (최대 ${policy.maxTotalMb}MB)` })
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
      // 네트워크 문제 시 무한 대기 방지 (MailService.md 10.9)
      connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
      socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    })

    const fromName = account.display_name || account.email_address
    const from = fromName && fromName !== account.email_address
      ? `"${String(fromName).replace(/"/g, '\\"')}" <${account.email_address}>`
      : account.email_address

    // 전송 로깅: 시작 시점에 페이로드 크기/첨부 개수 기록
    const bodyBytes = Buffer.byteLength(text || '', 'utf8') + Buffer.byteLength(html || '', 'utf8')
    const approxWireBytes = Math.round((bodyBytes + totalAttachBytes) * 1.37) // base64 오버헤드 추정
    const sendStartedAt = Date.now()
    console.log(`[Mail send] 시작 account=${account.email_address} to=${to.length} 첨부=${preparedAttachments.length}개 본문=${formatBytes(bodyBytes)} 첨부합계=${formatBytes(totalAttachBytes)} 예상전송크기≈${formatBytes(approxWireBytes)}`)

    let info
    try {
      info = await transporter.sendMail({
        from,
        to,
        cc: cc.length ? cc : undefined,
        bcc: bcc.length ? bcc : undefined,
        subject: subject || '(제목 없음)',
        text: text || undefined,
        html: html || undefined,
        attachments: preparedAttachments.length
          ? preparedAttachments.map(a => ({
              filename: a.filename,
              content: a.content,
              contentType: a.contentType || undefined,
            }))
          : undefined,
      })
    } catch (sendErr) {
      const elapsedMs = Date.now() - sendStartedAt
      console.error(`[Mail send] 실패 account=${account.email_address} ${elapsedMs}ms code=${sendErr.code || '-'} responseCode=${sendErr.responseCode || '-'}: ${sendErr.message}`)
      const mapped = mapSmtpSendError(sendErr, policy)
      return res.status(mapped.status).json({ error: mapped.message })
    }
    console.log(`[Mail send] 완료 account=${account.email_address} ${Date.now() - sendStartedAt}ms messageId=${info.messageId || '-'} accepted=${(info.accepted || []).length} rejected=${(info.rejected || []).length}`)

    const providerMessageId = info.messageId || `local-sent-${crypto.randomUUID()}`
    const storage = getMailStorage()
    const keyBase = {
      storagePrefix: account.storage_prefix,
      tenantId,
      userId: account.user_id,
      accountId: account.id,
      providerMessageId,
    }
    const bodyTextKey = buildMailObjectKey({ ...keyBase, suffix: 'body.txt' })
    const bodyHtmlKey = buildMailObjectKey({ ...keyBase, suffix: 'body.html' })
    await storage.saveObject(bodyTextKey, Buffer.from(text || '', 'utf8'))
    await storage.saveObject(bodyHtmlKey, Buffer.from(html || '', 'utf8'))

    // 발신 첨부를 스토리지에 개별 오브젝트로 저장한다. (수신 메일과 동일 구조)
    const savedAttachments = []
    for (let i = 0; i < preparedAttachments.length; i += 1) {
      const a = preparedAttachments[i]
      const key = buildMailObjectKey({ ...keyBase, suffix: `attachments/${i + 1}-${a.filename}` })
      await storage.saveObject(key, a.content)
      savedAttachments.push({
        providerAttachmentId: null,
        filename: a.filename,
        contentType: a.contentType || null,
        sizeBytes: a.size,
        objectKey: key,
      })
    }

    const folderMap = await repo.getFolderMap({ tenantId, accountId: account.id })
    const messageId = await repo.saveSyncedMessage({
      tenantId,
      account,
      parsed: {
        providerMessageId,
        internetMessageId: info.messageId || null,
        threadId: null,
        subject: subject || '(제목 없음)',
        fromEmail: account.email_address,
        fromName: account.display_name || account.email_address,
        to: parseAddressObjects(to),
        cc: parseAddressObjects(cc),
        bcc: parseAddressObjects(bcc),
        snippet: (text || stripHtmlToText(html) || subject || '').slice(0, 240),
        receivedAt: null,
        sentAt: new Date(),
        isRead: true,
        isStarred: false,
        hasAttachments: savedAttachments.length > 0,
        sizeBytes: Buffer.byteLength(text || '', 'utf8') + Buffer.byteLength(html || '', 'utf8') + totalAttachBytes,
      },
      folderId: folderMap.SENT || null,
      objectKeys: { bodyText: bodyTextKey, bodyHtml: bodyHtmlKey, raw: null },
      attachments: savedAttachments,
    })
    await enqueueMessageSynced({ tenantId, messageId, direction: 'outbound' }).catch(err => {
      console.warn('[AgenticAI Mail] sent event enqueue failed:', err.message)
    })

    res.json({ ok: true, messageId: info.messageId || null, savedMessageId: messageId, accepted: info.accepted || [] })
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
