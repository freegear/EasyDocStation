const test = require('node:test')
const assert = require('node:assert/strict')

process.env.CONTACTBOOK_ALLOW_PRIVATE_HOSTS = '1'
const { deleteResource } = require('./carddav')

const account = { auth_type: 'OAUTH2', secret: 'token' }

test('CardDAV 연락처를 ETag 조건부 DELETE로 삭제한다', async () => {
  const originalFetch = global.fetch
  let request
  global.fetch = async (url, options) => {
    request = { url, options }
    return new Response(null, { status: 204 })
  }
  try {
    const result = await deleteResource(account, 'https://contacts.example.test/book/contact.vcf', '"etag-1"')
    assert.equal(result.status, 204)
    assert.equal(request.options.method, 'DELETE')
    assert.equal(request.options.headers['If-Match'], '"etag-1"')
  } finally { global.fetch = originalFetch }
})

test('이미 삭제된 원격 연락처는 삭제 성공으로 취급한다', async () => {
  const originalFetch = global.fetch
  global.fetch = async () => new Response('', { status: 404 })
  try {
    const result = await deleteResource(account, 'https://contacts.example.test/book/missing.vcf', '"etag-2"')
    assert.equal(result.alreadyDeleted, true)
  } finally { global.fetch = originalFetch }
})

test('ETag 없는 삭제 요청은 거부한다', async () => {
  await assert.rejects(() => deleteResource(account, 'https://contacts.example.test/book/contact.vcf', ''), /ETag/)
})
