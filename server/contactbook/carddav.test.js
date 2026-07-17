const test = require('node:test')
const assert = require('node:assert/strict')
const { updateResource, getResource } = require('./carddav')

test('Google update sends a conditional vCard PUT and confirms with GET', async t => {
  process.env.CONTACTBOOK_ALLOW_PRIVATE_HOSTS = '1'
  const originalFetch = global.fetch
  const calls = []
  global.fetch = async (url, options) => {
    calls.push({ url, options })
    if (options.method === 'PUT') return new Response(null, { status: 204, headers: { etag: '"new"' } })
    return new Response('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Test\r\nEND:VCARD\r\n', { status: 200, headers: { etag: '"new"' } })
  }
  t.after(() => { global.fetch = originalFetch; delete process.env.CONTACTBOOK_ALLOW_PRIVATE_HOSTS })
  const account = { auth_type: 'OAUTH2', secret: 'access-token' }
  await updateResource(account, 'https://carddav.test/contact.vcf', 'BEGIN:VCARD\r\nEND:VCARD\r\n', '"old"')
  const confirmed = await getResource(account, 'https://carddav.test/contact.vcf')
  assert.equal(calls[0].options.method, 'PUT')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer access-token')
  assert.equal(calls[0].options.headers['If-Match'], '"old"')
  assert.equal(calls[0].options.headers['Content-Type'], 'text/vcard; charset=utf-8')
  assert.equal(calls[1].options.method, 'GET')
  assert.match(confirmed.xml, /FN:Test/)
})

test('conditional update exposes a 412 conflict without credentials', async t => {
  process.env.CONTACTBOOK_ALLOW_PRIVATE_HOSTS = '1'
  const originalFetch = global.fetch
  global.fetch = async () => new Response('precondition failed', { status: 412 })
  t.after(() => { global.fetch = originalFetch; delete process.env.CONTACTBOOK_ALLOW_PRIVATE_HOSTS })
  await assert.rejects(
    updateResource({ auth_type: 'OAUTH2', secret: 'hidden' }, 'https://carddav.test/contact.vcf', 'vcard', '"old"'),
    error => error.status === 412 && error.carddavResponse === 'precondition failed',
  )
})
