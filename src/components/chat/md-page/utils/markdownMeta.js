import { MD_DOC_META_PREFIX, MD_IMAGE_META_PREFIX } from './constants'
import { normalizeImageMetaKeys } from './imageMeta'
import { stripAuthTokenFromFileViewUrl } from './fileViewUrls'

export function extractImageMeta(mdText = '') {
  const regex = /<!--md-image-meta:([A-Za-z0-9+/=_-]+)-->/g
  const matches = Array.from(String(mdText || '').matchAll(regex))
  const encoded = matches.length > 0 ? matches[matches.length - 1]?.[1] : ''
  if (!encoded) return {}
  try {
    const decoded = atob(encoded)
    try {
      return normalizeImageMetaKeys(JSON.parse(decoded) || {})
    } catch {
      // Backward/forward safety for unicode payloads.
      return normalizeImageMetaKeys(JSON.parse(decodeURIComponent(escape(decoded))) || {})
    }
  } catch {
    return {}
  }
}

export function stripImageMeta(mdText = '') {
  return String(mdText || '').replace(/\n?<!--md-image-meta:[A-Za-z0-9+/=_-]+-->\s*/g, '')
}

export function mapDocMetaUrls(node, mapper = (v) => v) {
  if (Array.isArray(node)) return node.map((child) => mapDocMetaUrls(child, mapper))
  if (!node || typeof node !== 'object') return node

  const next = { ...node }
  if (next.attrs && typeof next.attrs === 'object') {
    next.attrs = { ...next.attrs }
    if (typeof next.attrs.src === 'string') next.attrs.src = mapper(next.attrs.src)
    if (typeof next.attrs.href === 'string') next.attrs.href = mapper(next.attrs.href)
  }
  if (Array.isArray(next.content)) {
    next.content = next.content.map((child) => mapDocMetaUrls(child, mapper))
  }
  return next
}

export function extractDocMeta(mdText = '') {
  const regex = /<!--md-doc-meta:([A-Za-z0-9+/=_-]+)-->/g
  const matches = Array.from(String(mdText || '').matchAll(regex))
  const encoded = matches.length > 0 ? matches[matches.length - 1]?.[1] : ''
  if (!encoded) return null
  try {
    const decoded = atob(encoded)
    const parsed = JSON.parse(decodeURIComponent(escape(decoded)))
    if (!parsed || typeof parsed !== 'object') return null
    return mapDocMetaUrls(parsed, (url) => stripAuthTokenFromFileViewUrl(url))
  } catch {
    return null
  }
}

export function stripDocMeta(mdText = '') {
  return String(mdText || '').replace(/\n?<!--md-doc-meta:[A-Za-z0-9+/=_-]+-->\s*/g, '')
}

export function stripAllMdMeta(mdText = '') {
  return stripDocMeta(stripImageMeta(mdText))
}

export function attachDocMeta(mdText = '', docJson = null) {
  const plain = stripDocMeta(mdText || '')
  if (!docJson || typeof docJson !== 'object') return plain
  const sanitized = mapDocMetaUrls(docJson, (url) => stripAuthTokenFromFileViewUrl(url))
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(sanitized))))
  return `${plain}\n${MD_DOC_META_PREFIX}${encoded}-->`
}

export function attachImageMeta(mdText = '', imageMeta = {}) {
  const plain = stripImageMeta(mdText || '')
  const normalizedMeta = normalizeImageMetaKeys(imageMeta || {})
  const keys = Object.keys(normalizedMeta)
  if (keys.length === 0) return plain
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(normalizedMeta))))
  return `${plain}\n${MD_IMAGE_META_PREFIX}${encoded}-->`
}

