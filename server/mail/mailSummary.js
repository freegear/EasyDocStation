const http = require('http')
const config = require('../../config.json')

function getOllamaChatOptions() {
  return {
    hostname: String(process.env.OLLAMA_HOST || '127.0.0.1').trim() || '127.0.0.1',
    port: Number(process.env.OLLAMA_PORT || 11434),
    path: '/api/chat',
  }
}

function requestOllama(payload, timeoutMs = 120000) {
  const options = getOllamaChatOptions()
  const body = JSON.stringify(payload)

  return new Promise((resolve, reject) => {
    const req = http.request({
      ...options,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Ollama HTTP ${res.statusCode}: ${raw.slice(0, 300)}`))
          return
        }
        try {
          const data = JSON.parse(raw)
          resolve(String(data?.message?.content || '').trim())
        } catch (err) {
          reject(err)
        }
      })
    })

    req.on('timeout', () => req.destroy(new Error('OLLAMA_TIMEOUT')))
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function normalizeText(value = '') {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

const PIPELINE_VERSION = 'mail-summary-pipeline-v2'

function decodeBasicHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}

function stripMailQuotedHistory(value = '') {
  const lines = String(value || '').split('\n')
  const stopPatterns = [
    /^-{2,}\s*original message\s*-{2,}$/i,
    /^-{2,}\s*forwarded message\s*-{2,}$/i,
    /^on .+ wrote:$/i,
    /^from:\s.+/i,
    /^보낸 사람\s*:/,
    /^발신\s*:/,
    /^전달된 메시지/,
    /^差出人\s*:/,
    /^送信者\s*:/,
  ]
  const kept = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (stopPatterns.some(pattern => pattern.test(trimmed))) break
    if (/^>+/.test(trimmed)) continue
    kept.push(line)
  }
  return kept.join('\n')
}

function cleanMailBodyText(value = '') {
  const withoutHtml = decodeBasicHtmlEntities(String(value || ''))
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  return normalizeText(stripMailQuotedHistory(withoutHtml)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n'))
}

function buildAddressLine(label, value) {
  const rows = Array.isArray(value) ? value : []
  const text = rows
    .map(item => {
      if (!item || typeof item !== 'object') return String(item || '').trim()
      const email = String(item.email || '').trim()
      const name = String(item.name || '').trim()
      return name && email ? `${name} <${email}>` : email || name
    })
    .filter(Boolean)
    .join(', ')
  return text ? `${label}: ${text}` : ''
}

function buildMailSummaryPrompt({ message, bodyText }) {
  const headers = [
    `제목: ${message.subject || '(제목 없음)'}`,
    message.from_email || message.from_name
      ? `보낸 사람: ${message.from_name || ''}${message.from_email ? ` <${message.from_email}>` : ''}`.trim()
      : '',
    buildAddressLine('받는 사람', message.to_json),
    buildAddressLine('참조', message.cc_json),
    message.received_at ? `수신 시간: ${message.received_at}` : '',
  ].filter(Boolean)

  return [
    '[메일 메타데이터]',
    ...headers,
    '',
    '[이메일 본문]',
    normalizeText(bodyText || message.snippet || ''),
  ].join('\n')
}

const LANGUAGE_META = {
  ko: { label: '한국어', noInfo: '확인된 내용 없음' },
  en: { label: 'English', noInfo: 'No confirmed information' },
  ja: { label: '日本語', noInfo: '確認できる内容なし' },
}

function normalizeLanguage(value) {
  const code = String(value || '').trim().toLowerCase()
  return LANGUAGE_META[code] ? code : 'ko'
}

function getLanguageMeta(language) {
  return LANGUAGE_META[normalizeLanguage(language)]
}

function hasKorean(text) {
  return /[가-힣]/.test(String(text || ''))
}

function hasJapaneseKana(text) {
  return /[\u3040-\u30ff]/.test(String(text || ''))
}

function detectLanguageHeuristic(text) {
  const value = String(text || '')
  if (hasKorean(value)) return 'ko'
  if (hasJapaneseKana(value)) return 'ja'
  if (/[A-Za-z]/.test(value)) return 'en'
  return 'unknown'
}

function cleanLanguageCode(value) {
  const code = String(value || '').trim().toLowerCase().match(/\b(ko|en|ja|unknown)\b/)?.[1]
  return code || 'unknown'
}

const NO_INFO = LANGUAGE_META.ko.noInfo

function defaultStructuredSummary(language = 'ko') {
  const noInfo = getLanguageMeta(language).noInfo
  return {
    schedule: {
      date: noInfo,
      time: noInfo,
      location: noInfo,
      participants: noInfo,
      notes: noInfo,
    },
    keyPoints: [noInfo],
    summary: noInfo,
    actionItems: [
      {
        task: noInfo,
        time: noInfo,
      },
    ],
  }
}

function asNonEmptyString(value, language = 'ko') {
  const text = String(value ?? '').trim()
  return text || getLanguageMeta(language).noInfo
}

function asStringArray(value, language = 'ko') {
  const noInfo = getLanguageMeta(language).noInfo
  if (Array.isArray(value)) {
    const rows = value.map(item => String(item ?? '').trim()).filter(Boolean)
    return rows.length ? rows : [noInfo]
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return [noInfo]
}

function normalizeStructuredSummary(value, language = 'ko') {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const base = defaultStructuredSummary(language)
  const noInfo = getLanguageMeta(language).noInfo
  const schedule = source.schedule && typeof source.schedule === 'object' && !Array.isArray(source.schedule)
    ? source.schedule
    : {}
  const actionItems = Array.isArray(source.actionItems) ? source.actionItems : []
  const normalizedActions = actionItems
    .map(item => {
      if (typeof item === 'string') return { task: asNonEmptyString(item, language), time: noInfo }
      if (!item || typeof item !== 'object') return null
      return {
        task: asNonEmptyString(item.task, language),
        time: asNonEmptyString(item.time, language),
      }
    })
    .filter(Boolean)

  return {
    schedule: {
      date: asNonEmptyString(schedule.date ?? base.schedule.date, language),
      time: asNonEmptyString(schedule.time ?? base.schedule.time, language),
      location: asNonEmptyString(schedule.location ?? base.schedule.location, language),
      participants: asNonEmptyString(schedule.participants ?? base.schedule.participants, language),
      notes: asNonEmptyString(schedule.notes ?? base.schedule.notes, language),
    },
    keyPoints: asStringArray(source.keyPoints, language),
    summary: asNonEmptyString(source.summary, language),
    actionItems: normalizedActions.length ? normalizedActions : base.actionItems,
  }
}

function stripJsonFence(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

function extractJsonObject(text) {
  const cleaned = stripJsonFence(text)
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) return cleaned

  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) return cleaned.slice(start, end + 1)
  return cleaned
}

function parseStructuredSummary(rawText, language = 'ko') {
  const jsonText = extractJsonObject(rawText)
  return normalizeStructuredSummary(JSON.parse(jsonText), language)
}

function parseFactLines(rawText) {
  return String(rawText || '')
    .split('\n')
    .map(line => line
      .replace(/^\s*[-*•]\s*/, '')
      .replace(/^\s*\d+[.)]\s*/, '')
      .trim())
    .filter(Boolean)
    .filter(line => !/^(없음|없습니다|no facts?|none|n\/a|確認できる内容なし)$/i.test(line))
    .slice(0, 12)
}

function uniqueRows(rows) {
  const seen = new Set()
  const result = []
  for (const row of rows.map(item => String(item || '').trim()).filter(Boolean)) {
    const key = row.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(row)
  }
  return result
}

function localizedText(language) {
  const code = normalizeLanguage(language)
  if (code === 'en') {
    return {
      thanks: 'The sender thanked the recipient for the reply.',
      proceed: 'The sender will proceed with the process based on the received response.',
      waitPayment: 'The sender asked the recipient to wait until the payment/deposit is completed.',
      noSchedule: 'No confirmed schedule information',
      noActionTime: 'No confirmed time',
      noExtraAction: 'No additional action confirmed',
      shortSummary: 'This email confirms receipt of the previous response and states that processing will continue. The sender asks the recipient to wait until the payment/deposit is completed.',
    }
  }
  if (code === 'ja') {
    return {
      thanks: '差出人は回答への謝意を伝えています。',
      proceed: '差出人は受領した内容に基づいて処理を進める予定です。',
      waitPayment: '差出人は入金まで少し待つよう依頼しています。',
      noSchedule: '確認できる日程情報なし',
      noActionTime: '確認できる時間なし',
      noExtraAction: '追加対応は確認できません',
      shortSummary: 'このメールは、前回の回答への謝意を伝え、受領した内容に基づいて処理を進めることを知らせています。入金まで少し待つよう依頼しています。',
    }
  }
  return {
    thanks: '발신자가 회신에 대해 감사 인사를 전했습니다.',
    proceed: '발신자는 받은 내용을 바탕으로 처리를 진행하겠다고 안내했습니다.',
    waitPayment: '발신자는 입금까지 조금 기다려 달라고 요청했습니다.',
    noSchedule: '확인된 일정 정보 없음',
    noActionTime: '확인된 시간 없음',
    noExtraAction: '추가로 확인된 조치 없음',
    shortSummary: '이 메일은 이전 답변에 대한 감사와 함께, 받은 내용을 바탕으로 처리를 진행하겠다는 내용을 전달합니다. 입금까지 조금 기다려 달라는 요청도 포함되어 있습니다.',
  }
}

function buildRuleFacts({ cleanBodyText, analysisText, targetLanguage }) {
  const text = [cleanBodyText, analysisText].filter(Boolean).join('\n')
  const local = localizedText(targetLanguage)
  const facts = []
  if (/(ありがとう|ありがとうございます|감사|thank(s| you)?)/i.test(text)) facts.push(local.thanks)
  if (/(処理\s*進め|進めて参ります|처리.{0,12}진행|proceed|process)/i.test(text)) facts.push(local.proceed)
  if (/(入金|입금|送金|송금|payment|deposit).{0,30}(待|기다|wait)|待.{0,30}(入金|입금|送金|송금|payment|deposit)/i.test(text)) {
    facts.push(local.waitPayment)
  }
  return facts
}

function isNoInfoText(value, language = 'ko') {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return true
  const noInfo = getLanguageMeta(language).noInfo.toLowerCase()
  return text === noInfo ||
    /^(확인된 내용 없음|확인된 일정 정보 없음|no confirmed information|no confirmed schedule information|確認できる内容なし|確認できる日程情報なし)$/i.test(text)
}

function findSummaryQualityFlags(summary, factList, language = 'ko') {
  const flags = []
  const meaningfulFacts = Array.isArray(factList) ? factList.filter(Boolean) : []
  const keyPoints = Array.isArray(summary?.keyPoints) ? summary.keyPoints : []
  const actions = Array.isArray(summary?.actionItems) ? summary.actionItems : []
  if (meaningfulFacts.length && keyPoints.every(item => isNoInfoText(item, language))) flags.push('key_points_empty_despite_facts')
  if (meaningfulFacts.length && isNoInfoText(summary?.summary, language)) flags.push('summary_empty_despite_facts')
  if (meaningfulFacts.length && actions.every(item => isNoInfoText(item?.task, language))) flags.push('actions_empty_despite_facts')
  return flags
}

async function detectMailLanguage({ text, model }) {
  const sample = normalizeText(text).slice(0, 6000)
  if (!sample) return 'unknown'
  try {
    const raw = await requestOllama({
      model,
      stream: false,
      messages: [
        {
          role: 'system',
          content: '다음 이메일 본문의 주된 언어를 ISO 코드로만 답하세요. 가능한 값: ko, en, ja, unknown. 설명 없이 코드만 출력하세요.',
        },
        { role: 'user', content: sample },
      ],
      options: {
        temperature: 0,
        num_ctx: config?.agenticai?.num_ctx || 4096,
        num_predict: 16,
      },
    }, 60000)
    const code = cleanLanguageCode(raw)
    return code === 'unknown' ? detectLanguageHeuristic(sample) : code
  } catch {
    return detectLanguageHeuristic(sample)
  }
}

async function translateMailText({ text, targetLanguage, model }) {
  const target = getLanguageMeta(targetLanguage)
  const source = normalizeText(text)
  if (!source) return ''
  return requestOllama({
    model,
    stream: false,
    messages: [
      {
        role: 'system',
        content: [
          `다음 이메일 본문을 ${target.label}로 정확히 번역하세요.`,
          '업무 메일의 의미, 날짜, 금액, 장소, 고유명사, 계정 번호는 변경하지 마세요.',
          '번역문만 출력하세요.',
        ].join('\n'),
      },
      { role: 'user', content: source.slice(0, 24000) },
    ],
    options: {
      temperature: 0.1,
      num_ctx: config?.agenticai?.num_ctx || 4096,
      num_predict: config?.agenticai?.num_predict || 2048,
    },
  })
}

async function extractMailFacts({ text, targetLanguage, model }) {
  const target = getLanguageMeta(targetLanguage)
  const source = normalizeText(text).slice(0, 20000)
  if (!source) return []
  try {
    const raw = await requestOllama({
      model,
      stream: false,
      messages: [
        {
          role: 'system',
          content: [
            '당신은 업무 이메일에서 명시적으로 확인 가능한 사실만 추출하는 assistant입니다.',
            `반드시 ${target.label}로만 작성하세요.`,
            '추측하지 말고, 메일에 직접 드러난 사실만 bullet 목록으로 출력하세요.',
            '감사, 처리 예정, 입금/송금 대기, 정보 요청, 회신 필요 여부처럼 짧은 업무 메일의 의도도 사실로 기록하세요.',
            '일정, 날짜, 시간, 장소, 참석자, 금액, 계정번호, 요청사항, 후속 조치를 빠뜨리지 마세요.',
            '출력은 bullet 목록만 사용하고 설명 문장은 쓰지 마세요.',
          ].join('\n'),
        },
        { role: 'user', content: source },
      ],
      options: {
        temperature: 0,
        num_ctx: config?.agenticai?.num_ctx || 4096,
        num_predict: 1024,
      },
    }, 90000)
    return parseFactLines(raw)
  } catch {
    return []
  }
}

function buildStructuredSystemPrompt({ retry = false, targetLanguage = 'ko' } = {}) {
  const target = getLanguageMeta(targetLanguage)
  const noInfo = target.noInfo
  return [
    '당신은 이메일 내용을 분석해 업무용 요약 JSON을 생성하는 assistant입니다.',
    '',
    `반드시 ${target.label}로만 응답하세요.`,
    '사용자가 제공한 이메일 본문과 메타데이터를 읽고, 반드시 JSON 객체만 반환하세요.',
    '사용자가 제공한 [확인된 사실 목록]을 최우선 근거로 사용하세요.',
    'Markdown, 설명 문장, 코드블록, 주석은 절대 출력하지 마세요.',
    retry ? '이전 응답은 부정확하거나 정보 누락이 있었습니다. 사실 목록의 의미를 반영해 순수 JSON 객체만 다시 출력하세요.' : '',
    '',
    '반환 JSON 스키마:',
    '{',
    '  "schedule": {',
    '    "date": "",',
    '    "time": "",',
    '    "location": "",',
    '    "participants": "",',
    '    "notes": ""',
    '  },',
    '  "keyPoints": [],',
    '  "summary": "",',
    '  "actionItems": [',
    '    {',
    '      "task": "",',
    '      "time": ""',
    '    }',
    '  ]',
    '}',
    '',
    '작성 규칙:',
    '- 이메일 본문에 있는 정보만 사용하세요.',
    '- 추측하거나 없는 내용을 만들지 마세요.',
    `- 사실 목록에 업무 의미가 있으면 "${noInfo}"으로 대체하지 말고 요약에 반영하세요.`,
    '- 단순 감사/처리 예정/입금 대기 같은 짧은 업무 메일도 의미 있는 keyPoints와 summary로 작성하세요.',
    '- 날짜, 시간, 장소, 참석 대상 등 일정 정보는 schedule에 정리하세요.',
    '- 핵심 목적, 회의 배경, 주요 요청사항은 keyPoints 배열에 정리하세요.',
    '- 전체 메일 내용은 summary에 2~4문장으로 자연스럽게 요약하세요.',
    '- 사용자가 해야 할 일, 준비물, 회신 필요 여부, 마감 또는 관련 시간은 actionItems에 정리하세요.',
    `- 정보가 없는 문자열 필드는 "${noInfo}"으로 작성하세요.`,
    `- 정보가 없는 배열 필드는 ["${noInfo}"]으로 작성하세요.`,
    `- actionItems의 time이 명확하지 않으면 "${noInfo}"으로 작성하세요.`,
    `- ${target.label}로 작성하세요.`,
    '- JSON 외의 텍스트를 출력하지 마세요.',
  ].filter(Boolean).join('\n')
}

function buildStructuredUserContent({ message, bodyText, factList }) {
  const prompt = buildMailSummaryPrompt({ message, bodyText })
  return [
    prompt,
    '',
    '[확인된 사실 목록]',
    ...(factList.length ? factList.map(item => `- ${item}`) : ['- 확인된 사실 없음']),
  ].join('\n').slice(0, 28000)
}

function buildFallbackSummary({ cleanBodyText, analysisText, targetLanguage, factList }) {
  const language = normalizeLanguage(targetLanguage)
  const noInfo = getLanguageMeta(language).noInfo
  const local = localizedText(language)
  const ruleFacts = buildRuleFacts({ cleanBodyText, analysisText, targetLanguage: language })
  const points = uniqueRows([...ruleFacts, ...(Array.isArray(factList) ? factList : [])]).slice(0, 5)
  const keyPoints = points.length ? points : [noInfo]
  const summary = points.length
    ? (ruleFacts.length >= 2 ? local.shortSummary : keyPoints.join(' '))
    : noInfo

  const actionItems = []
  if (ruleFacts.includes(local.waitPayment)) {
    actionItems.push({ task: local.waitPayment, time: local.noActionTime })
  }
  if (!actionItems.length) {
    actionItems.push({ task: points.length ? local.noExtraAction : noInfo, time: local.noActionTime })
  }

  return {
    schedule: {
      date: local.noSchedule,
      time: local.noSchedule,
      location: local.noSchedule,
      participants: local.noSchedule,
      notes: local.noSchedule,
    },
    keyPoints,
    summary,
    actionItems,
  }
}

async function summarizeMail({ message, bodyText, model: requestedModel, targetLanguage: requestedTargetLanguage = 'ko' }) {
  const model = String(
    requestedModel ||
    process.env.EASYDOC_MAIL_SUMMARY_MODEL ||
    process.env.EASYDOC_SUMMARY_MODEL ||
    process.env.EASYDOC_CHAT_MODEL ||
    config?.rag?.ocr_model ||
    'gemma4:e4b',
  ).trim()

  const targetLanguage = normalizeLanguage(requestedTargetLanguage)
  const cleanBodyText = cleanMailBodyText(bodyText || message.snippet || message.subject || '')
  const sourceLanguage = await detectMailLanguage({
    text: [message.subject, cleanBodyText || message.snippet || ''].filter(Boolean).join('\n\n'),
    model,
  })
  const shouldTranslate = sourceLanguage !== 'unknown' && sourceLanguage !== targetLanguage
  const translatedText = shouldTranslate
    ? normalizeText(await translateMailText({ text: cleanBodyText || message.snippet || message.subject || '', targetLanguage, model }))
    : ''
  if (shouldTranslate && !translatedText) {
    throw new Error('MAIL_TRANSLATION_FAILED')
  }
  const analysisText = shouldTranslate ? translatedText : cleanBodyText
  const llmFacts = await extractMailFacts({ text: analysisText, targetLanguage, model })
  const ruleFacts = buildRuleFacts({ cleanBodyText, analysisText, targetLanguage })
  const factList = uniqueRows([...ruleFacts, ...llmFacts]).slice(0, 12)
  const sourceText = buildStructuredUserContent({
    message,
    bodyText: analysisText,
    factList,
  })
  const qualityFlags = []
  const buildPayload = (retry = false) => ({
    model,
    stream: false,
    messages: [
      {
        role: 'system',
        content: buildStructuredSystemPrompt({ retry, targetLanguage }),
      },
      {
        role: 'user',
        content: sourceText,
      },
    ],
    options: {
      temperature: 0.1,
      num_ctx: config?.agenticai?.num_ctx || 4096,
      num_predict: config?.agenticai?.num_predict || 2048,
    },
  })

  let rawText = await requestOllama(buildPayload(false))
  let summary = defaultStructuredSummary(targetLanguage)
  let parseError = ''
  try {
    summary = parseStructuredSummary(rawText, targetLanguage)
  } catch (err) {
    parseError = err.message || 'JSON_PARSE_FAILED'
    qualityFlags.push('json_parse_failed')
    rawText = await requestOllama(buildPayload(true))
    try {
      summary = parseStructuredSummary(rawText, targetLanguage)
      parseError = ''
    } catch (retryErr) {
      parseError = retryErr.message || 'JSON_PARSE_FAILED'
      summary = defaultStructuredSummary(targetLanguage)
    }
  }

  let fallbackUsed = false
  const firstQualityFlags = findSummaryQualityFlags(summary, factList, targetLanguage)
  if (!parseError && firstQualityFlags.length) {
    qualityFlags.push(...firstQualityFlags)
    rawText = await requestOllama(buildPayload(true))
    try {
      const retrySummary = parseStructuredSummary(rawText, targetLanguage)
      const retryQualityFlags = findSummaryQualityFlags(retrySummary, factList, targetLanguage)
      if (retryQualityFlags.length) {
        qualityFlags.push(...retryQualityFlags.map(flag => `retry_${flag}`))
        summary = buildFallbackSummary({ cleanBodyText, analysisText, targetLanguage, factList })
        fallbackUsed = true
      } else {
        summary = retrySummary
      }
    } catch (err) {
      parseError = err.message || 'JSON_PARSE_FAILED'
      qualityFlags.push('retry_json_parse_failed')
      summary = buildFallbackSummary({ cleanBodyText, analysisText, targetLanguage, factList })
      fallbackUsed = true
    }
  } else if (parseError) {
    summary = buildFallbackSummary({ cleanBodyText, analysisText, targetLanguage, factList })
    fallbackUsed = true
  }

  return {
    summary,
    rawText,
    parseError,
    model,
    targetLanguage,
    sourceLanguage,
    translated: shouldTranslate,
    translatedText,
    cleanBodyText,
    factList,
    pipelineVersion: PIPELINE_VERSION,
    fallbackUsed,
    qualityFlags: uniqueRows(qualityFlags),
  }
}

module.exports = {
  summarizeMail,
  normalizeLanguage,
}
