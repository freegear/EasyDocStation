import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const historyPath = path.join(rootDir, 'UpdateHistory.json')
const versionKey = 'EasyDocStation Version'

function parseVersion(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

function toVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`
}

const description = process.argv.slice(2).join(' ').trim()
if (!description) {
  console.error('[version] 변경 설명이 필요합니다. 예: npm run version:bump -- "변경 내용"')
  process.exit(1)
}

const raw = fs.readFileSync(historyPath, 'utf8')
const history = JSON.parse(raw)
const current = parseVersion(history[versionKey])
if (!current) throw new Error(`${versionKey}이 major.minor.patch 형식이 아닙니다.`)
const next = { ...current, patch: current.patch + 1 }
const nextVersion = toVersion(next)

if (Object.prototype.hasOwnProperty.call(history, nextVersion)) {
  throw new Error(`업데이트 내역 ${nextVersion}이 이미 존재합니다.`)
}

const nextHistory = { [versionKey]: nextVersion, [nextVersion]: description }
for (const [key, value] of Object.entries(history)) {
  if (key !== versionKey) nextHistory[key] = value
}

const tmpPath = `${historyPath}.tmp-${process.pid}`
fs.writeFileSync(tmpPath, `${JSON.stringify(nextHistory, null, 2)}\n`, 'utf8')
fs.renameSync(tmpPath, historyPath)

console.log(`[version] EasyDocStation Version: ${toVersion(current)} -> ${nextVersion}`)
