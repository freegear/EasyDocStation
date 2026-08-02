const test = require('node:test')
const assert = require('node:assert/strict')
const { describeMailSyncError } = require('./syncError')

test('IMAP 인증 실패의 서버 코드와 사용자 조치를 보존한다', () => {
  const message = describeMailSyncError({
    message: 'Command failed',
    responseText: 'Authentication Failed',
    response: '1 NO [AUTHENTICATIONFAILED] Authentication Failed',
    authenticationFailed: true,
    serverResponseCode: 'AUTHENTICATIONFAILED',
  })

  assert.match(message, /인증에 실패/)
  assert.match(message, /앱 전용 암호/)
  assert.match(message, /AUTHENTICATIONFAILED/)
  assert.doesNotMatch(message, /^Command failed$/)
})

test('일반 IMAP 서버 응답은 Command failed 대신 구체 응답을 사용한다', () => {
  const message = describeMailSyncError({
    message: 'Command failed',
    responseText: 'Lookup failed request-123',
  })

  assert.equal(message, 'Lookup failed request-123')
})
