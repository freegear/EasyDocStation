const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const DEFAULT_CASSANDRA_CONFIG = '/etc/cassandra/cassandra.yaml'

function getCassandraYamlPath() {
  const configured = String(process.env.CASSANDRA_CONFIG || '').trim()
  if (configured) return configured

  const configDir = String(process.env.CASSANDRA_CONF || '').trim()
  if (configDir) return path.join(configDir, 'cassandra.yaml')

  return DEFAULT_CASSANDRA_CONFIG
}

function parseFirstDataDirectory(yaml = '') {
  const lines = String(yaml).split(/\r?\n/)
  const start = lines.findIndex((line) => /^\s*data_file_directories\s*:/.test(line))
  if (start < 0) return ''

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\S/.test(line) && !/^\s*#/.test(line)) break
    const match = line.match(/^\s*-\s*([^#]+?)\s*(?:#.*)?$/)
    if (match) return match[1].trim().replace(/^['"]|['"]$/g, '')
  }

  return ''
}

function getCassandraDataDirectory(fallbackPath = '') {
  const envPath = String(process.env.CASSANDRA_DATA_PATH || '').trim()
  if (envPath) return path.resolve(envPath)

  try {
    const configuredPath = parseFirstDataDirectory(
      fs.readFileSync(getCassandraYamlPath(), 'utf8')
    )
    if (configuredPath) return path.resolve(configuredPath)
  } catch {
    // Cassandra가 로컬에 없거나 설정을 읽을 수 없으면 앱 설정 경로를 사용한다.
  }

  return fallbackPath
}

function getCassandraLoad() {
  return new Promise((resolve) => {
    execFile('nodetool', ['info'], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve('')
      const match = String(stdout).match(/^Load\s*:\s*(.+)$/m)
      resolve(match ? match[1].trim() : '')
    })
  })
}

module.exports = {
  getCassandraDataDirectory,
  getCassandraLoad,
  parseFirstDataDirectory,
}
