const crypto = require('crypto')
const dns = require('dns').promises
const https = require('https')
const net = require('net')

const MAX_REMOTE_IMAGE_BYTES = 15 * 1024 * 1024
const MAX_REDIRECTS = 3
const TRACKING_PATTERN = /(?:^|[._/-])(receipt|confirm|tracking|track|open|pixel|beacon)(?:[._/?-]|$)/i

function decodeHtml(value) {
  return String(value || '').replace(/&amp;/gi, '&').replace(/&#38;/g, '&')
}

function extractRemoteImageCandidates(html) {
  const candidates = []
  const seen = new Set()
  for (const match of String(html || '').matchAll(/<img\b([^>]*?)>/gi)) {
    const attrs = match[1]
    const srcMatch = attrs.match(/\bsrc\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i)
    if (!srcMatch) continue
    const raw = decodeHtml(srcMatch[1] || srcMatch[2]).trim()
    let url
    try { url = new URL(raw) } catch { continue }
    if (!['https:', 'http:'].includes(url.protocol)) continue
    url.hash = ''
    const normalizedUrl = url.toString()
    const sourceUrlHash = crypto.createHash('sha256').update(normalizedUrl).digest('hex')
    if (seen.has(sourceUrlHash)) continue
    seen.add(sourceUrlHash)
    const width = Number(attrs.match(/\bwidth\s*=\s*["']?(\d+)/i)?.[1] || 0)
    const height = Number(attrs.match(/\bheight\s*=\s*["']?(\d+)/i)?.[1] || 0)
    const alt = attrs.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] || ''
    const tracking = (width > 0 && width <= 10) || (height > 0 && height <= 10)
      || TRACKING_PATTERN.test(`${url.hostname}${url.pathname}`)
    candidates.push({
      id: sourceUrlHash,
      sourceUrlHash,
      url: normalizedUrl,
      hostname: url.hostname.toLowerCase(),
      declaredWidth: width || null,
      declaredHeight: height || null,
      alt: alt.slice(0, 500),
      tracking,
    })
  }
  return candidates
}

function isBlockedAddress(address) {
  const version = net.isIP(address)
  if (version === 4) {
    const p = address.split('.').map(Number)
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224
      || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
      || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
  }
  if (version === 6) {
    const value = address.toLowerCase().split('%')[0]
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd')
      || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')
      || value.startsWith('ff') || value.startsWith('::ffff:127.') || value.startsWith('::ffff:10.')
  }
  return true
}

async function resolvePublicAddress(hostname) {
  const records = await dns.lookup(hostname, { all: true, verbatim: true })
  if (!records.length || records.some(record => isBlockedAddress(record.address))) {
    throw Object.assign(new Error('외부 이미지 주소가 안전하지 않습니다.'), { code: 'REMOTE_IMAGE_SSRF_BLOCKED' })
  }
  return records[0]
}

function detectImage(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), extension: 'png' }
  }
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue }
      const marker = buffer[offset + 1]
      const length = buffer.readUInt16BE(offset + 2)
      if (length < 2) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { contentType: 'image/jpeg', width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5), extension: 'jpg' }
      }
      offset += 2 + length
    }
    return { contentType: 'image/jpeg', extension: 'jpg' }
  }
  if (/^GIF8[79]a/.test(buffer.subarray(0, 6).toString('ascii'))) {
    return { contentType: 'image/gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), extension: 'gif' }
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { contentType: 'image/webp', extension: 'webp' }
  }
  return null
}

async function fetchRemoteImage(rawUrl, redirects = 0) {
  if (redirects > MAX_REDIRECTS) throw new Error('외부 이미지 redirect 한도를 초과했습니다.')
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:') throw new Error('HTTPS 외부 이미지만 분석할 수 있습니다.')
  if (url.username || url.password || url.port) throw new Error('허용되지 않은 외부 이미지 URL입니다.')
  const resolved = await resolvePublicAddress(url.hostname)
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'GET',
      headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif', 'User-Agent': 'EasyDocStation-RemoteImage/1.0' },
      timeout: 15000,
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [{ address: resolved.address, family: resolved.family }])
        else callback(null, resolved.address, resolved.family)
      },
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume()
        const next = new URL(response.headers.location, url).toString()
        fetchRemoteImage(next, redirects + 1).then(resolve, reject)
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`외부 이미지 응답 오류(${response.statusCode})`))
        return
      }
      const declared = Number(response.headers['content-length'] || 0)
      if (declared > MAX_REMOTE_IMAGE_BYTES) {
        response.destroy()
        reject(new Error('외부 이미지가 15MB 제한을 초과했습니다.'))
        return
      }
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > MAX_REMOTE_IMAGE_BYTES) response.destroy(new Error('외부 이미지가 15MB 제한을 초과했습니다.'))
        else chunks.push(chunk)
      })
      response.on('end', () => {
        const buffer = Buffer.concat(chunks)
        const image = detectImage(buffer)
        if (!image) return reject(new Error('응답이 지원되는 이미지 형식이 아닙니다.'))
        if (image.width && image.height && (image.width < 200 || image.height < 100)) {
          return reject(new Error('추적 픽셀 또는 너무 작은 이미지입니다.'))
        }
        resolve({ buffer, ...image, finalHostname: url.hostname.toLowerCase() })
      })
    })
    request.on('timeout', () => request.destroy(new Error('외부 이미지 요청 시간이 초과됐습니다.')))
    request.on('error', reject)
    request.end()
  })
}

module.exports = { extractRemoteImageCandidates, fetchRemoteImage, isBlockedAddress, detectImage }
