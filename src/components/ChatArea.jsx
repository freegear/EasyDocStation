import { useState, useRef, useEffect, useCallback } from 'react'
import { useChat } from '../contexts/ChatContext'
import { useAuth } from '../contexts/AuthContext'
import config from '../config.json'

const IMG_W = config.imagePreview.width
const IMG_H = config.imagePreview.height

// ─── Helpers ──────────────────────────────────────────────────

function formatDate(iso) {
  const d = new Date(iso)
  const now = new Date()
  const diff = Math.floor((now - d) / 1000)
  if (diff < 60) return '방금 전'
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}일 전`
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatFull(iso) {
  return new Date(iso).toLocaleString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function getFileCategory(type, name) {
  if (type.startsWith('image/')) return 'image'
  if (type === 'application/pdf') return 'pdf'
  if (type.includes('spreadsheet') || type.includes('excel') || /\.(xls|xlsx|csv)$/i.test(name)) return 'sheet'
  if (type.includes('word') || /\.(doc|docx)$/i.test(name)) return 'doc'
  if (type.includes('presentation') || /\.(ppt|pptx)$/i.test(name)) return 'slide'
  if (type.startsWith('text/') || /\.(md|json|yaml|yml|toml|env|sh|bash)$/i.test(name)) return 'text'
  if (/\.(js|ts|jsx|tsx|py|java|go|rs|cpp|c|cs|rb|php|swift|kt)$/i.test(name)) return 'code'
  if (/\.(zip|tar|gz|rar|7z)$/i.test(name)) return 'archive'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  return 'file'
}

function FileTypeIcon({ category, className = 'w-5 h-5' }) {
  const icons = {
    image: { color: 'text-green-400', path: 'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z' },
    pdf:   { color: 'text-red-400',   path: 'M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z' },
    sheet: { color: 'text-emerald-400', path: 'M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2' },
    doc:   { color: 'text-blue-400',  path: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
    slide: { color: 'text-orange-400', path: 'M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z' },
    text:  { color: 'text-gray-400',  path: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
    code:  { color: 'text-purple-400', path: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4' },
    archive: { color: 'text-yellow-400', path: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4' },
    video: { color: 'text-pink-400',  path: 'M15 10l4.553-2.069A1 1 0 0121 8.868v6.264a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z' },
    audio: { color: 'text-cyan-400',  path: 'M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3' },
    file:  { color: 'text-white/40',  path: 'M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z' },
  }
  const { color, path } = icons[category] || icons.file
  return (
    <svg className={`${className} ${color} flex-shrink-0`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={path} />
    </svg>
  )
}

// ─── Shared UI ────────────────────────────────────────────────

function Avatar({ letters, size = 'md' }) {
  const cls = size === 'sm' ? 'w-6 h-6 text-xs' : size === 'lg' ? 'w-10 h-10 text-base' : 'w-8 h-8 text-sm'
  return (
    <div className={`${cls} rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white font-bold flex-shrink-0`}>
      {letters}
    </div>
  )
}

function Tag({ label }) {
  return (
    <span className="px-2 py-0.5 rounded-md bg-indigo-500/20 text-indigo-300 text-xs font-medium border border-indigo-500/20">
      {label}
    </span>
  )
}

function PinIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-amber-400" fill="currentColor" viewBox="0 0 24 24">
      <path d="M16 4a1 1 0 00-1-1H9a1 1 0 00-1 1v6l-2 4h12l-2-4V4zm-4 14a2 2 0 002-2h-4a2 2 0 002 2z" />
    </svg>
  )
}

// ─── File Chips (shared between compose & detail) ─────────────

function FileChip({ file, onRemove }) {
  const category = getFileCategory(file.type, file.name)
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-white/6 border border-white/10 group max-w-[220px]">
      {category === 'image' && file.url ? (
        <img src={file.url} alt={file.name} className="w-6 h-6 rounded object-cover flex-shrink-0" />
      ) : (
        <FileTypeIcon category={category} className="w-4 h-4" />
      )}
      <div className="flex-1 min-w-0">
        <p className="text-white/80 text-xs font-medium truncate leading-none">{file.name}</p>
        <p className="text-white/30 text-xs leading-none mt-0.5">{formatSize(file.size)}</p>
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(file.id)}
          className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-white/70 transition-all flex-shrink-0 leading-none"
        >
          ×
        </button>
      )}
    </div>
  )
}

// ─── Attachment list in post detail ──────────────────────────

function AttachmentList({ attachments }) {
  if (!attachments || attachments.length === 0) return null

  const images = attachments.filter(a => getFileCategory(a.type, a.name) === 'image')
  const others = attachments.filter(a => getFileCategory(a.type, a.name) !== 'image')

  return (
    <div className="mt-6 border-t border-white/8 pt-5">
      <h4 className="text-white/50 text-xs font-semibold uppercase tracking-widest mb-3 flex items-center gap-1.5">
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
        </svg>
        첨부파일 {attachments.length}개
      </h4>

      {/* Image thumbnails — 512×512 */}
      {images.length > 0 && (
        <div className="flex flex-col gap-3 mb-3">
          {images.map(f => (
            <a
              key={f.id}
              href={f.url}
              target="_blank"
              rel="noreferrer"
              className="inline-block rounded-2xl overflow-hidden border border-white/10 hover:border-indigo-500/50 transition-colors group"
              style={{ width: IMG_W, maxWidth: '100%' }}
            >
              <img
                src={f.url}
                alt={f.name}
                className="block object-cover group-hover:opacity-90 transition-opacity"
                style={{ width: IMG_W, height: IMG_H, maxWidth: '100%', objectFit: 'cover' }}
              />
              <div className="px-3 py-2 flex items-center justify-between bg-white/4">
                <span className="text-white/60 text-xs font-medium truncate">{f.name}</span>
                <span className="text-white/30 text-xs ml-3 flex-shrink-0">{formatSize(f.size)}</span>
              </div>
            </a>
          ))}
        </div>
      )}

      {/* Non-image files */}
      {others.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {others.map(f => {
            const category = getFileCategory(f.type, f.name)
            return (
              <a
                key={f.id}
                href={f.url}
                download={f.name}
                className="flex items-center gap-3 px-3.5 py-2.5 rounded-xl bg-white/4 border border-white/8 hover:bg-white/7 hover:border-white/15 transition-all group"
              >
                <FileTypeIcon category={category} className="w-5 h-5" />
                <div className="flex-1 min-w-0">
                  <p className="text-white/80 text-sm font-medium truncate group-hover:text-white transition-colors">{f.name}</p>
                  <p className="text-white/30 text-xs">{formatSize(f.size)}</p>
                </div>
                <svg className="w-4 h-4 text-white/20 group-hover:text-white/60 transition-colors flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </a>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Content renderer ─────────────────────────────────────────

function ContentRenderer({ text }) {
  const lines = text.split('\n')
  return (
    <div className="space-y-1.5">
      {lines.map((line, i) => {
        if (line.startsWith('## ')) return <h2 key={i} className="text-white font-bold text-base mt-4 mb-1 first:mt-0">{line.slice(3)}</h2>
        if (line.startsWith('### ')) return <h3 key={i} className="text-white font-semibold text-sm mt-3 mb-1">{line.slice(4)}</h3>
        if (line.startsWith('- [ ] ')) return (
          <div key={i} className="flex items-center gap-2 text-white/80 text-sm">
            <input type="checkbox" disabled className="rounded" />
            <span>{line.slice(6)}</span>
          </div>
        )
        if (line.startsWith('- ')) return <li key={i} className="text-white/80 text-sm ml-4 list-disc">{renderInline(line.slice(2))}</li>
        if (/^\d+\./.test(line)) return <li key={i} className="text-white/80 text-sm ml-4 list-decimal">{renderInline(line.replace(/^\d+\.\s*/, ''))}</li>
        if (line.startsWith('```')) return null
        if (line.startsWith('|')) return <TableRow key={i} line={line} />
        if (line.startsWith('---')) return <hr key={i} className="border-white/10 my-2" />
        if (!line.trim()) return <div key={i} className="h-1.5" />
        return <p key={i} className="text-white/80 text-sm leading-relaxed">{renderInline(line)}</p>
      })}
    </div>
  )
}

function renderInline(text) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={i} className="text-white font-semibold">{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`'))
      return <code key={i} className="bg-white/10 text-indigo-300 px-1 rounded text-xs font-mono">{part.slice(1, -1)}</code>
    return part
  })
}

function TableRow({ line }) {
  if (line.replace(/\|/g, '').replace(/-/g, '').trim() === '') return null
  const cells = line.split('|').filter((_, i, a) => i > 0 && i < a.length - 1).map(c => c.trim())
  return (
    <tr className="border-b border-white/5">
      {cells.map((c, i) => <td key={i} className="px-3 py-1.5 text-white/70 text-xs">{c}</td>)}
    </tr>
  )
}

// ─── Compose bar with file attach ────────────────────────────

function ComposeBar({ onSubmit }) {
  const { currentUser } = useAuth()
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [tags, setTags] = useState([])
  const [files, setFiles] = useState([])
  const [expanded, setExpanded] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const titleRef = useRef(null)
  const contentRef = useRef(null)
  const fileInputRef = useRef(null)
  const dragCounter = useRef(0)

  function addFiles(newFiles) {
    const mapped = Array.from(newFiles).map(f => ({
      id: `f-${Date.now()}-${Math.random()}`,
      name: f.name,
      size: f.size,
      type: f.type,
      url: URL.createObjectURL(f),
      file: f,
    }))
    setFiles(prev => [...prev, ...mapped])
    if (!expanded) setExpanded(true)
  }

  function removeFile(id) {
    setFiles(prev => {
      const target = prev.find(f => f.id === id)
      if (target) URL.revokeObjectURL(target.url)
      return prev.filter(f => f.id !== id)
    })
  }

  function handleFileSelect(e) {
    if (e.target.files?.length) addFiles(e.target.files)
    e.target.value = ''
  }

  // Drag & drop handlers
  function handleDragEnter(e) {
    e.preventDefault()
    dragCounter.current++
    if (e.dataTransfer.types.includes('Files')) setDragOver(true)
  }
  function handleDragLeave(e) {
    e.preventDefault()
    dragCounter.current--
    if (dragCounter.current === 0) setDragOver(false)
  }
  function handleDragOver(e) {
    e.preventDefault()
  }
  function handleDrop(e) {
    e.preventDefault()
    dragCounter.current = 0
    setDragOver(false)
    if (e.dataTransfer.files?.length) {
      addFiles(e.dataTransfer.files)
    }
  }

  function handleTagKey(e) {
    if ((e.key === 'Enter' || e.key === ',') && tagInput.trim()) {
      e.preventDefault()
      const t = tagInput.trim().replace(',', '')
      if (t && !tags.includes(t)) setTags(prev => [...prev, t])
      setTagInput('')
    }
  }

  function handleTitleKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      setExpanded(true)
      setTimeout(() => contentRef.current?.focus(), 50)
    }
  }

  function handleSend() {
    if (!title.trim()) { titleRef.current?.focus(); return }
    onSubmit({ title: title.trim(), content: content.trim(), tags, attachments: files })
    // cleanup object URLs on send
    files.forEach(f => URL.revokeObjectURL(f.url))
    setTitle(''); setContent(''); setTags([]); setTagInput(''); setFiles([])
    setExpanded(false)
  }

  function handleCancel() {
    files.forEach(f => URL.revokeObjectURL(f.url))
    setContent(''); setTags([]); setTagInput(''); setFiles([])
    setExpanded(false)
  }

  const canSend = title.trim().length > 0

  return (
    <div className="flex-shrink-0 px-4 py-3 border-t border-white/10">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileSelect}
      />

      <div
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={`flex flex-col rounded-2xl border transition-all duration-150 relative overflow-hidden ${
          dragOver
            ? 'border-indigo-400/70 bg-indigo-500/10 shadow-lg shadow-indigo-500/20'
            : expanded
            ? 'bg-white/6 border-indigo-500/40'
            : 'bg-white/5 border-white/10 hover:border-white/20'
        }`}
      >
        {/* Drag overlay */}
        {dragOver && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-10 pointer-events-none">
            <svg className="w-8 h-8 text-indigo-400 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
            <p className="text-indigo-300 text-sm font-semibold">파일을 놓아 첨부하세요</p>
          </div>
        )}

        {/* Title row */}
        <div className="flex items-center gap-3 px-4 pt-3 pb-2">
          {currentUser && <Avatar letters={currentUser.avatar} size="sm" />}
          <input
            ref={titleRef}
            value={title}
            onChange={e => setTitle(e.target.value)}
            onFocus={() => setExpanded(true)}
            onKeyDown={handleTitleKey}
            placeholder="제목을 입력하세요..."
            className="flex-1 bg-transparent text-white placeholder-white/25 text-sm font-semibold focus:outline-none"
          />
        </div>

        {/* Expanded: content area */}
        {expanded && (
          <>
            <div className="px-4 pb-2 pl-[52px]">
              <textarea
                ref={contentRef}
                value={content}
                onChange={e => setContent(e.target.value)}
                placeholder="내용을 입력하세요... (마크다운 지원: ## 제목, **굵기**, `코드`)"
                rows={3}
                className="w-full bg-transparent text-white/70 placeholder-white/20 text-sm leading-relaxed resize-none focus:outline-none"
                onInput={e => {
                  e.target.style.height = 'auto'
                  e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'
                }}
              />
            </div>

            {/* Attached files preview */}
            {files.length > 0 && (
              <div className="px-4 pb-2 pl-[52px]">
                <div className="flex flex-wrap gap-2">
                  {files.map(f => <FileChip key={f.id} file={f} onRemove={removeFile} />)}
                </div>
              </div>
            )}

            {/* Tags + actions row */}
            <div className="flex items-center gap-2 px-3 pb-3 pl-[52px]">
              {/* Clip button */}
              <button
                type="button"
                title="파일 첨부"
                onClick={() => fileInputRef.current.click()}
                className="p-1.5 rounded-lg text-white/30 hover:text-white/70 hover:bg-white/8 transition-colors flex-shrink-0"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
              </button>

              {/* Tags */}
              <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
                {tags.map(tag => (
                  <span key={tag} className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-indigo-500/20 text-indigo-300 text-xs border border-indigo-500/20">
                    {tag}
                    <button type="button" onClick={() => setTags(p => p.filter(t => t !== tag))} className="text-indigo-400/60 hover:text-indigo-200 transition-colors leading-none">×</button>
                  </span>
                ))}
                <input
                  value={tagInput}
                  onChange={e => setTagInput(e.target.value)}
                  onKeyDown={handleTagKey}
                  placeholder={tags.length === 0 ? '태그 (Enter로 추가)' : '+태그'}
                  className="bg-transparent text-white/40 placeholder-white/20 text-xs focus:outline-none w-28 focus:text-white/70 transition-colors"
                />
              </div>

              {/* Cancel + Send */}
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button type="button" onClick={handleCancel} className="px-2.5 py-1.5 rounded-lg text-white/30 hover:text-white/60 text-xs transition-colors hover:bg-white/5">
                  취소
                </button>
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!canSend}
                  className="w-9 h-9 rounded-xl flex items-center justify-center transition-all disabled:opacity-30 disabled:cursor-not-allowed enabled:bg-indigo-600 enabled:hover:bg-indigo-500 enabled:shadow-lg enabled:shadow-indigo-500/25 enabled:active:scale-95"
                >
                  <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                </button>
              </div>
            </div>
          </>
        )}

        {/* Collapsed: show send button if title exists */}
        {!expanded && title.trim() && (
          <div className="flex items-center justify-between px-4 pb-3 pl-[52px]">
            <button type="button" onClick={() => fileInputRef.current.click()} className="p-1.5 rounded-lg text-white/30 hover:text-white/60 hover:bg-white/8 transition-colors">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
              </svg>
            </button>
            <button type="button" onClick={handleSend} className="w-9 h-9 rounded-xl bg-indigo-600 hover:bg-indigo-500 flex items-center justify-center shadow-lg shadow-indigo-500/25 active:scale-95 transition-all">
              <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </button>
          </div>
        )}
      </div>

      <p className="text-white/15 text-xs mt-1.5 px-1">
        Enter로 내용 입력 전환 · 클립으로 첨부 또는 파일 드래그 앤 드롭
      </p>
    </div>
  )
}

// ─── Post List ────────────────────────────────────────────────

function PostList({ posts, onSelect, onSubmit }) {
  const { selectedChannel, selectedTeam } = useChat()
  const pinnedPosts = posts.filter(p => p.pinned)
  const normalPosts = posts.filter(p => !p.pinned)
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [posts.length])

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center px-6 py-4 border-b border-white/10 flex-shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-white/40 text-sm">#</span>
            <h2 className="text-white font-bold text-base">{selectedChannel.name}</h2>
            {selectedChannel.type === 'private' && (
              <svg className="w-3.5 h-3.5 text-white/30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            )}
          </div>
          <p className="text-white/30 text-xs mt-0.5">{selectedTeam.name} · 게시글 {posts.length}개</p>
        </div>
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {posts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-16">
            <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-3xl mb-4">📄</div>
            <h3 className="text-white font-semibold mb-1">아직 게시글이 없습니다</h3>
            <p className="text-white/40 text-sm">아래 입력창에 제목을 입력하고 게시글을 작성해보세요!</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {pinnedPosts.length > 0 && (
              <>
                <div className="flex items-center gap-2 text-amber-400/60 text-xs font-medium uppercase tracking-widest mb-1">
                  <PinIcon /><span>고정된 게시글</span>
                </div>
                {pinnedPosts.map(p => <PostCard key={p.id} post={p} onSelect={onSelect} pinned />)}
                {normalPosts.length > 0 && <div className="border-t border-white/5 my-1" />}
              </>
            )}
            {normalPosts.map(p => <PostCard key={p.id} post={p} onSelect={onSelect} />)}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <ComposeBar onSubmit={onSubmit} />
    </div>
  )
}

function PostCard({ post, onSelect, pinned }) {
  const excerpt = post.content
    .replace(/#{1,3} /g, '').replace(/\*\*/g, '').replace(/`/g, '')
    .split('\n').filter(l => l.trim() && !l.startsWith('|') && !l.startsWith('-'))
    .slice(0, 2).join(' ').slice(0, 140)
  const attachCount = post.attachments?.length || 0

  return (
    <button
      onClick={() => onSelect(post)}
      className={`w-full text-left px-5 py-4 rounded-2xl border transition-all group ${
        pinned
          ? 'bg-amber-500/5 border-amber-500/15 hover:bg-amber-500/10 hover:border-amber-500/30'
          : 'bg-white/4 border-white/8 hover:bg-white/7 hover:border-white/15'
      }`}
    >
      <div className="flex items-start gap-3">
        <Avatar letters={post.author.avatar} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {pinned && <PinIcon />}
            <h3 className="text-white font-semibold text-sm leading-tight group-hover:text-indigo-300 transition-colors truncate">{post.title}</h3>
          </div>
          <div className="flex items-center gap-2 text-white/35 text-xs mb-2">
            <span className="font-medium text-white/50">{post.author.name}</span>
            <span>·</span>
            <span>{formatDate(post.createdAt)}</span>
            <span>·</span>
            <span className="flex items-center gap-1">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0zM2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
              {post.views}
            </span>
            {post.comments.length > 0 && (<><span>·</span><span className="flex items-center gap-1"><svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>{post.comments.length}</span></>)}
            {attachCount > 0 && (<><span>·</span><span className="flex items-center gap-1"><svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>{attachCount}</span></>)}
          </div>
          {excerpt && <p className="text-white/45 text-xs leading-relaxed line-clamp-2 mb-2.5">{excerpt}</p>}
          {post.tags.length > 0 && <div className="flex flex-wrap gap-1.5">{post.tags.map(t => <Tag key={t} label={t} />)}</div>}
        </div>
      </div>
    </button>
  )
}

// ─── Post Detail ──────────────────────────────────────────────

function PostDetail({ post, channelId, onBack }) {
  const { addComment, incrementViews, deletePost, posts } = useChat()
  const { currentUser } = useAuth()
  const [comment, setComment] = useState('')
  const [viewed, setViewed] = useState(false)
  const commentsEndRef = useRef(null)

  useEffect(() => {
    if (!viewed) { incrementViews(channelId, post.id); setViewed(true) }
  }, [])

  const freshPost = posts[channelId]?.find(p => p.id === post.id) || post
  const isOwn = freshPost.author.name === currentUser?.name

  function handleComment(e) {
    e.preventDefault()
    if (!comment.trim() || !currentUser) return
    addComment(channelId, post.id, comment.trim(), currentUser)
    setComment('')
    setTimeout(() => commentsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
  }

  function handleDelete() {
    if (window.confirm('이 게시글을 삭제하시겠습니까?')) { deletePost(channelId, post.id); onBack() }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-3 px-6 py-3 border-b border-white/10 flex-shrink-0">
        <button onClick={onBack} className="flex items-center gap-1.5 text-white/40 hover:text-white/80 text-sm transition-colors">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          목록으로
        </button>
        <div className="flex-1" />
        {isOwn && (
          <button onClick={handleDelete} className="flex items-center gap-1 text-red-400/60 hover:text-red-400 text-xs transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            삭제
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {/* Meta */}
        <div className="mb-6">
          {freshPost.pinned && <div className="flex items-center gap-1.5 text-amber-400 text-xs font-medium mb-3"><PinIcon /><span>고정된 게시글</span></div>}
          <h1 className="text-white font-bold text-xl leading-tight mb-3">{freshPost.title}</h1>
          <div className="flex items-center gap-3 mb-3">
            <Avatar letters={freshPost.author.avatar} />
            <div>
              <p className="text-white/80 text-sm font-medium">{freshPost.author.name}</p>
              <p className="text-white/30 text-xs" title={formatFull(freshPost.createdAt)}>{formatDate(freshPost.createdAt)} · 조회 {freshPost.views}회</p>
            </div>
          </div>
          {freshPost.tags.length > 0 && <div className="flex flex-wrap gap-1.5">{freshPost.tags.map(t => <Tag key={t} label={t} />)}</div>}
        </div>

        <div className="border-t border-white/8 mb-6" />

        {/* Body */}
        <div className="mb-4">
          <ContentRenderer text={freshPost.content} />
        </div>

        {/* Attachments */}
        <AttachmentList attachments={freshPost.attachments} />

        {/* Comments */}
        <div className="border-t border-white/8 pt-6 mt-6">
          <h3 className="text-white font-semibold text-sm mb-4">댓글 {freshPost.comments.length}개</h3>
          {freshPost.comments.length === 0 ? (
            <p className="text-white/30 text-sm mb-6">첫 번째 댓글을 남겨보세요.</p>
          ) : (
            <div className="flex flex-col gap-4 mb-6">
              {freshPost.comments.map(c => (
                <div key={c.id} className="flex items-start gap-3">
                  <Avatar letters={c.author.avatar} size="sm" />
                  <div className="flex-1 bg-white/5 rounded-xl px-4 py-3 border border-white/8">
                    <div className="flex items-baseline gap-2 mb-1.5">
                      <span className="text-white/80 text-xs font-semibold">{c.author.name}</span>
                      <span className="text-white/25 text-xs">{formatDate(c.createdAt)}</span>
                    </div>
                    <p className="text-white/70 text-sm leading-relaxed">{c.text}</p>
                  </div>
                </div>
              ))}
              <div ref={commentsEndRef} />
            </div>
          )}
          <form onSubmit={handleComment} className="flex items-start gap-3">
            {currentUser && <Avatar letters={currentUser.avatar} size="sm" />}
            <div className="flex-1 bg-white/5 rounded-xl border border-white/10 focus-within:border-indigo-500/40 transition-colors overflow-hidden">
              <textarea
                value={comment}
                onChange={e => setComment(e.target.value)}
                placeholder="댓글을 입력하세요..."
                rows={2}
                className="w-full bg-transparent text-white/80 placeholder-white/20 text-sm px-4 pt-3 pb-2 resize-none focus:outline-none leading-relaxed"
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleComment(e) } }}
              />
              <div className="flex justify-end px-3 pb-2">
                <button type="submit" disabled={!comment.trim()} className="px-3 py-1.5 rounded-lg bg-indigo-600 disabled:bg-white/10 enabled:hover:bg-indigo-500 text-white text-xs font-semibold transition-colors">
                  댓글 달기
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────

export default function ChatArea() {
  const { selectedChannel, posts, addPost } = useChat()
  const { currentUser } = useAuth()
  const [view, setView] = useState('list')
  const [selectedPost, setSelectedPost] = useState(null)

  const channelPosts = posts[selectedChannel?.id] || []

  useEffect(() => { setView('list'); setSelectedPost(null) }, [selectedChannel?.id])

  function handleSelectPost(post) { setSelectedPost(post); setView('detail') }

  function handleNewPost(data) {
    const post = addPost(selectedChannel.id, data, currentUser)
    setSelectedPost(post)
    setView('detail')
  }

  if (!selectedChannel) {
    return <div className="flex-1 flex items-center justify-center text-white/30 bg-[#1e1c30]">채널을 선택하세요</div>
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#1e1c30]">
      {view === 'list' && <PostList posts={channelPosts} onSelect={handleSelectPost} onSubmit={handleNewPost} />}
      {view === 'detail' && selectedPost && <PostDetail post={selectedPost} channelId={selectedChannel.id} onBack={() => setView('list')} />}
    </div>
  )
}
