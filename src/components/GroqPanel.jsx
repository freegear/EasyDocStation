import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { GROQ_MODELS, GROQ_API_KEY } from '../data/mockData'
import { apiFetch } from '../lib/api'
import { useChat } from '../contexts/ChatContext'

const SYSTEM_PROMPT = `당신은 EasyStation의 AI 어시스턴트입니다.
반드시 제공된 [참고 정보]에 있는 내용만을 근거로 답변하세요.
참고 정보에 없는 내용은 절대 추측하거나 일반 지식으로 보충하지 마세요.
답변은 간결하고 명확하게 한국어로 작성하세요.`

function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
}

export default function GroqPanel() {
  const { navigateToPost } = useChat()
  const [copiedId, setCopiedId] = useState(null)

  function copyToClipboard(id, text) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    })
  }

  const [messages, setMessages] = useState([
    {
      id: 'init',
      role: 'assistant',
      content: '안녕하세요! EasyStation AgenticAI 어시스턴트입니다. 무엇이든 물어보세요!',
      time: new Date().toISOString(),
    }
  ])
  const [input, setInput] = useState('')
  const [selectedModel, setSelectedModel] = useState(GROQ_MODELS[0].id)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [attachedFile, setAttachedFile] = useState(null)
  const [aiConfig, setAiConfig] = useState({ num_predict: 4096, num_ctx: 8192, history: 6 })
  const fileInputRef = useRef(null)
  const bottomRef = useRef(null)
  const textareaRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  useEffect(() => {
    async function fetchConfig() {
      try {
        const data = await apiFetch('/config/agenticai')
        setAiConfig(data)
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

    const fileName = attachedFile ? ` [파일 첨부: ${attachedFile.name}]` : ''
    const fullText = text + fileName

    const userMsg = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: fullText,
      time: new Date().toISOString(),
      image: imageUrl,
    }

    setMessages(prev => [...prev, userMsg])
    setInput('')
    setAttachedFile(null)
    setLoading(true)
    setError(null)

    // ── 1. RAG 검색 — LanceDB에서 관련 문서 검색 ────────────────
    let ragContext = ''
    let ragReferences = []
    try {
      const ragResult = await apiFetch('/rag/search', {
        method: 'POST',
        body: JSON.stringify({ query: text, limit: 3 }),
      })
      ragContext = ragResult.context || ''
      ragReferences = ragResult.references || []
    } catch (e) {
      console.warn('[RAG] 검색 실패:', e.message)
    }

    // ── 2. RAG 데이터 없으면 AI 호출 없이 안내 메시지 반환 ──────
    if (!ragContext) {
      setMessages(prev => [...prev, {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: '죄송합니다. 관련 데이터를 찾을 수 없습니다.\n\nRAG 데이터베이스에 해당 질문과 관련된 정보가 없습니다. 게시판에 관련 내용을 먼저 등록해 주세요.',
        references: [],
        time: new Date().toISOString(),
        model: selectedModel,
      }])
      setLoading(false)
      return
    }

    // ── 3. API 전송용 메시지 구성 — RAG 데이터만 사용 ────────────
    const contentWithContext = `아래 [참고 정보]에 있는 내용만을 근거로 답변하세요. 참고 정보에 없는 내용은 절대 추측하거나 일반 지식으로 보충하지 마세요.\n\n[참고 정보]\n${ragContext}\n\n[질문]\n${fullText}`

    const userApiMessage = { role: 'user', content: contentWithContext }
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
      const response = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
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
          ? { ...m, content: `오류가 발생했습니다: ${err.message}`, streaming: false, isError: true }
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

  function clearChat() {
    setMessages([{
      id: 'init-' + Date.now(),
      role: 'assistant',
      content: '대화가 초기화되었습니다. 새로운 질문을 입력해주세요.',
      time: new Date().toISOString(),
    }])
    setError(null)
    setAttachedFile(null)
  }

  return (
    <div className="w-80 flex-shrink-0 bg-[#161428] border-l border-white/5 flex flex-col h-full">
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-green-400 to-teal-500 flex items-center justify-center">
            <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <span className="text-white font-semibold text-sm">EasyStation AgenticAI</span>
          {loading && (
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={clearChat}
            title="대화 초기화"
            className="p-1.5 rounded-md text-white/30 hover:text-white/70 hover:bg-white/10 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Model selector */}
      <div className="px-3 py-2 border-b border-white/5 flex-shrink-0">
        <select
          value={selectedModel}
          onChange={e => setSelectedModel(e.target.value)}
          className="w-full bg-white text-black text-xs rounded-md px-2 py-1.5 border border-white/10 focus:outline-none focus:ring-1 focus:ring-green-500 cursor-pointer font-medium"
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
        {messages.map(msg => (
          <div key={msg.id} className={`flex flex-col gap-1 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
            <div className={`flex items-center gap-1.5 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
              {msg.role === 'assistant' ? (
                <div className="w-5 h-5 rounded-md bg-gradient-to-br from-green-400 to-teal-500 flex items-center justify-center">
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
              ) : (
                <div className="w-5 h-5 rounded-md bg-indigo-500 flex items-center justify-center text-white text-xs font-bold">
                  U
                </div>
              )}
              <span className="text-white/30 text-xs">{formatTime(msg.time)}</span>
            </div>
            <div className={`px-3 py-2 rounded-xl text-xs leading-relaxed max-w-full ${msg.role === 'user'
                ? 'bg-indigo-600 text-white rounded-tr-sm whitespace-pre-wrap'
                : msg.isError
                  ? 'bg-red-500/20 text-red-300 border border-red-500/30 rounded-tl-sm whitespace-pre-wrap'
                  : 'bg-white/8 text-white/85 rounded-tl-sm border border-white/5'
              }`}>
              {msg.image && (
                <div className="mb-2 w-64 h-64 overflow-hidden rounded-lg border border-white/10">
                  <img
                    src={msg.image}
                    alt="첨부 이미지"
                    className="w-full h-full object-cover"
                  />
                </div>
              )}
              {msg.streaming && msg.content === '' && (
                <span className="inline-block w-1.5 h-3.5 bg-white/50 rounded-sm animate-pulse" />
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
                    strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
                    em: ({ children }) => <em className="italic text-white/70">{children}</em>,
                    code: ({ inline, children }) => inline
                      ? <code className="bg-black/30 px-1 py-0.5 rounded text-green-300 font-mono">{children}</code>
                      : <pre className="bg-black/40 rounded-lg p-2 mt-1 mb-1.5 overflow-x-auto"><code className="text-green-300 font-mono text-[10px]">{children}</code></pre>,
                    blockquote: ({ children }) => <blockquote className="border-l-2 border-white/30 pl-2 text-white/60 italic my-1">{children}</blockquote>,
                    hr: () => <hr className="border-white/15 my-2" />,
                    a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" className="text-indigo-300 underline hover:text-indigo-200">{children}</a>,
                    table: ({ children }) => <div className="overflow-x-auto my-1.5"><table className="w-full text-[10px] border-collapse">{children}</table></div>,
                    th: ({ children }) => <th className="border border-white/20 px-2 py-1 bg-white/10 font-semibold text-left">{children}</th>,
                    td: ({ children }) => <td className="border border-white/10 px-2 py-1">{children}</td>,
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
                    <div className="text-[10px] text-white/30 mb-1 font-medium">참고 문서</div>
                    <div className="flex flex-col gap-1">
                      {msg.references.map((ref, i) => (
                        <button
                          key={i}
                          onClick={() => ref.channel_id && navigateToPost(ref.channel_id, ref.post_id, { commentId: ref.comment_id, attachmentId: ref.attachment_id })}
                          disabled={!ref.channel_id}
                          className="w-full flex items-start gap-1.5 bg-white/5 rounded-lg px-2 py-1.5 border border-white/8 text-left transition-colors enabled:hover:bg-white/10 enabled:hover:border-white/15 disabled:opacity-40 disabled:cursor-not-allowed"
                          title={ref.channel_id ? `${ref.team ? ref.team + ' · ' : ''}${ref.channel} 채널로 이동` : '재학습 후 이동 가능합니다'}
                        >
                          {ref.type === 'pdf' ? (
                            <svg className="w-3 h-3 text-red-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
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
                          <div className="flex flex-col min-w-0">
                            <span className="text-[10px] text-white/70 truncate leading-tight">{ref.label}</span>
                            <span className="text-[9px] text-white/30 leading-tight">
                              {ref.team ? `${ref.team} · ` : ''}{ref.channel || ''}
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <button
                  onClick={() => copyToClipboard(msg.id, msg.content)}
                  title="답변 복사"
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-white/25 hover:text-white/60 hover:bg-white/8 transition-all text-[10px]"
                >
                  {copiedId === msg.id ? (
                    <>
                      <svg className="w-3 h-3 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      <span className="text-green-400">Copied!</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </>
            )}
          </div>
        ))}

        {/* Typing indicator */}
        {loading && (
          <div className="flex items-start gap-2">
            <div className="w-5 h-5 rounded-md bg-gradient-to-br from-green-400 to-teal-500 flex items-center justify-center flex-shrink-0 mt-1">
              <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div className="px-3 py-2.5 rounded-xl bg-white/8 border border-white/5 rounded-tl-sm">
              <div className="flex gap-1 items-center">
                <div className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce [animation-delay:0ms]" />
                <div className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce [animation-delay:150ms]" />
                <div className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="px-3 py-3 border-t border-white/10 flex-shrink-0">
        {/* Attached File Preview */}
        {attachedFile && (
          <div className="mb-2 flex items-center justify-between bg-white/5 rounded-lg px-2 py-1.5 border border-white/10">
            <div className="flex items-center gap-2 overflow-hidden">
              <svg className="w-3.5 h-3.5 text-green-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.414a4 4 0 00-5.656-5.656l-6.415 6.414a6 6 0 008.486 8.486L20.5 13" />
              </svg>
              <span className="text-[10px] text-white/70 truncate">{attachedFile.name}</span>
            </div>
            <button onClick={removeFile} className="text-white/30 hover:text-white/70">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        <div className="flex items-end gap-2 bg-white/8 rounded-xl border border-white/10 px-2 py-2 focus-within:border-green-500/40 transition-colors">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
            title="파일 첨부"
            className="flex-shrink-0 w-7 h-7 rounded-lg hover:bg-white/10 text-white/40 hover:text-white/70 flex items-center justify-center transition-colors self-end"
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
            placeholder="AI에게 물어보세요..."
            rows={1}
            disabled={loading}
            className="flex-1 bg-transparent text-white placeholder-white/30 text-xs resize-none focus:outline-none leading-relaxed min-h-[24px] max-h-24 overflow-y-auto disabled:opacity-50"
            onInput={e => {
              e.target.style.height = 'auto'
              e.target.style.height = e.target.scrollHeight + 'px'
            }}
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || loading}
            className="flex-shrink-0 w-7 h-7 rounded-lg bg-green-600 disabled:bg-white/10 enabled:hover:bg-green-500 flex items-center justify-center transition-colors self-end"
          >
            {loading ? (
              <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            )}
          </button>
        </div>
        <p className="text-white/15 text-xs mt-1 px-0.5">Enter로 전송 · Shift+Enter로 줄바꿈</p>
      </div>
    </div>
  )
}
