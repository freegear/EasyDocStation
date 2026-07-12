const { ImapFlow } = require('imapflow')
const repo = require('./repository')
const { getMailStorage } = require('./storage')
const { decryptSecret, encryptSecret } = require('../lib/secrets')
const {
  refreshAccessToken,
  gmailModifyMessage,
  gmailTrashMessage,
} = require('./gmailOAuth')

const TOKEN_SKEW_MS = 60 * 1000

function buildImapClient(account, password) {
  return new ImapFlow({
    host: account.imap_host,
    port: Number(account.imap_port),
    secure: account.imap_security !== 'starttls' && account.imap_security !== 'none',
    auth: { user: account.username || account.email_address, pass: password },
    logger: false,
  })
}

async function ensureGmailAccessToken({ tenantId, account }) {
  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0
  const current = decryptSecret(account.access_token_encrypted)
  if (current && expiresAt && expiresAt - Date.now() > TOKEN_SKEW_MS) return current

  const refreshToken = decryptSecret(account.refresh_token_encrypted)
  if (!refreshToken) {
    const err = new Error('Gmail access token을 갱신할 refresh token이 없습니다. 계정을 재연결해주세요.')
    err.code = 'MAIL_REAUTH_REQUIRED'
    throw err
  }
  const refreshed = await refreshAccessToken(refreshToken)
  if (!refreshed.access_token) throw new Error('Gmail access token 갱신 응답에 access_token이 없습니다.')
  const expiresAtNext = refreshed.expires_in
    ? new Date(Date.now() + Number(refreshed.expires_in) * 1000)
    : null
  await repo.updateAccountTokens({
    tenantId,
    accountId: account.id,
    accessTokenEnc: encryptSecret(refreshed.access_token),
    expiresAt: expiresAtNext,
  })
  return refreshed.access_token
}

function isInsufficientGmailScope(err) {
  const text = `${err?.message || ''} ${JSON.stringify(err?.data || {})}`
  return err?.status === 403 && /insufficient|permission|scope/i.test(text)
}

async function moveGmailMessageOnProvider({ tenantId, account, message, targetFolder }) {
  const accessToken = await ensureGmailAccessToken({ tenantId, account })
  const providerMessageId = message.provider_message_id
  if (!providerMessageId) throw new Error('Gmail 메시지 ID가 없습니다.')
  try {
    if (targetFolder.provider_folder_id === 'TRASH' || targetFolder.type === 'trash') {
      await gmailTrashMessage(accessToken, providerMessageId)
      return { provider: 'gmail', target: 'TRASH' }
    }

    const addLabelIds = [targetFolder.provider_folder_id].filter(Boolean)
    const removeLabelIds = [message.folder_provider_id]
      .filter(Boolean)
      .filter(label => label !== targetFolder.provider_folder_id)
      .filter(label => label !== 'SENT' && label !== 'DRAFT')
    await gmailModifyMessage(accessToken, providerMessageId, { addLabelIds, removeLabelIds })
    return { provider: 'gmail', target: targetFolder.provider_folder_id }
  } catch (err) {
    if (isInsufficientGmailScope(err)) {
      throw new Error('Gmail 메일 이동 권한이 없습니다. Gmail 계정을 재연결해서 gmail.modify 권한을 승인해주세요.')
    }
    throw err
  }
}

function parseImapProviderMessageId(providerMessageId) {
  const value = String(providerMessageId || '')
  if (!value.startsWith('imap:')) return null
  const body = value.slice(5)
  const sep = body.lastIndexOf(':')
  if (sep <= 0) return null
  const uid = Number(body.slice(sep + 1))
  if (!Number.isFinite(uid) || uid <= 0) return null
  return { providerFolderId: body.slice(0, sep), uid }
}

function isImapProvider(provider) {
  return ['naver', 'apple', 'imap', 'other'].includes(provider)
}

function normalizeMailboxName(value) {
  return String(value || '').trim().toLowerCase()
}

function mailboxLeafName(box) {
  const path = String(box?.path || '')
  const delimiter = String(box?.delimiter || '/')
  return normalizeMailboxName(path.split(delimiter).filter(Boolean).pop() || path)
}

function mailboxHasSpecialUse(box, expected) {
  const target = normalizeMailboxName(expected)
  if (normalizeMailboxName(box?.specialUse) === target) return true
  for (const collection of [box?.flags, box?.attributes]) {
    if (!collection) continue
    const values = typeof collection[Symbol.iterator] === 'function' ? [...collection] : []
    if (values.some(value => normalizeMailboxName(value) === target)) return true
  }
  return false
}

function findMailbox(mailboxes, candidates) {
  for (const candidate of candidates.map(normalizeMailboxName).filter(Boolean)) {
    const found = mailboxes.find(box => (
      normalizeMailboxName(box.path) === candidate
      || normalizeMailboxName(box.name) === candidate
      || mailboxLeafName(box) === candidate
    ))
    if (found) return found.path
  }
  return null
}

function resolveMailboxPath(mailboxes, folder) {
  if (!folder) return null
  if (folder.type === 'inbox' || folder.provider_folder_id === 'INBOX') return 'INBOX'
  if (folder.type === 'trash' || folder.provider_folder_id === 'TRASH') {
    const bySpecial = mailboxes.find(box => mailboxHasSpecialUse(box, '\\trash'))
    return bySpecial?.path || findMailbox(mailboxes, [folder.provider_folder_id, 'Trash', 'Deleted Messages', 'Deleted Items', 'Deleted', '휴지통', '지운 편지함'])
  }
  if (folder.type === 'sent' || folder.provider_folder_id === 'SENT') {
    const bySpecial = mailboxes.find(box => mailboxHasSpecialUse(box, '\\sent'))
    return bySpecial?.path || findMailbox(mailboxes, [folder.provider_folder_id, 'Sent', 'Sent Messages', 'Sent Mail', '보낸메일함', '보낸 메일'])
  }
  if (folder.type === 'drafts' || folder.provider_folder_id === 'DRAFT') {
    const bySpecial = mailboxes.find(box => mailboxHasSpecialUse(box, '\\drafts'))
    return bySpecial?.path || findMailbox(mailboxes, [folder.provider_folder_id, 'Draft', 'Drafts', '임시보관함', '임시 보관함'])
  }
  return findMailbox(mailboxes, [folder.provider_folder_id])
}

function mailMoveError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// IMAP 메일함에서 Message-ID 헤더로 메시지 UID를 찾는다. (provider_message_id에
// UID가 없거나 형식이 깨진 메일을 이동하기 위한 폴백)
async function findImapUidByMessageId(client, internetMessageId) {
  const id = String(internetMessageId || '').trim()
  if (!id) return null
  const found = await client.search({ header: { 'message-id': id } }, { uid: true })
  if (!Array.isArray(found) || found.length === 0) return null
  return found[found.length - 1]
}

async function findImapMessageAcrossMailboxes(client, mailboxes, internetMessageId) {
  const id = String(internetMessageId || '').trim()
  if (!id) return null
  for (const box of mailboxes) {
    if (!box?.path || mailboxHasSpecialUse(box, '\\trash')) continue
    if (box.flags?.has?.('\\Noselect') || box.attributes?.has?.('\\Noselect')) continue
    let lock
    try {
      lock = await client.getMailboxLock(box.path)
      const uid = await findImapUidByMessageId(client, id)
      if (uid) return { mailbox: box.path, uid }
    } catch {
      // 일부 선택 불가 메일함의 오류는 다른 메일함 탐색을 막지 않는다.
    } finally {
      lock?.release()
    }
  }
  return null
}

async function moveImapMessageOnProvider({ account, message, targetFolder }) {
  if (targetFolder.is_local) return { provider: 'imap', skipped: true, reason: 'local_folder' }
  const password = decryptSecret(account.password_encrypted)
  if (!password) throw new Error('메일 계정 암호가 저장되어 있지 않습니다.')

  // provider_message_id가 imap:<folder>:<uid> 형식이면 그대로 쓰고,
  // 아니면(형식 깨짐/UID 없음) 메시지의 folder 정보 + Message-ID 검색으로 폴백한다.
  const parsed = parseImapProviderMessageId(message.provider_message_id)

  const client = buildImapClient(account, password)
  await client.connect()
  try {
    const mailboxes = await client.list()
    const sourceFolder = {
      provider_folder_id: parsed?.providerFolderId || message.folder_provider_id,
      type: message.folder_type || 'custom',
    }
    let sourceMailbox = resolveMailboxPath(mailboxes, sourceFolder)
    const targetMailbox = resolveMailboxPath(mailboxes, targetFolder)
    if (!targetMailbox) throw mailMoveError('IMAP_TRASH_MAILBOX_NOT_FOUND', 'IMAP 휴지통 메일함을 찾지 못했습니다.')

    let recoveredUid = null
    if (!sourceMailbox) {
      const recovered = await findImapMessageAcrossMailboxes(client, mailboxes, message.internet_message_id)
      if (!recovered) {
        if (message.internet_message_id) throw mailMoveError('IMAP_MESSAGE_NOT_FOUND', '원격 IMAP 서버에서 메일을 찾지 못했습니다.')
        throw mailMoveError('LOCAL_ORPHAN_CANDIDATE', '원본 메일함과 Message-ID가 없어 원격 메일을 확인할 수 없습니다.')
      }
      sourceMailbox = recovered.mailbox
      recoveredUid = recovered.uid
    }

    const lock = await client.getMailboxLock(sourceMailbox)
    try {
      let uid = recoveredUid || parsed?.uid || null
      if (!uid) uid = await findImapUidByMessageId(client, message.internet_message_id)
      if (!uid) throw mailMoveError('IMAP_MESSAGE_NOT_FOUND', '원격 IMAP 서버에서 메일을 찾지 못했습니다.')
      const result = await client.messageMove(String(uid), targetMailbox, { uid: true })
      const movedUid = result?.uidMap?.get(uid) || uid
      return {
        provider: 'imap',
        source: sourceMailbox,
        target: targetMailbox,
        providerMessageId: `imap:${targetFolder.provider_folder_id}:${movedUid}`,
      }
    } finally {
      lock.release()
    }
  } finally {
    if (client.usable) await client.logout().catch(() => {})
    else client.close()
  }
}

async function isLocalOrphanCandidateOnProvider({ account, message }) {
  if (!isImapProvider(account?.provider) || String(message?.internet_message_id || '').trim()) return false
  const password = decryptSecret(account.password_encrypted)
  if (!password) throw new Error('메일 계정 암호가 저장되어 있지 않습니다.')

  const parsed = parseImapProviderMessageId(message.provider_message_id)
  const client = buildImapClient(account, password)
  await client.connect()
  try {
    const mailboxes = await client.list()
    const sourceFolder = {
      provider_folder_id: parsed?.providerFolderId || message.folder_provider_id,
      type: message.folder_type || 'custom',
    }
    return !resolveMailboxPath(mailboxes, sourceFolder)
  } finally {
    if (client.usable) await client.logout().catch(() => {})
    else client.close()
  }
}

async function appendImapMessageToProvider({ account, targetFolder, rawMessage, message }) {
  if (targetFolder.is_local) return { provider: 'imap', skipped: true, reason: 'local_folder' }
  const password = decryptSecret(account.password_encrypted)
  if (!password) throw new Error('대상 메일 계정 암호가 저장되어 있지 않습니다.')

  const client = buildImapClient(account, password)
  await client.connect()
  try {
    const mailboxes = await client.list()
    const targetMailbox = resolveMailboxPath(mailboxes, targetFolder)
    if (!targetMailbox) throw new Error('IMAP 복사 대상 메일함을 찾지 못했습니다.')
    const flags = message.is_read === false ? [] : ['\\Seen']
    const idate = message.received_at || message.sent_at || message.created_at
      ? new Date(message.received_at || message.sent_at || message.created_at)
      : new Date()
    const result = await client.append(targetMailbox, rawMessage, flags, idate)
    // result.destination 은 '메일함 경로'라 UID가 아니다(옛 코드의 버그). UIDPLUS가 준
    // 실제 uid → 없으면 Message-ID 검색 → 그래도 없으면 소스 메시지 id로 유일값을 만든다.
    // (같은 폴더로 여러 건을 넣을 때 provider_message_id 충돌을 막기 위함)
    let uid = Number(result?.uid) > 0 ? Number(result.uid) : null
    if (!uid) {
      const lock = await client.getMailboxLock(targetMailbox)
      try {
        uid = await findImapUidByMessageId(client, message.internet_message_id)
      } finally {
        lock.release()
      }
    }
    const idPart = uid || `append-${message.id}`
    return {
      provider: 'imap',
      target: targetMailbox,
      providerMessageId: `imap:${targetFolder.provider_folder_id}:${idPart}`,
    }
  } finally {
    if (client.usable) await client.logout().catch(() => {})
    else client.close()
  }
}

async function moveMessageAcrossAccounts({ tenantId, account, message, targetFolder }) {
  if (!message.raw_object_key) throw new Error('교차 계정 이동에 필요한 원본 메일(raw)이 없습니다.')
  const targetAccount = await repo.getAccountForSync({
    tenantId,
    accountId: targetFolder.account_id,
    userId: message.user_id,
  })
  if (!targetAccount) throw new Error('대상 메일 계정을 찾지 못했습니다.')
  if (!isImapProvider(account.provider) || !isImapProvider(targetAccount.provider)) {
    throw new Error('교차 계정 이동은 현재 IMAP 계정 간 이동만 지원합니다.')
  }

  const rawMessage = await getMailStorage().getObject(message.raw_object_key)
  const targetAppend = await appendImapMessageToProvider({
    account: targetAccount,
    targetFolder,
    rawMessage,
    message,
  })

  let sourceCleanup = null
  try {
    const sourceTrashFolder = await repo.getFolderByTypeForAccount({
      tenantId,
      accountId: account.id,
      type: 'trash',
    })
    if (!sourceTrashFolder) throw new Error('원본 계정의 휴지통 폴더를 찾지 못했습니다.')
    sourceCleanup = await moveImapMessageOnProvider({
      account,
      message,
      targetFolder: sourceTrashFolder,
    })
  } catch (err) {
    sourceCleanup = { ok: false, error: err.message }
  }
  if (sourceCleanup?.ok === false) {
    throw new Error(`대상 계정에는 복사했지만 원본 메일 정리에 실패했습니다: ${sourceCleanup.error}`)
  }

  return {
    provider: 'cross_account_imap',
    sourceAccountId: account.id,
    targetAccountId: targetAccount.id,
    target: targetAppend,
    sourceCleanup,
    providerMessageId: targetAppend?.providerMessageId,
  }
}

async function moveMessageOnProvider({ tenantId, account, message, targetFolder }) {
  if (!targetFolder) throw new Error('대상 폴더를 찾지 못했습니다.')
  if (targetFolder.account_id && targetFolder.account_id !== account.id) {
    return moveMessageAcrossAccounts({ tenantId, account, message, targetFolder })
  }
  if (account.provider === 'gmail') {
    return moveGmailMessageOnProvider({ tenantId, account, message, targetFolder })
  }
  if (isImapProvider(account.provider)) {
    return moveImapMessageOnProvider({ account, message, targetFolder })
  }
  return { skipped: true, reason: `unsupported_provider:${account.provider}` }
}

// 여러 메일을 한 번에 계정의 휴지통으로 이동한다(계정당 IMAP 연결 1회, source 메일함별로 묶어 일괄 MOVE).
// 반환: Map<messageId, { ok, providerMessageId?, error? }>. (MailService.md 16.11 — 삭제 성능/신뢰성)
async function moveMessagesToTrashOnProvider({ tenantId, account, messages, trashFolder }) {
  const out = new Map()
  if (!messages || messages.length === 0) return out

  if (account.provider === 'gmail') {
    const accessToken = await ensureGmailAccessToken({ tenantId, account })
    for (const m of messages) {
      try {
        if (!m.provider_message_id) throw new Error('Gmail 메시지 ID가 없습니다.')
        await gmailTrashMessage(accessToken, m.provider_message_id)
        out.set(m.id, { ok: true }) // Gmail id 불변
      } catch (err) {
        out.set(m.id, { ok: false, error: isInsufficientGmailScope(err)
          ? 'Gmail 삭제 권한이 없습니다. 계정을 재연결해 gmail.modify를 승인하세요.'
          : err.message })
      }
    }
    return out
  }

  if (!isImapProvider(account.provider)) {
    for (const m of messages) out.set(m.id, { ok: false, error: `unsupported_provider:${account.provider}` })
    return out
  }

  const password = decryptSecret(account.password_encrypted)
  if (!password) {
    for (const m of messages) out.set(m.id, { ok: false, error: '메일 계정 암호가 저장되어 있지 않습니다.' })
    return out
  }

  const client = buildImapClient(account, password)
  await client.connect()
  try {
    const mailboxes = await client.list()
    const targetMailbox = resolveMailboxPath(mailboxes, trashFolder)
    if (!targetMailbox) {
      for (const m of messages) out.set(m.id, { ok: false, error: 'IMAP 휴지통 메일함을 찾지 못했습니다.' })
      return out
    }

    // source 메일함별로 묶는다(대개 INBOX 하나).
    const bySource = new Map()
    for (const m of messages) {
      const parsed = parseImapProviderMessageId(m.provider_message_id)
      const sourceFolder = {
        provider_folder_id: parsed?.providerFolderId || m.folder_provider_id,
        type: m.folder_type || 'custom',
      }
      const sourceMailbox = resolveMailboxPath(mailboxes, sourceFolder)
      if (!sourceMailbox) { out.set(m.id, { ok: false, error: 'IMAP 원본 메일함을 찾지 못했습니다.' }); continue }
      if (sourceMailbox === targetMailbox) { out.set(m.id, { ok: true }); continue } // 이미 휴지통
      if (!bySource.has(sourceMailbox)) bySource.set(sourceMailbox, [])
      bySource.get(sourceMailbox).push({ m, uid: parsed?.uid || null })
    }

    for (const [sourceMailbox, entries] of bySource) {
      const lock = await client.getMailboxLock(sourceMailbox)
      try {
        // UID 확정(형식 깨진 건 Message-ID로 폴백).
        for (const e of entries) {
          if (!e.uid) e.uid = await findImapUidByMessageId(client, e.m.internet_message_id)
        }
        const valid = entries.filter(e => e.uid)
        for (const e of entries) if (!e.uid) out.set(e.m.id, { ok: false, error: 'IMAP 메시지 UID를 확인할 수 없습니다.' })
        if (valid.length === 0) continue

        const uidList = valid.map(e => String(e.uid)).join(',')
        const result = await client.messageMove(uidList, targetMailbox, { uid: true })
        const uidMap = result?.uidMap
        for (const e of valid) {
          const newUid = (uidMap && uidMap.get(Number(e.uid))) || e.uid
          out.set(e.m.id, { ok: true, providerMessageId: `imap:${trashFolder.provider_folder_id}:${newUid}` })
        }
      } catch (err) {
        for (const e of entries) if (!out.has(e.m.id)) out.set(e.m.id, { ok: false, error: err.message })
      } finally {
        lock.release()
      }
    }
    return out
  } finally {
    if (client.usable) await client.logout().catch(() => {})
    else client.close()
  }
}

module.exports = {
  resolveMailboxPath,
  isLocalOrphanCandidateOnProvider,
  moveMessageOnProvider,
  moveMessagesToTrashOnProvider,
}
