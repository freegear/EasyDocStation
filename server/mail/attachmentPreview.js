const path = require('path')

const MAX_BINARY_PREVIEW_BYTES = 25 * 1024 * 1024
const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024

const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/xml',
  'text/xml',
])

const TEXT_EXTENSIONS = new Set(['.txt', '.csv', '.json', '.xml', '.log', '.md'])
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

function isAttachmentPreviewCandidate({ filename, contentType }) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase()
  const extension = path.extname(String(filename || '')).toLowerCase()
  return IMAGE_MIME_TYPES.has(mime)
    || IMAGE_EXTENSIONS.has(extension)
    || mime === 'application/pdf'
    || extension === '.pdf'
    || mime.startsWith('text/')
    || TEXT_MIME_TYPES.has(mime)
    || TEXT_EXTENSIONS.has(extension)
}

function startsWith(buffer, bytes) {
  return bytes.every((byte, index) => buffer[index] === byte)
}

function detectBinaryType(buffer) {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', contentType: 'image/png' }
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return { kind: 'image', contentType: 'image/jpeg' }
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return { kind: 'image', contentType: 'image/gif' }
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { kind: 'image', contentType: 'image/webp' }
  }
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') return { kind: 'pdf', contentType: 'application/pdf' }
  return null
}

function looksLikeText(buffer) {
  if (!buffer.length) return true
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  if (sample.includes(0)) return false
  let suspicious = 0
  for (const byte of sample) {
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) suspicious += 1
  }
  return suspicious / sample.length < 0.02
}

function resolveAttachmentPreview({ buffer, filename, declaredContentType }) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('attachment buffer가 필요합니다.')

  const binary = detectBinaryType(buffer)
  if (binary) {
    if (buffer.length > MAX_BINARY_PREVIEW_BYTES) {
      return { allowed: false, status: 413, code: 'PREVIEW_TOO_LARGE', reason: '미리보기 최대 크기를 초과했습니다.' }
    }
    return { allowed: true, ...binary, buffer }
  }

  const normalizedMime = String(declaredContentType || '').split(';')[0].trim().toLowerCase()
  const extension = path.extname(String(filename || '')).toLowerCase()
  const declaredAsText = normalizedMime.startsWith('text/') || TEXT_MIME_TYPES.has(normalizedMime) || TEXT_EXTENSIONS.has(extension)
  if (declaredAsText && looksLikeText(buffer)) {
    if (buffer.length > MAX_TEXT_PREVIEW_BYTES) {
      return { allowed: false, status: 413, code: 'PREVIEW_TOO_LARGE', reason: '텍스트 미리보기는 1MB 이하만 지원합니다.' }
    }
    return { allowed: true, kind: 'text', contentType: 'text/plain; charset=utf-8', buffer }
  }

  return { allowed: false, status: 415, code: 'PREVIEW_UNSUPPORTED', reason: '이 파일 형식은 안전한 미리보기를 지원하지 않습니다.' }
}

module.exports = {
  MAX_BINARY_PREVIEW_BYTES,
  MAX_TEXT_PREVIEW_BYTES,
  isAttachmentPreviewCandidate,
  resolveAttachmentPreview,
}
