export const MIN_CONTENT_FONT_SCALE = 90
export const MAX_CONTENT_FONT_SCALE = 130
export const CONTENT_FONT_BASE_REM = 0.875

export function normalizeContentFontScale(value) {
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed)) return 100
  return Math.min(MAX_CONTENT_FONT_SCALE, Math.max(MIN_CONTENT_FONT_SCALE, parsed))
}

export function getContentFontStyle(scale) {
  return {
    '--content-font-base': `${CONTENT_FONT_BASE_REM}rem`,
    '--content-font-scale': normalizeContentFontScale(scale) / 100,
    '--content-font-size': 'calc(var(--content-font-base) * var(--content-font-scale))',
    fontSize: 'var(--content-font-size)',
  }
}
