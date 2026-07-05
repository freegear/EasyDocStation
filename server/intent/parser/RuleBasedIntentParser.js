const { ACTIONS, TARGETS, SCOPES, createEmptyIntent } = require('../schema/IntentSchema')

// 자료유형어(type hint): 검색어가 아니라 "어떤 종류의 자료인지" 가리키는 단어.
// keyword 후보에서는 전량 제거하고, target/resourceType/semanticHint 판정에만 쓴다.
// 정렬은 긴 표현이 짧은 표현보다 먼저 오도록(게시글 > 글) 둔다.
const TYPE_HINT_WORDS = [
  '게시글', '포스트', '글',
  '문서', '자료', '데이터', '첨부', '파일',
  '블럭도', '블록도', '도면', '회로도', '다이어그램',
  '이미지', '사진', '그림', '스크린\\s*샷', '스크린샷', '캡처', '캡쳐',
  'pptx?', '프레젠테이션', '발표\\s*자료',
  'block\\s*diagram', 'presentation', 'resource', 'document',
  'attachment', 'file', 'data', 'diagram', 'image', 'photo', 'picture', 'screenshot',
]
const TYPE_HINT_ALT = TYPE_HINT_WORDS.join('|')
const TRAILING_TYPE_HINT_RE = new RegExp(`(?:${TYPE_HINT_ALT})$`, 'iu')
const EXACT_TYPE_HINT_RE = new RegExp(`^(?:${TYPE_HINT_ALT})$`, 'iu')

function getKstParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  }
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function toKstDateOnly(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`
}

function addDaysKst(dateOnly, days) {
  const date = new Date(`${dateOnly}T00:00:00+09:00`)
  date.setUTCDate(date.getUTCDate() + days)
  return getKstParts(date)
}

function parseDateExpression(question, now = new Date()) {
  const text = String(question || '').trim()
  const today = getKstParts(now)

  if (/오늘/.test(text)) {
    return { type: 'single_day', date: toKstDateOnly(today.year, today.month, today.day), source: '오늘' }
  }

  if (/어제/.test(text)) {
    const yesterday = addDaysKst(toKstDateOnly(today.year, today.month, today.day), -1)
    return { type: 'single_day', date: toKstDateOnly(yesterday.year, yesterday.month, yesterday.day), source: '어제' }
  }

  const monthDayMatch = text.match(/(?:(\d{1,2})\s*월\s*)?(\d{1,2})\s*일/)
  if (monthDayMatch) {
    const month = monthDayMatch[1] ? Number(monthDayMatch[1]) : today.month
    const day = Number(monthDayMatch[2])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return {
        type: 'single_day',
        date: toKstDateOnly(today.year, month, day),
        source: monthDayMatch[0],
      }
    }
  }

  return null
}

function parseAction(question) {
  if (isSingleKeywordLocateQuestion(question) || extractSingleKeywordLocateCommand(question)) {
    return ACTIONS.LOCATE
  }
  if (isImageLocateQuestion(question)) {
    return ACTIONS.LOCATE
  }
  if (/(블럭도|블록도|도면|회로도|다이어그램|diagram|block\s*diagram).{0,20}(알려\s*줘|알려줘)/i.test(question)) {
    return ACTIONS.LOCATE
  }
  if (/(어디|위치|찾아\s*줘|찾아줘|링크|바로\s*가기|문서로\s*가기)/.test(question)) {
    return ACTIONS.LOCATE
  }
  return /(요약|정리|핵심|요점)/.test(question) ? ACTIONS.SUMMARIZE : null
}

function parseTarget(question) {
  if (/(블럭도|블록도|도면|회로도|다이어그램|diagram|block\s*diagram)/i.test(question)) return TARGETS.DIAGRAM
  if (/(이미지|사진|그림|스크린\s*샷|스크린샷|캡처|캡쳐|image|photo|picture|screenshot)/i.test(question)) return TARGETS.IMAGE
  if (/(pptx?|프레젠테이션|발표\s*자료|presentation)/i.test(question)) return TARGETS.ATTACHMENTS
  if (/(첨부|파일|attachment|file)/i.test(question)) return TARGETS.ATTACHMENTS
  if (/(문서|document|doc)/i.test(question)) return TARGETS.DOCUMENTS
  if (/(자료|데이터|resource|data)/i.test(question)) return TARGETS.RESOURCES
  return /(글|게시글|포스트|post)/i.test(question) ? TARGETS.POSTS : null
}

function normalizeKeywordToken(value = '') {
  return String(value || '').normalize('NFC')
    .replace(/[?？!！.,，。]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripKoreanParticle(value = '') {
  return String(value || '').replace(/(은|는|이|가|을|를|의)$/u, '')
}

// 끝에 붙은 자료유형어를 "전량" 제거한다.
// 예) "RK3588S2블럭도이미지" → "RK3588S2" (이미지 → 블럭도 순으로 반복 제거)
function stripLocateTargetWords(value = '') {
  let result = String(value || '').trim()
  let prev
  do {
    prev = result
    result = result.replace(TRAILING_TYPE_HINT_RE, '').trim()
  } while (result && result !== prev)
  return result
}

// 토큰 전체가 자료유형어 하나인지 (예: "블럭도", "이미지", "PPT")
function isTypeHintToken(token = '') {
  return EXACT_TYPE_HINT_RE.test(String(token || '').trim())
}

function isExplicitNonLocateIntent(text = '') {
  return /(요약|정리|핵심|요점|설명|무엇|뭐야|뭔가|어떻게|왜|비교|번역|translate|summary)/i.test(String(text || ''))
}

function isImageLocateQuestion(text = '') {
  const normalized = normalizeKeywordToken(text)
  if (!normalized || isExplicitNonLocateIntent(normalized)) return false
  if (!/(이미지|사진|그림|스크린\s*샷|스크린샷|캡처|캡쳐|image|photo|picture|screenshot)/i.test(normalized)) return false
  return Boolean(extractImageLocateKeyword(normalized))
}

function isSingleKeywordLocateQuestion(text = '') {
  const normalized = normalizeKeywordToken(text)
  if (!normalized || /\s/.test(normalized)) return false
  if (normalized.length < 2 || normalized.length > 80) return false
  if (isExplicitNonLocateIntent(normalized)) return false
  if (/^(안녕|hello|hi)$/i.test(normalized)) return false
  return /^[A-Za-z0-9가-힣_.+\-/#]+$/u.test(normalized)
}

function extractSingleKeywordLocateCommand(text = '') {
  const normalized = normalizeKeywordToken(text)
  if (!normalized) return ''

  // 끝의 검색 명령어(찾아줘/검색 등)와 그 앞 조사만 떼어낸다. 공백은 보존한다.
  const stripped = normalized
    .replace(/\s*(?:을|를|은|는|이|가|의)?\s*(?:찾아\s*줘|찾아|검색해\s*줘|검색)$/u, '')
    .trim()
  if (!stripped || stripped === normalized) return '' // 검색 명령어가 없으면 단일키워드 명령이 아님

  // 토큰별로 조사·자료유형어를 제거하고, 남은 실제 검색어 토큰만 모은다.
  const keywords = stripped
    .split(/\s+/)
    .map(part => stripLocateTargetWords(stripKoreanParticle(part)))
    .filter(part => part.length >= 2 && !isTypeHintToken(part))

  if (keywords.length !== 1) return '' // 실검색어가 정확히 1개일 때만 단일 키워드로 처리
  const keyword = keywords[0]
  if (keyword.length < 2 || keyword.length > 80 || isExplicitNonLocateIntent(keyword)) return ''
  return keyword
}

function expandKeywordVariants(token = '') {
  const normalized = normalizeKeywordToken(token)
  if (!normalized) return []
  const compact = normalized.replace(/\s+/g, '')
  return compact && compact !== normalized ? [normalized, compact] : [normalized]
}

function extractImageLocateKeyword(text = '') {
  const normalized = normalizeKeywordToken(text)
  if (!normalized) return ''

  const match = normalized.match(/^(.+?)(?:\s*(?:을|를|은|는|이|가|의))?\s*(?:(?:사용|이용)한|포함(?:된|한)|관련(?:된)?|담긴)?\s*(?:이미지|사진|그림|스크린\s*샷|스크린샷|캡처|캡쳐|image|photo|picture|screenshot)(?:\s*(?:자료|파일|첨부))?(?:\s*(?:어디(?:에)?\s*(?:있는가|있어|있나요|있습니까)?|위치|찾아\s*줘|찾아줘|검색|검색해\s*줘|링크\s*(?:보여\s*줘|줘)?|보여\s*줘|보여줘|알려\s*줘|알려줘))?$/i)
  if (!match?.[1]) return ''
  return stripLocateTargetWords(stripKoreanParticle(normalizeKeywordToken(match[1])))
}

function parseKeywords(question) {
  const imageKeyword = extractImageLocateKeyword(question)
  if (imageKeyword) return [imageKeyword]

  const commandKeyword = extractSingleKeywordLocateCommand(question)
  if (commandKeyword) return [commandKeyword]

  let text = normalizeKeywordToken(question)
  if (!text) return []

  const relatedMatch = text.match(new RegExp(`(.+?)\\s*(?:관련|대한|관한)\\s*(?:${TYPE_HINT_ALT})`, 'iu'))
  if (relatedMatch?.[1]) {
    text = relatedMatch[1]
  } else {
    text = text
      .replace(new RegExp(`(?:${TYPE_HINT_ALT})(?:은|는|이|가|을|를)?\\s*(?:어디(?:에)?\\s*(?:있는가|있어|있나요|있습니까)?|위치|찾아\\s*줘|찾아줘|검색|검색해\\s*줘|링크\\s*(?:보여\\s*줘|줘)?|문서로\\s*가기|알려\\s*줘).*$`, 'iu'), '')
      .replace(/(?:어디(?:에)?\s*(?:있는가|있어|있나요|있습니까)?|위치|찾아\s*줘|찾아줘|링크\s*(?:보여\s*줘|줘)?|문서로\s*가기|알려\s*줘).*$/i, '')
  }

  text = text
    .replace(/^(?:전체|모든|현재|이|해당)\s+/, '')
    .replace(/\b(?:where|find|link|locate)\b/gi, ' ')

  const base = normalizeKeywordToken(text)
  if (!base) return []

  // 남은 토큰에서도 조사·자료유형어를 걸러 실제 검색어 토큰만 남긴다.
  const cleanTokens = base
    .split(/\s+/)
    .map(part => stripLocateTargetWords(stripKoreanParticle(part)))
    .filter(part => part.length >= 2 && !isTypeHintToken(part))
  if (cleanTokens.length === 0) return []

  const variants = [
    ...expandKeywordVariants(cleanTokens.join(' ')),
    ...cleanTokens,
  ]
  return [...new Set(variants.map(normalizeKeywordToken).filter(Boolean))]
}

class RuleBasedIntentParser {
  parse(question, context = {}) {
    const intent = createEmptyIntent()
    const text = String(question || '').normalize('NFC').trim()

    intent.action = parseAction(text)
    intent.target = parseTarget(text)
    intent.scope = SCOPES.CURRENT_CHANNEL
    intent.date = parseDateExpression(text, context.now)
    intent.keywords = intent.action === ACTIONS.LOCATE ? parseKeywords(text) : []
    intent.matchMode = isSingleKeywordLocateQuestion(text) || extractSingleKeywordLocateCommand(text) || extractImageLocateKeyword(text) ? 'exact_token_first' : null

    const matchedSlots = [intent.action, intent.target, intent.date, intent.keywords?.length ? intent.keywords : null, intent.matchMode].filter(Boolean).length
    intent.confidence = Math.min(1, matchedSlots / 5)

    return intent
  }
}

module.exports = RuleBasedIntentParser
