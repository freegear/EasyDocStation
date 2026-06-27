const ENTITY_MAP = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeHtmlEntities(value) {
  return String(value || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, entity) => {
    const key = entity.toLowerCase()
    if (key[0] === '#') {
      const radix = key[1] === 'x' ? 16 : 10
      const codePoint = Number.parseInt(key[1] === 'x' ? key.slice(2) : key.slice(1), radix)
      if (Number.isFinite(codePoint)) {
        try {
          return String.fromCodePoint(codePoint)
        } catch {
          return match
        }
      }
    }
    return ENTITY_MAP[key] || match
  })
}

function stripHtml(value) {
  return decodeHtmlEntities(String(value || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[if[\s\S]*?<!\[endif\]>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?(br|p|div|tr|li|table|tbody|thead|tfoot|h[1-6])\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
}

function normalizePreviewText(value, maxLength = 240) {
  return stripHtml(value)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function buildSnippet(candidates, maxLength = 240) {
  for (const candidate of candidates) {
    const snippet = normalizePreviewText(candidate, maxLength)
    if (snippet) return snippet
  }
  return ''
}

module.exports = {
  buildSnippet,
  decodeHtmlEntities,
  normalizePreviewText,
  stripHtml,
}
