import { DEFAULT_IMAGE_CONTAINER_STYLE } from './constants'
import { normalizeFileViewUrlKey, stripAuthTokenFromFileViewUrl } from './fileViewUrls'

export function normalizeImageMetaKeys(imageMeta = {}) {
  const entries = Object.entries(imageMeta || {})
  if (entries.length === 0) return {}
  const normalized = {}
  for (const [key, val] of entries) {
    const nextKey = normalizeFileViewUrlKey(stripAuthTokenFromFileViewUrl(String(key || '').trim()))
    if (!nextKey) continue
    normalized[nextKey] = val || {}
  }
  return normalized
}

export function extractPixelWidthFromStyle(style = '') {
  const text = String(style || '')
  const m = text.match(/width:\s*([0-9.]+)px/i)
  if (!m?.[1]) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? String(Math.round(n)) : null
}

export function buildContainerStyleWithWidth(existingStyle = '', width = null) {
  const styleText = String(existingStyle || '').trim()
  const widthValue = width == null ? null : `${Number(width)}px`
  if (!widthValue || Number.isNaN(Number(width))) {
    return styleText || DEFAULT_IMAGE_CONTAINER_STYLE
  }

  if (!styleText) {
    return `width: ${widthValue}; height: auto; cursor: pointer;`
  }

  if (/width\s*:/i.test(styleText)) {
    return styleText.replace(/width:\s*[^;]+;?/i, `width: ${widthValue};`)
  }
  return `width: ${widthValue}; ${styleText}`
}

export function normalizeStyleStr(s) {
  return String(s || '').trim().replace(/;\s*$/, '')
}

export function hasSizingMeta(meta = {}) {
  if (!meta || typeof meta !== 'object') return false
  const widthFromAttr = meta.width
  const widthFromContainerStyle = extractPixelWidthFromStyle(meta.containerStyle || '')
  return (
    widthFromAttr != null
    || widthFromContainerStyle != null
  )
}

export function collectImageMetaFromDoc(doc, fallbackMap = {}) {
  const normalizedFallbackMap = normalizeImageMetaKeys(fallbackMap || {})
  const map = {}
  doc.descendants((node) => {
    if (node.type.name !== 'image') return
    const src = normalizeFileViewUrlKey(stripAuthTokenFromFileViewUrl(String(node.attrs?.src || '').trim()))
    if (!src) return
    const widthFromAttr = node.attrs?.width ?? null
    const widthFromStyle = extractPixelWidthFromStyle(node.attrs?.containerStyle || '')
    const resolvedWidth = widthFromAttr ?? widthFromStyle ?? null
    const current = {
      width: resolvedWidth,
      containerStyle: node.attrs?.containerStyle ?? null,
      wrapperStyle: node.attrs?.wrapperStyle ?? null,
    }
    const fallback = normalizedFallbackMap?.[src] || {}
    map[src] = hasSizingMeta(current) ? current : {
      width: fallback.width ?? current.width ?? null,
      containerStyle: fallback.containerStyle ?? current.containerStyle ?? null,
      wrapperStyle: fallback.wrapperStyle ?? current.wrapperStyle ?? null,
    }
  })
  return map
}

export function sameImageMeta(a = {}, b = {}) {
  const aKeys = Object.keys(a).sort()
  const bKeys = Object.keys(b).sort()
  if (aKeys.length !== bKeys.length) return false
  for (let i = 0; i < aKeys.length; i += 1) {
    if (aKeys[i] !== bKeys[i]) return false
    const av = a[aKeys[i]] || {}
    const bv = b[bKeys[i]] || {}
    if ((av.width ?? null) !== (bv.width ?? null)) return false
    if (normalizeStyleStr(av.containerStyle) !== normalizeStyleStr(bv.containerStyle)) return false
    if (normalizeStyleStr(av.wrapperStyle) !== normalizeStyleStr(bv.wrapperStyle)) return false
  }
  return true
}

