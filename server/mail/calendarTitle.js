function compactTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function resolveCalendarEventTitle(actionItem, message) {
  return compactTitle(actionItem?.task) || compactTitle(message?.subject) || '메일 일정'
}

module.exports = { resolveCalendarEventTitle }
