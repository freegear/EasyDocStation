const crypto = require('crypto')

const ENC_PREFIX = 'enc:v1'
const MASK_VALUE = '********'

function getEncryptionKey() {
  const raw = String(process.env.DATA_ENCRYPTION_KEY || '').trim()
  if (!raw) return null

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex')
  }

  try {
    const buf = Buffer.from(raw, 'base64')
    if (buf.length === 32) return buf
  } catch (_) {}

  throw new Error('DATA_ENCRYPTION_KEY must be 32-byte base64 or 64-char hex.')
}

function encryptSecret(value) {
  const plain = String(value || '').trim()
  if (!plain) return null
  if (plain.startsWith(`${ENC_PREFIX}:`)) return plain

  const key = getEncryptionKey()
  if (!key) {
    throw new Error('DATA_ENCRYPTION_KEY is required to store SNS secrets securely.')
  }

  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENC_PREFIX}:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`
}

function decryptSecret(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (!raw.startsWith(`${ENC_PREFIX}:`)) return raw

  const key = getEncryptionKey()
  if (!key) return ''

  const parts = raw.split(':')
  if (parts.length !== 5) return ''
  const iv = Buffer.from(parts[2], 'base64')
  const tag = Buffer.from(parts[3], 'base64')
  const payload = Buffer.from(parts[4], 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(payload), decipher.final()])
  return plain.toString('utf8')
}

function maskSecret(value) {
  const plain = decryptSecret(value)
  return plain ? MASK_VALUE : null
}

function isMaskedValue(value) {
  return String(value || '').trim() === MASK_VALUE
}

module.exports = {
  encryptSecret,
  decryptSecret,
  maskSecret,
  isMaskedValue,
  MASK_VALUE,
}
