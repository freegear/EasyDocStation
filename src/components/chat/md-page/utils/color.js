export function normalizeHexColor(raw, fallback = '#111827') {
  const value = String(raw || '').trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/i.test(value)) return value
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    return `#${value.slice(1).split('').map(ch => `${ch}${ch}`).join('')}`
  }
  const rgbMatch = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (rgbMatch) {
    const r = Math.max(0, Math.min(255, Number(rgbMatch[1] || 0)))
    const g = Math.max(0, Math.min(255, Number(rgbMatch[2] || 0)))
    const b = Math.max(0, Math.min(255, Number(rgbMatch[3] || 0)))
    return `#${[r, g, b].map(n => n.toString(16).padStart(2, '0')).join('')}`
  }
  return fallback
}

export function normalizeHexForColorInput(raw = '#000000') {
  const hex = String(raw || '').trim()
  if (/^#[0-9a-f]{6}$/i.test(hex)) return hex
  if (/^#[0-9a-f]{3}$/i.test(hex)) {
    return `#${hex.slice(1).split('').map(ch => `${ch}${ch}`).join('')}`
  }
  return '#000000'
}

export function findHexTokenAt(text = '', cursorIndex = 0) {
  const src = String(text || '')
  const idx = Number.isFinite(cursorIndex) ? cursorIndex : 0
  const re = /#[0-9a-fA-F]{3,8}\b/g
  let m
  while ((m = re.exec(src)) !== null) {
    const start = m.index
    const end = start + m[0].length
    if (idx >= start && idx <= end) return { start, end, value: m[0] }
  }
  return null
}
