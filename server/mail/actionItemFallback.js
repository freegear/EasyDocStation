const PLACEHOLDER_PATTERNS = [
  /^추가로\s*확인된\s*조치\s*없음[.!]?$/i,
  /^확인된\s*(?:내용|조치)\s*없음[.!]?$/i,
  /^no\s+(?:additional\s+action\s+confirmed|confirmed\s+(?:information|action))[.!]?$/i,
  /^(?:追加対応は確認できません|確認できる内容なし|確認できる対応なし)[。.]?$/i,
]

function compactTask(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function isPlaceholderActionTask(value) {
  const task = compactTask(value)
  return !task || PLACEHOLDER_PATTERNS.some(pattern => pattern.test(task))
}

function taskFromItem(item) {
  return typeof item === 'string' ? item : item?.task
}

function applyActionItemSummaryFallback(summary, noInfo = '확인된 내용 없음') {
  if (!summary || typeof summary !== 'object') return summary
  const actionItems = Array.isArray(summary.actionItems) ? summary.actionItems : []
  const meaningfulItems = actionItems.filter(item => !isPlaceholderActionTask(taskFromItem(item)))
  if (meaningfulItems.length) return { ...summary, actionItems: meaningfulItems }

  const summaryTask = compactTask(summary.summary)
  const keyPointTask = (Array.isArray(summary.keyPoints) ? summary.keyPoints : [])
    .map(compactTask)
    .find(item => !isPlaceholderActionTask(item))
  const fallbackTask = !isPlaceholderActionTask(summaryTask) ? summaryTask : keyPointTask
  if (!fallbackTask) {
    return { ...summary, actionItems: [{ task: noInfo, time: noInfo }] }
  }

  return {
    ...summary,
    actionItems: [{
      task: fallbackTask,
      time: noInfo,
      taskSource: 'summary_fallback',
    }],
  }
}

module.exports = { applyActionItemSummaryFallback, isPlaceholderActionTask }
