const MAX_SUMMARY = 300
const MAX_DESCRIPTION = 3000
const MAX_OCR = 10000
const MAX_ITEMS = 50

function cleanText(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength)
}

function cleanList(value, maxItems = MAX_ITEMS) {
  const source = Array.isArray(value) ? value : (value ? [value] : [])
  return [...new Set(source
    .map(item => cleanText(item, 200))
    .filter(Boolean))]
    .slice(0, maxItems)
}

function extractJsonObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  const text = String(raw || '').trim()
  if (!text) return null
  const withoutFence = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  const first = withoutFence.indexOf('{')
  const last = withoutFence.lastIndexOf('}')
  if (first < 0 || last <= first) return null
  try {
    return JSON.parse(withoutFence.slice(first, last + 1))
  } catch (_) {
    return null
  }
}

function normalizeAnalysis(raw, { ocrText = '', fileName = '', schemaVersion = 1 } = {}) {
  const obj = extractJsonObject(raw) || {}
  const summary = cleanText(obj.summary || obj.caption, MAX_SUMMARY)
  const description = cleanText(obj.description, MAX_DESCRIPTION)
  const normalizedOcr = cleanText(ocrText, MAX_OCR)
  const visibleText = cleanList(obj.visible_text || obj.visibleText)
  const analysis = {
    schema_version: Number(obj.schema_version) || schemaVersion,
    language: 'ko',
    summary: summary || (description ? description.slice(0, MAX_SUMMARY) : `이미지 첨부: ${cleanText(fileName, 200) || 'image'}`),
    description,
    scene_type: cleanText(obj.scene_type || obj.sceneType, 200),
    objects: cleanList(obj.objects),
    actions: cleanList(obj.actions),
    visible_text: visibleText,
    entities: cleanList(obj.entities),
    keywords: cleanList(obj.keywords),
    safety_context: cleanList(obj.safety_context || obj.safetyContext),
    uncertainties: cleanList(obj.uncertainties),
    caption: cleanText(obj.caption || summary, MAX_SUMMARY),
  }
  if (!analysis.caption) analysis.caption = analysis.summary
  if (analysis.visible_text.length === 0 && normalizedOcr) {
    analysis.visible_text = normalizedOcr.split('\n').map(v => v.trim()).filter(Boolean).slice(0, MAX_ITEMS)
  }
  return { analysis, ocrText: normalizedOcr, parsed: Boolean(extractJsonObject(raw)) }
}

function section(title, value) {
  const body = Array.isArray(value) ? value.filter(Boolean).join(', ') : String(value || '').trim()
  return body ? `[${title}]\n${body}` : ''
}

function buildSearchContent(analysis = {}, ocrText = '') {
  return [
    section('IMAGE_SUMMARY', cleanText(analysis.summary, MAX_SUMMARY)),
    section('VISUAL_DESCRIPTION_KO', cleanText(analysis.description, MAX_DESCRIPTION)),
    section('EXACT_VISIBLE_TEXT', cleanText(ocrText, MAX_OCR) || cleanList(analysis.visible_text).join('\n')),
    section('SCENE_TYPE', cleanText(analysis.scene_type, 200)),
    section('OBJECTS', cleanList(analysis.objects)),
    section('ACTIONS', cleanList(analysis.actions)),
    section('ENTITIES', cleanList(analysis.entities)),
    section('SAFETY_CONTEXT', cleanList(analysis.safety_context)),
    section('SEARCH_KEYWORDS', cleanList(analysis.keywords)),
    section('UNCERTAINTIES', cleanList(analysis.uncertainties)),
  ].filter(Boolean).join('\n\n').slice(0, 18000)
}

function retryDelayMs() {
  return 2 * 60 * 60_000
}

module.exports = {
  cleanText,
  cleanList,
  extractJsonObject,
  normalizeAnalysis,
  buildSearchContent,
  retryDelayMs,
}
