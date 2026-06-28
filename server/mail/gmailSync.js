const repo = require('./repository')
const { getMailStorage, buildMailObjectKey } = require('./storage')
const { decryptSecret, encryptSecret } = require('../lib/secrets')
const {
  refreshAccessToken,
  gmailListMessages,
  gmailGetMessage,
  gmailGetAttachment,
  gmailListLabels,
} = require('./gmailOAuth')
const { parseGmailMessage, decodeBase64Url } = require('./messageParser')
const { enqueueMessageSynced } = require('./agentic/worker')

// ---------------------------------------------------------------------------
// Gmail 동기화 오케스트레이터.
//   네트워크(Gmail API) + 파싱(messageParser) + 저장(storage) + DB(repository)를 묶는다.
//   DB 쓰기는 전부 repository를 통하므로 tenant 라우팅(shared/dedicated)이 자동 적용된다.
// ---------------------------------------------------------------------------

const TOKEN_SKEW_MS = 60 * 1000 // 만료 1분 전이면 미리 갱신

// 유효한 access token을 보장한다. 만료 시 refresh token으로 갱신 후 DB에 저장한다.
async function ensureAccessToken({ tenantId, account }) {
  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0
  const current = decryptSecret(account.access_token_encrypted)
  if (current && expiresAt && expiresAt - Date.now() > TOKEN_SKEW_MS) {
    return current
  }

  const refreshToken = decryptSecret(account.refresh_token_encrypted)
  if (!refreshToken) {
    const err = new Error('refresh token이 없어 access token을 갱신할 수 없습니다. 계정을 재연결해야 합니다.')
    err.code = 'MAIL_REAUTH_REQUIRED'
    throw err
  }

  const refreshed = await refreshAccessToken(refreshToken)
  if (!refreshed.access_token) throw new Error('access token 갱신 응답에 access_token이 없습니다.')

  const newExpiry = refreshed.expires_in
    ? new Date(Date.now() + Number(refreshed.expires_in) * 1000)
    : null
  await repo.updateAccountTokens({
    tenantId,
    accountId: account.id,
    accessTokenEnc: encryptSecret(refreshed.access_token),
    expiresAt: newExpiry,
  })
  return refreshed.access_token
}

// Gmail 라벨 → 내부 기본 폴더(provider_folder_id) 매핑
function pickFolderProviderId(labelIds = []) {
  if (labelIds.includes('TRASH')) return 'TRASH'
  if (labelIds.includes('SENT')) return 'SENT'
  if (labelIds.includes('DRAFT')) return 'DRAFT'
  if (labelIds.includes('INBOX')) return 'INBOX'
  return null
}

// 최신 메시지 id 목록을 limit 까지 모은다.
// full(전체 증분) 동기화 시 한 번에 훑을 안전 상한
const GMAIL_FULL_MAX = 2000

async function collectMessageIds(accessToken, limit, full, labelIds) {
  const ids = []
  let pageToken
  const cap = full ? GMAIL_FULL_MAX : limit
  while (ids.length < cap) {
    const pageSize = full ? 100 : Math.min(100, cap - ids.length)
    const list = await gmailListMessages(accessToken, { maxResults: pageSize, pageToken, labelIds })
    for (const m of (list.messages || [])) ids.push(m.id)
    pageToken = list.nextPageToken
    if (!pageToken) break
  }
  return ids
}

// 메시지의 폴더(folder_id)를 결정한다. forceFolderId(특정 폴더 동기화) > 표준 폴더 > 사용자 라벨 순.
function resolveGmailFolderId(folderMap, labelIds, forceFolderId) {
  if (forceFolderId) return forceFolderId
  const std = pickFolderProviderId(labelIds)
  if (std && folderMap[std]) return folderMap[std]
  for (const l of (labelIds || [])) {
    if (folderMap[l]) return folderMap[l]
  }
  return null
}

// 메시지 1건: 상세 조회 → 본문/첨부 저장 → DB 적재
async function syncOneMessage({ tenantId, account, accessToken, storage, folderMap, providerMessageId, forceFolderId }) {
  const full = await gmailGetMessage(accessToken, providerMessageId, { format: 'full' })
  const parsed = parseGmailMessage(full)

  const keyBase = {
    storagePrefix: account.storage_prefix,
    tenantId,
    userId: account.user_id,
    accountId: account.id,
    providerMessageId: parsed.providerMessageId,
  }

  // 원본(JSON 아카이브) 저장
  const rawKey = buildMailObjectKey({ ...keyBase, suffix: 'raw.json' })
  await storage.saveObject(rawKey, Buffer.from(JSON.stringify(full), 'utf8'))
  const objectKeys = { raw: rawKey, bodyText: null, bodyHtml: null }

  if (parsed.bodyText != null) {
    const k = buildMailObjectKey({ ...keyBase, suffix: 'body.txt' })
    await storage.saveObject(k, Buffer.from(parsed.bodyText, 'utf8'))
    objectKeys.bodyText = k
  }
  if (parsed.bodyHtml != null) {
    const k = buildMailObjectKey({ ...keyBase, suffix: 'body.html' })
    await storage.saveObject(k, Buffer.from(parsed.bodyHtml, 'utf8'))
    objectKeys.bodyHtml = k
  }

  // 첨부 저장
  const attachments = []
  let idx = 0
  for (const att of parsed.attachments) {
    idx += 1
    let data = Buffer.alloc(0)
    if (att.providerAttachmentId) {
      const res = await gmailGetAttachment(accessToken, parsed.providerMessageId, att.providerAttachmentId)
      data = decodeBase64Url(res.data)
    }
    const k = buildMailObjectKey({ ...keyBase, suffix: `attachments/${idx}-${att.filename}` })
    await storage.saveObject(k, data)
    attachments.push({ ...att, sizeBytes: att.sizeBytes || data.length, objectKey: k })
  }

  const folderId = resolveGmailFolderId(folderMap, parsed.labelIds, forceFolderId)
  const messageId = await repo.saveSyncedMessage({ tenantId, account, parsed, folderId, objectKeys, attachments })
  await enqueueMessageSynced({ tenantId, messageId, direction: 'inbound' }).catch(err => {
    console.warn('[AgenticAI Mail] Gmail sync event enqueue failed:', err.message)
  })
}

// 계정 1개를 동기화한다. (account는 repo.getAccountForSync 결과: storage_prefix 포함)
async function syncGmailAccount({ tenantId, account, limit = 50, full = false }) {
  const accessToken = await ensureAccessToken({ tenantId, account })
  const storage = getMailStorage()
  const folderMap = await repo.getFolderMap({ tenantId, accountId: account.id })

  const ids = await collectMessageIds(accessToken, limit, full)
  const existing = await repo.getExistingProviderMessageIds({ tenantId, accountId: account.id, ids })
  const newIds = ids.filter(id => !existing.has(id))

  let saved = 0
  const errors = []
  for (const id of newIds) {
    try {
      await syncOneMessage({ tenantId, account, accessToken, storage, folderMap, providerMessageId: id })
      saved += 1
    } catch (err) {
      errors.push({ id, error: err.message })
    }
  }

  await repo.updateSyncState({ tenantId, accountId: account.id, markFullSync: true })
  await repo.recomputeUsage({ tenantId, accountId: account.id, userId: account.user_id })

  return {
    listed: ids.length,
    new: newIds.length,
    saved,
    failed: errors.length,
    errors: errors.slice(0, 10),
  }
}

// 사용자 라벨을 폴더로 발견해 반환한다.
async function discoverGmailFolders({ tenantId, account }) {
  const accessToken = await ensureAccessToken({ tenantId, account })
  const { labels } = await gmailListLabels(accessToken)
  return (labels || [])
    .filter(l => l.type === 'user')
    .map(l => ({ providerFolderId: l.id, name: l.name, type: 'custom' }))
}

// 특정 라벨(폴더) 1개의 메시지를 on-demand로 동기화한다.
async function syncGmailFolder({ tenantId, account, folder, limit = 50, full = false }) {
  const accessToken = await ensureAccessToken({ tenantId, account })
  const storage = getMailStorage()
  const folderMap = await repo.getFolderMap({ tenantId, accountId: account.id })

  const ids = await collectMessageIds(accessToken, limit, full, [folder.provider_folder_id])
  const existing = await repo.getExistingProviderMessageIds({ tenantId, accountId: account.id, ids })
  const newIds = ids.filter(id => !existing.has(id))

  let saved = 0
  const errors = []
  for (const id of newIds) {
    try {
      await syncOneMessage({ tenantId, account, accessToken, storage, folderMap, providerMessageId: id, forceFolderId: folder.id })
      saved += 1
    } catch (err) {
      errors.push({ id, error: err.message })
    }
  }
  await repo.recomputeUsage({ tenantId, accountId: account.id, userId: account.user_id })
  return { listed: ids.length, new: newIds.length, saved, failed: errors.length, errors: errors.slice(0, 10) }
}

module.exports = {
  syncGmailAccount,
  ensureAccessToken,
  discoverGmailFolders,
  syncGmailFolder,
}
