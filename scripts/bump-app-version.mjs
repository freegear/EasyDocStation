import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const configPath = path.join(rootDir, 'config.json')

function parseVersion(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

function toVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`
}

const raw = fs.readFileSync(configPath, 'utf8')
const config = JSON.parse(raw)
const current = parseVersion(config['EasyDocStation Version']) || { major: 0, minor: 3, patch: 0 }
const next = { ...current, patch: current.patch + 1 }
const nextVersion = toVersion(next)

config['EasyDocStation Version'] = nextVersion
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

console.log(`[version] EasyDocStation Version: ${toVersion(current)} -> ${nextVersion}`)
