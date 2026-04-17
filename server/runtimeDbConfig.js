const fs = require('fs')
const path = require('path')

const CONFIG_PATH = path.resolve(__dirname, '../config.json')

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function normalizeContactPoints(value) {
  if (Array.isArray(value)) {
    return value.map(v => String(v).trim()).filter(Boolean)
  }
  if (typeof value === 'string') {
    return value.split(',').map(v => v.trim()).filter(Boolean)
  }
  return []
}

function getPostgresPoolOptions() {
  const cfg = readConfig()
  const pg = cfg.postgresql || cfg.PostgreSQL || {}

  const connectionString = process.env.DATABASE_URL
    || process.env.POSTGRESQL_URL
    || pg.connectionString
    || pg.url

  if (connectionString) {
    try {
      const parsed = new URL(connectionString)
      const protocol = parsed.protocol.replace(':', '')
      if (protocol.startsWith('postgres')) {
        const options = {
          host: parsed.hostname || process.env.PGHOST || pg.host || 'localhost',
          port: Number(parsed.port || process.env.PGPORT || pg.port || 5432),
          database: (parsed.pathname || '').replace(/^\//, '') || process.env.PGDATABASE || pg.database || 'easydocstation',
        }

        const user = decodeURIComponent(parsed.username || '') || process.env.PGUSER || pg.user
        if (user) options.user = user

        // pg(SCRAM) expects password to be a string when auth is required.
        const resolvedPassword = process.env.PGPASSWORD
          ?? pg.password
          ?? decodeURIComponent(parsed.password || '')
        options.password = typeof resolvedPassword === 'string' ? resolvedPassword : ''

        return options
      }
    } catch (_) {}
    return { connectionString }
  }

  const options = {
    host: process.env.PGHOST || pg.host || 'localhost',
    port: Number(process.env.PGPORT || pg.port || 5432),
    database: process.env.PGDATABASE || pg.database || 'easydocstation',
  }

  const user = process.env.PGUSER || pg.user
  if (user) options.user = user
  const password = process.env.PGPASSWORD ?? pg.password ?? ''
  options.password = typeof password === 'string' ? password : ''

  return options
}

function getPostgresDatabaseName() {
  const cfg = readConfig()
  const pg = cfg.postgresql || cfg.PostgreSQL || {}
  return process.env.PGDATABASE || pg.database || 'easydocstation'
}

function getCassandraConfig() {
  const cfg = readConfig()
  const cass = cfg.cassandra || cfg.Cassandra || {}

  const contactPoints = normalizeContactPoints(
    process.env.CASSANDRA_CONTACT_POINTS || cass.contactPoints
  )
  const resolvedContactPoints = contactPoints.length > 0 ? contactPoints : ['127.0.0.1']

  const localDataCenter = process.env.CASSANDRA_LOCAL_DC
    || process.env.CASSANDRA_DATACENTER
    || cass.localDataCenter
    || 'datacenter1'

  const keyspace = process.env.CASSANDRA_KEYSPACE || cass.keyspace || 'easydocstation'

  return { contactPoints: resolvedContactPoints, localDataCenter, keyspace }
}

module.exports = {
  readConfig,
  getPostgresPoolOptions,
  getPostgresDatabaseName,
  getCassandraConfig,
}
