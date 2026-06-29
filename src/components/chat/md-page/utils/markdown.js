import { normalizeBrokenOrderedListItems } from '../../../../lib/markdownNormalize'

export function normalizeMarkdownForTableParsing(md = '') {
  const text = normalizeBrokenOrderedListItems(String(md || '')).replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!/^\s{4,}`[^`\n]+`\s*$/.test(line)) continue

    let prev = i - 1
    while (prev >= 0 && lines[prev].trim() === '') prev -= 1
    if (prev < 0) continue

    const prevLine = lines[prev]
    const isListLine = /^\s*(?:[-*+]\s+|\d+\.\s+)/.test(prevLine)
    if (!isListLine) continue

    lines[i] = `  ${line.trim()}`
  }
  const normalizedText = lines.join('\n')
  return normalizedText
    .replace(/(!\[[^\]]*]\([^)]*\))(?=\|)/g, '$1\n\n')
    .replace(/(<img\b[^>]*>)(?=\|)/gi, '$1\n\n')
    .replace(/(!\[[^\]]*]\([^)]+\)(?:\{[^}]*\})?[^\n]*)\n(?=\|.+\|)/g, '$1\n\n')
    .replace(/(<img\b[^>]*>[^\n]*)\n(?=\|.+\|)/gi, '$1\n\n')
}

export function normalizeLinkUrl(input = '') {
  const raw = String(input || '').trim()
  if (!raw) return ''
  if (/^(https?:\/\/|mailto:|tel:|\/|#)/i.test(raw)) return raw
  return `https://${raw}`
}

export function truncateSingleLine(text = '', max = 60) {
  const oneLine = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim())
    .find(Boolean) || ''
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max - 1)}…`
}
