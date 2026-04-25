import { useState, useRef, useEffect, useCallback } from 'react'
import { useChat } from '../contexts/ChatContext'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch, getToken } from '../lib/api'
import { hasAnyTextSelection } from '../lib/textSelection'
import { useSelectionClickGuard } from '../hooks/useSelectionClickGuard'
import config from '../config.json'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import ChannelManageModal from './ChannelManageModal'
import ConfirmDialog from './ConfirmDialog'
import PostDetailPane from './chat/PostDetailPane'
import { useT } from '../i18n/useT'
import { isTemplateContent, FORM_TEMPLATES } from '../templates/formTemplates'


// ─── Helpers ──────────────────────────────────────────────────

function formatDate(iso, t) {
  const d = new Date(iso)
  const now = new Date()
  const diff = Math.floor((now - d) / 1000)
  if (diff < 60) return t.chat.justNow
  if (diff < 3600) return t.chat.minutesAgo(Math.floor(diff / 60))
  if (diff < 86400) return t.chat.hoursAgo(Math.floor(diff / 3600))
  if (diff < 86400 * 7) return t.chat.daysAgo(Math.floor(diff / 86400))
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
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

function normalizeGatewayUrl(url) {
  if (!url) return url
  try {
    const parsed = new URL(url, window.location.origin)
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch (_) {
    return url
  }
}

function uploadFileWithProgress(uploadUrl, file, onProgress) {
  const targetUrl = normalizeGatewayUrl(uploadUrl)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', targetUrl, true)

    xhr.upload.onprogress = (evt) => {
      if (!onProgress) return
      const total = evt.lengthComputable ? evt.total : (file?.size || 0)
      onProgress({
        loaded: evt.loaded || 0,
        total,
        lengthComputable: Boolean(evt.lengthComputable),
      })
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        if (onProgress) {
          const total = file?.size || 0
          onProgress({ loaded: total, total, lengthComputable: true })
        }
        resolve()
        return
      }
      reject(new Error(`upload failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('upload network error'))
    xhr.onabort = () => reject(new Error('upload aborted'))
    xhr.send(file)
  })
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

function extractHttpUrls(text = '') {
  const urls = new Set()

  const markdownLinkPattern = /\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/gi
  const rawUrlPattern = /https?:\/\/[^\s<>"'`]+/gi

  const normalizeUrl = (candidate) => {
    if (!candidate) return null
    let cleaned = candidate.trim().replace(/[),.;!?]+$/g, '')
    try {
      const parsed = new URL(cleaned)
      if (!/^https?:$/i.test(parsed.protocol)) return null
      return parsed.toString()
    } catch {
      return null
    }
  }

  let match
  while ((match = markdownLinkPattern.exec(text)) !== null) {
    const normalized = normalizeUrl(match[1])
    if (normalized) urls.add(normalized)
  }
  while ((match = rawUrlPattern.exec(text)) !== null) {
    const normalized = normalizeUrl(match[0])
    if (normalized) urls.add(normalized)
  }

  return Array.from(urls)
}

function getFileCategory(type, name) {
  if (type.startsWith('image/')) return 'image'
  if (type === 'application/pdf') return 'pdf'
  if (type === 'text/html' || /\.html?$/i.test(name)) return 'html'
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

function isTxtFile(file = {}) {
  const name = (file.name || '').toLowerCase()
  const type = (file.type || '').toLowerCase()
  return type === 'text/plain' || /\.txt($|\?)/i.test(name)
}

function isImagePreviewTarget(file = {}) {
  const name = (file.name || '').toLowerCase()
  const type = (file.type || '').toLowerCase()
  return (
    type === 'image/jpeg' ||
    type === 'image/png' ||
    type === 'image/gif' ||
    /\.(jpe?g|png|gif)($|\?)/i.test(name)
  )
}

function getPreviewDimensions(
  f,
  imagePreviewOverride,
  moviePreviewOverride,
  htmlPreviewOverride,
  pdfPreviewOverride,
  txtPreviewOverride
) {
  const name = (f.name || '').toLowerCase()
  const type = (f.type || '').toLowerCase()
  const isPdf = type === 'application/pdf' || /\.pdf($|\?)/i.test(name)
  if (isTxtFile(f)) return txtPreviewOverride || config.txtPreview || { width: 270, height: 480 }
  if (isImagePreviewTarget(f)) return imagePreviewOverride || config.imagePreview || { width: 512, height: 512 }
  if (name.endsWith('.pptx') || name.endsWith('.ppt')) return config.pptPreview || config.imagePreview
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) return config.excelPreview || config.imagePreview
  if (name.endsWith('.docx') || name.endsWith('.doc')) return config.wordPreview || config.imagePreview
  if (isPdf) return pdfPreviewOverride || config.pdfPreview || { width: 480, height: 270 }
  if (/\.(avi|mov|mp4)$/i.test(name)) return moviePreviewOverride || config.moviePreview || config.imagePreview
  if (/\.html?$/i.test(name)) return htmlPreviewOverride || config.htmlPreview || { width: 480, height: 270 }
  return config.imagePreview
}

function FileTypeIcon({ category, className = 'w-5 h-5' }) {
  const icons = {
    image: { color: 'text-green-400', path: 'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z' },
    pdf:   { color: 'text-red-400',   path: 'M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z' },
    sheet: { color: 'text-emerald-400', path: 'M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2' },
    doc:   { color: 'text-blue-400',  path: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
    slide: { color: 'text-orange-600', path: 'M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z' },
    text:  { color: 'text-gray-400',  path: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
    code:  { color: 'text-purple-400', path: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4' },
    archive: { color: 'text-yellow-400', path: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4' },
    video: { color: 'text-pink-400',  path: 'M15 10l4.553-2.069A1 1 0 0121 8.868v6.264a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z' },
    audio: { color: 'text-cyan-400',  path: 'M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3' },
    file:  { color: 'text-gray-400',  path: 'M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z' },
  }
  const { color, path } = icons[category] || icons.file
  return (
    <svg className={`${className} ${color} flex-shrink-0`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={path} />
    </svg>
  )
}

// ─── Shared UI ────────────────────────────────────────────────

function Avatar({ letters, imageUrl, size = 'md' }) {
  const cls = size === 'sm' ? 'w-6 h-6 text-xs' : size === 'lg' ? 'w-10 h-10 text-base' : 'w-8 h-8 text-sm'
  return (
    <div className={`${cls} rounded-full bg-indigo-500 overflow-hidden flex items-center justify-center text-white font-bold flex-shrink-0 border border-gray-200 shadow-inner`}>
      {imageUrl ? (
        <img src={imageUrl} alt={letters} className="w-full h-full object-cover" />
      ) : (
        letters
      )}
    </div>
  )
}


function PinIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-amber-600" fill="currentColor" viewBox="0 0 24 24">
      <path d="M16 4a1 1 0 00-1-1H9a1 1 0 00-1 1v6l-2 4h12l-2-4V4zm-4 14a2 2 0 002-2h-4a2 2 0 002 2z" />
    </svg>
  )
}

function TrainingStatusBadge({ status }) {
  if (!status) return null
  const isTraining = status === 'training'
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
      isTraining
        ? 'text-amber-700 border-amber-200 bg-amber-50'
        : 'text-emerald-700 border-emerald-200 bg-emerald-50'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${isTraining ? 'bg-amber-500' : 'bg-emerald-500'}`} />
      {isTraining ? '학습중' : '학습완료'}
    </span>
  )
}

// ─── File Chips (shared between compose & detail) ─────────────

function FileChip({ file, onRemove }) {
  const category = getFileCategory(file.type, file.name)
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-gray-100 border border-gray-200 group max-w-[220px]">
      {category === 'image' && file.url ? (
        <img src={file.url} alt={file.name} className="w-6 h-6 rounded object-cover flex-shrink-0" />
      ) : (
        <FileTypeIcon category={category} className="w-4 h-4" />
      )}
      <div className="flex-1 min-w-0">
        <p className="text-gray-700 text-xs font-medium truncate leading-none">{file.name}</p>
        <p className="text-gray-400 text-xs leading-none mt-0.5">{formatSize(file.size)}</p>
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(file.id)}
          className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-gray-600 transition-all flex-shrink-0 leading-none"
        >
          ×
        </button>
      )}
    </div>
  )
}

// ─── Attachment list in post detail ──────────────────────────

// ─── PDF first-page preview ───────────────────────────────────

function PdfPagePreview({ fileId, width = 400 }) {
  const t = useT()
  const canvasRef = useRef(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!fileId) return
    let cancelled = false
    setLoading(true)
    setError(false)

    ;(async () => {
      try {
        const url = `/api/files/view/${fileId}?auth_token=${getToken()}`
        const resp = await fetch(url)
        if (!resp.ok) throw new Error('fetch failed')
        const arrayBuffer = await resp.arrayBuffer()
        if (cancelled) return

        const pdfjsLib = await import('pdfjs-dist')
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url
        ).href

        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
        if (cancelled) return

        const page = await pdf.getPage(1)
        if (cancelled) return

        const naturalW = page.getViewport({ scale: 1 }).width
        const viewport = page.getViewport({ scale: width / naturalW })

        const canvas = canvasRef.current
        if (!canvas) return
        canvas.width = viewport.width
        canvas.height = viewport.height
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise

        if (!cancelled) setLoading(false)
      } catch {
        if (!cancelled) { setLoading(false); setError(true) }
      }
    })()

    return () => { cancelled = true }
  }, [fileId, width])

  if (error) {
    return (
      <div className="flex items-center justify-center h-24 bg-gray-100 rounded-xl text-gray-400 text-sm">
        {t.chat.pdfPreviewFailed}
      </div>
    )
  }
  return (
    <div className="relative">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100 rounded-xl">
          <div className="w-5 h-5 border-2 border-gray-300 border-t-red-400 rounded-full animate-spin" />
        </div>
      )}
      <canvas
        ref={canvasRef}
        className={`rounded-xl w-full ${loading ? 'opacity-0' : 'opacity-100'} transition-opacity`}
      />
    </div>
  )
}

function TextPlainPreview({ src, width, height }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [content, setContent] = useState('')

  useEffect(() => {
    if (!src) return
    let cancelled = false
    setLoading(true)
    setError(false)
    setContent('')

    ;(async () => {
      try {
        const resp = await fetch(src)
        if (!resp.ok) throw new Error('fetch failed')
        const text = await resp.text()
        if (cancelled) return
        setContent(text || '')
        setLoading(false)
      } catch {
        if (cancelled) return
        setError(true)
        setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [src])

  if (error) {
    return (
      <div
        className="bg-gray-50 border-b border-gray-200 flex items-center justify-center text-gray-400 text-xs"
        style={{ width, height }}
      >
        TXT 미리보기 불가
      </div>
    )
  }

  return (
    <div
      className="bg-gray-50 border-b border-gray-200 overflow-auto"
      style={{ width, height }}
    >
      {loading ? (
        <div className="w-full h-full flex items-center justify-center">
          <div className="w-5 h-5 border-2 border-gray-300 border-t-indigo-500 rounded-full animate-spin" />
        </div>
      ) : (
        <pre className="text-[11px] leading-5 text-gray-700 p-3 whitespace-pre-wrap break-words font-mono min-h-full">
          {content}
        </pre>
      )}
    </div>
  )
}

// ─── Image lightbox ───────────────────────────────────────────

function ImageLightbox({ file, fileUrl, onClose }) {
  const t = useT()
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center" onClick={e => e.stopPropagation()}>
        <img
          src={fileUrl}
          alt={file.name}
          className="max-w-[90vw] max-h-[80vh] rounded-2xl object-contain shadow-2xl"
        />
        <div className="mt-3 flex items-center gap-3">
          <span className="text-gray-500 text-xs">{file.name}</span>
          <a
            href={fileUrl}
            download={file.name}
            className="px-3 py-1.5 rounded-lg bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-600 text-xs font-semibold border border-indigo-200 transition-colors"
            onClick={e => e.stopPropagation()}
          >
            {t.chat.download}
          </a>
        </div>
      </div>
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-9 h-9 rounded-full bg-gray-200 hover:bg-gray-300 flex items-center justify-center text-gray-900 transition-colors"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

// ─── Video player modal ───────────────────────────────────────

const BROWSER_VIDEO_EXTS = /\.(mp4|webm|ogg|ogv|m4v)$/i

function VideoPlayer({ file, fileUrl, onClose }) {
  const t = useT()
  const isBrowserPlayable = BROWSER_VIDEO_EXTS.test(file.name || '')

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex flex-col items-center gap-3"
        style={{ maxWidth: '90vw', maxHeight: '90vh' }}
        onClick={e => e.stopPropagation()}
      >
        {isBrowserPlayable ? (
          <video
            src={fileUrl}
            controls
            autoPlay
            className="rounded-2xl shadow-2xl bg-black"
            style={{ maxWidth: '88vw', maxHeight: '78vh' }}
          />
        ) : (
          <div className="flex flex-col items-center gap-4 px-10 py-8 bg-gray-100 rounded-2xl border border-gray-200">
            <svg className="w-14 h-14 text-pink-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.069A1 1 0 0121 8.868v6.264a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <p className="text-gray-600 text-sm text-center">
              {t.chat.videoUnsupported(file.name?.split('.').pop()?.toUpperCase() || '')}
            </p>
            <a
              href={fileUrl}
              download={file.name}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-colors"
              onClick={e => e.stopPropagation()}
            >
              {t.chat.fileDownload}
            </a>
          </div>
        )}
        <div className="flex items-center gap-3">
          <span className="text-gray-500 text-xs truncate max-w-xs">{file.name}</span>
          <a
            href={fileUrl}
            download={file.name}
            className="px-3 py-1.5 rounded-lg bg-gray-200 hover:bg-gray-300 text-gray-600 text-xs font-medium transition-colors flex-shrink-0"
            onClick={e => e.stopPropagation()}
          >
            {t.chat.download}
          </a>
        </div>
      </div>
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-9 h-9 rounded-full bg-gray-200 hover:bg-gray-300 flex items-center justify-center text-gray-900 transition-colors"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

function PdfModalViewer({ fileId, sourceUrl, onClose }) {
  const canvasRef = useRef(null)
  const [pdfDoc, setPdfDoc] = useState(null)
  const [totalPages, setTotalPages] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [renderWidth, setRenderWidth] = useState(() => Math.min(Math.max(window.innerWidth - 120, 360), 1100))

  useEffect(() => {
    const onResize = () => setRenderWidth(Math.min(Math.max(window.innerWidth - 120, 360), 1100))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose?.()
        return
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        setPage(p => Math.min(totalPages || 1, p + 1))
        return
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        setPage(p => Math.max(1, p - 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [totalPages, onClose])

  useEffect(() => {
    if (!fileId && !sourceUrl) return
    let cancelled = false
    setLoading(true)
    setError(false)

    ;(async () => {
      try {
        const url = sourceUrl || `/api/files/view/${fileId}?auth_token=${getToken()}`
        const resp = await fetch(url)
        if (!resp.ok) throw new Error('fetch failed')
        const arrayBuffer = await resp.arrayBuffer()
        if (cancelled) return

        const pdfjsLib = await import('pdfjs-dist')
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url
        ).href

        const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
        if (cancelled) return
        setPdfDoc(doc)
        setTotalPages(doc.numPages || 0)
        setPage(1)
      } catch {
        if (!cancelled) {
          setError(true)
          setLoading(false)
        }
      }
    })()

    return () => { cancelled = true }
  }, [fileId, sourceUrl])

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return
    let cancelled = false
    setLoading(true)
    setError(false)

    ;(async () => {
      try {
        const p = await pdfDoc.getPage(page)
        if (cancelled) return
        const naturalW = p.getViewport({ scale: 1 }).width
        const viewport = p.getViewport({ scale: renderWidth / naturalW })

        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        canvas.width = viewport.width
        canvas.height = viewport.height
        await p.render({ canvasContext: ctx, viewport }).promise
        if (!cancelled) setLoading(false)
      } catch {
        if (!cancelled) {
          setError(true)
          setLoading(false)
        }
      }
    })()

    return () => { cancelled = true }
  }, [pdfDoc, page, renderWidth])

  if (error) {
    return <div className="h-full flex items-center justify-center text-gray-500">PDF 미리보기를 불러오지 못했습니다.</div>
  }

  return (
    <div className="h-full flex flex-col">
      <div className="h-11 border-b border-gray-200 bg-gray-50 flex items-center justify-center gap-3 text-sm text-gray-700">
        <button
          type="button"
          onClick={() => setPage(p => Math.max(1, p - 1))}
          disabled={page <= 1 || loading}
          className="px-3 py-1.5 rounded-lg border border-gray-300 disabled:opacity-40"
        >
          이전
        </button>
        <span>{totalPages > 0 ? `${page} / ${totalPages}` : '-'}</span>
        <button
          type="button"
          onClick={() => setPage(p => Math.min(totalPages || 1, p + 1))}
          disabled={page >= totalPages || loading}
          className="px-3 py-1.5 rounded-lg border border-gray-300 disabled:opacity-40"
        >
          다음
        </button>
      </div>
      <div className="flex-1 overflow-auto bg-gray-100 p-4">
        <div className="mx-auto relative" style={{ width: renderWidth, maxWidth: '100%' }}>
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/80 rounded">
              <div className="w-6 h-6 border-2 border-gray-300 border-t-red-400 rounded-full animate-spin" />
            </div>
          )}
          <canvas ref={canvasRef} className="w-full rounded border border-gray-200 bg-white shadow-sm" />
        </div>
      </div>
    </div>
  )
}

function FilePreviewModal({ file, fileUrl, onClose }) {
  const [failed, setFailed] = useState(false)
  const category = getFileCategory(file?.type || '', file?.name || '')
  const isSlide = category === 'slide'
  const isPdf = (file?.type || '').toLowerCase() === 'application/pdf' || /\.pdf($|\?)/i.test((file?.name || '').toLowerCase())
  const isTxt = isTxtFile(file || {})
  const [txtLoading, setTxtLoading] = useState(false)
  const [txtError, setTxtError] = useState(false)
  const [txtContent, setTxtContent] = useState('')
  const slidePreviewPdfUrl = file?.id ? `/api/files/view/${file.id}?preview=pdf&auth_token=${getToken()}` : null
  const openInNewUrl = isSlide ? (slidePreviewPdfUrl || fileUrl) : fileUrl

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!isTxt || !fileUrl) return
    let cancelled = false
    setTxtLoading(true)
    setTxtError(false)
    setTxtContent('')

    ;(async () => {
      try {
        const resp = await fetch(fileUrl)
        if (!resp.ok) throw new Error('fetch failed')
        const text = await resp.text()
        if (cancelled) return
        setTxtContent(text || '')
        setTxtLoading(false)
      } catch {
        if (cancelled) return
        setTxtError(true)
        setTxtLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [isTxt, fileUrl])

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 backdrop-blur-sm px-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-6xl h-[85vh] rounded-2xl overflow-hidden border border-gray-200 bg-white shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="h-11 px-4 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
          <p className="text-sm text-gray-700 truncate pr-4">{file?.name || ''}</p>
          <div className="flex items-center gap-2">
            <a
              href={openInNewUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
            >
              새 창에서 열기
            </a>
            <button
              type="button"
              onClick={onClose}
              className="w-8 h-8 rounded-lg bg-gray-200 hover:bg-gray-300 text-gray-700 flex items-center justify-center transition-colors"
              aria-label="미리보기 닫기"
              title="닫기"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        {isPdf ? (
          <PdfModalViewer fileId={file?.id} onClose={onClose} />
        ) : isTxt ? (
          <div className="h-[calc(85vh-44px)] overflow-auto bg-gray-50">
            {txtLoading ? (
              <div className="w-full h-full flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-gray-300 border-t-indigo-500 rounded-full animate-spin" />
              </div>
            ) : txtError ? (
              <div className="w-full h-full flex items-center justify-center text-gray-500 text-sm">
                TXT 미리보기를 불러올 수 없습니다.
              </div>
            ) : (
              <pre className="p-4 text-sm leading-6 text-gray-700 whitespace-pre-wrap break-words font-mono">
                {txtContent}
              </pre>
            )}
          </div>
        ) : isSlide ? (
          <PdfModalViewer sourceUrl={slidePreviewPdfUrl} onClose={onClose} />
        ) : !failed ? (
          <iframe
            src={fileUrl}
            title={`file-preview-${file?.id || file?.name || 'file'}`}
            className="w-full h-[calc(85vh-44px)]"
            style={{ border: 'none', background: '#fff' }}
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="h-[calc(85vh-44px)] flex items-center justify-center text-gray-500 text-sm">
            미리보기를 불러올 수 없습니다.
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Attachment list in post detail ──────────────────────────

function AttachmentList({ attachments, compact = false }) {
  const t = useT()
  const [imagePreviewSize, setImagePreviewSize] = useState(config.imagePreview || { width: 512, height: 512 })
  const [moviePreviewSize, setMoviePreviewSize] = useState(config.moviePreview || { width: 480, height: 270 })
  const [htmlPreviewSize, setHtmlPreviewSize] = useState(config.htmlPreview || { width: 480, height: 270 })
  const [pdfPreviewSize, setPdfPreviewSize] = useState(config.pdfPreview || { width: 480, height: 270 })
  const [txtPreviewSize, setTxtPreviewSize] = useState(config.txtPreview || { width: 270, height: 480 })
  const [lightboxFile, setLightboxFile] = useState(null)
  const [videoFile, setVideoFile] = useState(null)
  const [previewFile, setPreviewFile] = useState(null)

  useEffect(() => {
    apiFetch('/config/display')
      .then(data => {
        if (data.imagePreview) setImagePreviewSize(data.imagePreview)
        if (data.moviePreview) setMoviePreviewSize(data.moviePreview)
        if (data.htmlPreview) setHtmlPreviewSize(data.htmlPreview)
        if (data.pdfPreview) setPdfPreviewSize(data.pdfPreview)
        if (data.txtPreview) setTxtPreviewSize(data.txtPreview)
      })
      .catch(() => {})
  }, [])

  if (!attachments || attachments.length === 0) return null

  function fileUrl(f) {
    if (!f.url) return null
    if (f.url.startsWith('blob:')) return f.url
    const token = getToken()
    return token ? `${f.url}?auth_token=${token}` : f.url
  }

  function thumbUrl(f) {
    if (!f.thumbnail_url) return null
    const token = getToken()
    return `${f.thumbnail_url}&auth_token=${token}`
  }

  // 이미지 클릭 → 라이트박스
  function handleImageClick(e, f) {
    e.preventDefault()
    setLightboxFile(f)
  }

  // 동영상 클릭 → 비디오 플레이어 모달
  function handleVideoClick(e, f) {
    e.preventDefault()
    setVideoFile(f)
  }

  // 일반 파일 클릭 → 미리보기 모달
  function handleFileClick(e, f) {
    e.preventDefault()
    setPreviewFile(f)
  }

  // 네이티브 앱으로 열기 (별도 버튼)
  async function openNative(e, f) {
    e.preventDefault()
    e.stopPropagation()
    if (!f.id || f.url?.startsWith('blob:')) { window.open(fileUrl(f), '_blank'); return }
    try {
      await apiFetch(`/files/${f.id}/open`, { method: 'POST' })
    } catch {
      window.open(fileUrl(f), '_blank')
    }
  }

  function triggerBrowserDownload(url, filename) {
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    if (filename) a.download = filename
    a.rel = 'noreferrer'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  async function downloadFile(e, f) {
    e.preventDefault()
    e.stopPropagation()
    if (!f?.id || f.url?.startsWith('blob:')) {
      triggerBrowserDownload(fileUrl(f), f?.name)
      return
    }
    try {
      const data = await apiFetch(`/files/${f.id}/get-download-url`)
      if (data?.downloadUrl) {
        triggerBrowserDownload(data.downloadUrl, f?.name)
        return
      }
    } catch {}
    triggerBrowserDownload(fileUrl(f), f?.name)
  }

  const NativeOpenBtn = ({ f }) => (
    <button
      title={t.chat.openInApp}
      onClick={e => openNative(e, f)}
      className="flex-shrink-0 p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-200 transition-colors"
    >
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
      </svg>
    </button>
  )

  const DownloadBtn = ({ f }) => (
    <button
      title={t.chat.download}
      onClick={e => downloadFile(e, f)}
      className="flex-shrink-0 p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-200 transition-colors"
    >
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v10m0 0l-4-4m4 4l4-4M4 20h16" />
      </svg>
    </button>
  )

  return (
    <>
      {lightboxFile && (
        <ImageLightbox
          file={lightboxFile}
          fileUrl={fileUrl(lightboxFile)}
          onClose={() => setLightboxFile(null)}
        />
      )}
      {videoFile && (
        <VideoPlayer
          file={videoFile}
          fileUrl={fileUrl(videoFile)}
          onClose={() => setVideoFile(null)}
        />
      )}
      {previewFile && fileUrl(previewFile) && (
        <FilePreviewModal
          file={previewFile}
          fileUrl={fileUrl(previewFile)}
          onClose={() => setPreviewFile(null)}
        />
      )}

      <div className="mt-6 border-t border-gray-200 pt-5">
        <h4 className="text-gray-500 text-xs font-semibold uppercase tracking-widest mb-3 flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
          {t.chat.attachmentsCount(attachments.length)}
        </h4>

        <div className="flex flex-wrap gap-3">
          {attachments.map(f => {
            const category = getFileCategory(f.type || '', f.name || '')
            const dims = getPreviewDimensions(
              f,
              imagePreviewSize,
              moviePreviewSize,
              htmlPreviewSize,
              pdfPreviewSize,
              txtPreviewSize
            )
            const previewW = Number(dims?.width) || 480
            const previewH = Number(dims?.height) || 270
            const isPdf = category === 'pdf'
            const isTxt = isTxtFile(f)
            const isSlide = category === 'slide'
            const shouldClampCompact = compact && !isPdf && !isTxt && !isSlide
            const MAX_W = shouldClampCompact ? 180 : Infinity
            const MAX_THUMB_H = shouldClampCompact ? 140 : Infinity
            const w = Math.min(previewW, MAX_W)
            const h = Math.min(previewH, MAX_THUMB_H)

            // ── Video → 비디오 플레이어 모달 ──────────────────
            if (category === 'video') {
              const tUrl = thumbUrl(f)
              return (
                <div key={f.id}
                  className="rounded-2xl overflow-hidden border border-gray-200 hover:border-pink-500/50 transition-colors group cursor-pointer flex-shrink-0 relative"
                  style={{ width: w, maxWidth: '100%' }}
                  onClick={e => handleVideoClick(e, f)}
                >
                  {tUrl ? (
                    <img src={tUrl} alt={f.name}
                      className="block group-hover:opacity-75 transition-opacity bg-black"
                      style={{ width: w, height: h, maxWidth: '100%', objectFit: 'cover' }}
                      onError={e => { e.target.style.display = 'none' }}
                    />
                  ) : (
                    <div className="bg-black flex items-center justify-center" style={{ width: w, height: h }}>
                      <FileTypeIcon category="video" className="w-10 h-10 opacity-40" />
                    </div>
                  )}
                  {/* 재생 버튼 오버레이 */}
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ bottom: 36 }}>
                    <div className="w-12 h-12 rounded-full bg-black/50 border-2 border-white/60 flex items-center justify-center group-hover:bg-black/70 group-hover:scale-110 transition-all">
                      <svg className="w-5 h-5 text-gray-900 ml-1" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </div>
                  </div>
                  <div className="px-3 py-2 flex items-center justify-between bg-black/60">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <FileTypeIcon category="video" className="w-3.5 h-3.5 flex-shrink-0" />
                      <span className="text-gray-600 text-xs font-medium truncate">{f.name}</span>
                    </div>
                    <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                      <span className="text-gray-400 text-xs">{formatSize(f.size)}</span>
                      <NativeOpenBtn f={f} />
                      <DownloadBtn f={f} />
                    </div>
                  </div>
                </div>
              )
            }

            // ── Image → 라이트박스 ─────────────────────────────
            if (category === 'image') {
              return (
                <div key={f.id}
                  className="rounded-2xl overflow-hidden border border-gray-200 hover:border-indigo-500/50 transition-colors group cursor-pointer flex-shrink-0"
                  style={{ width: w, maxWidth: '100%' }}
                  onClick={e => handleImageClick(e, f)}
                >
                  <img src={fileUrl(f)} alt={f.name}
                    className="block group-hover:opacity-90 transition-opacity"
                    style={{ width: w, height: h, maxWidth: '100%', objectFit: 'cover' }}
                  />
                  <div className="px-3 py-2 flex items-center justify-between bg-gray-50">
                    <span className="text-gray-500 text-xs font-medium truncate">{f.name}</span>
                    <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                      <span className="text-gray-400 text-xs">{formatSize(f.size)}</span>
                      <NativeOpenBtn f={f} />
                      <DownloadBtn f={f} />
                    </div>
                  </div>
                </div>
              )
            }

            // ── PDF → 브라우저 새 탭 ───────────────────────────
            if (category === 'pdf') {
              const tUrl = thumbUrl(f)
              if (tUrl) {
                return (
                  <div key={f.id}
                    className="rounded-2xl overflow-hidden border border-gray-200 hover:border-indigo-500/50 transition-colors group cursor-pointer flex-shrink-0"
                    style={{ width: w, maxWidth: '100%' }}
                    onClick={e => handleFileClick(e, f)}
                  >
                    <img src={tUrl} alt={f.name}
                      className="block group-hover:opacity-90 transition-opacity bg-white"
                      style={{ width: w, height: h, maxWidth: '100%', objectFit: 'contain' }}
                      onError={e => { e.target.style.display = 'none' }}
                    />
                    <div className="px-3 py-2 flex items-center justify-between bg-gray-50">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileTypeIcon category="pdf" className="w-4 h-4 flex-shrink-0" />
                        <span className="text-gray-500 text-xs truncate">{f.name}</span>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <span className="text-gray-400 text-xs">{formatSize(f.size)}</span>
                        <NativeOpenBtn f={f} />
                        <DownloadBtn f={f} />
                      </div>
                    </div>
                  </div>
                )
              }
              return (
                <div key={f.id}
                  className="rounded-2xl overflow-hidden border border-gray-200 cursor-pointer hover:border-indigo-500/50 transition-colors flex-shrink-0"
                  style={{ maxWidth: w }}
                  onClick={e => handleFileClick(e, f)}
                >
                  <PdfPagePreview fileId={f.id} width={w} />
                  <div className="px-3 py-2 flex items-center justify-between bg-gray-50">
                    <div className="flex items-center gap-2 min-w-0">
                      <FileTypeIcon category="pdf" className="w-4 h-4 flex-shrink-0" />
                      <span className="text-gray-500 text-xs truncate">{f.name}</span>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <span className="text-gray-400 text-xs">{formatSize(f.size)}</span>
                      <NativeOpenBtn f={f} />
                      <DownloadBtn f={f} />
                    </div>
                  </div>
                </div>
              )
            }

            // ── HTML → iframe 인라인 미리보기 ────────────────────
            if (category === 'html') {
              return (
                <div key={f.id}
                  className="rounded-2xl overflow-hidden border border-gray-200 hover:border-amber-500/50 transition-colors group cursor-pointer flex-shrink-0"
                  style={{ width: w, maxWidth: '100%' }}
                  onClick={e => handleFileClick(e, f)}
                >
                  <div style={{ width: w, height: h, position: 'relative', overflow: 'hidden' }}>
                    <iframe
                      src={fileUrl(f)}
                      sandbox="allow-same-origin"
                      title={f.name}
                      style={{
                        width: dims.width,
                        height: dims.height,
                        border: 'none',
                        transformOrigin: '0 0',
                        transform: `scale(${w / dims.width})`,
                        pointerEvents: 'none',
                        background: '#fff',
                      }}
                    />
                  </div>
                  <div className="px-3 py-2 flex items-center justify-between bg-gray-50">
                    <div className="flex items-center gap-2 min-w-0">
                      <svg className="w-4 h-4 text-amber-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                      </svg>
                      <span className="text-gray-500 text-xs font-medium truncate">{f.name}</span>
                    </div>
                    <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                      <span className="text-gray-400 text-xs">{formatSize(f.size)}</span>
                      <NativeOpenBtn f={f} />
                      <DownloadBtn f={f} />
                    </div>
                  </div>
                </div>
              )
            }

            if (isTxtFile(f)) {
              return (
                <div key={f.id}
                  className="rounded-2xl overflow-hidden border border-gray-200 hover:border-gray-300 transition-colors group cursor-pointer flex-shrink-0"
                  style={{ width: w, maxWidth: '100%' }}
                  onClick={e => handleFileClick(e, f)}
                >
                  <TextPlainPreview src={fileUrl(f)} width={w} height={h} />
                  <div className="px-3 py-2 flex items-center justify-between bg-gray-50">
                    <div className="flex items-center gap-2 min-w-0">
                      <FileTypeIcon category="text" className="w-4 h-4 flex-shrink-0" />
                      <span className="text-gray-500 text-xs font-medium truncate">{f.name}</span>
                    </div>
                    <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                      <span className="text-gray-400 text-xs">{formatSize(f.size)}</span>
                      <NativeOpenBtn f={f} />
                      <DownloadBtn f={f} />
                    </div>
                  </div>
                </div>
              )
            }

            // ── 썸네일 있는 파일 → 브라우저 새 탭 ───────────────
            const tUrl = thumbUrl(f)
            if (tUrl) {
              return (
                <div key={f.id}
                  className="rounded-2xl overflow-hidden border border-gray-200 hover:border-indigo-500/50 transition-colors group cursor-pointer flex-shrink-0"
                  style={{ width: w, maxWidth: '100%' }}
                  onClick={e => handleFileClick(e, f)}
                >
                  <img src={tUrl} alt={f.name}
                    className="block group-hover:opacity-90 transition-opacity bg-gray-100"
                    style={{ width: w, height: h, maxWidth: '100%', objectFit: 'cover' }}
                    onError={e => { e.target.style.display = 'none' }}
                  />
                  <div className="px-3 py-2 flex items-center justify-between bg-gray-50">
                    <div className="flex items-center gap-2 min-w-0">
                      <FileTypeIcon category={category} className="w-4 h-4 flex-shrink-0" />
                      <span className="text-gray-500 text-xs font-medium truncate">{f.name}</span>
                    </div>
                    <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                      <span className="text-gray-400 text-xs">{formatSize(f.size)}</span>
                      <NativeOpenBtn f={f} />
                      <DownloadBtn f={f} />
                    </div>
                  </div>
                </div>
              )
            }

            // ── 썸네일 없는 파일 → 브라우저 새 탭 ───────────────
            return (
              <div key={f.id} className="flex items-center gap-3 px-3.5 py-3 rounded-xl bg-gray-50 border border-gray-200 cursor-pointer hover:border-gray-300 transition-colors"
                onClick={e => handleFileClick(e, f)}
              >
                <FileTypeIcon category={category} className="w-5 h-5" />
                <div className="flex-1 min-w-0">
                  <p className="text-gray-700 text-sm font-medium truncate">{f.name}</p>
                  <p className="text-gray-400 text-xs">{formatSize(f.size)}</p>
                </div>
                <NativeOpenBtn f={f} />
                <DownloadBtn f={f} />
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

// ─── Template renderer (HTML iframe) ──────────────────────────
// 문서번호 캐시: postId별로 한 번만 발급 (컴포넌트 재마운트 시에도 재사용)
const _expenseDocNoCache = {}
const _tripDocNoCache = {}

function TemplateRenderer({ html, postId, onContentChange, onSave }) {
  const iframeRef = useRef(null)
  const { currentUser } = useAuth()
  const userName = currentUser?.name || '사용자'
  const userEmail = currentUser?.email || 'user@example.com'
  const sealUrl = `${window.location.origin}/company/seal.png`
  const logoUrl = `${window.location.origin}/company/logo.png`
  const [savedAttachments, setSavedAttachments] = useState([])
  const [savedFormData, setSavedFormData] = useState(null)
  const [reservedDocNo, setReservedDocNo] = useState(() => _expenseDocNoCache[postId] || null)
  const [reservedTripDocNo, setReservedTripDocNo] = useState(() => _tripDocNoCache[postId] || null)
  const isTripTemplate = html.includes('<title>출장보고서')

  useEffect(() => {
    if (!postId) return
    apiFetch(`/expense/load?postId=${encodeURIComponent(postId)}`)
      .then(data => {
        setSavedAttachments(data.attachments || [])
        setSavedFormData(data.formData || null)
        const existingDocNo = data.formData?.docNo
        if (existingDocNo) {
          _expenseDocNoCache[postId] = existingDocNo
          setReservedDocNo(existingDocNo)
        } else if (!_expenseDocNoCache[postId]) {
          // 신규 게시글 — 서버에서 문서번호 발급
          apiFetch('/expense/next-doc-no')
            .then(r => {
              _expenseDocNoCache[postId] = r.docNo
              setReservedDocNo(r.docNo)
            })
            .catch(() => {})
        }
      })
      .catch(() => { setSavedAttachments([]); setSavedFormData(null) })
  }, [postId])

  useEffect(() => {
    if (!postId || !isTripTemplate) return
    if (_tripDocNoCache[postId]) {
      setReservedTripDocNo(_tripDocNoCache[postId])
      return
    }
    apiFetch('/trip/next-doc-no')
      .then(r => {
        _tripDocNoCache[postId] = r.docNo
        setReservedTripDocNo(r.docNo)
      })
      .catch(() => {})
  }, [postId, isTripTemplate])

  const safePostId = (postId || '').replace(/'/g, "\\'")
  const safeDocNo  = (reservedDocNo || '').replace(/'/g, "\\'")
  const safeTripDocNo = (reservedTripDocNo || '').replace(/'/g, "\\'")
  const attachJson  = JSON.stringify(savedAttachments)
  const formJson    = JSON.stringify(savedFormData)
  const resolvedHtml = html
    .replace(/\{\{USER_NAME\}\}/g, userName)
    .replace(/\{\{USER_EMAIL\}\}/g, userEmail)
    .replace(/\{\{SEAL_URL\}\}/g, sealUrl)
    .replace(/\{\{LOGO_URL\}\}/g, logoUrl)
    .replace('</head>', `<script>var POST_ID='${safePostId}';var EXPENSE_DOC_NO='${safeDocNo}';var TRIP_DOC_NO='${safeTripDocNo}';var SAVED_ATTACHMENTS=${attachJson};var SAVED_FORM_DATA=${formJson};</script></head>`)

  useEffect(() => {
    function handleMessage(e) {
      if (e.data?.type === 'templateFieldChanged' && onContentChange) {
        onContentChange(e.data.field, e.data.value)
      }
      if (e.data?.type === 'expenseSave' && onSave) {
        onSave(e.data.data)
          .then(() => {
            iframeRef.current?.contentWindow?.postMessage(
              { type: 'expenseSaveResult', success: true }, '*'
            )
          })
          .catch((err) => {
            iframeRef.current?.contentWindow?.postMessage(
              { type: 'expenseSaveResult', success: false, error: err.message }, '*'
            )
          })
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [onContentChange, onSave])

  function handleLoad() {
    try {
      const doc = iframeRef.current?.contentDocument
      const win = iframeRef.current?.contentWindow
      if (doc) {
        // 템플릿 내부 .editable 클릭 핸들러가 부분 드래그 선택을 깨뜨리는 문제 방지
        if (!doc.querySelector('style[data-selection-guard="true"]')) {
          const selectionStyle = doc.createElement('style')
          selectionStyle.setAttribute('data-selection-guard', 'true')
          selectionStyle.textContent = `
            .editable { -webkit-user-select: text !important; user-select: text !important; }
          `
          doc.head?.appendChild(selectionStyle)
        }
        if (!doc.__selectionClickGuardBound) {
          doc.__selectionClickGuardBound = true
          doc.addEventListener('click', (e) => {
            const target = e.target
            if (!target || !target.closest) return
            if (!target.closest('.editable')) return
            const selected = win?.getSelection?.()?.toString?.().trim?.() || ''
            if (selected.length > 0) {
              e.stopImmediatePropagation()
            }
          }, true)
        }

        // 기존 저장 문서(구버전 템플릿)도 동일한 인쇄 동작을 사용하도록 강제
        if (win) {
          if (!doc.querySelector('style[data-print-guard="true"]')) {
            const guardStyle = doc.createElement('style')
            guardStyle.setAttribute('data-print-guard', 'true')
            guardStyle.textContent = `
              @media print {
                .no-print, .ocr-bar, button, .btn, .actions, .template-actions {
                  display: none !important;
                }
              }
            `
            doc.head?.appendChild(guardStyle)
          }

          win.printExpense = function printExpenseSafe() {
            const styleText = Array.from(doc.querySelectorAll('style'))
              .map(node => node.textContent || '')
              .join('\n')

            const root =
              doc.querySelector('.wrap') ||
              doc.querySelector('#paper') ||
              doc.body

            const rootClone = root?.cloneNode(true)
            if (rootClone) {
              rootClone.querySelectorAll('.no-print, .ocr-bar, button, .btn, .actions, .template-actions')
                .forEach(el => el.remove())
            }

            const attachments = doc.querySelector('#attachment-pages')?.cloneNode(true)
            if (attachments) {
              attachments.querySelectorAll('.no-print, .ocr-bar, button, .btn, .actions, .template-actions')
                .forEach(el => el.remove())
            }

            const printableHtml = `
              <!doctype html>
              <html>
                <head>
                  <meta charset="utf-8" />
                  <title>Print</title>
                  <style>
                    ${styleText}
                    @media print {
                      .no-print, .ocr-bar, button, .btn, .actions, .template-actions {
                        display: none !important;
                      }
                    }
                  </style>
                </head>
                <body>
                  ${rootClone?.outerHTML || ''}
                  ${attachments?.outerHTML || ''}
                </body>
              </html>
            `

            const printWin = win.open('', '_blank', 'noopener,noreferrer,width=1100,height=900')
            if (!printWin) {
              win.print()
              return
            }

            printWin.document.open()
            printWin.document.write(printableHtml)
            printWin.document.close()

            const runPrint = () => {
              try {
                printWin.focus()
                printWin.print()
              } catch (_) {}
            }

            if (printWin.document.readyState === 'complete') {
              setTimeout(runPrint, 120)
            } else {
              printWin.onload = () => setTimeout(runPrint, 120)
            }
          }

          const printTriggers = Array.from(doc.querySelectorAll('button, a')).filter(node => {
            const text = (node.textContent || '').trim()
            const id = node.id || ''
            const onclick = node.getAttribute('onclick') || ''
            return (
              /print/i.test(id) ||
              /print/i.test(onclick) ||
              /인쇄/.test(text) ||
              /PDF/.test(text)
            )
          })

          printTriggers.forEach(node => {
            if (node.dataset.printBound === 'true') return
            node.dataset.printBound = 'true'
            node.removeAttribute('onclick')
            node.addEventListener('click', (e) => {
              e.preventDefault()
              e.stopPropagation()
              win.printExpense()
            })
          })
        }

        const h = doc.documentElement.scrollHeight
        iframeRef.current.style.height = h + 'px'
      }
    } catch (_) {}
  }

  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden bg-white">
      <div className="flex items-center gap-2 px-4 py-2 bg-gray-50 border-b border-gray-200 text-xs text-gray-500">
        <svg className="w-3.5 h-3.5 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <span>양식 템플릿</span>
      </div>
      <iframe
        ref={iframeRef}
        srcDoc={resolvedHtml}
        sandbox="allow-scripts allow-same-origin allow-modals"
        className="w-full border-0"
        style={{ minHeight: 400 }}
        onLoad={handleLoad}
        title="form-template"
      />
    </div>
  )
}

// ─── Content renderer ─────────────────────────────────────────

function LinkPreviewCards({ links = [] }) {
  const [htmlPreviewSize, setHtmlPreviewSize] = useState(config.htmlPreview || { width: 480, height: 270 })
  const safeLinks = links.filter(Boolean).slice(0, 1)

  useEffect(() => {
    if (safeLinks.length === 0) return
    apiFetch('/config/display')
      .then(data => {
        if (data?.htmlPreview?.width && data?.htmlPreview?.height) {
          setHtmlPreviewSize(data.htmlPreview)
        }
      })
      .catch(() => {})
  }, [safeLinks.length])

  if (safeLinks.length === 0) return null

  const width = Number(htmlPreviewSize.width) || 480
  const height = Number(htmlPreviewSize.height) || 270
  const baseViewportWidth = 1366
  const baseViewportHeight = 768
  const previewScale = Math.min(width / baseViewportWidth, height / baseViewportHeight)

  return (
    <div className="mt-3 space-y-3">
      {safeLinks.map((url) => (
        <a
          key={url}
          href={url}
          target="_blank"
          rel="noreferrer"
          className="block rounded-xl border border-gray-200 overflow-hidden hover:border-indigo-300 transition-colors bg-white"
          style={{ width: '100%', maxWidth: width }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 text-xs text-indigo-600 truncate">
            {url}
          </div>
          <div
            style={{
              width: '100%',
              height,
              position: 'relative',
              overflow: 'hidden',
              background: '#fff',
            }}
          >
            <iframe
              src={url}
              title={`link-preview-${url}`}
              loading="lazy"
              sandbox="allow-same-origin"
              style={{
                width: baseViewportWidth,
                height: baseViewportHeight,
                border: 'none',
                position: 'absolute',
                left: '50%',
                top: '50%',
                transformOrigin: 'center center',
                transform: `translate(-50%, -50%) scale(${previewScale})`,
                pointerEvents: 'none',
                background: '#fff',
              }}
            />
          </div>
        </a>
      ))}
    </div>
  )
}

function ContentRenderer({ text = '' }) {
  const normalized = normalizeMarkdownCodeFence(text || '')
  const links = extractHttpUrls(text || '')
  return (
    <div
      className="text-gray-700 text-sm leading-relaxed break-words select-text allow-copy cursor-text"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-1.5 text-gray-700 text-sm leading-relaxed">{children}</p>,
          h1: ({ children }) => <h1 className="mt-4 mb-2 text-gray-900 font-bold text-lg">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-4 mb-2 text-gray-900 font-bold text-base">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-3 mb-1.5 text-gray-900 font-semibold text-sm">{children}</h3>,
          ul: ({ children }) => <ul className="list-disc pl-5 my-1.5 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 my-1.5 space-y-1">{children}</ol>,
          li: ({ children }) => <li className="text-gray-700 text-sm">{children}</li>,
          hr: () => <hr className="border-gray-200 my-3" />,
          table: ({ children }) => (
            <div className="overflow-x-auto my-2">
              <table className="min-w-full border border-gray-200 rounded-lg overflow-hidden text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-gray-100 text-gray-900">{children}</thead>,
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => <tr className="border-b border-gray-200">{children}</tr>,
          th: ({ children }) => <th className="px-3 py-2 text-left font-semibold">{children}</th>,
          td: ({ children }) => <td className="px-3 py-2 text-gray-700">{children}</td>,
          code: ({ inline, children }) => inline
            ? <code className="bg-gray-200 text-indigo-600 px-1 rounded text-xs font-mono">{children}</code>
            : (
              <pre className="bg-gray-900 text-gray-100 rounded-xl p-3 my-2 overflow-x-auto border border-gray-700">
                <code className="font-mono text-xs leading-relaxed">{children}</code>
              </pre>
            ),
        }}
      >
        {normalized}
      </ReactMarkdown>
      <LinkPreviewCards links={links} />
    </div>
  )
}

function normalizeMarkdownCodeFence(text) {
  // Support triple single-quote fence as requested:
  // '''js ... '''  -> ```js ... ```
  const lines = (text || '').split('\n')
  return lines.map((line) => {
    const trimmed = line.trim()
    if (trimmed.startsWith("'''")) {
      return line.replace("'''", '```')
    }
    return line
  }).join('\n')
}

// ─── Compose bar with file attach ────────────────────────────

function ComposeBar({ onSubmit, isArchived }) {
  const t = useT()
  const { currentUser, maxAttachmentFileSize } = useAuth()
  const { selectedChannel } = useChat()
  const [content, setContent] = useState('')
  const [files, setFiles] = useState([])
  const [dragOver, setDragOver] = useState(false)
  const [sending, setSending] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(null)
  const [focused, setFocused] = useState(false)
  const [securityLevel, setSecurityLevel] = useState(Math.min(1, currentUser?.security_level ?? 0))
  const maxSelectableLevel = currentUser?.role === 'site_admin' ? 4 : (currentUser?.security_level ?? 0)

  const contentRef = useRef(null)
  const fileInputRef = useRef(null)
  const dragCounter = useRef(0)

  function addFiles(newFiles) {
    if (files.length + newFiles.length > 10) {
      alert(t.chat.maxFiles10)
      return
    }
    const limitBytes = (maxAttachmentFileSize ?? 100) * 1024 * 1024
    for (const f of Array.from(newFiles)) {
      if (f.size > limitBytes) {
        alert(t.chat.fileTooLarge(maxAttachmentFileSize ?? 100))
        return
      }
    }
    if (newFiles.length > 0 && !content.trim()) {
      setContent(newFiles[0].name)
    }
    const mapped = Array.from(newFiles).map(f => ({
      id: `f-${Date.now()}-${Math.random()}`,
      name: f.name,
      size: f.size,
      type: f.type,
      url: URL.createObjectURL(f),
      file: f,
    }))
    setFiles(prev => [...prev, ...mapped])
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

  function handleDragEnter(e) {
    e.preventDefault()
    if (!dataTransferHasFiles(e.dataTransfer)) return
    dragCounter.current++
    setDragOver(true)
  }
  function handleDragLeave(e) {
    e.preventDefault()
    dragCounter.current = Math.max(0, dragCounter.current - 1)
    if (dragCounter.current === 0) setDragOver(false)
  }
  function handleDragOver(e) {
    e.preventDefault()
    if (!dataTransferHasFiles(e.dataTransfer)) return
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }
  function handleDrop(e) {
    e.preventDefault()
    dragCounter.current = 0
    setDragOver(false)
    if (dataTransferHasFiles(e.dataTransfer) && e.dataTransfer.files?.length) {
      addFiles(e.dataTransfer.files)
    }
  }

  function handleTextareaDrop(e) {
    if (!dataTransferHasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    handleDrop(e)
  }

  function handleTextareaDragOver(e) {
    if (!dataTransferHasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }

  async function handleSend() {
    if (!content.trim() && files.length === 0) { contentRef.current?.focus(); return }
    setSending(true)
    try {
      const attachmentIds = []
      const totalUploadBytes = files.reduce((sum, f) => sum + (f.file?.size || 0), 0)
      let uploadedBytesDone = 0
      if (files.length > 0) {
        setUploadProgress({
          percent: 0,
          uploadedBytes: 0,
          totalBytes: totalUploadBytes,
          fileIndex: 1,
          fileCount: files.length,
        })
      }

      // Upload each file to Mock S3 first
      for (let i = 0; i < files.length; i++) {
        const fObj = files[i]
        const { uploadUrl, file_uuid } = await apiFetch('/files/get-upload-url', {
          method: 'POST',
          body: JSON.stringify({
            filename: fObj.name,
            contentType: fObj.type,
            channelId: selectedChannel.id,
          }),
        })
        await uploadFileWithProgress(uploadUrl, fObj.file, ({ loaded, total }) => {
          const currentTotal = total || fObj.file?.size || 0
          const safeLoaded = Math.min(Math.max(loaded || 0, 0), currentTotal)
          const overallUploaded = uploadedBytesDone + safeLoaded
          const percent = totalUploadBytes > 0
            ? Math.min(100, Math.round((overallUploaded / totalUploadBytes) * 100))
            : 100
          setUploadProgress({
            percent,
            uploadedBytes: overallUploaded,
            totalBytes: totalUploadBytes,
            fileIndex: i + 1,
            fileCount: files.length,
          })
        })
        uploadedBytesDone += fObj.file?.size || 0
        attachmentIds.push(file_uuid)
      }

      await onSubmit({ content: content.trim(), attachmentIds, security_level: securityLevel })

      files.forEach(f => URL.revokeObjectURL(f.url))
      setContent('')
      setFiles([])
      setFocused(false)
      if (contentRef.current) {
        contentRef.current.style.height = 'auto'
      }
    } catch (err) {
      alert(t.chat.sendError(err.message))
    } finally {
      setSending(false)
      setUploadProgress(null)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  function handleCancel() {
    files.forEach(f => URL.revokeObjectURL(f.url))
    setContent('')
    setFiles([])
    setFocused(false)
    if (contentRef.current) contentRef.current.style.height = 'auto'
  }

  const hasContent = content.trim().length > 0 || files.length > 0
  const showActions = focused || hasContent

  if (isArchived) {
    return (
      <div className="flex-shrink-0 px-4 py-8 border-t border-gray-200 flex flex-col items-center justify-center bg-white/2">
        <div className="w-12 h-12 rounded-full bg-amber-50 flex items-center justify-center text-amber-500 mb-3">
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
          </svg>
        </div>
        <p className="text-gray-900 font-bold text-sm mb-1">{t.chat.archivedChannel}</p>
        <p className="text-gray-400 text-[11px]">{t.chat.archivedDesc}</p>
      </div>
    )
  }

  return (
    <div className="flex-shrink-0 px-4 py-3 border-t border-gray-200">
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />

      <div
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={`flex flex-col rounded-2xl border transition-all duration-150 relative overflow-hidden ${
          dragOver
            ? 'border-indigo-400/70 bg-indigo-50 shadow-lg shadow-indigo-200'
            : showActions
            ? 'bg-gray-100 border-indigo-300'
            : 'bg-gray-100 border-gray-200 hover:border-gray-300'
        }`}
      >
        {/* Drag overlay */}
        {dragOver && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-10 pointer-events-none">
            <svg className="w-8 h-8 text-indigo-600 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
            <p className="text-indigo-600 text-sm font-semibold">{t.chat.dropFile}</p>
          </div>
        )}

        {/* Content textarea row */}
        <div className="flex items-start gap-3 px-4 pt-3 pb-2">
          {currentUser && <Avatar letters={currentUser.avatar} size="sm" />}
          <textarea
            ref={contentRef}
            value={content}
            onChange={e => setContent(e.target.value)}
            onFocus={() => setFocused(true)}
            onKeyDown={handleKeyDown}
            onDragOver={handleTextareaDragOver}
            onDrop={handleTextareaDrop}
            placeholder={t.chat.messagePlaceholder}
            rows={1}
            className="flex-1 bg-transparent text-gray-800 placeholder-gray-400 text-sm leading-relaxed resize-none focus:outline-none pt-0.5"
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

        {/* Action row — shown when focused or has content */}
        {showActions && (
          <div className="px-3 pb-3 pl-[52px]">
            {sending && uploadProgress && (
              <div className="mb-2">
                <div className="flex items-center justify-between text-[11px] text-gray-500 mb-1">
                  <span>{t.chat.sending} {uploadProgress.percent}%</span>
                  <span>{uploadProgress.fileIndex}/{uploadProgress.fileCount} · {formatSize(uploadProgress.uploadedBytes)} / {formatSize(uploadProgress.totalBytes)}</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
                  <div
                    className="h-full bg-indigo-500 transition-all duration-150"
                    style={{ width: `${uploadProgress.percent}%` }}
                  />
                </div>
              </div>
            )}
            <div className="flex items-center gap-2">
            {/* Clip button */}
            <button
              type="button"
              title={t.chat.attachFile}
              onClick={() => fileInputRef.current.click()}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-200 transition-colors flex-shrink-0"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
              </svg>
            </button>

            <div className="flex-1" />

            {/* Security Level */}
            <select
              value={securityLevel}
              onChange={e => setSecurityLevel(Number(e.target.value))}
              className="text-xs px-2 py-1 rounded-lg border border-gray-200 bg-white text-gray-600 focus:outline-none focus:border-indigo-300"
            >
              {(t.admin.securityLevels || []).map((label, i) => i <= maxSelectableLevel && (
                <option key={i} value={i}>{label}</option>
              ))}
            </select>

            {/* Cancel + Send */}
            <button
              type="button"
              onClick={handleCancel}
              className="px-2.5 py-1.5 rounded-lg text-gray-400 hover:text-gray-500 text-xs transition-colors hover:bg-gray-100"
            >
              {t.chat.cancel}
            </button>
            <button
              type="button"
              onClick={handleSend}
              disabled={!hasContent || sending}
              className="w-9 h-9 rounded-xl flex items-center justify-center transition-all disabled:opacity-30 disabled:cursor-not-allowed enabled:bg-indigo-600 enabled:hover:bg-indigo-500 enabled:shadow-lg enabled:shadow-indigo-200 enabled:active:scale-95"
            >
              {sending ? (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              )}
            </button>
            </div>
          </div>
        )}
      </div>

      <p className="text-gray-300 text-xs mt-1.5 px-1">
        {t.chat.messageHint}
      </p>
    </div>
  )
}

// ─── Post List ────────────────────────────────────────────────

function PostList({ posts, onSelect, onSubmit, selectedPostId, onOpenDocumentList }) {
  const t = useT()
  const { selectedChannel, selectedTeam, refreshTeams } = useChat()
  const pinnedPosts = posts.filter(p => p.pinned)
  const normalPosts = posts.filter(p => !p.pinned)
  const bottomRef = useRef(null)
  const [showManageModal, setShowManageModal] = useState(false)
  const { currentUser } = useAuth()
  const isAdmin = ['Admin', 'site_admin', 'channel_admin', 'team_admin'].includes(currentUser?.role)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [posts.length])

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center px-6 py-4 border-b border-gray-200 flex-shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-gray-400 text-sm">#</span>
            <h2 className="text-gray-900 font-bold text-base">{selectedChannel.name}</h2>
            {selectedChannel.type === 'private' && (
              <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            )}
          </div>
          <p className="text-gray-400 text-xs mt-0.5">{t.chat.postsCount(selectedTeam.name, posts.length)}</p>
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-2">
          <button
            onClick={onOpenDocumentList}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-sky-50 border border-sky-200 text-sky-600 hover:bg-sky-100 transition-all text-xs font-semibold"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            {t.chat.documentList || '문서 목록'}
          </button>

          {isAdmin && (
            <button
              onClick={() => setShowManageModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-50 border border-indigo-200 text-indigo-600 hover:bg-indigo-100 transition-all text-xs font-semibold"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              {t.channel.manageTitle}
            </button>
          )}
        </div>
      </div>

      {showManageModal && (
        <ChannelManageModal
          onClose={() => setShowManageModal(false)}
          onSave={() => refreshTeams()}
        />
      )}

      {/* Feed */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {posts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-16">
            <div className="w-16 h-16 rounded-2xl bg-indigo-50 border border-indigo-200 flex items-center justify-center text-3xl mb-4">📄</div>
            <h3 className="text-gray-900 font-semibold mb-1">{t.chat.noPostsTitle}</h3>
            <p className="text-gray-400 text-sm">{t.chat.noPostsDesc}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {pinnedPosts.length > 0 && (
              <>
                <div className="flex items-center gap-2 text-amber-600/60 text-xs font-medium uppercase tracking-widest mb-1">
                  <PinIcon /><span>{t.chat.pinnedPost}</span>
                </div>
                {pinnedPosts.map(p => <PostCard key={p.id} post={p} onSelect={onSelect} pinned isSelected={p.id === selectedPostId} />)}
                {normalPosts.length > 0 && <div className="border-t border-gray-100 my-1" />}
              </>
            )}
            {normalPosts.map(p => <PostCard key={p.id} post={p} onSelect={onSelect} isSelected={p.id === selectedPostId} />)}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <ComposeBar onSubmit={onSubmit} isArchived={selectedChannel?.is_archived} />
    </div>
  )
}

function ChannelDocumentListPage({ posts, onBack, onOpenPost }) {
  const t = useT()
  const { selectedChannel, selectedTeam } = useChat()
  const [docType, setDocType] = useState('all') // all | template | attachment
  const [search, setSearch] = useState('')

  function formatDocumentTime(iso) {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const min = String(d.getMinutes()).padStart(2, '0')
    return `${yyyy}년 ${mm}월 ${dd}일 ${hh}시 ${min}분`
  }

  function isDateOnlyQuery(raw) {
    return /^[\d\s\-./년월일시분:]+$/.test((raw || '').trim())
  }

  function parseDateSearch(raw) {
    const text = (raw || '').trim()
    if (!text) return null

    const compactDigits = text.replace(/[^\d]/g, '')
    if (/^\d{4}$/.test(compactDigits)) {
      return { year: Number(compactDigits) }
    }
    if (/^\d{6}$/.test(compactDigits)) {
      return { year: Number(compactDigits.slice(0, 4)), month: Number(compactDigits.slice(4, 6)) }
    }
    if (/^\d{8}$/.test(compactDigits)) {
      return {
        year: Number(compactDigits.slice(0, 4)),
        month: Number(compactDigits.slice(4, 6)),
        day: Number(compactDigits.slice(6, 8)),
      }
    }

    const nums = (text.match(/\d+/g) || []).map(v => Number(v))
    if (!nums.length) return null
    if (String(nums[0]).length < 4) return null

    const [year, month, day] = nums
    const parsed = { year }
    if (nums.length >= 2) parsed.month = month
    if (nums.length >= 3) parsed.day = day
    return parsed
  }

  function matchesDateSearch(iso, parsed) {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return false

    const year = d.getFullYear()
    const month = d.getMonth() + 1
    const day = d.getDate()

    if (year !== parsed.year) return false
    if (parsed.month != null && month !== parsed.month) return false
    if (parsed.day != null && day !== parsed.day) return false
    return true
  }

  const documentItems = posts.flatMap(post => {
    const items = []
    const isTemplate = isTemplateContent(post.content)
    const templateMeta = isTemplate
      ? FORM_TEMPLATES.find(f => post.content.includes(`<title>${f.label}`))
      : null

    if (isTemplate) {
      items.push({
        key: `${post.id}-template`,
        kind: 'template',
        icon: templateMeta?.icon || '📄',
        title: templateMeta ? `${templateMeta.label} 양식` : '양식 문서',
        post,
      })
    }

    const attachments = post.attachments || []
    attachments.forEach((att, idx) => {
      items.push({
        key: `${post.id}-attachment-${idx}`,
        kind: 'attachment',
        icon: '📎',
        title: att.name || `첨부파일 ${idx + 1}`,
        post,
      })
    })

    return items
  })
  .sort((a, b) => new Date(b.post.createdAt).getTime() - new Date(a.post.createdAt).getTime())

  const filteredItems = documentItems.filter(item => {
    if (docType !== 'all' && item.kind !== docType) return false
    const raw = search.trim()
    const q = raw.toLowerCase()
    if (!raw) return true

    const parsedDate = parseDateSearch(raw)
    if (parsedDate && matchesDateSearch(item.post.createdAt, parsedDate)) return true
    if (parsedDate && isDateOnlyQuery(raw)) return false

    const authorName = (item.post.author?.name || '').toLowerCase()
    const title = (item.title || '').toLowerCase()
    return title.includes(q) || authorName.includes(q)
  })

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-gray-50">
      <div className="flex items-center px-6 py-4 border-b border-gray-200 flex-shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-gray-400 text-sm">#</span>
            <h2 className="text-gray-900 font-bold text-base">{selectedChannel?.name}</h2>
            <span className="text-sky-600 text-xs font-semibold">{t.chat.documentList || '문서 목록'}</span>
          </div>
          <p className="text-gray-400 text-xs mt-0.5">
            {(selectedTeam?.name || '')} · {(t.chat.documentCount?.(filteredItems.length) || `문서 ${filteredItems.length}개`)}
          </p>
        </div>
        <div className="flex-1" />
        <button
          onClick={onBack}
          className="px-3 py-1.5 rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-100 text-xs font-semibold transition-colors"
        >
          {t.search.back || '돌아가기'}
        </button>
      </div>

      <div className="px-6 py-3 border-b border-gray-200 bg-white/70">
        <div className="flex items-center gap-2 mb-2">
          <button
            onClick={() => setDocType('all')}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${
              docType === 'all'
                ? 'bg-sky-50 text-sky-700 border-sky-200'
                : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-100'
            }`}
          >
            {t.chat.documentFilterAll || '전체'}
          </button>
          <button
            onClick={() => setDocType('template')}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${
              docType === 'template'
                ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
                : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-100'
            }`}
          >
            {t.chat.templateDocument || '양식 문서'}
          </button>
          <button
            onClick={() => setDocType('attachment')}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${
              docType === 'attachment'
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-100'
            }`}
          >
            {t.chat.attachmentDocument || '첨부 문서'}
          </button>
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t.chat.documentSearchPlaceholder || '문서 제목 또는 작성자 검색...'}
          className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:outline-none focus:border-sky-300"
        />
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {filteredItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-16">
            <div className="w-16 h-16 rounded-2xl bg-sky-50 border border-sky-200 flex items-center justify-center text-3xl mb-4">🗂️</div>
            <h3 className="text-gray-900 font-semibold mb-1">{t.chat.documentList || '문서 목록'}</h3>
            <p className="text-gray-400 text-sm">{t.chat.noDocumentsDesc || '이 채널에는 문서가 없습니다.'}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filteredItems.map(item => (
              <button
                key={item.key}
                onClick={() => onOpenPost(item.post)}
                className="w-full text-left px-4 py-3 rounded-xl border border-gray-200 bg-white hover:border-sky-200 hover:bg-sky-50/40 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="text-base">{item.icon}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm truncate">
                      <span className="font-semibold text-gray-800">{item.title}</span>
                      <span className="text-gray-900 font-medium"> · {item.post.author?.name || ''} · {formatDocumentTime(item.post.createdAt)}</span>
                    </p>
                  </div>
                  {item.kind === 'attachment' && (
                    <span className="text-[10px] text-gray-400 whitespace-nowrap mr-2">
                      {item.size ? formatSize(item.size) : ''}
                    </span>
                  )}
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border ${
                    item.kind === 'template'
                      ? 'text-indigo-600 border-indigo-200 bg-indigo-50'
                      : 'text-emerald-600 border-emerald-200 bg-emerald-50'
                  }`}>
                    {item.kind === 'template' ? (t.chat.templateDocument || '양식 문서') : (t.chat.attachmentDocument || '첨부 문서')}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function PostCard({ post, onSelect, pinned, isSelected }) {
  const t = useT()
  const isTemplate = isTemplateContent(post.content)
  const templateMeta = isTemplate
    ? FORM_TEMPLATES.find(f => post.content.includes(`<title>${f.label}`))
    : null
  const plain = isTemplate ? [] : (post.content || '')
    .replace(/#{1,3} /g, '').replace(/\*\*/g, '').replace(/`/g, '')
    .split('\n').filter(l => l.trim() && !l.startsWith('|') && !l.startsWith('-'))
  const isQuotation = isTemplate && templateMeta?.id === 'quotation'
  const isExpense   = isTemplate && templateMeta?.id === 'expense-report'
  const quoteNo       = isQuotation ? (post.content.match(/data-type="no"[^>]*>([^<]+)</) || [])[1]?.trim() || null : null
  const recvVal       = isQuotation ? (post.content.match(/data-field="recv"[^>]*>([^<]+)</) || [])[1]?.trim() || null : null
  const estimateVal   = isQuotation ? (post.content.match(/data-field="estimate-name"[^>]*>([^<]+)</) || [])[1]?.trim() || null : null
  const expDocNo      = isExpense ? (post.content.match(/data-field="expense-doc-no"[^>]*>([^<]+)</) || [])[1]?.trim() || '' : null
  const expDocDate    = isExpense ? (post.content.match(/data-field="expense-doc-date"[^>]*>([^<]+)</) || [])[1]?.trim() || '' : null
  const expAuthorRaw  = isExpense ? (post.content.match(/data-field="expense-author"[^>]*>([^<]+)</) || [])[1]?.trim() || '' : null
  const expAuthor     = isExpense ? (expAuthorRaw === '{{USER_NAME}}' || !expAuthorRaw ? (post.author?.name || '') : expAuthorRaw) : null
  const leadLine = isTemplate
    ? (templateMeta
        ? (() => {
            if (isQuotation) {
              const parts = [`${templateMeta.icon} ${templateMeta.label} 양식`]
              if (quoteNo) parts.push(quoteNo)
              if (recvVal) parts.push(recvVal)
              if (estimateVal) parts.push(estimateVal)
              return parts.join('-')
            }
            if (isExpense) {
              const parts = [`${templateMeta.icon} 지출결의서`]
              if (expAuthor) parts.push(expAuthor)
              if (expDocDate) parts.push(expDocDate)
              if (expDocNo) parts.push(expDocNo)
              return parts.join('-')
            }
            return `${templateMeta.icon} ${templateMeta.label} 양식`
          })()
        : '📄 양식 템플릿')
    : (plain[0]?.slice(0, 100) || '')
  const bodyPreview = isTemplate ? '' : plain.slice(1).join(' ').slice(0, 120)
  const attachCount = post.attachments?.length || 0
  const commentCount = post.comments?.length || 0
  const trainingStatus = post.training_status || null
  const [copyToast, setCopyToast] = useState(null)
  const {
    handleMouseDown,
    handleMouseUp,
    handleClickCapture,
    shouldBlockClick,
  } = useSelectionClickGuard({ scope: 'post-card', dragThreshold: 4, blockOnAnySelection: true })

  function handleCardMouseUp(e) {
    const selected = handleMouseUp(e)
    if (selected) {
      setCopyToast({ x: e.clientX, y: e.clientY, text: selected })
      return
    }
    setCopyToast(null)
  }

  function handleCardClick(e) {
    if (shouldBlockClick(e, { useDragThreshold: true })) return
    setCopyToast(null)
    onSelect(post)
  }

  function handleCopy() {
    if (!copyToast) return
    navigator.clipboard.writeText(copyToast.text).catch(() => {
      const ta = document.createElement('textarea')
      ta.value = copyToast.text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    })
    setCopyToast(null)
    window.getSelection?.()?.removeAllRanges?.()
  }

  function handleCardKeyDown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setCopyToast(null)
      onSelect(post)
    }
  }

  return (
    <div className="relative">
      <div
        tabIndex={0}
        onMouseDown={handleMouseDown}
        onMouseUp={handleCardMouseUp}
        onClickCapture={handleClickCapture}
        onClick={handleCardClick}
        onKeyDown={handleCardKeyDown}
        className={`w-full text-left px-5 py-3 rounded-2xl border transition-all group cursor-pointer ${
          isSelected
            ? 'bg-indigo-50 border-indigo-300'
            : pinned
            ? 'bg-amber-50 border-amber-100 hover:bg-amber-50 hover:border-amber-200'
            : 'bg-gray-50 border-gray-200 hover:bg-white/7 hover:border-gray-200'
        }`}
      >
      <div className="flex items-start gap-2.5">
        <Avatar letters={post.author?.avatar || '?'} imageUrl={post.author?.image_url} />
        <div className="flex-1 min-w-0">
          {/* Lead line */}
          <div className="flex items-center gap-2 mb-0.5">
            {pinned && <PinIcon />}
            {leadLine && (
              <p className="text-gray-800 font-semibold text-sm leading-tight group-hover:text-indigo-600 transition-colors overflow-hidden text-ellipsis whitespace-nowrap select-text allow-copy cursor-text">{leadLine}</p>
            )}
          </div>
          {/* Meta */}
          <div className={`flex items-center gap-2 text-gray-400 text-xs select-text allow-copy ${bodyPreview ? 'mb-1' : 'mb-0'}`}>
            <span className="font-medium text-gray-500">{post.author?.name}</span>
            {post.author?.username && (
              <span className="text-gray-400">@{post.author.username}</span>
            )}
            <span>·</span>
            <span>{formatDate(post.createdAt, t)}</span>
            {attachCount > 0 && (
              <>
                <span>·</span>
                <span className="flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                  {attachCount}
                </span>
              </>
            )}
            {trainingStatus && (
              <>
                <span>·</span>
                <TrainingStatusBadge status={trainingStatus} />
              </>
            )}
            {commentCount > 0 && (
              <>
                <span>·</span>
                <span className="flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                  {commentCount}
                </span>
              </>
            )}
          </div>
          {/* Body preview (second line onward) */}
          {bodyPreview && (
            <p
              className="text-gray-400 text-xs leading-relaxed line-clamp-2 select-text allow-copy cursor-text"
            >
              {bodyPreview}
            </p>
          )}
        </div>
      </div>
      </div>
      {copyToast && (
        <div
          className="fixed z-50 flex items-center gap-1.5 bg-gray-900 text-white text-xs px-3 py-1.5 rounded-lg shadow-lg cursor-pointer select-none"
          style={{ left: copyToast.x, top: copyToast.y - 40 }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleCopy}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          복사
        </div>
      )}
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────

export default function ChatArea({ autoOpenPostId }) {
  const {
    selectedChannel,
    posts,
    addPost,
    pendingOpenPostId,
    clearPendingPost,
    setSelectedPostContext,
    clearSelectedPostContext,
  } = useChat()
  const t = useT()
  const [selectedPost, setSelectedPost] = useState(null)
  const [showDocumentList, setShowDocumentList] = useState(false)
  const [leftWidth, setLeftWidth] = useState(42) // percent
  const [resizing, setResizing] = useState(false)
  const containerRef = useRef(null)

  // 검색 결과로 선택된 게시글 자동 오픈
  useEffect(() => {
    if (!autoOpenPostId) return
    const channelPosts = posts[selectedChannel?.id] || []
    const target = channelPosts.find(p => String(p.id) === String(autoOpenPostId))
    if (target) setSelectedPost(target)
  }, [autoOpenPostId, selectedChannel?.id, posts])

  // RAG 참고 문서 클릭으로 이동된 게시글 자동 오픈
  useEffect(() => {
    if (!pendingOpenPostId) return
    const channelPosts = posts[selectedChannel?.id] || []
    const target = channelPosts.find(p => String(p.id) === String(pendingOpenPostId))
    if (target) {
      setSelectedPost(target)
      clearPendingPost()
    }
  }, [pendingOpenPostId, selectedChannel?.id, posts, clearPendingPost])

  const startResizing = useCallback(() => {
    setResizing(true)
  }, [])

  const stopResizing = useCallback(() => {
    setResizing(false)
  }, [])

  const onMouseMove = useCallback((e) => {
    if (!resizing || !containerRef.current) return
    const containerRect = containerRef.current.getBoundingClientRect()
    const newWidth = ((e.clientX - containerRect.left) / containerRect.width) * 100
    if (newWidth > 20 && newWidth < 80) setLeftWidth(newWidth)
  }, [resizing])

  useEffect(() => {
    if (resizing) {
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', stopResizing)
      document.body.style.cursor = 'col-resize'
    } else {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', stopResizing)
      document.body.style.cursor = ''
    }
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', stopResizing)
      document.body.style.cursor = ''
    }
  }, [resizing, onMouseMove, stopResizing])

  const channelPosts = posts[selectedChannel?.id] || []
  const postDetailHelpers = {
    Avatar,
    PinIcon,
    TrainingStatusBadge,
    FileChip,
    AttachmentList,
    ContentRenderer,
    TemplateRenderer,
    ConfirmDialog,
    formatDate,
    formatFull,
    formatSize,
    dataTransferHasFiles,
    uploadFileWithProgress,
  }

  // 채널 전환 시 기존 선택된 게시글 초기화 (단, 이동 중인 경우에는 유지)
  useEffect(() => { 
    if (!pendingOpenPostId) {
      setSelectedPost(null) 
    }
    setShowDocumentList(false)
  }, [selectedChannel?.id])

  useEffect(() => {
    if (selectedPost?.id && selectedChannel?.id) {
      setSelectedPostContext(selectedChannel.id, selectedPost.id)
      return
    }
    clearSelectedPostContext()
  }, [selectedPost?.id, selectedChannel?.id, setSelectedPostContext, clearSelectedPostContext])

  useEffect(() => {
    return () => {
      clearSelectedPostContext()
    }
  }, [clearSelectedPostContext])

  useEffect(() => {
    if (!showDocumentList) return
    function handleEscOnDocumentList(e) {
      if (e.key === 'Escape') {
        setShowDocumentList(false)
      }
    }
    window.addEventListener('keydown', handleEscOnDocumentList)
    return () => window.removeEventListener('keydown', handleEscOnDocumentList)
  }, [showDocumentList])

  async function handleNewPost(data) {
    await addPost(selectedChannel.id, data)
  }

  if (!selectedChannel) {
    return <div className="flex-1 flex items-center justify-center text-gray-400 bg-gray-50">{t.chat.selectChannel}</div>
  }

  return (
    <div ref={containerRef} className="flex-1 flex min-w-0 bg-gray-50">
      {showDocumentList ? (
        <ChannelDocumentListPage
          posts={channelPosts}
          onBack={() => setShowDocumentList(false)}
          onOpenPost={(post) => {
            setSelectedPost(post)
            setShowDocumentList(false)
          }}
        />
      ) : (
        <>
      {/* Left panel — post list (narrows when detail is open) */}
      <div 
        className={`flex flex-col min-h-0 bg-gray-50 ${selectedPost ? 'border-r border-gray-200' : 'flex-1'} ${resizing ? '' : 'transition-[width] duration-200'}`}
        style={{ width: selectedPost ? `${leftWidth}%` : '100%' }}
      >
        <PostList
          posts={channelPosts}
          selectedPostId={selectedPost?.id}
          onSelect={setSelectedPost}
          onSubmit={handleNewPost}
          onOpenDocumentList={() => {
            setSelectedPost(null)
            setShowDocumentList(true)
          }}
        />
      </div>

      {/* Resize handle */}
      {selectedPost && (
        <div
          onMouseDown={startResizing}
          className="group relative w-1 flex-shrink-0 cursor-col-resize z-10"
        >
          <div className={`absolute inset-y-0 -left-1 -right-1 group-hover:bg-indigo-500/30 transition-colors ${resizing ? 'bg-indigo-500/50' : ''}`} />
        </div>
      )}

      {/* Right panel — post detail */}
      {selectedPost && (
        <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
          <PostDetailPane
            post={selectedPost}
            channelId={selectedChannel.id}
            onClose={() => setSelectedPost(null)}
            helpers={postDetailHelpers}
          />
        </div>
      )}
        </>
      )}
    </div>
  )
}
