const fs = require('fs/promises')
const path = require('path')

function normalizeObjectKey(key) {
  const normalized = String(key || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(part => part && part !== '.' && part !== '..')
    .join('/')

  if (!normalized) throw new Error('object key is required')
  return normalized
}

function createLocalMailStorage({ basePath }) {
  const root = path.resolve(basePath)

  function resolveKey(key) {
    const objectKey = normalizeObjectKey(key)
    const fullPath = path.resolve(root, objectKey)
    if (!fullPath.startsWith(root + path.sep) && fullPath !== root) {
      throw new Error('invalid object key')
    }
    return { objectKey, fullPath }
  }

  return {
    driver: 'local',

    async saveObject(key, data) {
      const { objectKey, fullPath } = resolveKey(key)
      await fs.mkdir(path.dirname(fullPath), { recursive: true })
      await fs.writeFile(fullPath, data)
      return { objectKey, storagePath: fullPath }
    },

    async getObject(key) {
      const { fullPath } = resolveKey(key)
      return fs.readFile(fullPath)
    },

    async deleteObject(key) {
      const { fullPath } = resolveKey(key)
      await fs.rm(fullPath, { force: true })
    },

    async deletePrefix(prefix) {
      const { fullPath } = resolveKey(prefix)
      await fs.rm(fullPath, { recursive: true, force: true })
    },

    async exists(key) {
      const { fullPath } = resolveKey(key)
      try {
        await fs.access(fullPath)
        return true
      } catch {
        return false
      }
    },

    getSignedUrl(key) {
      return `/api/mail/objects/${encodeURIComponent(normalizeObjectKey(key))}`
    },

    getBasePath() {
      return root
    },
  }
}

module.exports = {
  createLocalMailStorage,
  normalizeObjectKey,
}
