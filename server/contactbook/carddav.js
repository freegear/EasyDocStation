const dns = require('dns').promises
const net = require('net')
const { XMLParser } = require('fast-xml-parser')

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, attributeNamePrefix: '@_', processEntities: false })
const MULTIGET_BATCH_SIZE = 100

function array(value) { return value == null ? [] : (Array.isArray(value) ? value : [value]) }
function text(value) {
  if (typeof value === 'string') return value
  return value?.['#text'] || ''
}
function decodeXmlCharacterReferences(value) {
  const predefined = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' }
  return String(value || '').replace(/&(?:#x([0-9a-f]+)|#(\d+)|(quot|apos|amp|lt|gt));/gi, (matched, hex, decimal, named) => {
    if (named) return predefined[named.toLowerCase()]
    const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10)
    if (!Number.isInteger(codePoint) || codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return matched
    return String.fromCodePoint(codePoint)
  })
}
function xmlEscape(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
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
async function request(account, url, { method = 'PROPFIND', body = '', depth = '0', redirects = 0, headers = {}, contentType = 'application/xml; charset=utf-8' } = {}) {
  await assertSafeUrl(url)
  const response = await fetch(url, {
    method, redirect: 'manual', signal: AbortSignal.timeout(20000),
    headers: { ...authHeaders(account), Depth: depth, 'Content-Type': contentType, ...headers }, body: body || undefined,
  })
  if ([301, 302, 307, 308].includes(response.status)) {
    if (redirects >= 5) throw new Error('CardDAV redirect 횟수를 초과했습니다.')
    const location = response.headers.get('location')
    if (!location) throw new Error('CardDAV redirect 주소가 없습니다.')
    return request(account, new URL(location, url).toString(), { method, body, depth, redirects: redirects + 1, headers, contentType })
  }
  if (!response.ok && response.status !== 207) {
    const responseText = await response.text()
    const error = new Error(response.status === 401 ? 'CardDAV 인증에 실패했습니다.' : `CardDAV 서버 오류 (${response.status})`)
    error.status = response.status
    error.carddavMethod = method
    error.carddavHost = new URL(url).host
    error.carddavPath = new URL(url).pathname
    error.carddavAuthenticate = response.headers.get('www-authenticate') || ''
    error.carddavResponse = responseText.slice(0, 2000)
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
  const listingBody = `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:getetag/><D:resourcetype/></D:prop></D:propfind>`
  let listing
  try {
    listing = await request(account, bookUrl, { body: listingBody, depth: '1' })
  } catch (error) {
    error.message = `CardDAV resource 목록 조회 실패: ${error.message}`
    throw error
  }
  const metadata = responses(listing.xml).map(item => {
    const prop = propOf(item)
    const resourceType = prop.resourcetype
    if (!text(prop.getetag) || (resourceType && (Object.prototype.hasOwnProperty.call(resourceType, 'collection') || Object.prototype.hasOwnProperty.call(resourceType, 'addressbook')))) return null
    return { href: text(item.href), etag: text(prop.getetag) }
  }).filter(Boolean)
  const resources = []
  for (let start = 0; start < metadata.length; start += MULTIGET_BATCH_SIZE) {
    const batch = metadata.slice(start, start + MULTIGET_BATCH_SIZE)
    const hrefs = batch.map(item => `<D:href>${xmlEscape(item.href)}</D:href>`).join('')
    const body = `<?xml version="1.0"?><C:addressbook-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><D:prop><D:getetag/><C:address-data content-type="text/vcard" version="3.0"/></D:prop>${hrefs}</C:addressbook-multiget>`
    let result
    try {
      result = await request(account, bookUrl, { method: 'REPORT', body, depth: '0' })
    } catch (error) {
      if (![405, 501].includes(error.status)) {
        error.message = `CardDAV multiget 실패 (${start + 1}-${start + batch.length}): ${error.message}`
        throw error
      }
      for (const item of batch) {
        const href = resolveHref(bookUrl, item.href)
        const fetched = await request(account, href, { method: 'GET', depth: '0' })
        resources.push({ href, etag: fetched.headers.get('etag') || item.etag, vcard: decodeXmlCharacterReferences(fetched.xml) })
      }
      continue
    }
    const returned = responses(result.xml).map(item => {
      const prop = propOf(item)
      return {
        href: resolveHref(bookUrl, item.href),
        etag: text(prop.getetag),
        vcard: decodeXmlCharacterReferences(text(prop['address-data'])),
      }
    }).filter(item => item.vcard)
    if (returned.length !== batch.length) throw new Error(`CardDAV 연락처 일부를 가져오지 못했습니다. (${returned.length}/${batch.length})`)
    resources.push(...returned)
  }
  return resources
}

async function updateResource(account, resourceUrl, vcard, etag) {
  if (!etag) throw new Error('연락처 ETag가 없어 안전하게 수정할 수 없습니다.')
  return request(account, resourceUrl, {
    method: 'PUT', body: vcard, depth: '0', contentType: 'text/vcard; charset=utf-8', headers: { 'If-Match': etag },
  })
}

async function getResource(account, resourceUrl) {
  return request(account, resourceUrl, { method: 'GET', depth: '0', contentType: 'text/vcard; charset=utf-8' })
}

async function deleteResource(account, resourceUrl, etag) {
  if (!etag) { const error = new Error('연락처 ETag가 없어 안전하게 삭제할 수 없습니다.'); error.status = 409; throw error }
  try {
    return await request(account, resourceUrl, { method: 'DELETE', depth: '0', headers: { 'If-Match': etag } })
  } catch (error) {
    if ([404, 410].includes(error.status)) return { status: error.status, alreadyDeleted: true }
    throw error
  }
}

module.exports = { discover, listResources, updateResource, getResource, deleteResource, decodeXmlCharacterReferences }
