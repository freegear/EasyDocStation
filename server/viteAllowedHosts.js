const fs = require('fs')
const net = require('net')

const DEFAULT_VITE_ALLOWED_HOSTS = [
  'www.easystation.co.kr',
  'easystation.co.kr',
  '218.237.25.214',
]

function normalizeViteAllowedHost(value) {
  let host = String(value || '').trim().toLowerCase()
  if (!host || host.length > 254) return ''
  if (host.includes('://') || /[\s/?#@:]/.test(host)) return ''

  const includeSubdomains = host.startsWith('.')
  if (includeSubdomains) host = host.slice(1)
  host = host.replace(/\.$/, '')
  if (!host || host.includes('..')) return ''

  const labels = host.split('.')
  if (!labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return ''
  return includeSubdomains ? `.${host}` : host
}

function resolveViteAllowedHosts(config = {}) {
  const configured = config?.vite?.allowedHosts
  if (!Array.isArray(configured)) return [...DEFAULT_VITE_ALLOWED_HOSTS]
  const normalized = [...new Set(configured.map(normalizeViteAllowedHost).filter(Boolean))]
  return normalized.length > 0 ? normalized : [...DEFAULT_VITE_ALLOWED_HOSTS]
}

function validateViteAllowedHosts(value) {
  if (!Array.isArray(value)) throw new Error('vite.allowedHosts는 문자열 배열이어야 합니다.')
  if (value.length > 100) throw new Error('allowedHosts는 최대 100개까지 저장할 수 있습니다.')

  const invalid = value.find(host => !normalizeViteAllowedHost(host))
  if (invalid !== undefined) {
    throw new Error(`허용 호스트 형식이 올바르지 않습니다: ${String(invalid)}`)
  }

  const normalized = [...new Set(value.map(normalizeViteAllowedHost))]
  if (normalized.length === 0) throw new Error('허용 호스트를 한 개 이상 입력해 주세요.')
  return normalized
}

function loadViteAllowedHostsFromFile(configPath) {
  try {
    return resolveViteAllowedHosts(JSON.parse(fs.readFileSync(configPath, 'utf8')))
  } catch (error) {
    console.warn(`[AllowedHosts] ${configPath} 읽기 실패, 기본값을 사용합니다: ${error.message}`)
    return [...DEFAULT_VITE_ALLOWED_HOSTS]
  }
}

function extractHostname(hostHeader) {
  const value = String(hostHeader || '').trim().toLowerCase()
  if (!value) return ''
  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']')
    return closingBracket > 0 ? value.slice(1, closingBracket) : ''
  }
  return value.replace(/:\d+$/, '').replace(/\.$/, '')
}

function isAllowedFrontendHost(hostHeader, allowedHosts) {
  const hostname = extractHostname(hostHeader)
  if (!hostname) return false
  if (net.isIP(hostname) || hostname === 'localhost' || hostname.endsWith('.localhost')) return true

  return allowedHosts.some((allowedHost) => {
    if (allowedHost.startsWith('.')) {
      const domain = allowedHost.slice(1)
      return hostname === domain || hostname.endsWith(`.${domain}`)
    }
    return hostname === allowedHost
  })
}

module.exports = {
  DEFAULT_VITE_ALLOWED_HOSTS,
  normalizeViteAllowedHost,
  resolveViteAllowedHosts,
  validateViteAllowedHosts,
  loadViteAllowedHostsFromFile,
  isAllowedFrontendHost,
}
