const test = require('node:test')
const assert = require('node:assert/strict')
const { extractRemoteImageCandidates, isBlockedAddress, detectImage } = require('./remoteImages')

test('대형 원격 포스터와 추적 픽셀을 구분한다', () => {
  const candidates = extractRemoteImageCandidates(`
    <img src="https://img.example.com/event-poster.png">
    <img src="https://mailer.example.com/receipt_confirm.php?email=user%40example.com" width="3" height="3">
  `)
  assert.equal(candidates.length, 2)
  assert.equal(candidates[0].tracking, false)
  assert.equal(candidates[1].tracking, true)
  assert.equal(candidates[0].hostname, 'img.example.com')
  assert.match(candidates[0].id, /^[a-f0-9]{64}$/)
})

test('중복 URL과 fragment를 정규화하여 후보를 한 번만 만든다', () => {
  const candidates = extractRemoteImageCandidates(`
    <img src="https://img.example.com/poster.png#top">
    <img src="https://img.example.com/poster.png#bottom">
  `)
  assert.equal(candidates.length, 1)
})

test('내부망과 특수 IP 주소를 차단한다', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1']) {
    assert.equal(isBlockedAddress(address), true, address)
  }
  assert.equal(isBlockedAddress('8.8.8.8'), false)
  assert.equal(isBlockedAddress('2001:4860:4860::8888'), false)
})

test('PNG signature와 실제 크기를 판별한다', () => {
  const buffer = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer)
  buffer.writeUInt32BE(1600, 16)
  buffer.writeUInt32BE(2200, 20)
  assert.deepEqual(detectImage(buffer), { contentType: 'image/png', width: 1600, height: 2200, extension: 'png' })
})
