const nodemailer = require('nodemailer')
const fs = require('fs')
const path = require('path')
const repo = require('./repository')
const db = require('../db')
const { getMailStorage } = require('./storage')
const { decryptSecret } = require('../lib/secrets')
const { moveMessageOnProvider } = require('./providerMove')

const CONFIG_PATH = path.resolve(__dirname, '../../config.json')

function normalize(value) {
  return String(value || '').trim().toLowerCase()
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function addressEmails(value) {
  return asArray(value).map(item => normalize(item?.email || item)).filter(Boolean)
}

function oneOfContains(haystack, needles) {
  const source = normalize(haystack)
  return asArray(needles).some(item => {
    const needle = normalize(item)
    return needle && source.includes(needle)
  })
}

function anyAddressMatches(addresses, conditions) {
  const normalizedAddresses = addresses.map(normalize).filter(Boolean)
  const normalizedConditions = asArray(conditions).map(normalize).filter(Boolean)
  if (!normalizedConditions.length) return false
  return normalizedAddresses.some(address => (
    normalizedConditions.some(condition => address === condition || address.includes(condition))
  ))
}

function matchRule(rule, message) {
  const activeConditions = [
    rule.sender_check_enabled,
    rule.cc_check_enabled,
    rule.keyword_check_enabled,
  ].filter(Boolean).length
  if (activeConditions === 0) return false

  if (rule.sender_check_enabled) {
    if (!anyAddressMatches([message.from_email], rule.sender_conditions)) return false
  }
  if (rule.cc_check_enabled) {
    if (!anyAddressMatches(addressEmails(message.cc_json), rule.cc_conditions)) return false
  }
  if (rule.keyword_check_enabled) {
    if (!oneOfContains(message.subject, rule.keyword_conditions)) return false
  }
  return true
}

async function loadObjectText(key) {
  if (!key) return ''
  try {
    return (await getMailStorage().getObject(key)).toString('utf8')
  } catch {
    return ''
  }
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

function analyzeMessage(message, bodyText) {
  const text = [message.subject, message.snippet, bodyText].filter(Boolean).join('\n')
  const actionItems = []
  const dateHints = []
  const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean).slice(0, 40)
  for (const line of lines) {
    if (/(요청|확인|처리|공유|회신|검토|등록|예약|약속|todo|action|please|check|review)/i.test(line)) {
      actionItems.push(line.slice(0, 180))
    }
    if (/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}월\s*\d{1,2}일|오늘|내일|오전|오후|AM|PM)/i.test(line)) {
      dateHints.push(line.slice(0, 180))
    }
  }
  return {
    summary: (message.snippet || bodyText || message.subject || '').slice(0, 500),
    action_items: [...new Set(actionItems)].slice(0, 10),
    date_hints: [...new Set(dateHints)].slice(0, 10),
  }
}

function escapeTelegramHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

async function notifyAnalysisToTelegram({ userId, message, analysis }) {
  let cfg = {}
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return { skipped: true, reason: 'config_not_found' }
  }
  const telegramCfg = cfg?.sns?.telegram || {}
  if (!telegramCfg.enabled) return { skipped: true, reason: 'telegram_disabled' }
  const botToken = String(process.env.TELEGRAM_BOT_TOKEN || telegramCfg.httpApiToken || '').trim()
  if (!botToken) return { skipped: true, reason: 'telegram_token_missing' }

  const userRow = await db.query(
    `SELECT telegram_id, use_sns_channel FROM users WHERE id = $1`,
    [userId],
  )
  const user = userRow.rows?.[0]
  if (!user || String(user.use_sns_channel || '').trim() !== 'telegram') {
    return { skipped: true, reason: 'user_telegram_disabled' }
  }
  const chatId = String(user.telegram_id || '').trim()
  if (!/^-?[0-9]+$/.test(chatId)) return { skipped: true, reason: 'chat_id_missing' }

  const lines = [
    '<b>MailClaw 중요 메모</b>',
    `제목: ${escapeTelegramHtml(message.subject || '(제목 없음)')}`,
    message.from_email ? `발신자: ${escapeTelegramHtml(message.from_email)}` : '',
    '',
    escapeTelegramHtml(analysis.summary || ''),
    analysis.action_items?.length ? `\n<b>ActionItem</b>\n${analysis.action_items.map(item => `- ${escapeTelegramHtml(item)}`).join('\n')}` : '',
    analysis.date_hints?.length ? `\n<b>날짜 후보</b>\n${analysis.date_hints.map(item => `- ${escapeTelegramHtml(item)}`).join('\n')}` : '',
  ].filter(Boolean)

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: lines.join('\n'),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) {
    throw new Error(data.description || `Telegram 전송 실패: ${res.status}`)
  }
  return { ok: true }
}

async function forwardOriginalMessage({ tenantId, account, message, to }) {
  if (!account.smtp_host || !account.smtp_port || !account.password_encrypted) {
    throw new Error('SMTP 설정 또는 앱 비밀번호가 없어 원본 메일을 전달할 수 없습니다.')
  }

  const [bodyText, bodyHtml, attachments] = await Promise.all([
    loadObjectText(message.body_text_object_key),
    loadObjectText(message.body_html_object_key),
    repo.listMessageAttachments({ tenantId, messageId: message.id }),
  ])
  const attachmentPayloads = []
  for (const attachment of attachments) {
    try {
      attachmentPayloads.push({
        filename: attachment.filename,
        contentType: attachment.content_type || undefined,
        content: await getMailStorage().getObject(attachment.object_key),
      })
    } catch (err) {
      console.warn('[MailClaw] attachment load failed:', err.message)
    }
  }

  const password = decryptSecret(account.password_encrypted)
  const transporter = nodemailer.createTransport({
    host: account.smtp_host,
    port: Number(account.smtp_port),
    secure: account.smtp_security === 'ssl',
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
  const originalFrom = [message.from_name, message.from_email ? `<${message.from_email}>` : ''].filter(Boolean).join(' ')
  const originalDate = message.received_at || message.sent_at || message.created_at || ''
  const headerText = [
    '---------- Forwarded message ---------',
    `From: ${originalFrom || '(unknown)'}`,
    `Date: ${originalDate}`,
    `Subject: ${message.subject || '(제목 없음)'}`,
    '',
  ].join('\n')
  const headerHtml = `
    <div style="border-top:1px solid #ddd;margin-top:16px;padding-top:12px;color:#555;font-size:13px">
      <div>---------- Forwarded message ---------</div>
      <div><strong>From:</strong> ${originalFrom || '(unknown)'}</div>
      <div><strong>Date:</strong> ${originalDate}</div>
      <div><strong>Subject:</strong> ${message.subject || '(제목 없음)'}</div>
    </div>
  `

  const info = await transporter.sendMail({
    from,
    to,
    subject: `Fwd: ${message.subject || '(제목 없음)'}`,
    text: `${headerText}${bodyText || stripHtmlToText(bodyHtml) || message.snippet || ''}`,
    html: bodyHtml ? `${headerHtml}${bodyHtml}` : undefined,
    attachments: attachmentPayloads,
  })
  return { messageId: info.messageId || null, accepted: info.accepted || [] }
}

async function executeRule({ tenantId, rule, message, force = false }) {
  const log = await repo.tryCreateMailClawExecutionLog({
    tenantId,
    ruleId: rule.id,
    messageId: message.id,
    matched: true,
    force,
  })
  if (!log) return { skipped: true, reason: 'already_executed' }

  const actionResults = []
  const errors = []
  const account = await repo.getAccountForSync({
    tenantId,
    accountId: message.account_id,
    userId: message.user_id,
  })

  // MailService.md 9.2.1 실행 순서:
  // 1) AI 메일 분석 → 2) 중요 메일 등록 → 3) 원본 전달(켜진 경우) → 4) 지정된 폴더로 이동.
  // 따라서 원본 전달이 꺼져 있으면 AI 분석 → 중요 메일 등록 → 지정된 폴더 이동 순서가 된다.
  if (rule.ai_analysis_enabled) {
    try {
      const bodyText = await loadObjectText(message.body_text_object_key)
      const analysis = analyzeMessage(message, bodyText)
      let telegram = null
      try {
        telegram = await notifyAnalysisToTelegram({ userId: message.user_id, message, analysis })
      } catch (err) {
        telegram = { ok: false, error: err.message }
      }
      actionResults.push({ action: 'ai_analysis', ok: true, analysis, telegram })
    } catch (err) {
      errors.push(err)
      actionResults.push({ action: 'ai_analysis', ok: false, error: err.message })
    }
  }

  if (rule.important_mail_enabled) {
    try {
      const updated = await repo.setMessagesStarred({
        tenantId,
        userId: message.user_id,
        messageIds: [message.id],
        starred: true,
      })
      if (!updated.length) throw new Error('중요 메일 상태를 갱신하지 못했습니다.')
      actionResults.push({ action: 'important_mail', ok: true, is_starred: true })
    } catch (err) {
      errors.push(err)
      actionResults.push({ action: 'important_mail', ok: false, error: err.message })
    }
  }

  if (rule.forward_enabled) {
    try {
      const result = await forwardOriginalMessage({
        tenantId,
        account,
        message,
        to: asArray(rule.forward_addresses),
      })
      actionResults.push({ action: 'forward_original', ok: true, result })
    } catch (err) {
      errors.push(err)
      actionResults.push({ action: 'forward_original', ok: false, error: err.message })
    }
  }

  if (rule.move_folder_enabled) {
    try {
      const configuredFolder = await repo.getFolderByIdForUser({
        tenantId,
        folderId: rule.target_folder_id,
        userId: message.user_id,
      })
      if (!configuredFolder) throw new Error('대상 폴더를 찾지 못했습니다.')
      const isTrashTarget = configuredFolder.type === 'trash' || configuredFolder.provider_folder_id === 'TRASH'
      const targetFolder = isTrashTarget
        ? await repo.resolveFolderForAccount({
            tenantId,
            accountId: message.account_id,
            folderId: rule.target_folder_id,
          })
        : configuredFolder
      if (!targetFolder) throw new Error('대상 폴더를 찾지 못했습니다.')
      const providerMove = await moveMessageOnProvider({
        tenantId,
        account,
        message,
        targetFolder,
      })
      const moved = targetFolder.account_id && targetFolder.account_id !== message.account_id
        ? await repo.moveMessageToAccountFolder({
            tenantId,
            messageId: message.id,
            targetAccountId: targetFolder.account_id,
            targetFolderId: targetFolder.id,
            userId: message.user_id,
            providerMessageId: providerMove?.providerMessageId,
          })
        : await repo.moveMessageToFolder({
            tenantId,
            messageId: message.id,
            targetFolderId: targetFolder.id,
            userId: message.user_id,
            providerMessageId: providerMove?.providerMessageId,
          })
      if (!moved) throw new Error('대상 폴더로 메일 정보를 갱신하지 못했습니다.')
      actionResults.push({ action: 'move_folder', ok: true, folder_id: moved.folder_id, provider: providerMove })
    } catch (err) {
      errors.push(err)
      actionResults.push({ action: 'move_folder', ok: false, error: err.message })
    }
  }

  // 스마트 폴더 태그 부여(+각 계정 내 아카이브 옵션) — MailService.md 13.6.
  if (rule.tag_smart_folder_enabled && rule.tag_smart_folder_id) {
    try {
      const tagResult = await repo.tagMessagesToSmartFolder({
        tenantId,
        userId: message.user_id,
        smartFolderId: rule.tag_smart_folder_id,
        messageIds: [message.id],
      })
      let archived = false
      if (rule.tag_archive_enabled && tagResult.tagged.length > 0) {
        // 각 계정 내 아카이브: 자기 계정의 보관함(type='archive')으로 이동(같은 계정 = 안전 경로). 하드 삭제 없음.
        const archiveFolder = await repo.getFolderByTypeForAccount({
          tenantId,
          accountId: message.account_id,
          type: 'archive',
        })
        if (archiveFolder?.id && message.folder_id !== archiveFolder.id) {
          const providerMove = await moveMessageOnProvider({ tenantId, account, message, targetFolder: archiveFolder })
          const moved = await repo.moveMessageToFolder({
            tenantId,
            messageId: message.id,
            targetFolderId: archiveFolder.id,
            userId: message.user_id,
            providerMessageId: providerMove?.providerMessageId,
          })
          archived = !!moved
        }
      }
      actionResults.push({ action: 'tag_smart_folder', ok: true, smart_folder_id: rule.tag_smart_folder_id, archived })
    } catch (err) {
      errors.push(err)
      actionResults.push({ action: 'tag_smart_folder', ok: false, error: err.message })
    }
  }

  const enabledActions = [
    rule.ai_analysis_enabled,
    rule.important_mail_enabled,
    rule.forward_enabled,
    rule.move_folder_enabled,
    rule.tag_smart_folder_enabled,
  ].filter(Boolean).length
  const status = errors.length === 0
    ? 'completed'
    : errors.length >= enabledActions
      ? 'failed'
      : 'partial_failed'
  await repo.finishMailClawExecutionLog({
    tenantId,
    id: log.id,
    status,
    actionResults,
    errorMessage: errors.map(err => err.message).join('\n') || null,
  })
  return { status, actionResults }
}

async function executeMailClawForMessage({ tenantId, messageId }) {
  if (!tenantId || !messageId) return { matched: 0 }
  const message = await repo.getMessageForAgentic({ tenantId, messageId })
  if (!message) return { matched: 0, missing: true }
  const rules = await repo.listEnabledMailClawRules({ tenantId })
  let matched = 0
  const results = []
  for (const rule of rules) {
    if (rule.owner_user_id !== message.user_id) continue
    if (!matchRule(rule, message)) continue
    matched += 1
    results.push({ ruleId: rule.id, ...(await executeRule({ tenantId, rule, message })) })
  }
  return { matched, results }
}

async function executeMailClawRuleForMessage({ tenantId, ruleId, messageId, userId, isSiteAdmin = false, force = false }) {
  if (!tenantId || !ruleId || !messageId) return { matched: false, error: 'missing_required_fields' }
  const [rule, message] = await Promise.all([
    repo.getMailClawRule({ tenantId, id: ruleId, userId, isSiteAdmin }),
    repo.getMessageForAgentic({ tenantId, messageId }),
  ])
  if (!rule) return { matched: false, error: 'rule_not_found' }
  if (!message) return { matched: false, error: 'message_not_found' }
  if (rule.owner_user_id !== message.user_id && !isSiteAdmin) {
    return { matched: false, error: 'message_not_allowed' }
  }
  if (!rule.enabled) return { matched: false, skipped: true, reason: 'rule_disabled' }
  if (!matchRule(rule, message)) return { matched: false, skipped: true, reason: 'condition_not_matched' }
  return {
    matched: true,
    ruleId: rule.id,
    ...(await executeRule({ tenantId, rule, message, force })),
  }
}

// 폴더 전체에 규칙을 적용한다. 규칙/권한은 1회만 확인하고, 메시지는 배치로 한 번에
// 읽어 메모리에서 매칭하며, 실제 동작(이동/전달/분석)은 매칭된 메일에만 수행한다.
// onProgress(progress)로 진행 상황을 주기적으로 보고한다.
async function executeMailClawRuleForMessages({
  tenantId,
  ruleId,
  messageIds,
  userId,
  isSiteAdmin = false,
  force = false,
  onProgress = null,
}) {
  const ids = Array.from(new Set((messageIds || []).map(id => String(id || '').trim()).filter(Boolean)))
  const summary = { total: ids.length, done: 0, matched: 0, skipped: 0, failed: 0 }
  if (!tenantId || !ruleId) return { ...summary, error: 'missing_required_fields' }

  const rule = await repo.getMailClawRule({ tenantId, id: ruleId, userId, isSiteAdmin })
  if (!rule) return { ...summary, error: 'rule_not_found' }
  if (!rule.enabled) return { ...summary, error: 'rule_disabled' }
  if (ids.length === 0) return summary

  // 매칭에 필요한 필드를 한 번에(청크 단위) 읽는다.
  const messages = await repo.getMessagesForAgenticBatch({ tenantId, messageIds: ids })
  const byId = new Map(messages.map(m => [m.id, m]))

  const emit = () => { if (typeof onProgress === 'function') onProgress({ ...summary }) }
  emit()

  let sinceEmit = 0
  for (const id of ids) {
    const message = byId.get(id)
    if (!message) {
      summary.skipped += 1
    } else if (rule.owner_user_id !== message.user_id && !isSiteAdmin) {
      summary.skipped += 1
    } else if (!matchRule(rule, message)) {
      summary.skipped += 1
    } else {
      // 매칭된 메일만 실제 동작 수행(이동 등 provider 호출 포함).
      try {
        const result = await executeRule({ tenantId, rule, message, force })
        summary.matched += 1
        if (result?.status === 'failed' || result?.status === 'partial_failed') summary.failed += 1
      } catch {
        summary.matched += 1
        summary.failed += 1
      }
    }
    summary.done += 1
    sinceEmit += 1
    // 매칭 안 된 메일은 매우 빠르므로 매 건 보고하지 않고 일정 간격으로만 보고한다.
    if (sinceEmit >= 25 || summary.done === ids.length) {
      sinceEmit = 0
      emit()
    }
  }
  return summary
}

module.exports = {
  executeMailClawForMessage,
  executeMailClawRuleForMessage,
  executeMailClawRuleForMessages,
  matchRule,
}
