const fs = require('fs')
const path = require('path')
const { getDatabasePath } = require('../../databasePaths')
const { createLocalMailStorage } = require('./localStorage')

const CONFIG_PATH = path.resolve(__dirname, '../../../config.json')

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function getMailStorageBasePath() {
  const cfg = readConfig()
  const objectBase = getDatabasePath(cfg, 'ObjectFile Path')
  return path.join(objectBase, 'MailService')
}

function getMailStorage() {
  const driver = String(process.env.MAIL_STORAGE_DRIVER || 'local').toLowerCase()
  if (driver !== 'local') {
    // S3-compatible storage can be added behind the same interface later.
    throw new Error(`Unsupported MAIL_STORAGE_DRIVER: ${driver}`)
  }
  return createLocalMailStorage({ basePath: getMailStorageBasePath() })
}

// 파일 시스템/URL 안전을 위해 경로 세그먼트를 정리한다.
function sanitizeSegment(value, fallback = '_') {
  const cleaned = String(value || '')
    .replace(/[\\/]/g, '_')
    .replace(/\.\.+/g, '_')
    .trim()
  return cleaned || fallback
}

// 설계 원칙 #4: object_key는 tenants/{tenant_id}/users/{user_id}/mail/{account_id}/... 형태.
// 메시지 식별자는 DB uuid가 아니라 provider_message_id를 사용한다.
function buildMailObjectKey({ storagePrefix, tenantId, userId, accountId, providerMessageId, suffix }) {
  const prefix = storagePrefix || `tenants/${sanitizeSegment(tenantId)}`
  const parts = [
    prefix,
    'users', sanitizeSegment(userId),
    'mail', sanitizeSegment(accountId),
    'messages', sanitizeSegment(providerMessageId),
  ]
  if (suffix) {
    for (const seg of String(suffix).split('/')) {
      if (seg) parts.push(sanitizeSegment(seg))
    }
  }
  return parts.join('/')
}

module.exports = {
  getMailStorage,
  getMailStorageBasePath,
  buildMailObjectKey,
  sanitizeSegment,
}
