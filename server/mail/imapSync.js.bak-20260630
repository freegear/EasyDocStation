const { ImapFlow } = require('imapflow')
const { simpleParser } = require('mailparser')
const repo = require('./repository')
const { getMailStorage, buildMailObjectKey } = require('./storage')
const { decryptSecret } = require('../lib/secrets')
const { buildSnippet } = require('./textPreview')
const { decodeHeaderText, getRawHeader, detectFallbackCharset } = require('./mimeHeaderDecode')
const { parseAddressList, normalizeInternetMessageId } = require('./messageParser')
const { enqueueMessageSynced } = require('./agentic/worker')

function asAddressList(addressObject) {
  return (addressObject?.value || [])
    .map(item => ({
      name: item.name || '',
      email: item.address || '',
    }))
    .filter(item => item.email)
}

// mailparser가 비표준(raw 8bit) 헤더를 UTF-8로 잘못 읽어 이름이 깨진 경우(U+FFFD),
// 원본 .eml의 해당 헤더 바이트에서 직접 다시 디코딩해 복구한다.
function recoverAddresses(source, headerName, fallbackList, fallbackCs) {
  const hasGarble = (fallbackList || []).some(a => a.name && a.name.includes('�'))
  if (!hasGarble) return fallbackList
  const raw = getRawHeader(source, headerName)
  if (!raw) return fallbackList
  const list = parseAddressList(decodeHeaderText(raw, fallbackCs))
  return list.length ? list : fallbackList
}

// full(전체 증분) 동기화 시 한 번에 가져올 안전 상한과 본문 fetch 배치 크기
const FULL_MAX = 2000
const FETCH_BATCH = 100

function buildImapClient(account, password) {
  return new ImapFlow({
    host: account.imap_host,
    port: Number(account.imap_port),
    secure: account.imap_security !== 'starttls' && account.imap_security !== 'none',
    auth: { user: account.username || account.email_address, pass: password },
    logger: false,
  })
}

// IMAP 메일함을 내부 폴더 타입으로 분류한다.
function classifyMailbox(box) {
  const su = String(box.specialUse || '').toLowerCase()
  const path = String(box.path || '').toLowerCase()
  const name = String(box.name || '').toLowerCase()
  const label = [path, name]
  if (su === '\\sent') return 'sent'
  if (su === '\\drafts') return 'drafts'
  if (su === '\\trash') return 'trash'
  if (su === '\\junk') return 'spam'
  if (su === '\\archive') return 'archive'
  if (path === 'inbox') return 'inbox'
  if (label.some(value => ['draft', 'drafts', '임시보관함', '임시 보관함'].includes(value))) return 'drafts'
  return 'custom'
}

function mailboxDisplayName(box) {
  const delim = box.delimiter || '/'
  const segs = String(box.path || '').split(delim).filter(Boolean)
  return box.name || segs[segs.length - 1] || box.path
}

function normalizeFolderIdentity(box) {
  const type = classifyMailbox(box)
  if (type === 'inbox') return { providerFolderId: 'INBOX', name: '받은 편지함', type }
  if (type === 'sent') return { providerFolderId: 'SENT', name: '보낸 메일', type }
  if (type === 'drafts') return { providerFolderId: 'DRAFT', name: '임시 보관함', type }
  if (type === 'trash') return { providerFolderId: 'TRASH', name: '휴지통', type }
  return { providerFolderId: box.path, name: mailboxDisplayName(box), type }
}

// 계정의 전체 메일함을 발견해 폴더 목록으로 반환한다(선택 불가/가상 폴더 제외).
async function listImapFolders(account) {
  const password = decryptSecret(account.password_encrypted)
  if (!password) throw new Error('메일 계정 암호가 저장되어 있지 않습니다.')
  const client = buildImapClient(account, password)
  await client.connect()
  try {
    const boxes = await client.list()
    const folders = []
    for (const box of boxes) {
      if (box.flags && typeof box.flags.has === 'function' && box.flags.has('\\Noselect')) continue
      folders.push(normalizeFolderIdentity(box))
    }
    return folders
  } finally {
    if (client.usable) await client.logout().catch(() => {})
    else client.close()
  }
}

// 특정 폴더 1개의 메시지를 on-demand로 동기화한다.
// IMAP SELECT 시 "메일박스 없음" 응답(NONEXISTENT)을 식별한다. (ImapFlow 에러 객체 기준)
function isMailboxMissingError(err) {
  if (!err) return false
  if (err.mailboxMissing === true) return true
  const text = `${err.responseText || ''} ${err.response || ''} ${err.message || ''}`
  return /NONEXISTENT|mailbox doesn'?t exist|no such mailbox/i.test(text)
}

async function syncImapFolder({ tenantId, account, folder, limit = 50, full = false }) {
  // 로컬 전용 폴더는 서버에 메일박스가 없으므로 동기화하지 않는다.
  if (folder.is_local) {
    return { listed: 0, new: 0, saved: 0, failed: 0, errors: [], skipped: true, reason: 'local_folder' }
  }

  const password = decryptSecret(account.password_encrypted)
  if (!password) throw new Error('메일 계정 암호가 저장되어 있지 않습니다.')
  const client = buildImapClient(account, password)
  await client.connect()
  try {
    const storage = getMailStorage()
    const folderMap = await repo.getFolderMap({ tenantId, accountId: account.id })
    let mailboxPath = folder.provider_folder_id
    if (folder.type === 'inbox') mailboxPath = 'INBOX'
    else if (folder.type === 'sent') mailboxPath = pickSentMailbox(await client.list()) || folder.provider_folder_id
    else if (folder.type === 'drafts') mailboxPath = pickDraftsMailbox(await client.list()) || folder.provider_folder_id
    else if (folder.type === 'trash') mailboxPath = pickTrashMailbox(await client.list()) || folder.provider_folder_id

    let result
    try {
      result = await syncMailbox({
        client, tenantId, account, storage, folderMap,
        mailboxPath, providerFolderId: folder.provider_folder_id, limit, full,
      })
    } catch (err) {
      // 서버에서 폴더가 사라진(이름변경/삭제) 거울 폴더: 에러로 터뜨리지 않고 'missing'으로 표시하고
      // 자동 동기화를 멈춘다. (시스템 폴더 INBOX/SENT 등은 표시하지 않는다.)
      if (isMailboxMissingError(err)) {
        if (folder.type === 'custom') {
          await repo.setFolderSyncStatus({ tenantId, accountId: account.id, folderId: folder.id, syncStatus: 'missing' }).catch(() => {})
        }
        return { listed: 0, new: 0, saved: 0, failed: 0, errors: [], mailboxMissing: true }
      }
      throw err
    }

    // 동기화 성공 → 이전에 missing이었다면 정상으로 복구.
    if (folder.sync_status) {
      await repo.setFolderSyncStatus({ tenantId, accountId: account.id, folderId: folder.id, syncStatus: null }).catch(() => {})
    }
    await repo.recomputeUsage({ tenantId, accountId: account.id, userId: account.user_id })
    return result
  } finally {
    if (client.usable) await client.logout().catch(() => {})
    else client.close()
  }
}

function pickSentMailbox(mailboxes) {
  const candidates = [
    '\\Sent',
    'SENT',
    'Sent',
    'Sent Messages',
    'Sent Mail',
    '보낸메일함',
    '보낸 메일',
    '보낸편지함',
    '보낸 편지함',
  ]
  const bySpecialUse = mailboxes.find(box => String(box.specialUse || '').toLowerCase() === '\\sent')
  if (bySpecialUse) return bySpecialUse.path
  for (const candidate of candidates) {
    const found = mailboxes.find(box => (
      String(box.path || '').toLowerCase() === candidate.toLowerCase()
      || String(box.name || '').toLowerCase() === candidate.toLowerCase()
    ))
    if (found) return found.path
  }
  return null
}

function pickDraftsMailbox(mailboxes) {
  const candidates = [
    '\\Drafts',
    'DRAFT',
    'Draft',
    'Drafts',
    '임시보관함',
    '임시 보관함',
  ]
  const bySpecialUse = mailboxes.find(box => String(box.specialUse || '').toLowerCase() === '\\drafts')
  if (bySpecialUse) return bySpecialUse.path
  for (const candidate of candidates) {
    const found = mailboxes.find(box => (
      String(box.path || '').toLowerCase() === candidate.toLowerCase()
      || String(box.name || '').toLowerCase() === candidate.toLowerCase()
    ))
    if (found) return found.path
  }
  return null
}

function pickTrashMailbox(mailboxes) {
  const candidates = [
    '\\Trash',
    'TRASH',
    'Trash',
    'Deleted Messages',
    'Deleted Items',
    '휴지통',
  ]
  const bySpecialUse = mailboxes.find(box => String(box.specialUse || '').toLowerCase() === '\\trash')
  if (bySpecialUse) return bySpecialUse.path
  for (const candidate of candidates) {
    const found = mailboxes.find(box => (
      String(box.path || '').toLowerCase() === candidate.toLowerCase()
      || String(box.name || '').toLowerCase() === candidate.toLowerCase()
    ))
    if (found) return found.path
  }
  return null
}

function buildParsedMessage({ account, providerFolderId, uid, source, parsed, flags, internalDate, size }) {
  const fallbackCs = detectFallbackCharset(source)
  // 제목: 비표준 raw 8bit 헤더까지 처리하기 위해 원본 바이트에서 직접 디코딩
  const rawSubject = getRawHeader(source, 'subject')
  const subject = rawSubject ? decodeHeaderText(rawSubject, fallbackCs) : (parsed.subject || '')

  const toList = recoverAddresses(source, 'to', asAddressList(parsed.to), fallbackCs)
  const ccList = recoverAddresses(source, 'cc', asAddressList(parsed.cc), fallbackCs)
  const bccList = recoverAddresses(source, 'bcc', asAddressList(parsed.bcc), fallbackCs)
  const from = recoverAddresses(source, 'from', asAddressList(parsed.from), fallbackCs)[0] || { name: '', email: '' }

  return {
    providerMessageId: `imap:${providerFolderId}:${uid}`,
    internetMessageId: normalizeInternetMessageId(parsed.messageId || getRawHeader(source, 'message-id')),
    subject,
    fromEmail: from.email || null,
    fromName: from.name || null,
    to: toList,
    cc: ccList,
    bcc: bccList,
    snippet: buildSnippet([parsed.text, parsed.html, parsed.textAsHtml]),
    receivedAt: internalDate || parsed.date || null,
    sentAt: parsed.date || internalDate || null,
    isRead: Array.from(flags || []).some(flag => String(flag).toLowerCase() === '\\seen'),
    isStarred: Array.from(flags || []).some(flag => String(flag).toLowerCase() === '\\flagged'),
    hasAttachments: (parsed.attachments || []).length > 0,
    sizeBytes: Number(size || source.length || 0),
    bodyText: parsed.text || null,
    bodyHtml: parsed.html || null,
    attachments: (parsed.attachments || []).map((att, index) => ({
      providerAttachmentId: att.contentId || `${uid}-${index + 1}`,
      filename: att.filename || `attachment-${index + 1}`,
      contentType: att.contentType || 'application/octet-stream',
      sizeBytes: Number(att.size || att.content?.length || 0),
      content: att.content || Buffer.alloc(0),
    })),
    accountEmail: account.email_address,
  }
}

async function saveImapMessage({ tenantId, account, storage, folderMap, providerFolderId, source, parsedMessage }) {
  const keyBase = {
    storagePrefix: account.storage_prefix,
    tenantId,
    userId: account.user_id,
    accountId: account.id,
    providerMessageId: parsedMessage.providerMessageId,
  }

  const rawKey = buildMailObjectKey({ ...keyBase, suffix: 'raw.eml' })
  await storage.saveObject(rawKey, source)
  const objectKeys = { raw: rawKey, bodyText: null, bodyHtml: null }

  if (parsedMessage.bodyText != null) {
    const k = buildMailObjectKey({ ...keyBase, suffix: 'body.txt' })
    await storage.saveObject(k, Buffer.from(parsedMessage.bodyText, 'utf8'))
    objectKeys.bodyText = k
  }
  if (parsedMessage.bodyHtml != null) {
    const k = buildMailObjectKey({ ...keyBase, suffix: 'body.html' })
    await storage.saveObject(k, Buffer.from(parsedMessage.bodyHtml, 'utf8'))
    objectKeys.bodyHtml = k
  }

  const attachments = []
  for (const [index, att] of parsedMessage.attachments.entries()) {
    const k = buildMailObjectKey({ ...keyBase, suffix: `attachments/${index + 1}-${att.filename}` })
    await storage.saveObject(k, att.content)
    attachments.push({
      providerAttachmentId: att.providerAttachmentId,
      filename: att.filename,
      contentType: att.contentType,
      sizeBytes: att.sizeBytes || att.content.length,
      objectKey: k,
    })
  }

  const { attachments: _ignoredAttachments, bodyText: _bodyText, bodyHtml: _bodyHtml, ...dbMessage } = parsedMessage
  const folderId = folderMap[providerFolderId] || null
  const messageId = await repo.saveSyncedMessage({
    tenantId,
    account,
    parsed: dbMessage,
    folderId,
    objectKeys,
    attachments,
  })
  await enqueueMessageSynced({ tenantId, messageId, direction: providerFolderId === 'SENT' ? 'outbound' : 'inbound' }).catch(err => {
    console.warn('[AgenticAI Mail] IMAP sync event enqueue failed:', err.message)
  })
}

async function syncMailbox({ client, tenantId, account, storage, folderMap, mailboxPath, providerFolderId, limit, full }) {
  if (!mailboxPath) return { listed: 0, new: 0, saved: 0, failed: 0, errors: [] }
  const lock = await client.getMailboxLock(mailboxPath)
  try {
    const mailbox = client.mailbox || {}
    const exists = Number(mailbox.exists || 0)
    if (exists <= 0) return { listed: 0, new: 0, saved: 0, failed: 0, errors: [] }

    // 1) 전체 UID와 Message-ID만 가볍게 수집 → 무엇이 누락됐는지 판단
    const allMessages = []
    for await (const m of client.fetch('1:*', { uid: true, envelope: true })) {
      if (m?.uid) {
        allMessages.push({
          uid: m.uid,
          internetMessageId: normalizeInternetMessageId(m.envelope?.messageId),
        })
      }
    }
    allMessages.sort((a, b) => Number(b.uid) - Number(a.uid)) // 최신 우선

    // 2) 이미 저장된 것 제외 → 누락분만 대상으로
    const ids = allMessages.map(msg => `imap:${providerFolderId}:${msg.uid}`)
    const existing = await repo.getExistingProviderMessageIds({ tenantId, accountId: account.id, ids })
    const internetIds = allMessages.map(msg => msg.internetMessageId).filter(Boolean)
    const existingInternetIds = await repo.getExistingInternetMessageIds({ tenantId, accountId: account.id, ids: internetIds })
    let targetUids = allMessages
      .filter(msg => !existing.has(`imap:${providerFolderId}:${msg.uid}`))
      .filter(msg => !msg.internetMessageId || !existingInternetIds.has(msg.internetMessageId))
      .map(msg => msg.uid)

    // full이면 누락분 전부(안전 상한까지), 아니면 최신 limit개만
    const cap = full ? FULL_MAX : limit
    let truncated = false
    if (targetUids.length > cap) {
      targetUids = targetUids.slice(0, cap)
      truncated = true
    }
    const newCount = targetUids.length

    // 3) 누락분 본문을 배치로 가져와 저장
    let saved = 0
    const errors = []
    for (let i = 0; i < targetUids.length; i += FETCH_BATCH) {
      const chunk = targetUids.slice(i, i + FETCH_BATCH)
      for await (const msg of client.fetch(
        chunk.join(','),
        { uid: true, flags: true, internalDate: true, source: true, size: true },
        { uid: true },
      )) {
        if (!msg?.uid || !msg?.source) continue
        try {
          const source = Buffer.isBuffer(msg.source) ? msg.source : Buffer.from(msg.source)
          const parsed = await simpleParser(source)
          const parsedMessage = buildParsedMessage({
            account,
            providerFolderId,
            uid: msg.uid,
            source,
            parsed,
            flags: msg.flags,
            internalDate: msg.internalDate,
            size: msg.size,
          })
          await saveImapMessage({ tenantId, account, storage, folderMap, providerFolderId, source, parsedMessage })
          saved += 1
        } catch (err) {
          errors.push({ id: msg.uid, error: err.message })
        }
      }
    }

    if (truncated) {
      console.warn(`[imapSync] ${account.email_address} ${providerFolderId}: 누락분이 많아 이번엔 ${cap}건만 가져왔습니다(나머지는 다음 새로고침에서).`)
    }

    return {
      listed: allMessages.length,
      new: newCount,
      saved,
      failed: errors.length,
      errors: errors.slice(0, 10),
      truncated,
    }
  } finally {
    lock.release()
  }
}

async function syncImapAccount({ tenantId, account, limit = 50, full = false }) {
  const password = decryptSecret(account.password_encrypted)
  if (!password) throw new Error('메일 계정 암호가 저장되어 있지 않습니다.')
  if (!account.imap_host || !account.imap_port) throw new Error('IMAP 서버 설정이 없습니다.')

  const client = buildImapClient(account, password)

  await client.connect()
  try {
    const mailboxes = await client.list()

    const storage = getMailStorage()
    const folderMap = await repo.getFolderMap({ tenantId, accountId: account.id })
    const inbox = await syncMailbox({
      client,
      tenantId,
      account,
      storage,
      folderMap,
      mailboxPath: 'INBOX',
      providerFolderId: 'INBOX',
      limit,
      full,
    })
    const sentPath = pickSentMailbox(mailboxes)
    const sent = await syncMailbox({
      client,
      tenantId,
      account,
      storage,
      folderMap,
      mailboxPath: sentPath,
      providerFolderId: 'SENT',
      limit,
      full,
    })

    await repo.updateSyncState({ tenantId, accountId: account.id, markFullSync: true })
    await repo.recomputeUsage({ tenantId, accountId: account.id, userId: account.user_id })

    return {
      listed: inbox.listed + sent.listed,
      new: inbox.new + sent.new,
      saved: inbox.saved + sent.saved,
      failed: inbox.failed + sent.failed,
      folders: {
        inbox,
        sent: { ...sent, mailboxPath: sentPath },
      },
      errors: [...inbox.errors, ...sent.errors].slice(0, 10),
    }
  } finally {
    if (client.usable) {
      await client.logout().catch(() => {})
    } else {
      client.close()
    }
  }
}

module.exports = {
  syncImapAccount,
  pickSentMailbox,
  listImapFolders,
  syncImapFolder,
}
