const FILE_VIEW_URL_PATTERN = /(https?:\/\/[^\s)"']+\/api\/files\/view\/[A-Za-z0-9-]+(?:\?[^\s)"']*)?|\/api\/files\/view\/[A-Za-z0-9-]+(?:\?[^\s)"']*)?)/g

export function mapFileViewUrl(url, mutateParams) {
  try {
    const input = String(url || '').trim()
    if (!input) return input
    const absolute = /^https?:\/\//i.test(input)
    const parsed = new URL(input, window.location.origin)
    if (!parsed.pathname.startsWith('/api/files/view/')) return input
    mutateParams(parsed.searchParams)
    if (absolute) return parsed.toString()
    const q = parsed.searchParams.toString()
    return `${parsed.pathname}${q ? `?${q}` : ''}${parsed.hash || ''}`
  } catch {
    return String(url || '')
  }
}

export function normalizeFileViewUrlKey(url) {
  try {
    const input = String(url || '').trim()
    if (!input) return ''
    const parsed = new URL(input, window.location.origin)
    if (!parsed.pathname.startsWith('/api/files/view/')) return input
    parsed.searchParams.delete('auth_token')
    const entries = Array.from(parsed.searchParams.entries())
    entries.sort(([a], [b]) => a.localeCompare(b))
    const query = new URLSearchParams(entries).toString()
    return `${parsed.pathname}${query ? `?${query}` : ''}`
  } catch {
    return String(url || '').trim()
  }
}

export function stripAuthTokenFromFileViewUrl(url) {
  return mapFileViewUrl(url, (params) => {
    params.delete('auth_token')
  })
}

export function ensureAuthTokenInFileViewUrl(url, token) {
  return mapFileViewUrl(url, (params) => {
    params.delete('auth_token')
    if (token) params.set('auth_token', token)
  })
}

export function rewriteFileViewUrlsInMarkdown(md = '', rewriteFn = (v) => v) {
  return String(md || '').replace(FILE_VIEW_URL_PATTERN, (matched) => rewriteFn(matched))
}

export function stripAuthTokenFromMarkdown(md = '') {
  return rewriteFileViewUrlsInMarkdown(md, stripAuthTokenFromFileViewUrl)
}

export function injectAuthTokenIntoMarkdown(md = '', token = '') {
  return rewriteFileViewUrlsInMarkdown(md, (url) => ensureAuthTokenInFileViewUrl(url, token))
}
