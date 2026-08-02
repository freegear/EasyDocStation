const repo = require('./repository')
const { decryptSecret, encryptSecret } = require('../lib/secrets')
const { withImapClient } = require('./imapClient')
const {
  refreshAccessToken,
  gmailPatchLabel,
  gmailDeleteLabel,
} = require('./gmailOAuth')

const TOKEN_SKEW_MS = 60 * 1000

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

function isImapProvider(provider) {
  return ['naver', 'apple', 'imap', 'other'].includes(provider)
}

// Gmail 사용자 라벨 이름 변경. 라벨 id(provider_folder_id)는 불변, name만 바뀐다.
async function renameGmailLabel({ tenantId, account, folder, newName }) {
  const accessToken = await ensureGmailAccessToken({ tenantId, account })
  const labelId = folder.provider_folder_id
  if (!labelId) throw new Error('Gmail 라벨 ID가 없습니다.')
  try {
    const label = await gmailPatchLabel(accessToken, labelId, { name: newName })
    return { provider: 'gmail', providerFolderId: labelId, name: label?.name || newName }
  } catch (err) {
    if (isInsufficientGmailScope(err)) {
      throw new Error('Gmail 라벨 수정 권한이 없습니다. Gmail 계정을 재연결해서 gmail.modify 권한을 승인해주세요.')
    }
    // Gmail은 시스템 라벨/중복 이름을 400/409로 거부한다. 메시지를 그대로 전달한다.
    throw err
  }
}

// IMAP delimiter를 확인해 같은 부모 아래 새 leaf 경로를 만든다.
function resolveNewImapPath(currentPath, newLeafName, delimiter) {
  const delim = delimiter || '/'
  const segs = String(currentPath || '').split(delim)
  if (segs.length <= 1) return newLeafName
  segs[segs.length - 1] = newLeafName
  return segs.join(delim)
}

// IMAP 메일함 이름 변경. 경로가 곧 식별자라 provider_folder_id(=경로)가 바뀐다.
// 1차 범위: 하위 메일함이 없는 폴더만 허용한다.
async function renameImapMailbox({ account, folder, newName }) {
  const password = decryptSecret(account.password_encrypted)
  if (!password) throw new Error('메일 계정 암호가 저장되어 있지 않습니다.')

  return withImapClient(account, password, async client => {
    const mailboxes = await client.list()
    const currentPath = folder.provider_folder_id
    const current = mailboxes.find(box => String(box.path) === String(currentPath))
    if (!current) throw new Error('IMAP 메일함을 찾지 못했습니다.')

    const delimiter = current.delimiter || '/'
    // 이름에 구분자가 들어가면 계층 이동이 되어 버리므로 거부한다(1차 범위 밖).
    if (String(newName).includes(delimiter)) {
      throw new Error(`폴더 이름에 구분자('${delimiter}')를 포함할 수 없습니다.`)
    }
    // 하위 메일함이 있으면 경로 프리픽스 연쇄 재매핑이 필요하므로 1차에서는 거부한다.
    const hasChildren = mailboxes.some(box => String(box.path || '').startsWith(`${currentPath}${delimiter}`))
    if (hasChildren) {
      throw new Error('하위 폴더가 있는 폴더는 아직 이름을 변경할 수 없습니다.')
    }

    const newPath = resolveNewImapPath(currentPath, newName, delimiter)
    if (newPath === currentPath) return { provider: 'imap', providerFolderId: currentPath, name: newName }
    // 대상 경로가 이미 존재하면 충돌이므로 거부한다.
    if (mailboxes.some(box => String(box.path) === newPath)) {
      throw new Error('같은 이름의 폴더가 이미 있습니다.')
    }

    const info = await client.mailboxRename(currentPath, newPath)
    const finalPath = info?.newPath || newPath
    return { provider: 'imap', providerFolderId: finalPath, name: newName }
  })
}

// 폴더 이름을 프로바이더에 반영한다. 로컬 전용 폴더는 호출 전 라우트에서 걸러진다.
// 반환: { provider, providerFolderId, name } — 로컬 DB 정합에 사용.
async function renameFolderOnProvider({ tenantId, account, folder, newName }) {
  if (!folder) throw new Error('대상 폴더를 찾지 못했습니다.')
  if (account.provider === 'gmail') {
    return renameGmailLabel({ tenantId, account, folder, newName })
  }
  if (isImapProvider(account.provider)) {
    return renameImapMailbox({ account, folder, newName })
  }
  return { skipped: true, reason: `unsupported_provider:${account.provider}` }
}

// Gmail 라벨 삭제. 라벨만 제거되고 메일은 전체보관함에 남는다(비파괴). (MailService.md 16.11)
async function deleteGmailLabel({ tenantId, account, folder }) {
  const accessToken = await ensureGmailAccessToken({ tenantId, account })
  const labelId = folder.provider_folder_id
  if (!labelId) throw new Error('Gmail 라벨 ID가 없습니다.')
  try {
    await gmailDeleteLabel(accessToken, labelId)
    return { provider: 'gmail', destructive: false }
  } catch (err) {
    if (isInsufficientGmailScope(err)) {
      throw new Error('Gmail 라벨 삭제 권한이 없습니다. Gmail 계정을 재연결해서 gmail.modify 권한을 승인해주세요.')
    }
    // 이미 삭제된 라벨(404)은 성공으로 간주한다(멱등).
    if (err?.status === 404) return { provider: 'gmail', destructive: false, alreadyGone: true }
    throw err
  }
}

// IMAP 서버가 메일함 삭제를 거부하는 응답을 식별한다(예: 네이버 예약 메일함).
// isMailboxMissingError(imapSync.js)와 동일한 패턴. NONEXISTENT(없음)와는 구분한다.
function isMailboxDeleteRejectedError(err) {
  if (!err) return false
  const text = `${err.responseText || ''} ${err.response || ''} ${err.message || ''}`
  if (/NONEXISTENT|mailbox doesn'?t exist|no such mailbox/i.test(text)) return false
  return /cannot delete|can't delete|not allowed|permission denied|reserved/i.test(text)
    || /\bNO\b.*DELETE/i.test(text)
}

// IMAP 메일함 삭제. 메일함과 그 안의 메일이 서버에서 함께 삭제된다(파괴적). (MailService.md 16.11)
// 1차 범위: 하위 메일함이 없는 폴더만 허용한다.
// 서버가 삭제를 거부하면 예외 대신 { rejected: true, message } 를 반환해 라우트에서 409로 안내한다.
async function deleteImapMailbox({ account, folder }) {
  const password = decryptSecret(account.password_encrypted)
  if (!password) throw new Error('메일 계정 암호가 저장되어 있지 않습니다.')

  return withImapClient(account, password, async client => {
    const mailboxes = await client.list()
    const currentPath = folder.provider_folder_id
    const current = mailboxes.find(box => String(box.path) === String(currentPath))
    // 이미 서버에 없으면 멱등하게 성공 처리(로컬만 정리).
    if (!current) return { provider: 'imap', destructive: true, alreadyGone: true }

    const delimiter = current.delimiter || '/'
    // 하위 메일함(직속/후손 모두) 탐색. deleteImapMailbox의 이 가드는 폴더 발견(listImapFolders)과
    // 다른 트리를 본다: 발견은 \Noselect(선택 불가·컨테이너 전용) 메일함을 건너뛰므로 사이드바에는
    // 안 보이지만, 여기서는 원본 LIST에 남아 삭제를 막는다. 그래서 "안 보이는 하위 폴더" 때문에
    // 막히는 혼란이 생긴다 → 어떤 하위 폴더가 막는지 이름을 함께 돌려줘 사용자가 조치할 수 있게 한다.
    // (MailService.md 22)
    const childBoxes = mailboxes.filter(box => String(box.path || '').startsWith(`${currentPath}${delimiter}`))
    if (childBoxes.length > 0) {
      const isNoselect = box => !!(box.flags && typeof box.flags.has === 'function' && box.flags.has('\\Noselect'))
      // 표시용 이름은 부모 경로를 뺀 상대 경로(예: Mailbox/2019 → 2019)로 만든다.
      const childNames = childBoxes.map(box => String(box.path || '').slice(currentPath.length + delimiter.length))
      const allNoselect = childBoxes.every(isNoselect)
      const preview = childNames.slice(0, 5).join(', ') + (childNames.length > 5 ? ` 외 ${childNames.length - 5}개` : '')
      const hint = allNoselect
        ? '(사이드바에 표시되지 않는 서버 전용/컨테이너 폴더입니다. 다른 메일 클라이언트에서 정리해야 할 수 있습니다.)'
        : '먼저 하위 폴더를 삭제한 뒤 다시 시도하세요.'
      return {
        provider: 'imap',
        rejected: true,
        reason: 'has_children',
        children: childNames,
        allNoselect,
        message: `하위 폴더 ${childBoxes.length}개가 있어 삭제할 수 없습니다: ${preview}. ${hint}`,
      }
    }

    try {
      await client.mailboxDelete(currentPath)
    } catch (err) {
      // 서버가 삭제를 거부(예: 네이버 예약 메일함 'Cannot delete this mailbox.')하면 500 대신 명확히 안내한다.
      if (isMailboxDeleteRejectedError(err)) {
        return { provider: 'imap', rejected: true, reason: 'server_rejected', message: '이 메일함은 서버에서 삭제할 수 없습니다.' }
      }
      throw err
    }
    return { provider: 'imap', destructive: true }
  })
}

// 폴더를 프로바이더에서 삭제한다. 로컬 전용 폴더는 호출 전 라우트에서 걸러진다.
// 반환: { provider, destructive } — destructive=true면 로컬 메일 행도 삭제해야 한다(IMAP).
async function deleteFolderOnProvider({ tenantId, account, folder }) {
  if (!folder) throw new Error('대상 폴더를 찾지 못했습니다.')
  if (account.provider === 'gmail') {
    return deleteGmailLabel({ tenantId, account, folder })
  }
  if (isImapProvider(account.provider)) {
    return deleteImapMailbox({ account, folder })
  }
  return { skipped: true, reason: `unsupported_provider:${account.provider}` }
}

module.exports = {
  renameFolderOnProvider,
  deleteFolderOnProvider,
}
