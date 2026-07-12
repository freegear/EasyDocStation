const dns = require('dns').promises
const net = require('net')
const { XMLParser } = require('fast-xml-parser')

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, attributeNamePrefix: '@_', processEntities: false })

function array(value) { return value == null ? [] : (Array.isArray(value) ? value : [value]) }
function text(value) {
  if (typeof value === 'string') return value
  return value?.['#text'] || ''
}
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number)
    return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168)
  }
  return ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')
}
async function assertSafeUrl(raw) {
  const url = new URL(raw)
  if (url.protocol !== 'https:') throw new Error('HTTPS CardDAV 주소만 사용할 수 있습니다.')
  if (!process.env.CONTACTBOOK_ALLOW_PRIVATE_HOSTS) {
    const found = await dns.lookup(url.hostname, { all: true })
    if (found.some(x => isPrivateIp(x.address))) throw new Error('내부 네트워크 CardDAV 주소는 허용되지 않습니다.')
  }
  return url
}
function resolveHref(base, href) { return new URL(text(href), base).toString() }
function authHeaders(account) {
  if (account.auth_type === 'OAUTH2') return { Authorization: `Bearer ${account.secret}` }
  return { Authorization: `Basic ${Buffer.from(`${account.username}:${account.secret}`).toString('base64')}` }
}
async function request(account, url, { method = 'PROPFIND', body = '', depth = '0', redirects = 0 } = {}) {
  await assertSafeUrl(url)
  const response = await fetch(url, {
    method, redirect: 'manual', signal: AbortSignal.timeout(20000),
    headers: { ...authHeaders(account), Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }, body: body || undefined,
  })
  if ([301, 302, 307, 308].includes(response.status)) {
    if (redirects >= 5) throw new Error('CardDAV redirect 횟수를 초과했습니다.')
    const location = response.headers.get('location')
    if (!location) throw new Error('CardDAV redirect 주소가 없습니다.')
    return request(account, new URL(location, url).toString(), { method, body, depth, redirects: redirects + 1 })
  }
  if (!response.ok && response.status !== 207) {
    const error = new Error(response.status === 401 ? 'CardDAV 인증에 실패했습니다.' : `CardDAV 서버 오류 (${response.status})`)
    error.status = response.status
    throw error
  }
  return { url: response.url || url, status: response.status, xml: await response.text(), headers: response.headers }
}
function responses(xml) { return array(parser.parse(xml)?.multistatus?.response) }
function propOf(response) { return array(response?.propstat).find(x => String(x?.status || '').includes('200'))?.prop || {} }

async function discover(account) {
  const discoveryBody = `<?xml version="1.0"?><propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>`
  const first = await request(account, account.discovery_url, { body: discoveryBody })
  const principalHref = propOf(responses(first.xml)[0])?.['current-user-principal']?.href
  const principalUrl = principalHref ? resolveHref(first.url, principalHref) : first.url
  const homeBody = `<?xml version="1.0"?><propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><prop><C:addressbook-home-set/></prop></propfind>`
  const principal = await request(account, principalUrl, { body: homeBody })
  const homeHref = propOf(responses(principal.xml)[0])?.['addressbook-home-set']?.href
  if (!homeHref) throw new Error('CardDAV addressbook-home-set을 찾지 못했습니다.')
  const homeUrl = resolveHref(principalUrl, homeHref)
  const booksBody = `<?xml version="1.0"?><propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/"><prop><displayname/><resourcetype/><sync-token/><CS:getctag/></prop></propfind>`
  const listing = await request(account, homeUrl, { body: booksBody, depth: '1' })
  const books = responses(listing.xml).map(item => {
    const prop = propOf(item)
    if (!prop?.resourcetype || !Object.prototype.hasOwnProperty.call(prop.resourcetype, 'addressbook')) return null
    return { remoteUrl: resolveHref(homeUrl, item.href), displayName: text(prop.displayname) || 'Contacts', syncToken: text(prop['sync-token']), ctag: text(prop.getctag) }
  }).filter(Boolean)
  return { principalUrl, homeUrl, books }
}

async function listResources(account, bookUrl) {
  const body = `<?xml version="1.0"?><C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><D:prop><D:getetag/><C:address-data/></D:prop><C:filter><C:prop-filter name="FN"/></C:filter></C:addressbook-query>`
  const result = await request(account, bookUrl, { method: 'REPORT', body, depth: '1' })
  return responses(result.xml).map(item => {
    const prop = propOf(item)
    return { href: resolveHref(bookUrl, item.href), etag: text(prop.getetag), vcard: text(prop['address-data']) }
  }).filter(x => x.vcard)
}

module.exports = { discover, listResources }
