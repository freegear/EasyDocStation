function renderReportMarkdown({ thread, report }) {
  const lines = [
    '# 메일 타래 요약 보고',
    '',
    '## 기본 정보',
    `- 제목: ${thread?.normalized_subject || ''}`,
    `- 계정: ${thread?.account_id || ''}`,
    `- 마지막 업데이트: ${new Date().toLocaleString('ko-KR')}`,
    '',
    '## 중요 이슈',
    ...(report.important_issues || []).map(item => `- ${item.title || item.description || ''}`),
    '',
    '## 진행 사항 요약',
    ...(report.progress_summary || []).map(item => `- ${item.date ? `${item.date}: ` : ''}${item.description || ''}`),
    '',
    '## Action Item',
    ...(report.action_items || []).map(item => `- [${item.status === 'done' ? 'x' : ' '}] ${item.title || ''}`),
    '',
    '## 할 일 목록',
    ...(report.todo_items || []).map(item => `- [ ] ${item.title || ''}`),
    '',
    '## 결정 사항',
    ...(report.decisions || []).map(item => `- ${item.title || item.description || item}`),
    '',
    '## 리스크',
    ...(report.risks || []).map(item => `- ${item.title || item.description || item}`),
    '',
    '## 미해결 질문',
    ...(report.open_questions || []).map(item => `- ${item.title || item.description || item}`),
  ]
  return lines.join('\n')
}

module.exports = { renderReportMarkdown }
