import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_VITE_ALLOWED_HOSTS, resolveViteAllowedHosts } from './vite-allowed-hosts.mjs'

const silentLogger = { warn() {} }

test('config.json의 Vite 허용 호스트를 정규화하고 중복을 제거한다', () => {
  assert.deepEqual(resolveViteAllowedHosts({
    vite: { allowedHosts: [' APP.OPTIUS.AI ', 'app.optius.ai', '.example.com'] },
  }, silentLogger), ['app.optius.ai', '.example.com'])
})

test('URL, 포트, 경로 또는 빈 배열은 허용하지 않는다', () => {
  assert.deepEqual(resolveViteAllowedHosts({
    vite: { allowedHosts: ['https://app.optius.ai', 'app.optius.ai:5173', 'app.optius.ai/path'] },
  }, silentLogger), DEFAULT_VITE_ALLOWED_HOSTS)
})

test('설정이 없거나 배열이 아니면 안전한 기본값을 사용한다', () => {
  assert.deepEqual(resolveViteAllowedHosts({}, silentLogger), DEFAULT_VITE_ALLOWED_HOSTS)
  assert.deepEqual(resolveViteAllowedHosts({ vite: { allowedHosts: true } }, silentLogger), DEFAULT_VITE_ALLOWED_HOSTS)
})
