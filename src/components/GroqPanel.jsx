import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { GROQ_MODELS, GROQ_API_KEY } from '../data/mockData'
import { apiFetch, getToken } from '../lib/api'
import { useChat } from '../contexts/ChatContext'
import { useAuth } from '../contexts/AuthContext'
import { useT } from '../i18n/useT'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'

const LANGUAGE_LABEL = {
  ko: '한국어',
  ja: '일본어',
  en: '영어',
  zh: '중국어',
}

function resolveLanguageCode(value) {
  return ['ko', 'ja', 'en', 'zh'].includes(value) ? value : 'ko'
}

function buildSystemPrompt(language) {
  const lang = resolveLanguageCode(language)
  const label = LANGUAGE_LABEL[lang]
  return `당신은 EasyStation의 AI 어시스턴트입니다.
반드시 제공된 [참고 정보]에 있는 내용만을 근거로 답변하세요.
참고 정보에 없는 사실은 추측하거나 일반 지식으로 보충하지 마세요.
[AI 이미지 분석 (Gemma Vision)]으로 표시된 블록은 문서 이미지를 Gemma 비전 모델이 분석한 설명문입니다. 이 내용도 근거로 활용하세요.
단, 사용자가 요청한 언어/톤/역할(예: 일본어 답변, 엔지니어 톤)은 사실 판단과 무관한 표현 지시이므로 반영하세요.
기본 답변 언어는 ${label}입니다.`
}

function buildImageSystemPrompt(language) {
  const lang = resolveLanguageCode(language)
  const label = LANGUAGE_LABEL[lang]
  return `당신은 EasyStation의 AI 어시스턴트입니다.
이미지가 첨부된 질문에서는 첨부된 이미지를 근거로 답변하세요.
이미지에서 확인 가능한 사실만 설명하고, 보이지 않는 내용은 추측하지 마세요.
사용자가 요청한 언어/톤/역할 지시는 반영하세요.
기본 답변 언어는 ${label}입니다.`
}

function buildTranslationSystemPrompt(language) {
  const lang = resolveLanguageCode(language)
  const label = LANGUAGE_LABEL[lang]
  return `당신은 전문 번역가입니다.
사용자가 요청한 텍스트를 정확하고 자연스럽게 번역하세요.
번역 이외의 내용은 추가하지 마세요.
기본 응답 언어는 ${label}입니다.`
}

// 번역 요청인지 감지 (RAG 검색 불필요한 경우)
function isTranslationQuery(text) {
  const t = text.toLowerCase()
  return (
    /번역/.test(text) ||
    /translate/i.test(text) ||
    /翻訳|翻译/.test(text) ||
    /한(글|국어)로.{0,10}(바꿔|변환|옮겨)/.test(text) ||
    /영어로.{0,10}(바꿔|변환|번역)/.test(text) ||
    /일본어로.{0,10}(바꿔|변환|번역)/.test(text) ||
    /중국어로.{0,10}(바꿔|변환|번역)/.test(text) ||
    /を(日本語|韓国語|英語|中国語)に/.test(text) ||
    /訳して/.test(text) ||
    t.includes('translation') ||
    t.includes('interpret')
  )
}

function isGlobalRagQuery(text = '') {
  return /(전체|모든|전사|전체\s*RAG|전체\s*검색|전역|global|all documents|all data)/i.test(String(text || ''))
}

function normalizeUserQuestionText(text = '') {
  return String(text || '').normalize('NFC').trim()
}

function isImageRagQuery(text = '') {
  return /(이미지|사진|그림|첨부\s*이미지|이\s*이미지|해당\s*이미지|image|photo|picture|screenshot)/i.test(String(text || ''))
}

function isChannelPostSummaryIntent(text) {
  const compact = String(text || '').replace(/\s+/g, '')
  return (
    /(오늘|어제|(\d{1,2}월)?\d{1,2}일)/.test(compact) &&
    /(글|게시글|포스트|post)/i.test(compact) &&
    /(요약|정리|핵심|요점)/.test(compact)
  )
}

function isChannelResourceLocateIntent(text) {
  const compact = String(text || '').replace(/\s+/g, '')
  const locateCommandOnly = isShortLocateFollowup(text)
  const genericLocateWithSubject = Boolean(extractLocateSubject(text))
  const hasImageTarget = /(이미지|사진|그림|스크린샷|캡처|캡쳐|image|photo|picture|screenshot)/i.test(compact)
  const imageLocate = (
    hasImageTarget &&
    !/(요약|정리|핵심|요점|설명|무엇|뭐야|뭔가|어떻게|왜|비교|번역|translate|summary)/i.test(compact) &&
    !/^(이|해당)?(이미지|사진|그림|스크린샷|캡처|캡쳐|image|photo|picture|screenshot)$/i.test(compact) &&
    compact.replace(/(?:을|를|은|는|이|가|의)?(?:(?:사용|이용)한|포함(?:된|한)|관련(?:된)?|담긴)?(?:이미지|사진|그림|스크린샷|캡처|캡쳐|image|photo|picture|screenshot)(?:자료|파일|첨부)?(?:어디(?:에)?(?:있는가|있어|있나요|있습니까)?|위치|찾아줘|찾아|검색|검색해줘|링크(?:보여줘|줘)?|보여줘|알려줘)?$/i, '').length >= 2
  )
  return (
    imageLocate ||
    locateCommandOnly ||
    genericLocateWithSubject ||
    (
      /(글|게시글|포스트|post|문서|자료|파일|첨부|데이터|블럭도|블록도|도면|회로도|다이어그램|이미지|사진|그림|스크린샷|캡처|캡쳐|diagram|blockdiagram|image|photo|picture|screenshot|document|resource|file|attachment)/i.test(compact) ||
      /^[A-Za-z0-9가-힣_.+\-/#]+(?:을|를|은|는|이|가|의)?(?:찾아줘|찾아|검색|검색해줘)$/u.test(compact)
    ) &&
    /(어디|위치|찾아줘|찾아|검색|검색해줘|링크|바로가기|문서로가기)/i.test(compact)
  )
}

function stripLocateCommandText(text = '') {
  return normalizeUserQuestionText(text)
    .replace(/[?？!！.,，。]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*(?:을|를|은|는|이|가|의)?\s*(?:자료|문서|파일|첨부|글|게시글|포스트)?\s*(?:은|는|이|가|을|를|의)?\s*(?:어디(?:에)?\s*(?:있는가|있어|있나요|있습니까)?|위치(?:를)?\s*(?:알려\s*줘|알려줘|찾아\s*줘|찾아줘)?|찾아\s*줘|찾아줘|찾아|검색해\s*줘|검색해줘|검색|링크\s*(?:보여\s*줘|보여줘|줘)?|바로\s*가기|문서로\s*가기)\s*$/iu, '')
    .replace(/\s*(?:설명해\s*줘|설명해|알려\s*줘|알려줘|정리해\s*줘|요약해\s*줘|해\s*줘|주세요)\s*$/iu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractLocateSubject(text = '') {
  const normalized = normalizeUserQuestionText(text)
  if (!/(어디|위치|찾아\s*줘|찾아줘|찾아|검색해\s*줘|검색해줘|검색|링크|바로\s*가기|문서로\s*가기)/iu.test(normalized)) return ''
  const subject = stripLocateCommandText(normalized)
    .replace(/^(?:이|그|저|해당|이전|위)\s*(?:자료|문서|파일|첨부|글|게시글)?$/iu, '')
    .trim()
  if (!subject || subject.length < 2) return ''
  if (/^(어디|위치|찾아|찾아줘|검색|검색해줘|링크|바로가기|문서로가기)$/iu.test(subject.replace(/\s+/g, ''))) return ''
  return subject
}

function isShortLocateFollowup(text = '') {
  const compact = normalizeUserQuestionText(text).replace(/\s+/g, '')
  return /^(어디(?:에)?(?:있는가|있어|있나요|있습니까)?|위치(?:알려줘|찾아줘)?|찾아줘|찾아|검색해줘|검색|링크(?:줘|보여줘)?|바로가기|문서로가기)$/iu.test(compact)
}

function resolvePreviousLocateSubject(messages = []) {
  const previousUsers = (Array.isArray(messages) ? messages : [])
    .filter(message => message?.role === 'user')
    .slice()
    .reverse()
  for (const message of previousUsers) {
    const content = normalizeUserQuestionText(message.content || '')
      .replace(/\[[^\]]+\]\s*$/u, '')
      .trim()
    const subject = extractLocateSubject(content) || stripLocateCommandText(content)
    if (subject && subject.length >= 2 && !isShortLocateFollowup(subject)) return subject
  }
  return ''
}

function resolveQuestionForRetrieval(text = '', messages = []) {
  const normalized = normalizeUserQuestionText(text)
  const directSubject = extractLocateSubject(normalized)
  if (directSubject && isChannelResourceLocateIntent(normalized) && !/(자료|문서|파일|첨부|resource|document|file|attachment)/iu.test(normalized)) {
    return `${directSubject} 자료는 어디에 있어?`
  }
  if (isShortLocateFollowup(normalized)) {
    const previousSubject = resolvePreviousLocateSubject(messages)
    if (previousSubject) return `${previousSubject} 자료는 어디에 있어?`
  }
  return normalized
}

function isInternalToolJson(text = '') {
  const raw = String(text || '').trim()
  if (!raw) return false
  const cleaned = raw
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()
  try {
    const parsed = JSON.parse(cleaned)
    return parsed?.action === 'call' && typeof parsed?.function === 'string'
  } catch (_) {
    return false
  }
}

function isInternalToolJsonLike(text = '') {
  const raw = String(text || '').trim()
  return /^```(?:json)?\s*\{/i.test(raw) || (/^\{/.test(raw) && /"action"\s*:\s*"call"|function"\s*:\s*"locate_/i.test(raw))
}

function hideInternalToolJson(text = '') {
  return isInternalToolJson(text) || isInternalToolJsonLike(text) ? '' : text
}

function removePlaceholderLinks(text = '') {
  return String(text || '')
    .replace(/^\s*[-*•]?\s*(?:링크|Link|URL)\s*:\s*(?:\[?[^\]\n]*\]?\()?(?:\/channels\/\{channelId\}\/posts\/\{postId\}|\/channels\/:channelId\/posts\/:postId|https?:\/\/[^\s)]*\/channels\/\{channelId\}\/posts\/\{postId\})(?:\))?(?:\s*\([^)]*\))?\s*$/gim, '')
    .replace(/^\s*[-*•]?\s*(?:링크|Link|URL)\s*:\s*(?:\{channelId\}|\{postId\}|.*\{channelId\}.*\{postId\}).*$/gim, '')
    .replace(/\[([^\]]+)\]\((?:\/channels\/\{channelId\}\/posts\/\{postId\}|\/channels\/:channelId\/posts\/:postId|[^)]*\{channelId\}[^)]*\{postId\}[^)]*)\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function sanitizeAssistantContent(text = '') {
  return removePlaceholderLinks(hideInternalToolJson(text))
}

function isSingleKeywordLocateIntent(text) {
  const normalized = String(text || '')
    .replace(/[?？!！.,，。]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized || /\s/.test(normalized)) return false
  if (normalized.length < 2 || normalized.length > 80) return false
  if (/(요약|정리|핵심|요점|설명|무엇|뭐야|뭔가|어떻게|왜|비교|번역|translate|summary)/i.test(normalized)) return false
  if (/^(안녕|hello|hi)$/i.test(normalized)) return false
  return /^[A-Za-z0-9가-힣_.+\-/#]+$/u.test(normalized)
}

function buildPostHref(channelId, postId, commentId = '') {
  if (!channelId || !postId) return ''
  const params = new URLSearchParams({
    channelId: String(channelId),
    postId: String(postId),
  })
  if (commentId) params.set('commentId', String(commentId))
  return `/?${params.toString()}`
}

function stripReferenceIdsFromSummary(summary = '') {
  return String(summary || '')
    .replace(
      /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?\s*참조\s*게시글\s*ID\s*(?:\*\*)?\s*\n(?:\s*[-*]?\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*,?\s*\n?)+/gi,
      '\n'
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function isGenericPostLabel(label = '') {
  return /^게시글(?:\s*\d+|\s+[0-9a-f]{8})$/i.test(String(label || '').trim())
}

function stripPostContent(value = '') {
  return String(value || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6]|tr|blockquote)\s*>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function firstContentLine(value = '') {
  const text = stripPostContent(value)
  return text.split(/\r?\n/).map(line => line.trim()).find(Boolean) || text
}

function truncateTitle(value = '', max = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}...` : text
}

function resolvePostReferenceLabel(ref, index) {
  const rawLabel = String(ref.label || ref.title || '').trim()
  if (rawLabel && !isGenericPostLabel(rawLabel)) return rawLabel

  const preview = firstContentLine(ref.contentPreview || ref.content || '')
  if (preview) return truncateTitle(preview)

  const id = String(ref.post_id || ref.postId || ref.id || '').trim()
  return id ? `게시글 ${id.slice(0, 8)}` : `게시글 ${index + 1}`
}

function enrichReferencesFromLocalPosts(references = [], channelPosts = [], selectedChannelId = '') {
  const postMap = new Map((channelPosts || []).map(post => [String(post.id), post]))
  return references.map((ref) => {
    const postId = String(ref.post_id || ref.postId || ref.id || '').trim()
    const localPost = postMap.get(postId)
    if (!localPost) return ref

    const title = truncateTitle(firstContentLine(localPost.content))
    if (!title) return ref

    return {
      ...ref,
      id: ref.id || postId,
      post_id: ref.post_id || ref.postId || postId,
      postId: ref.postId || ref.post_id || postId,
      channel_id: ref.channel_id || ref.channelId || localPost.channel_id || localPost.channelId || selectedChannelId,
      channelId: ref.channelId || ref.channel_id || localPost.channel_id || localPost.channelId || selectedChannelId,
      label: title,
      title,
      contentPreview: ref.contentPreview || stripPostContent(localPost.content).slice(0, 240),
    }
  })
}

function buildPostReferenceSection(references = []) {
  if (!references.length) return ''
  const lines = references.map((ref, index) => {
    const channelId = ref.channel_id || ref.channelId
    const postId = ref.post_id || ref.postId || ref.id
    const commentId = ref.comment_id || ref.commentId || ''
    const label = resolvePostReferenceLabel(ref, index).replace(/\]/g, '\\]')
    return `${index + 1}. [${label}](${ref.link || buildPostHref(channelId, postId, commentId)})`
  })
  return ['## 참조 게시글', ...lines].join('\n')
}

function isCommandQuery(text = '') {
  return /(명령어|커맨드|cli|command|snmp|show\s+\S+|config|configure)/i.test(String(text || ''))
}

function isTemporalQuery(text = '') {
  return /(언제|일시|시간|날짜|시각|기한|기간|몇\s*시|작업\s*희망|예정\s*일시)/i.test(String(text || ''))
}

function isEnumerationQuery(text = '') {
  return /(포인트|항목|목록|가지|종류|설명|내용|특징|요소|이유|방법|단계|순서|뭐|무엇|어떤|어떻게)/i.test(String(text || ''))
}

function extractSourceHints(text = '') {
  const src = String(text || '')
  const matches = src.match(/[A-Za-z0-9가-힣_.()\-]+\.(pdf|docx|doc|pptx|xlsx|csv|txt|md)/gi) || []
  return [...new Set(matches.map(v => v.trim()).filter(Boolean))]
}

function normalizeRetrievalConfig(cfg = {}) {
  const searchTypeRaw = String(cfg?.search_type || cfg?.searchType || 'mmr').toLowerCase()
  const search_type = ['similarity', 'mmr', 'similarity_score_threshold'].includes(searchTypeRaw)
    ? searchTypeRaw
    : 'mmr'
  const k = Number.isFinite(Number(cfg?.k)) ? Math.max(1, Math.min(20, Number(cfg.k))) : 8
  const fetch_k = Number.isFinite(Number(cfg?.fetch_k ?? cfg?.fetchK))
    ? Math.max(k, Math.min(80, Number(cfg.fetch_k ?? cfg.fetchK)))
    : Math.max(24, k * 3)
  const score_threshold = Number.isFinite(Number(cfg?.score_threshold ?? cfg?.scoreThreshold))
    ? Math.max(0, Math.min(1, Number(cfg.score_threshold ?? cfg.scoreThreshold)))
    : 0
  const mmr_lambda = Number.isFinite(Number(cfg?.mmr_lambda ?? cfg?.mmrLambda))
    ? Math.max(0, Math.min(1, Number(cfg.mmr_lambda ?? cfg.mmrLambda)))
    : 0.7
  const filter = cfg?.filter && typeof cfg.filter === 'object' ? cfg.filter : {}
  return { search_type, k, fetch_k, score_threshold, mmr_lambda, filter }
}

function formatTime(isoString, language = 'ko') {
  const localeMap = {
    ko: 'ko-KR',
    ja: 'ja-JP',
    en: 'en-US',
    zh: 'zh-CN',
  }
  const locale = localeMap[language] || 'ko-KR'
  return new Date(isoString).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}

function normalizeGatewayUrl(url) {
  if (!url) return url
  try {
    const parsed = new URL(url, window.location.origin)
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch (_) {
    return url
  }
}

function dataTransferHasFiles(dataTransfer) {
  if (!dataTransfer) return false
  const { types, items, files } = dataTransfer
  if (types) {
    if (typeof types.includes === 'function' && types.includes('Files')) return true
    if (typeof types.contains === 'function' && types.contains('Files')) return true
    for (const type of Array.from(types)) {
      if (type === 'Files') return true
    }
  }
  if (items && Array.from(items).some(item => item?.kind === 'file')) return true
  return Boolean(files && files.length > 0)
}

function AgenticAIWelcomeCard() {
  const capabilities = [
    { icon: '⌕', label: '검색하고 찾아내기' },
    { icon: '✦', label: '콘텐츠 생성 및 관리' },
    { icon: '◷', label: '사용자의 시간 및 정보/데이터 관리' },
  ]

  return (
    <div className="flex w-full justify-center py-4">
      <div className="w-full max-w-[360px] rounded-2xl bg-white px-5 py-6 text-center shadow-sm ring-1 ring-gray-200">
        <div
          className="mx-auto mb-5 flex h-24 w-24 items-center justify-center overflow-hidden rounded-3xl"
          style={{ backgroundColor: '#4c2361' }}
        >
          <video
            src="/img/agentic-ai_char.mp4"
            poster="/img/agentic-ai-character.png"
            autoPlay
            muted
            loop
            playsInline
            className="h-24 w-24 object-cover"
            aria-hidden="true"
          />
        </div>
        <h2 className="text-2xl font-bold leading-tight text-gray-950">
          안녕하세요
        </h2>
        <p className="mt-4 text-sm leading-relaxed text-gray-500">
          EasyStation에서 최고의 성과를 낼 수 있도록 확실히 도와드릴 수 있습니다.<br />
          제가 할 수 있는 작업은 다음과 같습니다:
        </p>
        <div className="mt-6 flex flex-col gap-3 text-left">
          {capabilities.map((item) => (
            <div
              key={item.label}
              className="flex items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 shadow-sm"
            >
              <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-cyan-200 bg-white text-lg text-gray-800 shadow-sm">
                {item.icon}
              </span>
              <span className="text-sm font-medium text-gray-900">{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function GroqPanel({ width }) {
  const {
    navigateToPost,
    selectedChannel,
    selectedTeam,
    addPost,
    addComment,
    agenticTarget,
    clearAgenticTarget,
    teams,
    activePostSelection,
    posts,
  } = useChat()
  const { currentUser, language } = useAuth()
  const t = useT()
  const [copiedId, setCopiedId] = useState(null)
  const [postingId, setPostingId] = useState(null)
  const [excludingRefKey, setExcludingRefKey] = useState(null)
  const [referenceMenuKey, setReferenceMenuKey] = useState(null)
  const [noticeDialog, setNoticeDialog] = useState(null) // { title, message }
  const canEditSearchResults = currentUser?.role === 'site_admin' || Boolean(currentUser?.can_edit_search_results)

  function openNotice(message, title = '알림') {
    setNoticeDialog({ title, message })
  }

  async function copyToClipboard(id, text) {
    const normalized = String(text || '').trim()
    if (!normalized) return
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(normalized)
      } else {
        const ta = document.createElement('textarea')
        ta.value = normalized
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = normalized
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    }
  }

  function findChannelById(channelId) {
    for (const team of (teams || [])) {
      const channel = (team.channels || []).find(c => String(c.id) === String(channelId))
      if (channel) return channel
    }
    return null
  }

  async function uploadQuestionImage(file, channelId) {
    if (!file || !channelId) return []

    const { uploadUrl, file_uuid } = await apiFetch('/files/get-upload-url', {
      method: 'POST',
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        channelId,
      }),
    })
    await fetch(normalizeGatewayUrl(uploadUrl), { method: 'PUT', body: file })
    return [file_uuid]
  }

  async function registerAnswerToBoard(answerMsg, answerIndex) {
    if (!answerMsg?.id || postingId) return
    const hasSelectedPost = Boolean(activePostSelection?.postId && activePostSelection?.channelId)
    const targetChannelId = hasSelectedPost ? activePostSelection.channelId : selectedChannel?.id
    const targetPostId = hasSelectedPost ? activePostSelection.postId : ''
    const targetChannel = targetChannelId ? findChannelById(targetChannelId) : null
    if (!targetChannelId) {
      openNotice(t.ai.postToBoardNoChannel)
      return
    }
    if (targetChannel?.is_archived) {
      openNotice(t.ai.postToBoardArchived)
      return
    }

    const answer = (answerMsg.content || '').trim()
    if (!answer) return

    const questionMsg = [...messages.slice(0, answerIndex)]
      .reverse()
      .find(m => m.role === 'user')
    const question = questionMsg?.content?.trim() || ''
    const questionImageFile = questionMsg?.questionImageFile || null
    const titleQuestion = question.replace(/\s*\[[^\]]*:\s*[^\]]*\]\s*$/, '').trim()
    const postTitle = titleQuestion || 'AgenticAI 질문'

    const content = [
      postTitle,
      '',
      '### 질문',
      question || postTitle,
      '',
      '### 답변',
      answer,
    ].filter(Boolean).join('\n')

    setPostingId(answerMsg.id)
    try {
      const attachmentIds = questionImageFile ? await uploadQuestionImage(questionImageFile, targetChannelId) : []
      if (hasSelectedPost && targetPostId) {
        await addComment(
          targetChannelId,
          targetPostId,
          content,
          currentUser,
          attachmentIds,
          currentUser?.security_level ?? 0
        )
        openNotice(t.ai.postToBoardTargetSuccess || '질문/답변이 대상 링크의 댓글로 등록되었습니다.', t.ai.postToBoard)
      } else {
        await addPost(targetChannelId, {
          content,
          attachmentIds,
          security_level: currentUser?.security_level ?? 0,
        }, { suppressAlert: true })
        openNotice(t.ai.postToBoardSuccess, t.ai.postToBoard)
      }
    } catch (e) {
      openNotice(t.ai.postToBoardFail(e.message), t.ai.postToBoard)
    } finally {
      setPostingId(null)
    }
  }

  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [selectedModel, setSelectedModel] = useState(GROQ_MODELS[0].id)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [attachedFile, setAttachedFile] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const [aiConfig, setAiConfig] = useState({ num_predict: 2048, num_ctx: 8192, history: 6, language: 'ko', operation_mode: 'server' })
  const [ragRetrieval, setRagRetrieval] = useState(normalizeRetrievalConfig({}))
  const fileInputRef = useRef(null)
  const bottomRef = useRef(null)
  const textareaRef = useRef(null)
  const dragCounterRef = useRef(0)
  const abortControllerRef = useRef(null)

  function getReferenceExclusionKey(ref = {}) {
    return [
      ref.type || ref.source || 'post',
      ref.post_id || ref.postId || ref.id || '',
      ref.comment_id || ref.commentId || '',
      ref.attachment_id || ref.attachmentId || '',
    ].join(':')
  }

  async function handleExcludeReference(messageId, ref = {}) {
    const key = getReferenceExclusionKey(ref)
    if (excludingRefKey === key) return
    setExcludingRefKey(key)
    try {
      await apiFetch('/questions/exclusions', {
        method: 'POST',
        body: JSON.stringify({
          sourceType: ref.type || ref.source || 'post',
          postId: ref.post_id || ref.postId || ref.id || '',
          commentId: ref.comment_id || ref.commentId || '',
          attachmentId: ref.attachment_id || ref.attachmentId || '',
          reason: 'wrong_result',
        }),
      })
      setMessages(prev => prev.map(msg => (
        msg.id === messageId
          ? { ...msg, references: (msg.references || []).filter(item => getReferenceExclusionKey(item) !== key) }
          : msg
      )))
      openNotice('이 결과는 향후 위치 찾기 결과에서 제외됩니다.', '검색 결과 제외')
    } catch (err) {
      openNotice(`검색 결과 제외에 실패했습니다: ${err.message}`, '검색 결과 제외')
    } finally {
      setExcludingRefKey(null)
      setReferenceMenuKey(null)
    }
  }
  const [stopping, setStopping] = useState(false)
  const [collapsedRefs, setCollapsedRefs] = useState(() => new Set()) // 참조 섹션 전체 접힘 (msg.id 집합)
  const [expandedRefs, setExpandedRefs] = useState(() => new Set())   // 미리보기 개수 초과분까지 펼침 (msg.id 집합)

  const toggleRefsCollapsed = (id) => setCollapsedRefs(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  const toggleRefsExpanded = (id) => setExpandedRefs(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  function buildSearchResultMessage(query, results = []) {
    const safeResults = Array.isArray(results) ? results : []
    if (safeResults.length === 0) {
      return `**검색 결과**\n\n"${query}"에 대한 게시글/댓글 검색 결과가 없습니다.`
    }
    const lines = [
      `**검색 결과**`,
      '',
      `"${query}" 검색 결과 ${safeResults.length}건입니다.`,
      '',
      ...safeResults.slice(0, 10).map((item, idx) => {
        const typeLabel = item.type === 'image_attachment' ? '이미지' : item.type === 'comment' ? '댓글' : '게시글'
        const place = [item.teamName, item.channelName].filter(Boolean).join(' / ')
        const author = item.author?.name ? ` · ${item.author.name}` : ''
        const text = String(item.content || '').replace(/\s+/g, ' ').trim()
        const preview = text.length > 140 ? `${text.slice(0, 140)}...` : text
        return `${idx + 1}. **${typeLabel}**${place ? ` · ${place}` : ''}${author}\n   ${preview || '(내용 없음)'}`
      }),
    ]
    if (safeResults.length > 10) lines.push('', `외 ${safeResults.length - 10}건은 검색 결과 페이지에서 확인할 수 있습니다.`)
    return lines.join('\n')
  }

  const REF_PREVIEW_COUNT = 5 // 기본으로 보여줄 참조 자료 개수

  function buildSearchReferences(results = []) {
    return (Array.isArray(results) ? results : []).slice(0, 10).map((item, idx) => ({
      type: item.type === 'image_attachment' ? 'image' : item.type === 'comment' ? 'comment' : 'post',
      label: `${idx + 1}. ${item.type === 'image_attachment' ? '이미지' : item.type === 'comment' ? '댓글' : '게시글'} 검색 결과`,
      team: item.teamName || '',
      channel: item.channelName || '',
      channel_id: item.channelId || '',
      post_id: item.type === 'comment' ? (item.postId || '') : (item.postId || item.id || ''),
      comment_id: item.type === 'comment' ? (item.id || '') : (item.commentId || ''),
      attachment_id: item.attachmentId || '',
      page_number: 0,
    }))
  }

  function buildKeywordSearchContext(results = []) {
    const safeResults = (Array.isArray(results) ? results : []).slice(0, 5)
    return safeResults.map((item, idx) => {
      const typeLabel = item.type === 'image_attachment' ? '이미지' : item.type === 'comment' ? '댓글' : '게시글'
      const place = [item.teamName, item.channelName].filter(Boolean).join(' / ')
      const source = [typeLabel, place, item.fileName].filter(Boolean).join(' - ')
      const score = Number.isFinite(Number(item.score)) ? ` / score: ${Number(item.score).toFixed(3)}` : ''
      const content = String(item.content || '').trim()
      return [
        `[키워드 검색 결과 ${idx + 1} - source: ${source}${score}]`,
        content,
      ].filter(Boolean).join('\n')
    }).filter(Boolean).join('\n\n')
  }

  function buildKeywordSearchQueries(text = '') {
    const original = String(text || '').trim()
    const normalized = original
      .replace(/\s+/g, ' ')
      .replace(/(에\s*대해서|에\s*대한|대해서|관련해서|관련하여|관해서|무엇인지|뭔지)/g, ' ')
      .replace(/(설명해줘|설명해|알려줘|정리해줘|요약해줘|찾아줘|보여줘|해줘|주세요|해|줘)/g, ' ')
      .replace(/[?!.,，。]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return [...new Set([original, normalized].filter(q => q.length >= 2))]
  }

  function getUrlTargetIds() {
    try {
      const params = new URLSearchParams(window.location.search)
      return {
        channelId: params.get('channelId') || '',
        postId: params.get('postId') || '',
        commentId: params.get('commentId') || '',
        attachmentId: params.get('attachmentId') || '',
      }
    } catch (_) {
      return { channelId: '', postId: '', commentId: '', attachmentId: '' }
    }
  }

  function resolveRagScope(text = '') {
    if (isGlobalRagQuery(text)) {
      return { scope: 'global_scope', filter: {}, target: {} }
    }

    const urlTarget = getUrlTargetIds()
    const target = {
      channelId: agenticTarget?.channelId || activePostSelection?.channelId || urlTarget.channelId || selectedChannel?.id || '',
      postId: agenticTarget?.postId || activePostSelection?.postId || urlTarget.postId || '',
      commentId: agenticTarget?.commentId || urlTarget.commentId || '',
      attachmentId: agenticTarget?.attachmentId || urlTarget.attachmentId || '',
    }

    if (isImageRagQuery(text) && target.postId) {
      return {
        scope: 'image_scope',
        target,
        filter: {
          post_id: String(target.postId),
          ...(target.attachmentId ? { attachment_id: String(target.attachmentId) } : {}),
          type: 'image_attachment',
        },
      }
    }

    if (target.commentId && target.postId) {
      return {
        scope: 'comment_scope',
        target,
        filter: {
          post_id: String(target.postId),
          comment_id: String(target.commentId),
        },
      }
    }

    if (target.postId) {
      return {
        scope: 'post_scope',
        target,
        filter: {
          post_id: String(target.postId),
        },
      }
    }

    // 게시글/댓글/이미지를 콕 집은 질문(post/comment/image_scope)만 엄격하게 좁힌다.
    // 현재 채널에 서 있다는 이유만으로 채널에 가두면(channel_scope), 다른 접근 가능 채널에
    // 있는 자료(예: 타 채널의 PDF)가 evidence gate에서 전량 차단된다. 따라서 주제/내용 질문은
    // global_scope로 두고, 현재 채널 자료는 서버의 priority boost(current_channel_id)로 우선시한다.
    // 날짜 기반 채널 요약/locate는 이미 상위(/api/questions 분기)에서 처리되므로 여기로 오지 않는다.
    return { scope: 'global_scope', filter: {}, target }
  }

  function filterKeywordResultsByScope(results = [], ragScopeInfo = {}) {
    const scope = ragScopeInfo.scope || 'global_scope'
    if (scope === 'global_scope') return results
    if (scope === 'image_scope') return []

    const filter = ragScopeInfo.filter || {}
    return (Array.isArray(results) ? results : []).filter(item => {
      if (scope === 'post_scope') {
        return filter.post_id && String(item.postId || item.id || '') === String(filter.post_id)
      }
      if (scope === 'comment_scope') {
        return (
          (filter.comment_id && String(item.id || item.commentId || '') === String(filter.comment_id)) ||
          (filter.post_id && String(item.postId || '') === String(filter.post_id))
        )
      }
      if (scope === 'channel_scope') {
        return filter.channel_id && String(item.channelId || '') === String(filter.channel_id)
      }
      return true
    })
  }

  function mergeKeywordResults(...groups) {
    const seen = new Set()
    const merged = []
    for (const group of groups) {
      for (const item of (Array.isArray(group) ? group : [])) {
        const key = `${item.type || ''}:${item.id || item.postId || ''}:${item.attachmentId || ''}`
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(item)
      }
    }
    return merged
  }

  useEffect(() => {
    if (messages.length === 0) {
      setMessages([{
        id: 'init',
        role: 'assistant',
        content: t.ai.greeting,
        time: new Date().toISOString(),
      }])
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.ai.greeting])

  useEffect(() => {
    setMessages(prev => {
      if (prev.length !== 1) return prev
      const only = prev[0]
      if (!only || only.id !== 'init' || only.role !== 'assistant') return prev
      if (only.content === t.ai.greeting) return prev
      return [{ ...only, content: t.ai.greeting }]
    })
  }, [t.ai.greeting])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  useEffect(() => {
    const onFillInput = (evt) => {
      const text = String(evt?.detail?.text || '')
      if (!text) return
      setInput(text)
      setTimeout(() => {
        try {
          textareaRef.current?.focus()
          const len = text.length
          textareaRef.current?.setSelectionRange?.(len, len)
        } catch (_) {}
      }, 0)
    }
    window.addEventListener('agentic-fill-input', onFillInput)
    return () => window.removeEventListener('agentic-fill-input', onFillInput)
  }, [])

  useEffect(() => {
    const onSearchResults = (evt) => {
      const query = String(evt?.detail?.query || '').trim()
      const results = Array.isArray(evt?.detail?.results) ? evt.detail.results : []
      if (!query) return
      setMessages(prev => [...prev, {
        id: `search-${Date.now()}`,
        role: 'assistant',
        content: buildSearchResultMessage(query, results),
        references: buildSearchReferences(results),
        time: new Date().toISOString(),
      }])
    }
    window.addEventListener('agentic-search-results', onSearchResults)
    return () => window.removeEventListener('agentic-search-results', onSearchResults)
  }, [])

  useEffect(() => {
    async function fetchConfig() {
      try {
        const [aiData, ragRetrievalData] = await Promise.all([
          apiFetch('/config/agenticai'),
          apiFetch('/config/rag-retrieval').catch(() => ({})),
        ])
        setAiConfig(prev => ({ ...prev, ...aiData, language: resolveLanguageCode(aiData?.language) }))
        setRagRetrieval(normalizeRetrievalConfig(ragRetrievalData))
      } catch (e) {
        console.error('Failed to load AI config:', e)
      }
    }
    fetchConfig()
  }, [])

  // 파일을 Base64로 변환하는 헬퍼 함수
  const fileToBase64 = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.readAsDataURL(file)
      reader.onload = () => resolve(reader.result.split(',')[1]) // 'data:image/...;base64,' 부분 제거
      reader.onerror = (error) => reject(error)
    })
  }

  async function sendMessage() {
    const rawText = input.trim()
    const text = normalizeUserQuestionText(rawText)
    if (!text && !attachedFile || loading) return
    const abortController = new AbortController()
    abortControllerRef.current = abortController
    setStopping(false)

    const isImage = attachedFile?.type.startsWith('image/')
    let imageUrl = null
    let base64Data = null

    if (isImage) {
      imageUrl = URL.createObjectURL(attachedFile)
      try {
        base64Data = await fileToBase64(attachedFile)
      } catch (e) {
        console.error("Base64 conversion failed", e)
      }
    }

    const fileName = attachedFile ? ` [${t.ai.attachFile}: ${attachedFile.name}]` : ''
    const fullText = text + fileName
    const resolvedQuestion = !attachedFile ? resolveQuestionForRetrieval(text, messages) : text
    const resolvedFullText = resolvedQuestion + fileName

    const userMsg = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: fullText,
      time: new Date().toISOString(),
      image: imageUrl,
      questionImageFile: isImage ? attachedFile : null,
    }

    setMessages(prev => [...prev, userMsg])
    setInput('')
    setAttachedFile(null)
    setLoading(true)
    setError(null)

    if (!attachedFile && (isChannelPostSummaryIntent(resolvedQuestion) || isChannelResourceLocateIntent(resolvedQuestion) || isSingleKeywordLocateIntent(resolvedQuestion))) {
      try {
        if (!selectedChannel?.id) {
          setMessages(prev => [...prev, {
            id: `a-${Date.now()}`,
            role: 'assistant',
            content: '먼저 검색할 채널을 선택해주세요.',
            references: [],
            time: new Date().toISOString(),
            model: null,
          }])
          return
        }

        const result = await apiFetch('/questions', {
          method: 'POST',
          signal: abortController.signal,
          body: JSON.stringify({
            question: resolvedQuestion,
            originalQuestion: text,
            channelId: selectedChannel.id,
            model: selectedModel,
          }),
        })

        if (result.intent?.action === 'locate') {
          const references = (result.references || []).map((ref, index) => ({
            id: ref.id,
            label: resolvePostReferenceLabel(ref, index),
            title: resolvePostReferenceLabel(ref, index),
            type: ref.type || 'post',
            source: ref.type || 'post',
            channelId: ref.channelId || ref.channel_id || selectedChannel.id,
            channel_id: ref.channel_id || ref.channelId || selectedChannel.id,
            postId: ref.postId || ref.post_id || ref.id,
            post_id: ref.post_id || ref.postId || ref.id,
            commentId: ref.commentId || ref.comment_id || '',
            comment_id: ref.comment_id || ref.commentId || '',
            attachmentId: ref.attachmentId || ref.attachment_id || '',
            attachment_id: ref.attachment_id || ref.attachmentId || '',
            fileName: ref.fileName || ref.file_name || '',
            file_name: ref.file_name || ref.fileName || '',
            contentPreview: ref.contentPreview,
            createdAt: ref.createdAt,
            link: ref.link,
          }))
          const content = result.message || (
            references.length
              ? ['관련 자료를 찾았습니다.', '', ...references.map((ref, index) => {
                  const label = ref.fileName || ref.title || ref.label || `자료 ${index + 1}`
                  return `${index + 1}. ${label}\n   링크: ${ref.link || buildPostHref(ref.channelId, ref.postId, ref.commentId)}`
                })].join('\n')
              : '현재 채널에서 관련 자료 링크를 찾지 못했습니다.'
          )

          setMessages(prev => [...prev, {
            id: `a-${Date.now()}`,
            role: 'assistant',
            content,
            references,
            time: new Date().toISOString(),
            model: result.model || null,
          }])
          return
        }

        const dateLabel = result.intent?.dateRange
          ? `${result.intent.dateRange.from} ~ ${result.intent.dateRange.to}`
          : ''
        const header = dateLabel
          ? `현재 채널의 ${dateLabel} 게시글 요약입니다.\n\n`
          : ''
        const references = enrichReferencesFromLocalPosts(
          result.references || result.posts || [],
          posts?.[selectedChannel.id] || [],
          selectedChannel.id,
        )
        const referenceSection = buildPostReferenceSection(references)
        const fallbackNote = result.fallback
          ? '\n\nAI 요약 서버 연결이 원활하지 않아 게시글 목록 기반으로 간단히 정리했습니다.'
          : ''
        const content = [
          `${header}${stripReferenceIdsFromSummary(result.summary || '요약 결과가 없습니다.')}`,
          referenceSection,
          fallbackNote,
        ].filter(Boolean).join('\n\n')

        setMessages(prev => [...prev, {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content,
          references: references.map((post, index) => ({
            id: post.id,
            label: resolvePostReferenceLabel(post, index),
            title: resolvePostReferenceLabel(post, index),
            type: 'post',
            source: 'post',
            channelId: post.channelId || post.channel_id || selectedChannel.id,
            channel_id: post.channel_id || post.channelId || selectedChannel.id,
            postId: post.postId || post.post_id || post.id,
            post_id: post.post_id || post.postId || post.id,
            contentPreview: post.contentPreview,
            createdAt: post.createdAt,
          })),
          time: new Date().toISOString(),
          model: result.model || selectedModel,
        }])
      } catch (err) {
        const message = err?.name === 'AbortError'
          ? (t.ai.stopped || '요청이 중단되었습니다.')
          : `게시글 요약을 처리하지 못했습니다: ${err.message}`
        setError(err?.name === 'AbortError' ? null : err.message)
        setMessages(prev => [...prev, {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: message,
          references: [],
          time: new Date().toISOString(),
          model: selectedModel,
          isError: err?.name !== 'AbortError',
        }])
      } finally {
        abortControllerRef.current = null
        setStopping(false)
        setLoading(false)
      }
      return
    }

    // ── 1. 번역 요청 감지 — 번역이면 RAG 검색 없이 바로 AI 호출 ──
    const isTranslation = isTranslationQuery(resolvedQuestion)
    const ragScopeInfo = (!isTranslation && !base64Data)
      ? resolveRagScope(resolvedQuestion)
      : { scope: 'global_scope', filter: {}, target: {} }

    let ragContext = ''
    let ragReferences = []
    if (!isTranslation && !base64Data) {
      let keywordContext = ''
      let keywordReferences = []
      try {
        const keywordGroups = []
        for (const searchQuery of buildKeywordSearchQueries(resolvedQuestion)) {
          const searchParams = new URLSearchParams({ q: searchQuery, limit: '5' })
          if (selectedChannel?.id) searchParams.set('current_channel_id', selectedChannel.id)
          if (selectedTeam?.id) searchParams.set('current_team_id', selectedTeam.id)
          const result = await apiFetch(`/posts/search?${searchParams.toString()}`)
          keywordGroups.push(result)
        }
        const safeKeywordResults = filterKeywordResultsByScope(
          mergeKeywordResults(...keywordGroups),
          ragScopeInfo,
        ).slice(0, 5)
        keywordContext = buildKeywordSearchContext(safeKeywordResults)
        keywordReferences = buildSearchReferences(safeKeywordResults)
      } catch (e) {
        console.warn('[SearchIndex] 키워드 검색 실패:', e.message)
      }

      // ── 1-1. RAG 검색 — LanceDB에서 관련 문서 검색 ──────────
      try {
        const dynamicLimit = isCommandQuery(resolvedQuestion) || isTemporalQuery(resolvedQuestion) ? 10 : isEnumerationQuery(resolvedQuestion) ? 8 : 5
        const preferredSources = extractSourceHints(resolvedQuestion)
        const scopedFetchK = ragScopeInfo.scope === 'global_scope' ? dynamicLimit * 3 : 80
        const retrievalPayload = {
          ...ragRetrieval,
          k: Math.max(dynamicLimit, ragRetrieval.k || dynamicLimit),
          fetch_k: Math.max((ragRetrieval.fetch_k || scopedFetchK), scopedFetchK),
          scope: ragScopeInfo.scope,
          filter: {
            ...(ragRetrieval.filter || {}),
            ...(ragScopeInfo.filter || {}),
          },
        }
        const ragResult = await apiFetch('/rag/search', {
          method: 'POST',
          signal: abortController.signal,
          body: JSON.stringify({
            query: resolvedQuestion,
            limit: dynamicLimit,
            preferred_sources: preferredSources,
            retrieval: retrievalPayload,
            rag_scope: ragScopeInfo.scope,
            current_channel_id: selectedChannel?.id || '',
            current_team_id: selectedTeam?.id || '',
          }),
        })
        if (ragResult.blocked) {
          setMessages(prev => [...prev, {
            id: `a-${Date.now()}`,
            role: 'assistant',
            content: ragResult.message || '현재 질문 범위와 일치하는 학습 근거를 찾지 못했습니다. 다른 자료를 근거로 추정 답변을 생성하지 않았습니다.',
            references: [],
            time: new Date().toISOString(),
            model: selectedModel,
          }])
          setLoading(false)
          return
        }
        ragContext = ragResult.context || ''
        ragReferences = ragResult.references || []
      } catch (e) {
        console.warn('[RAG] 검색 실패:', e.message)
      }

      if (keywordContext) {
        ragContext = [keywordContext, ragContext].filter(Boolean).join('\n\n')
        ragReferences = [...keywordReferences, ...ragReferences]
      }

      // ── 1-2. RAG 데이터 없으면 안내 메시지 반환 ──────────────
      if (!ragContext) {
        setMessages(prev => [...prev, {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: t.ai.noData,
          references: [],
          time: new Date().toISOString(),
          model: selectedModel,
        }])
        setLoading(false)
        return
      }
    }

    // ── 2. API 전송용 메시지 구성 ────────────────────────────────
    // 번역 요청: RAG 없이 원문 그대로 전송
    // 이미지 첨부: RAG context 무시하고 직접 전송
    // 일반 질문: RAG context를 프롬프트에 포함
    const contentWithContext = (ragContext && !base64Data && !isTranslation)
      ? `아래 [참고 정보]에 있는 사실만 근거로 답변하세요. 참고 정보에 없는 사실은 추측하지 마세요. 다만 언어/문체/역할 요청(예: 일본어로 답변)은 반영하세요.\n링크, URL, 경로는 절대 추측해서 만들지 마세요. /channels/{channelId}/posts/{postId} 같은 템플릿 링크를 작성하지 마세요. 실제 link 값이 참고 정보에 명시되어 있지 않으면 본문에 링크 항목을 쓰지 말고, 자료 위치는 참고 문서 카드에서 확인할 수 있다고만 안내하세요.\n\n[참고 정보]\n${ragContext}\n\n[질문]\n${resolvedFullText}`
      : resolvedFullText

    const scopedContentWithContext = agenticTarget
      ? (() => {
          const scopeText = agenticTarget.type === 'comment' ? '댓글 단일 범위' : '게시글 범위'
          const targetBody = String(agenticTarget.content || '').trim()
          if (targetBody) {
            return `${contentWithContext}\n\n[대상 본문]\n${targetBody}\n\n[대상 범위]\n${scopeText}`
          }
          return `${contentWithContext}\n\n[대상 링크]\n${agenticTarget.link || ''}\n[대상 범위]\n${scopeText}`
        })()
      : contentWithContext

    const userApiMessage = { role: 'user', content: scopedContentWithContext }
    if (base64Data) {
      userApiMessage.images = [base64Data] // Ollama 멀티모달 형식
    }

    const isScopedRagQuestion = !isTranslation && !base64Data && ragScopeInfo.scope !== 'global_scope'
    const historyForApi = isScopedRagQuestion
      ? messages
          .filter(m => m.role === 'user')
          .slice(-1)
          .map(m => ({ role: m.role, content: m.content }))
      : messages
          .filter(m => m.role !== 'system')
          .slice(-(aiConfig.history ?? 6))  // 관리자 설정값만큼 최근 메시지 유지
          .map(m => ({ role: m.role, content: m.content }))

    // ── 3-1. 스트리밍용 빈 메시지 먼저 추가 ────────────────────
    const msgId = `a-${Date.now()}`
    setMessages(prev => [...prev, {
      id: msgId,
      role: 'assistant',
      content: '',
      references: ragReferences,
      time: new Date().toISOString(),
      model: selectedModel,
      streaming: true,
    }])

    try {
      // 로컬 Ollama Native API 호출 (스트리밍)
      const aiChatUrl = aiConfig.operation_mode === 'local'
        ? 'http://127.0.0.1:11434/api/chat'
        : '/api/ai/chat'
      const response = await fetch(aiChatUrl, {
        method: 'POST',
        signal: abortController.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(aiConfig.operation_mode === 'server' && getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: [
            { role: 'system', content: isTranslation
              ? buildTranslationSystemPrompt(aiConfig.language)
              : (base64Data ? buildImageSystemPrompt(aiConfig.language) : buildSystemPrompt(aiConfig.language))
            },
            ...historyForApi,
            userApiMessage,
          ],
          stream: true,
          options: {
            temperature: 0.7,
            num_ctx: aiConfig.num_ctx || 4096,
            num_predict: aiConfig.num_predict || 2048,
          }
        }),
      })

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        throw new Error(errData.error || `HTTP ${response.status}`)
      }

      // ── NDJSON 스트림 읽기 ─────────────────────────────────
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()  // 마지막 불완전 줄은 다음 청크로

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const obj = JSON.parse(line)
            if (obj.message?.content) {
              accumulated += obj.message.content
              const visibleContent = sanitizeAssistantContent(accumulated)
              setMessages(prev => prev.map(m =>
                m.id === msgId ? { ...m, content: visibleContent } : m
              ))
              bottomRef.current?.scrollIntoView({ behavior: 'instant' })
            }
          } catch (_) {}
        }
      }

      // 스트리밍 완료 — streaming 플래그 제거
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, content: sanitizeAssistantContent(accumulated), streaming: false } : m
      ))
    } catch (err) {
      if (err?.name === 'AbortError') {
        setMessages(prev => prev.map(m =>
          m.id === msgId
            ? { ...m, content: t.ai.stopped || '요청이 중단되었습니다.', streaming: false }
            : m
        ))
        return
      }
      setError(err.message)
      setMessages(prev => prev.map(m =>
        m.id === msgId
          ? { ...m, content: t.ai.errorPrefix + err.message, streaming: false, isError: true }
          : m
      ))
    } finally {
      abortControllerRef.current = null
      setStopping(false)
      setLoading(false)
    }
  }

  function handleStop() {
    if (!loading || !abortControllerRef.current) return
    setStopping(true)
    abortControllerRef.current.abort()
  }

  function handleKeyDown(e) {
    // 한글 입력 중(IME 조합 중) 엔터키가 두 번 인식되는 것을 방지
    if (e.nativeEvent.isComposing) return

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  function handleFileChange(e) {
    const file = e.target.files[0]
    if (file) {
      setAttachedFile(file)
    }
    e.target.value = null // Reset for same file selection
  }

  function removeFile() {
    setAttachedFile(null)
  }

  function attachDroppedFile(fileList) {
    if (!fileList?.length) return
    setAttachedFile(fileList[0])
  }

  function handleDragEnter(e) {
    e.preventDefault()
    if (!dataTransferHasFiles(e.dataTransfer)) return
    dragCounterRef.current += 1
    setDragOver(true)
  }

  function handleDragLeave(e) {
    e.preventDefault()
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1)
    if (dragCounterRef.current === 0) setDragOver(false)
  }

  function handleDragOver(e) {
    e.preventDefault()
    if (!dataTransferHasFiles(e.dataTransfer)) return
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }

  function handleDrop(e) {
    e.preventDefault()
    dragCounterRef.current = 0
    setDragOver(false)
    if (dataTransferHasFiles(e.dataTransfer) && e.dataTransfer.files?.length) {
      attachDroppedFile(e.dataTransfer.files)
    }
  }

  function handleTextareaDrop(e) {
    if (!dataTransferHasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    handleDrop(e)
  }

  function clearChat() {
    setMessages([{
      id: 'init',
      role: 'assistant',
      content: t.ai.greeting,
      time: new Date().toISOString(),
    }])
    setError(null)
    setAttachedFile(null)
  }

  useEffect(() => {
    if (!noticeDialog) return
    function onKey(e) {
      if (e.key === 'Escape') setNoticeDialog(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [noticeDialog])

  return (
    <div className="flex-shrink-0 bg-gray-50 border-l border-gray-200 flex flex-col h-full" style={{ width: width ?? 320 }}>
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
            <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <span className="text-gray-900 font-semibold text-sm">EasyStation AgenticAI</span>
          {loading && (
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={clearChat}
            title={t.ai.clearChat}
            className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-200 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Model selector */}
      <div className="px-3 py-2 border-b border-gray-100 flex-shrink-0">
        <select
          value={selectedModel}
          onChange={e => setSelectedModel(e.target.value)}
          className="w-full bg-white text-black text-xs rounded-md px-2 py-1.5 border border-gray-200 focus:outline-none focus:ring-1 focus:ring-green-500 cursor-pointer font-medium"
        >
          {GROQ_MODELS.map(m => (
            <option key={m.id} value={m.id} className="text-black bg-white">
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <PanelGroup
        direction="vertical"
        autoSaveId="agentic-ai-compose"
        className="flex-1 min-h-0"
      >
      <Panel defaultSize={76} minSize={25} className="overflow-hidden">
      {/* Messages */}
      <div className="h-full overflow-y-auto px-3 py-3 flex flex-col gap-3">
        {messages.map((msg, idx) => {
          if (msg.id === 'init' && msg.role === 'assistant') {
            return <AgenticAIWelcomeCard key={msg.id} />
          }

          return (
          <div key={msg.id} className={`flex flex-col gap-1 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
            <div className={`flex items-center gap-1.5 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
              {msg.role === 'assistant' ? (
                <div className="w-5 h-5 rounded-md bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
              ) : (
                <div className="w-5 h-5 rounded-md bg-indigo-500 flex items-center justify-center text-white text-xs font-bold">
                  U
                </div>
              )}
              <span className="text-gray-400 text-xs">{formatTime(msg.time, language)}</span>
            </div>
            {/* References section — 답변 위에 표시, 기본 5개 + 더보기/접기 */}
            {msg.role === 'assistant' && !msg.isError && msg.references && msg.references.length > 0 && (
              <div className="w-full mt-1 px-1">
                <button
                  onClick={() => toggleRefsCollapsed(msg.id)}
                  className="flex items-center gap-1 text-[10px] text-gray-400 mb-1 font-medium hover:text-gray-600 transition-colors"
                  title={t.ai.references}
                >
                  <svg className={`w-2.5 h-2.5 flex-shrink-0 transition-transform ${collapsedRefs.has(msg.id) ? '' : 'rotate-90'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  <span>{t.ai.references} ({msg.references.length})</span>
                </button>
                {!collapsedRefs.has(msg.id) && (
                  <div className="flex flex-col gap-1">
                    {(expandedRefs.has(msg.id) ? msg.references : msg.references.slice(0, REF_PREVIEW_COUNT)).map((ref, i) => (
                      <div key={i} className="w-full rounded-lg border border-gray-200 bg-gray-100">
                        <button
                          onClick={() => ref.channel_id && navigateToPost(ref.channel_id, ref.post_id, { commentId: ref.comment_id, attachmentId: ref.attachment_id })}
                          disabled={!ref.channel_id}
                          className="w-full flex items-start gap-1.5 rounded-t-lg px-2 py-1.5 text-left transition-colors enabled:hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
                          title={ref.channel_id ? t.ai.gotoChannel(ref.team, ref.channel) : t.ai.gotoAfterRetrain}
                        >
                        {ref.type === 'pdf' || ref.type === 'table' || ref.type === 'word' ? (
                          <svg className="w-3 h-3 text-red-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                          </svg>
                        ) : ref.type === 'image' ? (
                          <svg className="w-3 h-3 text-emerald-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11h.01M21 15l-5-5L5 21" />
                          </svg>
                        ) : ref.type === 'comment' ? (
                          <svg className="w-3 h-3 text-yellow-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                          </svg>
                        ) : (
                          <svg className="w-3 h-3 text-blue-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                        )}
                        <div className="flex flex-col min-w-0 w-full">
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] text-gray-600 truncate leading-tight flex-1">{ref.label}</span>
                            {ref.type === 'image' && (
                              <span className="text-[8px] bg-emerald-100 text-emerald-700 px-1 py-0.5 rounded font-medium flex-shrink-0">Gemma AI</span>
                            )}
                          </div>
                          <span className="text-[9px] text-gray-400 leading-tight">
                            {ref.team ? `${ref.team} · ` : ''}{ref.channel || ''}
                            {ref.page_number > 0 ? `${ref.channel ? ' · ' : ''}p.${ref.page_number}` : ''}
                          </span>
                          {ref.type === 'image' && ref.img_path && (
                            <div className="mt-1.5 rounded overflow-hidden border border-emerald-200 bg-gray-50" style={{ width: '100%', maxHeight: 80 }}>
                              <img
                                src={`/api/rag/image?path=${encodeURIComponent(ref.img_path)}`}
                                alt={ref.label}
                                className="w-full object-contain"
                                style={{ maxHeight: 80 }}
                                onError={e => { e.currentTarget.parentElement.style.display = 'none' }}
                              />
                            </div>
                          )}
                        </div>
                        </button>
                        {canEditSearchResults && (
                          <div className="relative flex justify-end border-t border-gray-200 px-2 py-1">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                const key = getReferenceExclusionKey(ref)
                                setReferenceMenuKey(prev => prev === key ? null : key)
                              }}
                              disabled={excludingRefKey === getReferenceExclusionKey(ref)}
                              className="text-[9px] font-medium text-gray-400 transition-colors hover:text-gray-700 disabled:cursor-wait disabled:opacity-50"
                              title="검색 결과 설정"
                            >
                              {excludingRefKey === getReferenceExclusionKey(ref) ? '처리 중...' : '결과 설정'}
                            </button>
                            {referenceMenuKey === getReferenceExclusionKey(ref) && (
                              <div className="absolute right-2 top-6 z-20 w-44 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    handleExcludeReference(msg.id, ref)
                                  }}
                                  className="w-full px-3 py-2 text-left text-[10px] font-medium text-red-600 hover:bg-red-50"
                                >
                                  이것은 아니다. 잘못된 결과이다.
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                    {msg.references.length > REF_PREVIEW_COUNT && (
                      <button
                        onClick={() => toggleRefsExpanded(msg.id)}
                        className="self-start text-[10px] text-indigo-500 hover:text-indigo-700 px-1 py-0.5 font-medium transition-colors"
                      >
                        {expandedRefs.has(msg.id) ? t.ai.collapseRefList : t.ai.showMoreRefs(msg.references.length - REF_PREVIEW_COUNT)}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            <div className={`px-3 py-2 rounded-xl text-xs leading-relaxed max-w-full ${msg.role === 'user'
                ? 'bg-indigo-600 text-white rounded-tr-sm whitespace-pre-wrap'
                : msg.isError
                  ? 'bg-red-50 text-red-600 border border-red-200 rounded-tl-sm whitespace-pre-wrap'
                  : 'bg-gray-200 text-gray-700 rounded-tl-sm border border-gray-200'
              }`}>
              {msg.image && (
                <div className="mb-2 w-64 h-64 overflow-hidden rounded-lg border border-gray-200">
                  <img
                    src={msg.image}
                    alt={t.ai.attachedImage}
                    className="w-full h-full object-cover"
                  />
                </div>
              )}
              {msg.streaming && msg.content === '' && (
                <span className="inline-block w-1.5 h-3.5 bg-gray-1000 rounded-sm animate-pulse" />
              )}
              {msg.role === 'assistant' && !msg.isError ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    h1: ({ children }) => <p className="font-bold text-sm mb-1">{children}</p>,
                    h2: ({ children }) => <p className="font-bold text-xs mb-1">{children}</p>,
                    h3: ({ children }) => <p className="font-semibold text-xs mb-1">{children}</p>,
                    p: ({ children }) => <p className="mb-1.5 last:mb-0">{children}</p>,
                    ul: ({ children }) => <ul className="list-disc pl-4 mb-1.5 space-y-0.5">{children}</ul>,
                    ol: ({ children }) => <ol className="list-decimal pl-4 mb-1.5 space-y-0.5">{children}</ol>,
                    li: ({ children }) => <li>{children}</li>,
                    strong: ({ children }) => <strong className="font-semibold text-gray-900">{children}</strong>,
                    em: ({ children }) => <em className="italic text-gray-600">{children}</em>,
                    code: ({ className, children }) => {
                      const text = String(children ?? '')
                      const isBlock = /language-/.test(String(className || '')) || text.includes('\n')
                      if (!isBlock) {
                        return <code className="bg-gray-200 px-1 py-0.5 rounded text-green-300 font-mono">{children}</code>
                      }
                      return (
                        <pre className="bg-black/40 rounded-lg p-2 mt-1 mb-1.5 overflow-x-auto">
                          <code className={`text-green-300 font-mono text-[10px] ${className || ''}`.trim()}>{children}</code>
                        </pre>
                      )
                    },
                    blockquote: ({ children }) => <blockquote className="border-l-2 border-white/30 pl-2 text-gray-500 italic my-1">{children}</blockquote>,
                    hr: () => <hr className="border-gray-200 my-2" />,
                    a: ({ href, children }) => {
                      const rawHref = String(href || '')
                      const isPostLink = rawHref.startsWith('/?')
                      return (
                        <a
                          href={rawHref}
                          target={isPostLink ? undefined : '_blank'}
                          rel={isPostLink ? undefined : 'noreferrer'}
                          onClick={isPostLink ? (e) => {
                            const url = new URL(rawHref, window.location.origin)
                            const channelId = url.searchParams.get('channelId')
                            const postId = url.searchParams.get('postId')
                            if (!channelId || !postId) return
                            e.preventDefault()
                            navigateToPost(channelId, postId)
                          } : undefined}
                          className="text-indigo-600 underline hover:text-indigo-600"
                        >
                          {children}
                        </a>
                      )
                    },
                    table: ({ children }) => <div className="overflow-x-auto my-1.5"><table className="w-full text-[10px] border-collapse">{children}</table></div>,
                    th: ({ children }) => <th className="border border-gray-300 px-2 py-1 bg-gray-200 font-semibold text-left">{children}</th>,
                    td: ({ children }) => <td className="border border-gray-200 px-2 py-1">{children}</td>,
                  }}
                >
                  {msg.content + (msg.streaming ? '▍' : '')}
                </ReactMarkdown>
              ) : (
                msg.content
              )}
            </div>
            {msg.role === 'assistant' && !msg.isError && (
              <>
                <div className="flex items-center gap-1">
                  {!String(msg.id).startsWith('init') && Boolean(msg.content?.trim()) && (
                    <button
                      onClick={() => registerAnswerToBoard(msg, idx)}
                      disabled={postingId === msg.id}
                      title={t.ai.postToBoard}
                      className="flex items-center gap-1 px-2 py-1 rounded-md text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 transition-all text-[10px] disabled:opacity-50"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                      <span>{postingId === msg.id ? t.ai.postingToBoard : t.ai.postToBoard}</span>
                    </button>
                  )}
                  <button
                    onClick={() => copyToClipboard(msg.id, msg.content)}
                    title={t.ai.copyAnswer}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-gray-400 hover:text-gray-500 hover:bg-gray-200 transition-all text-[10px]"
                  >
                    {copiedId === msg.id ? (
                      <>
                        <svg className="w-3 h-3 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        <span className="text-blue-500">{t.ai.copied}</span>
                      </>
                    ) : (
                      <>
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                        <span>{t.ai.copy}</span>
                      </>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
          )
        })}

        {/* Typing indicator */}
        {loading && (
          <div className="flex items-start gap-2">
            <div className="w-5 h-5 rounded-md bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center flex-shrink-0 mt-1">
              <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div className="px-3 py-2.5 rounded-xl bg-gray-200 border border-gray-100 rounded-tl-sm">
              <div className="flex gap-1 items-center">
                <div className="w-1.5 h-1.5 rounded-full bg-gray-500 animate-bounce [animation-delay:0ms]" />
                <div className="w-1.5 h-1.5 rounded-full bg-gray-500 animate-bounce [animation-delay:150ms]" />
                <div className="w-1.5 h-1.5 rounded-full bg-gray-500 animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
            <button
              onClick={handleStop}
              disabled={stopping}
              title={t.ai.stop || '중단'}
              className="mt-1 px-2 py-1 rounded-md border border-red-200 bg-white text-[10px] font-semibold text-red-500 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {stopping ? (t.ai.stopping || '중단 중...') : (t.ai.stop || '중단')}
            </button>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
        </Panel>

        <PanelResizeHandle className="h-1.5 bg-gray-200 hover:bg-green-400 active:bg-green-500 transition-colors flex-shrink-0" />
        <Panel defaultSize={24} minSize={12} className="overflow-hidden">
      {/* Input area */}
      <div className="h-full min-h-0 flex flex-col px-3 py-3 border-t border-gray-200">
        {agenticTarget && (
          <div className="mb-2 px-2.5 py-2 border border-sky-100 rounded-lg bg-sky-50/60 flex-shrink-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold text-sky-700">{t.ai.targetLinkLabel || '대상 링크'}</p>
                <p className="text-[11px] text-gray-700 truncate">{agenticTarget.label || (agenticTarget.type === 'comment' ? '댓글' : '게시글')}</p>
                {agenticTarget.link ? (
                  <a href={agenticTarget.link} target="_blank" rel="noreferrer" className="text-[10px] text-sky-600 underline truncate block">
                    {agenticTarget.link}
                  </a>
                ) : (
                  <p className="text-[10px] text-sky-600 truncate">{t.ai.targetBodyLabel || '게시글 본문이 대상에 포함됩니다.'}</p>
                )}
              </div>
              <button
                onClick={clearAgenticTarget}
                title={t.ai.clearTargetLink || '대상 링크 해제'}
                className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-white/80"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        )}

        {/* Attached File Preview */}
        {attachedFile && (
          <div className="mb-2 flex items-center justify-between bg-gray-100 rounded-lg px-2 py-1.5 border border-gray-200 flex-shrink-0">
            <div className="flex items-center gap-2 overflow-hidden">
              <svg className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.414a4 4 0 00-5.656-5.656l-6.415 6.414a6 6 0 008.486 8.486L20.5 13" />
              </svg>
              <span className="text-[10px] text-gray-600 truncate">{attachedFile.name}</span>
            </div>
            <button onClick={removeFile} className="text-gray-400 hover:text-gray-600">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        <div
          className={`flex-1 min-h-0 flex flex-col gap-1 rounded-xl border px-2 py-2 transition-colors relative overflow-hidden ${
            dragOver
              ? 'border-green-500/60 bg-green-50 shadow-sm shadow-green-200'
              : 'bg-gray-200 border-gray-200 focus-within:border-green-500/40'
          }`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {dragOver && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center pointer-events-none">
              <svg className="w-7 h-7 text-green-600 mb-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.414a4 4 0 00-5.656-5.656l-6.415 6.414a6 6 0 008.486 8.486L20.5 13" />
              </svg>
              <p className="text-green-700 text-[11px] font-semibold">{t.chat.dropFile}</p>
            </div>
          )}
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            className="hidden"
          />
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onDragOver={handleDragOver}
            onDrop={handleTextareaDrop}
            placeholder={t.ai.inputPlaceholder}
            disabled={loading}
            className="flex-1 w-full min-h-0 bg-transparent text-gray-900 placeholder-white/30 text-xs resize-none focus:outline-none leading-relaxed overflow-y-auto disabled:opacity-50"
          />
          {/* 버튼은 입력창 아래 별도 행. 이 행에는 글이 들어가지 않는다. */}
          <div className="flex-shrink-0 flex items-center justify-end gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
              title={t.ai.attachFile}
              className="flex-shrink-0 w-7 h-7 rounded-lg hover:bg-gray-300 text-gray-400 hover:text-gray-600 flex items-center justify-center transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.414a4 4 0 00-5.656-5.656l-6.415 6.414a6 6 0 008.486 8.486L20.5 13" />
              </svg>
            </button>
            <button
              onClick={sendMessage}
              disabled={(!input.trim() && !attachedFile) || loading}
              className="flex-shrink-0 w-7 h-7 rounded-lg bg-green-600 disabled:bg-gray-200 enabled:hover:bg-green-500 flex items-center justify-center transition-colors"
            >
              {loading ? (
                <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <svg className="w-3.5 h-3.5 text-gray-900" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              )}
            </button>
          </div>
        </div>
        <p className="text-gray-300 text-xs mt-1 px-0.5 flex-shrink-0">{t.ai.inputHint}</p>
      </div>
        </Panel>
      </PanelGroup>

      {noticeDialog && (
        <div className="fixed inset-0 z-[95] bg-black/40 flex items-center justify-center px-4">
          <div className="w-full max-w-sm bg-white border border-gray-200 rounded-2xl shadow-2xl p-5">
            <h3 className="text-gray-900 font-bold text-base">{noticeDialog.title}</h3>
            <p className="text-gray-700 text-sm mt-2 leading-relaxed whitespace-pre-wrap">{noticeDialog.message}</p>
            <div className="flex justify-end mt-5">
              <button
                onClick={() => setNoticeDialog(null)}
                className="px-4 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 text-sm"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
