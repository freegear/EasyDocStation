const path = require('path')

const LINUX_DEFAULT_APP_BASE = '/home/freegear/EasyDocStation'

function getProjectRoot() {
  return path.resolve(__dirname, '..')
}

function getDefaultAppBasePath() {
  const envAppBase = process.env.EASYDOC_STATION_FOLDER
  if (typeof envAppBase === 'string' && envAppBase.trim()) {
    return envAppBase.trim()
  }
  if (process.platform === 'linux') {
    return LINUX_DEFAULT_APP_BASE
  }
  return getProjectRoot()
}

function buildDefaultDatabasePaths(appBasePath = getDefaultAppBasePath()) {
  return {
    basePath: appBasePath,
    postgres: path.join(appBasePath, 'Database/PoseSQLDB'),
    cassandra: path.join(appBasePath, 'Database/CassandraDB'),
    objectFile: path.join(appBasePath, 'Database/ObjectFile'),
    lancedb: path.join(appBasePath, 'Database/LanceDB'),
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

function resolveAppBasePath(config = {}) {
  const rawBase = config.EasyDocStationFolder
  const defaultBase = getDefaultAppBasePath()
  if (typeof rawBase !== 'string' || !rawBase.trim()) {
    return defaultBase
  }
  const configured = rawBase.trim()
  if (path.isAbsolute(configured)) {
    return isForeignOsAbsolutePath(configured) ? defaultBase : configured
  }
  return path.resolve(getProjectRoot(), configured)
}

function getDbRelativeDefault(key) {
  switch (key) {
    case 'PostgreSQL Database Path':
      return 'Database/PoseSQLDB'
    case 'Cassandra Database Path':
      return 'Database/CassandraDB'
    case 'ObjectFile Path':
      return 'Database/ObjectFile'
    case 'lancedb Database Path':
      return 'Database/LanceDB'
    default:
      return 'Database'
  }
}

function getDatabasePath(config = {}, key) {
  const envDbBase = process.env.EASYDOC_DB_BASE
  if (typeof envDbBase === 'string' && envDbBase.trim()) {
    const envBase = envDbBase.trim()
    const defaults = buildDefaultDatabasePaths(envBase)
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
        return envBase
    }
  }

  const appBase = resolveAppBasePath(config)
  const raw = config[key]
  const configured = (typeof raw === 'string' && raw.trim())
    ? raw.trim()
    : getDbRelativeDefault(key)

  if (path.isAbsolute(configured)) {
    if (!isForeignOsAbsolutePath(configured)) {
      return configured
    }
    return path.resolve(appBase, getDbRelativeDefault(key))
  }

  return path.resolve(appBase, configured)
}

module.exports = {
  LINUX_DEFAULT_APP_BASE,
  getDefaultAppBasePath,
  buildDefaultDatabasePaths,
  resolveAppBasePath,
  getDatabasePath,
}
