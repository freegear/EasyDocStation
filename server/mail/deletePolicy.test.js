const test = require('node:test')
const assert = require('node:assert/strict')

const { isRetryableMailDeleteError, runMailDeleteWithRetry } = require('./deletePolicy')

test('원격 부재와 메일함 탐색 실패는 자동 재시도하지 않는다', () => {
  assert.equal(isRetryableMailDeleteError({ code: 'IMAP_MESSAGE_NOT_FOUND' }), false)
  assert.equal(isRetryableMailDeleteError({ code: 'IMAP_TRASH_MAILBOX_NOT_FOUND' }), false)
  assert.equal(isRetryableMailDeleteError({ code: 'IMAP_MOVE_SUCCEEDED_UID_PENDING' }), false)
})

test('연결, 인증, 서버 오류는 재시도 대상으로 분류한다', () => {
  assert.equal(isRetryableMailDeleteError({ code: 'ETIMEDOUT' }), true)
  assert.equal(isRetryableMailDeleteError({ code: 'EAUTH' }), true)
  assert.equal(isRetryableMailDeleteError({ status: 503 }), true)
})

test('일시 오류 뒤 삭제 작업을 자동 재시도한다', async () => {
  let calls = 0
  const result = await runMailDeleteWithRetry(async () => {
    calls += 1
    if (calls < 3) {
      const err = new Error('connection temporarily unavailable')
      err.code = 'ECONNRESET'
      throw err
    }
    return { ok: true }
  }, { delaysMs: [1, 1], sleep: async () => {} })
  assert.deepEqual(result, { ok: true })
  assert.equal(calls, 3)
})

test('재시도가 모두 실패하면 보존 가능한 실패 정보를 남긴다', async () => {
  await assert.rejects(
    runMailDeleteWithRetry(async () => {
      const err = new Error('authentication failed')
      err.code = 'EAUTH'
      throw err
    }, { delaysMs: [1], sleep: async () => {} }),
    err => err.retryable === true && err.attempts === 2,
  )
})
