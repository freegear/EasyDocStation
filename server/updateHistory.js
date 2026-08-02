const fs = require('fs')
const path = require('path')

const DEFAULT_PATH = path.resolve(__dirname, '../UpdateHistory.json')
const VERSION_KEY = 'EasyDocStation Version'
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

function compareVersionsDescending(a, b) {
  const left = String(a).split('.').map(Number)
  const right = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return right[i] - left[i]
  }
  return 0
}

function normalizeUpdateHistory(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('UpdateHistory.json의 루트는 JSON object여야 합니다.')
  }
  const currentVersion = String(raw[VERSION_KEY] || '').trim()
  if (!VERSION_PATTERN.test(currentVersion)) {
    throw new Error(`${VERSION_KEY}은 major.minor.patch 형식이어야 합니다.`)
  }

  const releases = Object.entries(raw)
    .filter(([version]) => version !== VERSION_KEY)
    .map(([version, description]) => {
      if (!VERSION_PATTERN.test(version)) throw new Error(`잘못된 업데이트 버전입니다: ${version}`)
      if (typeof description !== 'string') throw new Error(`${version} 업데이트 내역은 문자열이어야 합니다.`)
      return { version, description, current: version === currentVersion }
    })
    .sort((a, b) => compareVersionsDescending(a.version, b.version))

  if (!releases.some(release => release.version === currentVersion)) {
    throw new Error(`현재 버전 ${currentVersion}의 업데이트 내역이 없습니다.`)
  }
  return { productName: 'EasyStation', currentVersion, releases, available: true }
}

function loadUpdateHistory(filePath = DEFAULT_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return normalizeUpdateHistory(raw)
  } catch (error) {
    console.error(`[UpdateHistory] 로드 실패: ${error.message}`)
    return { productName: 'EasyStation', currentVersion: '0.0.0', releases: [], available: false, error: error.message }
  }
}

module.exports = { DEFAULT_PATH, VERSION_KEY, compareVersionsDescending, normalizeUpdateHistory, loadUpdateHistory }
