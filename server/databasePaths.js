const path = require('path')

const LINUX_DEFAULT_DB_BASE = '/home/freegear/EasyDocStation/Database'

function getDefaultDatabaseBasePath() {
  const envBase = process.env.EASYDOC_DB_BASE
  if (typeof envBase === 'string' && envBase.trim()) {
    return envBase.trim()
  }
  if (process.platform === 'linux') {
    return LINUX_DEFAULT_DB_BASE
  }
  return path.resolve(__dirname, '../Database')
}

function buildDefaultDatabasePaths(basePath = getDefaultDatabaseBasePath()) {
  return {
    basePath,
    postgres: path.join(basePath, 'PoseSQLDB'),
    cassandra: path.join(basePath, 'CassandraDB'),
    objectFile: path.join(basePath, 'ObjectFile'),
    lancedb: path.join(basePath, 'LanceDB'),
  }
}

function isForeignOsAbsolutePath(targetPath) {
  if (typeof targetPath !== 'string') return false
  if (!path.isAbsolute(targetPath)) return false
  const normalized = targetPath.replace(/\\/g, '/')
  if (process.platform === 'linux') {
    return normalized.startsWith('/Users/')
  }
  if (process.platform === 'darwin') {
    return normalized.startsWith('/home/') || normalized.startsWith('/root/')
  }
  return false
}

function getDatabasePath(config = {}, key) {
  const raw = config[key]
  if (typeof raw === 'string' && raw.trim()) {
    const configured = raw.trim()
    if (!isForeignOsAbsolutePath(configured)) {
      return configured
    }
  }
  const defaults = buildDefaultDatabasePaths()
  switch (key) {
    case 'PostgreSQL Database Path':
      return defaults.postgres
    case 'Cassandra Database Path':
      return defaults.cassandra
    case 'ObjectFile Path':
      return defaults.objectFile
    case 'lancedb Database Path':
      return defaults.lancedb
    default:
      return defaults.basePath
  }
}

module.exports = {
  LINUX_DEFAULT_DB_BASE,
  getDefaultDatabaseBasePath,
  buildDefaultDatabasePaths,
  getDatabasePath,
}
