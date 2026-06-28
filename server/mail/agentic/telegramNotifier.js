const threadRepo = require('./threadRepository')

function shouldNotify(report) {
  return (report?.important_issues || []).length > 0 || (report?.action_items || []).length > 0
}

async function notifyThreadUpdate({ tenantId, threadId, messageId, report }) {
  if (!shouldNotify(report)) return { skipped: true, reason: 'no_important_delta' }

  // 확장 지점: Telegram Bot API 설정이 연결되면 여기에서 전송한다.
  // 현재는 메일 분석 완료를 막지 않도록 이벤트 이력만 남긴다.
  await threadRepo.createEvent({
    tenantId,
    threadId,
    messageId,
    eventType: 'telegram_notify_completed',
    payload: {
      skipped: true,
      reason: 'telegram_adapter_not_configured',
    },
  })
  return { skipped: true, reason: 'telegram_adapter_not_configured' }
}

module.exports = { notifyThreadUpdate }
