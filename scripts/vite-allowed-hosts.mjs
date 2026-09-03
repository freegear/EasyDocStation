import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_VITE_ALLOWED_HOSTS = [
  'www.easystation.co.kr',
  'easystation.co.kr',
  '218.237.25.214',
]

function normalizeHost(value) {
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

export function resolveViteAllowedHosts(config, logger = console) {
  const configured = config?.vite?.allowedHosts
  if (configured === undefined) return [...DEFAULT_VITE_ALLOWED_HOSTS]
  if (!Array.isArray(configured)) {
    logger.warn('[Vite] config.json의 vite.allowedHosts는 문자열 배열이어야 합니다. 기본값을 사용합니다.')
    return [...DEFAULT_VITE_ALLOWED_HOSTS]
  }

  const allowedHosts = [...new Set(configured.map(normalizeHost).filter(Boolean))]
  if (allowedHosts.length === 0) {
    logger.warn('[Vite] 유효한 vite.allowedHosts가 없어 기본값을 사용합니다.')
    return [...DEFAULT_VITE_ALLOWED_HOSTS]
  }
  if (allowedHosts.length !== configured.length) {
    logger.warn('[Vite] 형식이 잘못되었거나 중복된 allowedHosts 항목을 제외했습니다.')
  }
  return allowedHosts
}

export function loadViteAllowedHosts({ configPath, logger = console } = {}) {
  const defaultConfigPath = fileURLToPath(new URL('../config.json', import.meta.url))
  const resolvedPath = path.resolve(configPath || process.env.EASYSTATION_CONFIG_FILE || defaultConfigPath)
  try {
    const config = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'))
    return resolveViteAllowedHosts(config, logger)
  } catch (error) {
    logger.warn(`[Vite] ${resolvedPath}에서 allowedHosts를 읽지 못해 기본값을 사용합니다: ${error.message}`)
    return [...DEFAULT_VITE_ALLOWED_HOSTS]
  }
}
