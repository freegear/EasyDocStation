import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { GROQ_MODELS, GROQ_API_KEY } from '../data/mockData'
import { apiFetch, getToken } from '../lib/api'
import { useChat } from '../contexts/ChatContext'
import { useAuth } from '../contexts/AuthContext'
import { useT } from '../i18n/useT'

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

function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
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

export default function GroqPanel({ width }) {
  const {
    navigateToPost,
    selectedChannel,
    addPost,
    addComment,
    agenticTarget,
    clearAgenticTarget,
    teams,
    activePostSelection,
  } = useChat()
  const { currentUser } = useAuth()
  const t = useT()
  const [copiedId, setCopiedId] = useState(null)
  const [postingId, setPostingId] = useState(null)
  const [noticeDialog, setNoticeDialog] = useState(null) // { title, message }

  function openNotice(message, title = '알림') {
    setNoticeDialog({ title, message })
  }

  function copyToClipboard(id, text) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    })
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
  const [aiConfig, setAiConfig] = useState({ num_predict: 2048, num_ctx: 8192, history: 6, language: 'ko' })
  const [ragRetrieval, setRagRetrieval] = useState(normalizeRetrievalConfig({}))
  const fileInputRef = useRef(null)
  const bottomRef = useRef(null)
  const textareaRef = useRef(null)
  const dragCounterRef = useRef(0)

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
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

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
    const text = input.trim()
    if (!text && !attachedFile || loading) return

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

    // ── 1. 번역 요청 감지 — 번역이면 RAG 검색 없이 바로 AI 호출 ──
    const isTranslation = isTranslationQuery(text)

    let ragContext = ''
    let ragReferences = []
    if (!isTranslation && !base64Data) {
      // ── 1-1. RAG 검색 — LanceDB에서 관련 문서 검색 ──────────
      try {
        const dynamicLimit = isCommandQuery(text) || isTemporalQuery(text) ? 10 : isEnumerationQuery(text) ? 8 : 5
        const preferredSources = extractSourceHints(text)
        const scopeFilter = {}
        if (agenticTarget?.postId) scopeFilter.post_id = String(agenticTarget.postId)
        if (agenticTarget?.commentId) scopeFilter.comment_id = String(agenticTarget.commentId)
        const retrievalPayload = {
          ...ragRetrieval,
          k: Math.max(dynamicLimit, ragRetrieval.k || dynamicLimit),
          fetch_k: Math.max((ragRetrieval.fetch_k || dynamicLimit * 3), dynamicLimit * 3),
          filter: {
            ...(ragRetrieval.filter || {}),
            ...scopeFilter,
          },
        }
        const ragResult = await apiFetch('/rag/search', {
          method: 'POST',
          body: JSON.stringify({
            query: text,
            limit: dynamicLimit,
            preferred_sources: preferredSources,
            retrieval: retrievalPayload,
          }),
        })
        ragContext = ragResult.context || ''
        ragReferences = ragResult.references || []
      } catch (e) {
        console.warn('[RAG] 검색 실패:', e.message)
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
      ? `아래 [참고 정보]에 있는 사실만 근거로 답변하세요. 참고 정보에 없는 사실은 추측하지 마세요. 다만 언어/문체/역할 요청(예: 일본어로 답변)은 반영하세요.\n\n[참고 정보]\n${ragContext}\n\n[질문]\n${fullText}`
      : fullText

    const scopedContentWithContext = agenticTarget
      ? `${contentWithContext}\n\n[대상 링크]\n${agenticTarget.link || ''}\n[대상 범위]\n${agenticTarget.type === 'comment' ? '댓글 단일 범위' : '게시글 범위'}`
      : contentWithContext

    const userApiMessage = { role: 'user', content: scopedContentWithContext }
    if (base64Data) {
      userApiMessage.images = [base64Data] // Ollama 멀티모달 형식
    }

    const historyForApi = messages
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
      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
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
              setMessages(prev => prev.map(m =>
                m.id === msgId ? { ...m, content: accumulated } : m
              ))
              bottomRef.current?.scrollIntoView({ behavior: 'instant' })
            }
          } catch (_) {}
        }
      }

      // 스트리밍 완료 — streaming 플래그 제거
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, streaming: false } : m
      ))
    } catch (err) {
      setError(err.message)
      setMessages(prev => prev.map(m =>
        m.id === msgId
          ? { ...m, content: t.ai.errorPrefix + err.message, streaming: false, isError: true }
          : m
      ))
    } finally {
      setLoading(false)
    }
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
      id: 'init-' + Date.now(),
      role: 'assistant',
      content: t.ai.cleared,
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

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-3">
        {messages.map((msg, idx) => (
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
              <span className="text-gray-400 text-xs">{formatTime(msg.time)}</span>
            </div>
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
                    code: ({ inline, children }) => inline
                      ? <code className="bg-gray-200 px-1 py-0.5 rounded text-green-300 font-mono">{children}</code>
                      : <pre className="bg-black/40 rounded-lg p-2 mt-1 mb-1.5 overflow-x-auto"><code className="text-green-300 font-mono text-[10px]">{children}</code></pre>,
                    blockquote: ({ children }) => <blockquote className="border-l-2 border-white/30 pl-2 text-gray-500 italic my-1">{children}</blockquote>,
                    hr: () => <hr className="border-gray-200 my-2" />,
                    a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" className="text-indigo-600 underline hover:text-indigo-600">{children}</a>,
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
                {/* References section */}
                {msg.references && msg.references.length > 0 && (
                  <div className="w-full mt-1 px-1">
                    <div className="text-[10px] text-gray-400 mb-1 font-medium">{t.ai.references}</div>
                    <div className="flex flex-col gap-1">
                      {msg.references.map((ref, i) => (
                        <button
                          key={i}
                          onClick={() => ref.channel_id && navigateToPost(ref.channel_id, ref.post_id, { commentId: ref.comment_id, attachmentId: ref.attachment_id })}
                          disabled={!ref.channel_id}
                          className="w-full flex items-start gap-1.5 bg-gray-100 rounded-lg px-2 py-1.5 border border-gray-200 text-left transition-colors enabled:hover:bg-gray-200 enabled:hover:border-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
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
                      ))}
                    </div>
                  </div>
                )}
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
        ))}

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
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="px-3 py-3 border-t border-gray-200 flex-shrink-0">
        {agenticTarget && (
          <div className="mb-2 px-2.5 py-2 border border-sky-100 rounded-lg bg-sky-50/60">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold text-sky-700">{t.ai.targetLinkLabel || '대상 링크'}</p>
                <p className="text-[11px] text-gray-700 truncate">{agenticTarget.label || (agenticTarget.type === 'comment' ? '댓글' : '게시글')}</p>
                <a href={agenticTarget.link} target="_blank" rel="noreferrer" className="text-[10px] text-sky-600 underline truncate block">
                  {agenticTarget.link}
                </a>
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
          <div className="mb-2 flex items-center justify-between bg-gray-100 rounded-lg px-2 py-1.5 border border-gray-200">
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
          className={`flex items-end gap-2 rounded-xl border px-2 py-2 transition-colors relative overflow-hidden ${
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
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
            title={t.ai.attachFile}
            className="flex-shrink-0 w-7 h-7 rounded-lg hover:bg-gray-200 text-gray-400 hover:text-gray-600 flex items-center justify-center transition-colors self-end"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.414a4 4 0 00-5.656-5.656l-6.415 6.414a6 6 0 008.486 8.486L20.5 13" />
            </svg>
          </button>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onDragOver={handleDragOver}
            onDrop={handleTextareaDrop}
            placeholder={t.ai.inputPlaceholder}
            rows={1}
            disabled={loading}
            className="flex-1 bg-transparent text-gray-900 placeholder-white/30 text-xs resize-none focus:outline-none leading-relaxed min-h-[24px] max-h-24 overflow-y-auto disabled:opacity-50"
            onInput={e => {
              e.target.style.height = 'auto'
              e.target.style.height = e.target.scrollHeight + 'px'
            }}
          />
          <button
            onClick={sendMessage}
            disabled={(!input.trim() && !attachedFile) || loading}
            className="flex-shrink-0 w-7 h-7 rounded-lg bg-green-600 disabled:bg-gray-200 enabled:hover:bg-green-500 flex items-center justify-center transition-colors self-end"
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
        <p className="text-gray-300 text-xs mt-1 px-0.5">{t.ai.inputHint}</p>
      </div>

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
