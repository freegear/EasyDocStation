import { useState, useRef, useEffect } from 'react'
import { GROQ_MODELS, GROQ_API_KEY } from '../data/mockData'

const SYSTEM_PROMPT = `You are a helpful AI assistant integrated into EasyDocStation, a team collaboration platform.
Help users with their questions, summarize discussions, draft messages, and provide insights.
Respond concisely and helpfully. When responding in Korean, use natural Korean.`

function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
}

export default function GroqPanel() {
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
      content: '안녕하세요! EasyDoc AgenticAI 어시스턴트입니다. 무엇이든 물어보세요!',
      time: new Date().toISOString(),
    }
  ])
  const [input, setInput] = useState('')
   const [selectedModel, setSelectedModel] = useState(GROQ_MODELS[0].id)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [attachedFile, setAttachedFile] = useState(null)
  const fileInputRef = useRef(null)
  const bottomRef = useRef(null)
  const textareaRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

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

    // API 전송용 메시지 구성
    const userApiMessage = { role: 'user', content: fullText }
    if (base64Data) {
      userApiMessage.images = [base64Data] // Ollama 멀티모달 형식
    }

    const historyForApi = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }))

    try {
      // 로컬 Ollama Native API 호출 (멀티모달 지원 최적화)
      const response = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            ...historyForApi,
            userApiMessage,
          ],
          stream: false, // 스트리밍 대신 한 번에 결과 받기
          options: {
            temperature: 0.7,
            num_predict: 1024,
          }
        }),
      })

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        throw new Error(errData.error || `HTTP ${response.status}`)
      }

      const data = await response.json()
      const assistantContent = data.message?.content || '응답을 받지 못했습니다.'

      setMessages(prev => [...prev, {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: assistantContent,
        time: new Date().toISOString(),
        model: selectedModel,
      }])
    } catch (err) {
      setError(err.message)
      setMessages(prev => [...prev, {
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: `오류가 발생했습니다: ${err.message}`,
        time: new Date().toISOString(),
        isError: true,
      }])
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
          <span className="text-white font-semibold text-sm">EasyDoc AgenticAI</span>
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
          className="w-full bg-white/8 text-white text-xs rounded-md px-2 py-1.5 border border-white/10 focus:outline-none focus:ring-1 focus:ring-green-500 cursor-pointer"
        >
          {GROQ_MODELS.map(m => (
            <option key={m.id} value={m.id} className="bg-[#161428]">
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
            <div className={`px-3 py-2 rounded-xl text-xs leading-relaxed max-w-full whitespace-pre-wrap ${
              msg.role === 'user'
                ? 'bg-indigo-600 text-white rounded-tr-sm'
                : msg.isError
                ? 'bg-red-500/20 text-red-300 border border-red-500/30 rounded-tl-sm'
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
              {msg.content}
            </div>
            {msg.role === 'assistant' && !msg.isError && (
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
