function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function describeMailSyncError(err) {
  if (!err) return '알 수 없는 메일 동기화 오류가 발생했습니다.'

  const responseText = compact(err.responseText)
  const response = compact(err.response)
  const message = compact(err.message)
  const serverCode = compact(err.serverResponseCode)
  const authenticationFailed = err.authenticationFailed === true
    || /AUTHENTICATIONFAILED|authentication failed/i.test(`${responseText} ${response} ${message}`)

  if (authenticationFailed) {
    const code = serverCode || (/AUTHENTICATIONFAILED/i.test(response) ? 'AUTHENTICATIONFAILED' : '')
    const detail = responseText && !/^authentication failed$/i.test(responseText) ? `: ${responseText}` : ''
    return `메일 계정 인증에 실패했습니다${detail}. 비밀번호 또는 앱 전용 암호를 확인해주세요.${code ? ` (${code})` : ''}`
  }

  if (responseText) return responseText
  if (response && !message) return response
  if (message && !/^command failed$/i.test(message)) return message
  if (response) return response
  return message || '알 수 없는 메일 동기화 오류가 발생했습니다.'
}

module.exports = { describeMailSyncError }
