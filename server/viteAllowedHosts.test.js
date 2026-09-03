const test = require('node:test')
const assert = require('node:assert/strict')

const {
  resolveViteAllowedHosts,
  validateViteAllowedHosts,
  isAllowedFrontendHost,
} = require('./viteAllowedHosts')

test('config의 allowedHosts를 정규화하고 중복을 제거한다', () => {
  assert.deepEqual(
    resolveViteAllowedHosts({ vite: { allowedHosts: [' APP.OPTIUS.AI ', 'app.optius.ai', '.Example.com'] } }),
    ['app.optius.ai', '.example.com'],
  )
})

test('관리자 저장용 검증은 URL, 포트, 경로와 빈 목록을 거부한다', () => {
  for (const invalid of ['https://app.optius.ai', 'app.optius.ai:5173', 'app.optius.ai/path']) {
    assert.throws(() => validateViteAllowedHosts([invalid]), /형식이 올바르지 않습니다/)
  }
  assert.throws(() => validateViteAllowedHosts([]), /한 개 이상/)
})

test('프로덕션 프론트 서버는 명시된 도메인만 허용하고 로컬·IP 접근은 유지한다', () => {
  const allowedHosts = ['app.optius.ai', '.easystation.co.kr']
  assert.equal(isAllowedFrontendHost('app.optius.ai', allowedHosts), true)
  assert.equal(isAllowedFrontendHost('www.easystation.co.kr:5173', allowedHosts), true)
  assert.equal(isAllowedFrontendHost('127.0.0.1:5173', allowedHosts), true)
  assert.equal(isAllowedFrontendHost('unknown.invalid', allowedHosts), false)
})
