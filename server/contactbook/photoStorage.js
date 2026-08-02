const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { getDatabasePath } = require('../databasePaths')

const configPath = path.resolve(__dirname, '../../config.json')
let config = {}
try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch {}
const root = path.join(getDatabasePath(config, 'ObjectFile Path'), 'contactbook-photos')

const signatures = [
  { mime: 'image/jpeg', ext: 'jpg', matches: b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: 'png', matches: b => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  { mime: 'image/gif', ext: 'gif', matches: b => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('ascii')) },
  { mime: 'image/webp', ext: 'webp', matches: b => b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
]

function imageInfo(buffer) {
  const type = signatures.find(item => item.matches(buffer))
  if (!type) { const error = new Error('JPEG, PNG, GIF, WebP 사진만 업로드할 수 있습니다.'); error.status = 415; throw error }
  let width = null; let height = null
  if (type.ext === 'png' && buffer.length >= 24) { width = buffer.readUInt32BE(16); height = buffer.readUInt32BE(20) }
  if (type.ext === 'gif' && buffer.length >= 10) { width = buffer.readUInt16LE(6); height = buffer.readUInt16LE(8) }
  if (type.ext === 'jpg') {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue }
      const marker = buffer[offset + 1]
      const length = buffer.readUInt16BE(offset + 2)
      if (length < 2) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = buffer.readUInt16BE(offset + 5); width = buffer.readUInt16BE(offset + 7); break
      }
      offset += 2 + length
    }
  }
  if ((width && width > 20000) || (height && height > 20000) || (width && height && width * height > 100000000)) {
    const error = new Error('사진 해상도가 너무 큽니다.'); error.status = 413; throw error
  }
  return { ...type, width, height }
}

async function savePhoto(buffer, userId) {
  const info = imageInfo(buffer)
  const relative = path.join(String(userId), `${crypto.randomUUID()}.${info.ext}`)
  const target = path.join(root, relative)
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  await fs.promises.writeFile(target, buffer, { flag: 'wx', mode: 0o600 })
  return { objectKey: relative, mimeType: info.mime, width: info.width, height: info.height, sha256: crypto.createHash('sha256').update(buffer).digest('hex') }
}

function resolvePhoto(objectKey) {
  const target = path.resolve(root, String(objectKey || ''))
  const base = path.resolve(root)
  if (!target.startsWith(`${base}${path.sep}`)) throw new Error('잘못된 사진 경로입니다.')
  return target
}

async function deletePhoto(objectKey) {
  await fs.promises.unlink(resolvePhoto(objectKey)).catch(error => { if (error.code !== 'ENOENT') throw error })
}

module.exports = { savePhoto, resolvePhoto, deletePhoto, imageInfo }
