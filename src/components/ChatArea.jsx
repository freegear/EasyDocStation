import { useState, useRef, useEffect, useCallback, useLayoutEffect, useMemo, lazy, Suspense } from 'react'
import useMentionAutocomplete, { MENTION_SEPARATOR } from '../hooks/useMentionAutocomplete'
import MentionDropdown from './MentionDropdown'
import { useChat } from '../contexts/ChatContext'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch, getToken } from '../lib/api'
import { hasAnyTextSelection } from '../lib/textSelection'
import { findDuplicateFileNames } from '../lib/fileNameValidation'
import { getPastedImageFiles } from '../lib/clipboardFiles'
import { useSelectionClickGuard } from '../hooks/useSelectionClickGuard'
import { getContentFontStyle, normalizeContentFontScale } from '../lib/contentFont'
import { useMeetingRecording } from '../contexts/MeetingRecordingContext'
import { normalizeBrokenOrderedListItems } from '../lib/markdownNormalize'
import {
  clearMeetingChunks,
  deleteMeetingChunk,
  deleteMeetingSession,
  getMeetingSession,
  listMeetingChunks,
  saveMeetingChunk,
  saveMeetingSession,
} from '../lib/meetingRecordingStore'
import config from '../config.json'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import MarkdownPreBlock from './markdown/MarkdownPreBlock'
import { normalizeLatexDelimiters } from '../lib/markdownMath'
import ChannelManageModal from './ChannelManageModal'
import RecentlyDeletedModal from './RecentlyDeletedModal'
import ConfirmDialog from './ConfirmDialog'
import SpeakerRegistrationModal from './SpeakerRegistrationModal'
import PostDetailPane from './chat/PostDetailPane'
import MDPageViewer from './chat/MDPageViewer'
import { useT } from '../i18n/useT'
import { isTemplateContent, isMdPage, getMdPageContent, getMdPageTitle, isEasySheet, getEasySheetTitle, isMailCardContent, FORM_TEMPLATES } from '../templates/formTemplates'
// Univer 번들(~5.6MB)은 무거우므로 EasySheet 뷰어를 지연 로딩한다.
const EasySheetViewer = lazy(() => import('./chat/EasySheetViewer'))
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'

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

function toKstDateKey(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown-date'
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

function formatKstDividerLabel(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '날짜 미상'
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d)
  const pick = (type) => parts.find((p) => p.type === type)?.value || '00'
  return `${pick('year')}년 ${pick('month')}월 ${pick('day')}일`
}

function resolveAttachmentUrl(file) {
  if (!file?.url) return null
  if (file.url.startsWith('blob:')) return file.url
  if (/^https?:\/\//i.test(file.url)) return file.url
  const token = getToken()
  return token ? `${file.url}?auth_token=${token}` : file.url
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

async function downloadAttachmentFile(file) {
  if (!file?.id || file.url?.startsWith('blob:')) {
    triggerBrowserDownload(resolveAttachmentUrl(file), file?.name)
    return
  }
  try {
    const data = await apiFetch(`/files/${file.id}/get-download-url`)
    if (data?.downloadUrl) {
      triggerBrowserDownload(data.downloadUrl, file?.name)
      return
    }
  } catch {}
  triggerBrowserDownload(resolveAttachmentUrl(file), file?.name)
}

function buildDateSeparatedRows(items = [], getCreatedAt, getId) {
  const rows = []
  let prevDateKey = ''
  for (const item of items) {
    const createdAt = getCreatedAt(item)
    const dateKey = toKstDateKey(createdAt)
    if (dateKey !== prevDateKey) {
      rows.push({
        type: 'divider',
        key: `divider-${dateKey}`,
        label: formatKstDividerLabel(createdAt),
      })
      prevDateKey = dateKey
    }
    rows.push({
      type: 'item',
      key: `item-${getId(item)}`,
      item,
    })
  }
  return rows
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

function sanitizePostPreviewText(text = '') {
  return String(text || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>\n]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sanitizePostPreviewTextKeepLines(text = '') {
  return String(text || '')
    .replace(/<!--[\s\S]*?-->/g, '\n')
    .replace(/<[^>\n]*>/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\\[ \t]*(?=\n|$)/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
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

function isHtmlLikeName(name = '') {
  return /\.(html?|php|asp|aspx|jsp|cfm)($|\?)/i.test(String(name || ''))
}

function getFileCategory(type, name) {
  if (type.startsWith('image/')) return 'image'
  if (type === 'application/pdf') return 'pdf'
  if (type === 'text/html' || isHtmlLikeName(name)) return 'html'
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
  if (isHtmlLikeName(name)) return htmlPreviewOverride || config.htmlPreview || { width: 480, height: 270 }
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
    <svg data-print-exclude="true" aria-hidden="true" className={`${className} ${color} flex-shrink-0`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
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

function TrainingStatusBadge({ status, error = null }) {
  if (!status) return null
  const isTraining = status === 'training' || status === 'queued'
  const isFailed = status === 'failed' || status === 'timed_out'
  const label = status === 'queued'
    ? '학습대기'
    : status === 'training'
      ? '학습중'
      : status === 'failed'
        ? '학습실패'
        : status === 'timed_out'
          ? '시간초과'
          : '학습완료'
  return (
    <span title={error || label} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
      isFailed
        ? 'text-red-700 border-red-200 bg-red-50'
        : isTraining
        ? 'text-amber-700 border-amber-200 bg-amber-50'
        : 'text-emerald-700 border-emerald-200 bg-emerald-50'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${isFailed ? 'bg-red-500' : isTraining ? 'bg-amber-500' : 'bg-emerald-500'}`} />
      {label}
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

function PdfPagePreview({ fileId, width = 400, previewPdf = false }) {
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
        const params = []
        if (previewPdf) params.push('preview=pdf')
        const tk = getToken()
        if (tk) params.push(`auth_token=${tk}`)
        const url = `/api/files/view/${fileId}${params.length ? `?${params.join('&')}` : ''}`
        const resp = await fetch(url, { credentials: 'include' })
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
  }, [fileId, width, previewPdf])

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

// PPT/슬라이드 첨부 미리보기: 서버 썸네일을 우선 사용하고, 이미지 로드가
// 실패하면 변환된 PDF 첫 페이지를 pdf.js로 직접 렌더(폴백)한다. 둘 다 실패해도
// PdfPagePreview가 에러 박스를 보여주므로 미리보기가 통째로 사라지지 않는다.
function SlideAttachmentPreview({ file, thumbUrl, width, height, onOpen, NativeOpenBtn, DownloadBtn }) {
  const [imgFailed, setImgFailed] = useState(false)
  const showThumb = thumbUrl && !imgFailed
  return (
    <div
      className="rounded-2xl overflow-hidden border border-gray-200 hover:border-orange-500/50 transition-colors group cursor-pointer flex-shrink-0"
      style={{ width, maxWidth: '100%' }}
      onClick={onOpen}
    >
      {showThumb ? (
        <img
          src={thumbUrl}
          alt={file.name}
          className="block group-hover:opacity-90 transition-opacity bg-white"
          style={{ width, height, maxWidth: '100%', objectFit: 'contain' }}
          onError={() => setImgFailed(true)}
        />
      ) : (
        <PdfPagePreview fileId={file.id} previewPdf width={typeof width === 'number' ? width : 480} />
      )}
      <div className="px-3 py-2 flex items-center justify-between bg-gray-50">
        <div className="flex items-center gap-2 min-w-0">
          <FileTypeIcon category="slide" className="w-4 h-4 flex-shrink-0" />
          <span className="text-gray-500 text-xs truncate">{file.name}</span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <span className="text-gray-400 text-xs">{formatSize(file.size)}</span>
          <NativeOpenBtn f={file} />
          <DownloadBtn f={file} />
        </div>
      </div>
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

// images: 라이트박스에서 좌우 이동할 이미지 배열, index: 현재 위치,
// resolveUrl: 파일 → URL 변환 함수, onIndexChange: 인덱스 이동 콜백
function ImageLightbox({ images, index, resolveUrl, onIndexChange, onClose }) {
  const t = useT()
  const file = images[index]
  const hasPrev = index > 0
  const hasNext = index < images.length - 1
  const multiple = images.length > 1

  const goPrev = useCallback(() => { if (index > 0) onIndexChange(index - 1) }, [index, onIndexChange])
  const goNext = useCallback(() => { if (index < images.length - 1) onIndexChange(index + 1) }, [index, images.length, onIndexChange])

  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') goPrev()
      else if (e.key === 'ArrowRight') goNext()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, goPrev, goNext])

  if (!file) return null
  const fileUrl = resolveUrl(file)

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* 이전 이미지 화살표 */}
      {multiple && (
        <button
          onClick={e => { e.stopPropagation(); goPrev() }}
          disabled={!hasPrev}
          aria-label="이전 이미지"
          className={`absolute left-4 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full flex items-center justify-center transition-colors ${
            hasPrev
              ? 'bg-gray-200/90 hover:bg-gray-300 text-gray-900 cursor-pointer'
              : 'bg-gray-200/30 text-gray-400 opacity-40 cursor-default'
          }`}
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      )}

      <div className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center" onClick={e => e.stopPropagation()}>
        <img
          src={fileUrl}
          alt={file.name}
          className="max-w-[90vw] max-h-[80vh] rounded-2xl object-contain shadow-2xl"
        />
        <div className="mt-3 flex items-center gap-3">
          {multiple && (
            <span className="text-gray-400 text-xs tabular-nums">{index + 1} / {images.length}</span>
          )}
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

      {/* 다음 이미지 화살표 */}
      {multiple && (
        <button
          onClick={e => { e.stopPropagation(); goNext() }}
          disabled={!hasNext}
          aria-label="다음 이미지"
          className={`absolute right-4 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full flex items-center justify-center transition-colors ${
            hasNext
              ? 'bg-gray-200/90 hover:bg-gray-300 text-gray-900 cursor-pointer'
              : 'bg-gray-200/30 text-gray-400 opacity-40 cursor-default'
          }`}
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}

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

function ServerRenderedPdfViewer({ fileId, onFallback }) {
  const [pageCount, setPageCount] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!fileId) {
      onFallback?.()
      return undefined
    }
    let cancelled = false

    fetch(`/api/files/pdf-preview/${fileId}/manifest`, { credentials: 'include' })
      .then(resp => {
        if (!resp.ok) throw new Error('PDF preview manifest failed')
        return resp.json()
      })
      .then(data => {
        if (cancelled) return
        const count = Number(data?.pageCount)
        if (!Number.isInteger(count) || count < 1) throw new Error('Invalid PDF page count')
        setPageCount(count)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) onFallback?.()
      })

    return () => { cancelled = true }
  }, [fileId, onFallback])

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-100">
        <div className="w-6 h-6 border-2 border-gray-300 border-t-red-400 rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto bg-gray-100 p-4">
      <div className="mx-auto max-w-[1100px] space-y-4">
        {Array.from({ length: pageCount }, (_, index) => {
          const page = index + 1
          return (
            <figure key={page} className="m-0">
              <img
                src={`/api/files/pdf-preview/${fileId}/pages/${page}`}
                alt={`PDF ${page}페이지`}
                loading={page === 1 ? 'eager' : 'lazy'}
                decoding="async"
                className="block w-full h-auto rounded border border-gray-200 bg-white shadow-sm"
                onError={onFallback}
              />
              {pageCount > 1 && (
                <figcaption className="pt-1 text-center text-xs text-gray-500">
                  {page} / {pageCount}
                </figcaption>
              )}
            </figure>
          )
        })}
      </div>
    </div>
  )
}

function PdfPreviewViewer({ fileId, onClose }) {
  const [usePdfJs, setUsePdfJs] = useState(false)
  const fallbackToPdfJs = useCallback(() => setUsePdfJs(true), [])

  if (usePdfJs) return <PdfModalViewer fileId={fileId} onClose={onClose} />
  return <ServerRenderedPdfViewer fileId={fileId} onFallback={fallbackToPdfJs} />
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

  async function handleDownload(e) {
    e.preventDefault()
    e.stopPropagation()
    await downloadAttachmentFile(file)
  }

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
            <button
              type="button"
              onClick={handleDownload}
              className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-100 text-gray-700 transition-colors"
            >
              다운로드
            </button>
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
          <PdfPreviewViewer fileId={file?.id} onClose={onClose} />
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

function AttachmentList({ attachments, compact = false, pendingOpenAttachmentId = null, onConsumePendingOpen = null }) {
  const t = useT()
  const [imagePreviewSize, setImagePreviewSize] = useState(config.imagePreview || { width: 512, height: 512 })
  const [moviePreviewSize, setMoviePreviewSize] = useState(config.moviePreview || { width: 480, height: 270 })
  const [htmlPreviewSize, setHtmlPreviewSize] = useState(config.htmlPreview || { width: 480, height: 270 })
  const [pdfPreviewSize, setPdfPreviewSize] = useState(config.pdfPreview || { width: 480, height: 270 })
  const [txtPreviewSize, setTxtPreviewSize] = useState(config.txtPreview || { width: 270, height: 480 })
  const [lightboxIndex, setLightboxIndex] = useState(-1)
  const [videoFile, setVideoFile] = useState(null)
  const [previewFile, setPreviewFile] = useState(null)
  const [failedHtmlAttachmentPreview, setFailedHtmlAttachmentPreview] = useState({})

  // 모바일(≤768px)에서는 첨부 미리보기 썸네일을 숨기고 파일 칩만 노출한다.
  const [isMobileView, setIsMobileView] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia('(max-width: 768px)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const mq = window.matchMedia('(max-width: 768px)')
    const onChange = (e) => setIsMobileView(e.matches)
    setIsMobileView(mq.matches)
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }
    mq.addListener(onChange)
    return () => mq.removeListener(onChange)
  }, [])

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

  function fileUrl(f) {
    return resolveAttachmentUrl(f)
  }

  function thumbUrl(f) {
    if (!f.thumbnail_url) return null
    if (/^https?:\/\//i.test(f.thumbnail_url)) return f.thumbnail_url
    const token = getToken()
    return `${f.thumbnail_url}&auth_token=${token}`
  }

  // 라이트박스 캐러셀에 포함할 이미지 첨부만 모은 배열 (원본 순서 유지)
  const imageAttachments = useMemo(
    () => (attachments || []).filter(f => getFileCategory(f.type || '', f.name || '') === 'image'),
    [attachments]
  )

  // 이미지 클릭 → 라이트박스 (이미지 배열 내 위치로 열기)
  function handleImageClick(e, f) {
    e.preventDefault()
    const idx = imageAttachments.findIndex(img => img.id === f.id)
    setLightboxIndex(idx >= 0 ? idx : 0)
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

  useEffect(() => {
    if (!pendingOpenAttachmentId || !attachments || attachments.length === 0) return
    const target = attachments.find(f => String(f.id) === String(pendingOpenAttachmentId))
    if (!target) return
    const category = getFileCategory(target.type || '', target.name || '')
    if (category === 'image') {
      const idx = imageAttachments.findIndex(img => img.id === target.id)
      setLightboxIndex(idx >= 0 ? idx : 0)
    }
    else if (category === 'video') setVideoFile(target)
    else setPreviewFile(target)
    onConsumePendingOpen?.()
  }, [pendingOpenAttachmentId, attachments, imageAttachments, onConsumePendingOpen])

  if (!attachments || attachments.length === 0) return null

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

  async function downloadFile(e, f) {
    e.preventDefault()
    e.stopPropagation()
    await downloadAttachmentFile(f)
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
      {lightboxIndex >= 0 && lightboxIndex < imageAttachments.length && (
        <ImageLightbox
          images={imageAttachments}
          index={lightboxIndex}
          resolveUrl={fileUrl}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(-1)}
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
          <svg data-print-exclude="true" aria-hidden="true" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
          {t.chat.attachmentsCount(attachments.length)}
        </h4>

        <div className="flex flex-wrap gap-3">
          {attachments.map(f => {
            const category = getFileCategory(f.type || '', f.name || '')

            // 모바일: 미리보기 썸네일 없이 파일 칩(이름 + 열기/다운로드)만 표시
            if (isMobileView) {
              return (
                <div
                  key={f.id}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-xl border border-gray-200 bg-gray-50"
                >
                  <FileTypeIcon category={category} className="w-5 h-5 flex-shrink-0 text-gray-400" />
                  <span className="flex-1 min-w-0 truncate text-gray-700 text-sm">{f.name}</span>
                  <span className="text-gray-400 text-xs flex-shrink-0">{formatSize(f.size)}</span>
                  <NativeOpenBtn f={f} />
                  <DownloadBtn f={f} />
                </div>
              )
            }

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
              const originalUrl = String(f.url || '')
              const isExternalLink = /^https?:\/\//i.test(originalUrl)
              const htmlPreviewImageUrl = `/api/files/link-preview-image?url=${encodeURIComponent(originalUrl)}&width=${previewW}&height=${previewH}`
              const failedKey = String(f.id || f.name || originalUrl)
              const isFailed = Boolean(failedHtmlAttachmentPreview[failedKey])
              return (
                <div key={f.id}
                  className="rounded-2xl overflow-hidden border border-gray-200 hover:border-amber-500/50 transition-colors group cursor-pointer flex-shrink-0"
                  style={{ width: w, maxWidth: '100%' }}
                  onClick={e => handleFileClick(e, f)}
                >
                  <div style={{ width: w, height: h, position: 'relative', overflow: 'hidden' }}>
                    {isExternalLink ? (
                      !isFailed ? (
                        <img
                          src={htmlPreviewImageUrl}
                          alt={f.name}
                          loading="lazy"
                          className="block bg-gray-100"
                          style={{ width: w, height: h, objectFit: 'cover' }}
                          onError={() => {
                            setFailedHtmlAttachmentPreview(prev => ({ ...prev, [failedKey]: true }))
                          }}
                        />
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center text-gray-400 text-xs gap-1 bg-gray-100">
                          <span>미리보기를 불러올 수 없습니다.</span>
                          <span className="text-[11px] text-gray-300">새 창에서 링크를 열어주세요.</span>
                        </div>
                      )
                    ) : (
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
                    )}
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

            // ── PPT/슬라이드 → 썸네일 우선, 실패 시 pdf.js 폴백 ──
            if (isSlide) {
              return (
                <SlideAttachmentPreview
                  key={f.id}
                  file={f}
                  thumbUrl={thumbUrl(f)}
                  width={w}
                  height={h}
                  onOpen={(e) => handleFileClick(e, f)}
                  NativeOpenBtn={NativeOpenBtn}
                  DownloadBtn={DownloadBtn}
                />
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
    .replace('</head>', `<script data-template-runtime="true">var POST_ID='${safePostId}';var EXPENSE_DOC_NO='${safeDocNo}';var TRIP_DOC_NO='${safeTripDocNo}';var SAVED_ATTACHMENTS=${attachJson};var SAVED_FORM_DATA=${formJson};</script></head>`)

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
      if (e.data?.type === 'meetingMinutesConfirm' && e.data.html && onSave) {
        onSave({ kind: 'meeting-minutes', html: e.data.html, ragContent: e.data.ragContent || '' })
          .then(() => {
            iframeRef.current?.contentWindow?.postMessage(
              { type: 'meetingMinutesConfirmResult', success: true, status: 'completed' }, '*'
            )
          })
          .catch((err) => {
            iframeRef.current?.contentWindow?.postMessage(
              { type: 'meetingMinutesConfirmResult', success: false, error: err.message }, '*'
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
  const [failedUrls, setFailedUrls] = useState({})
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
              background: '#f3f4f6',
            }}
          >
            {!failedUrls[url] ? (
              <img
                src={`/api/files/link-preview-image?url=${encodeURIComponent(url)}&width=${width}&height=${height}&auth_token=${encodeURIComponent(getToken() || '')}`}
                alt={url}
                loading="lazy"
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  display: 'block',
                }}
                onError={() => setFailedUrls(prev => ({ ...prev, [url]: true }))}
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center text-gray-400 text-xs gap-1">
                <span>미리보기를 불러올 수 없습니다.</span>
                <span className="text-[11px] text-gray-300">새 창에서 링크를 열어주세요.</span>
              </div>
            )}
          </div>
        </a>
      ))}
    </div>
  )
}

function renderMentionTokens(text, keyPrefix = 'mention') {
  if (typeof text !== 'string') return text
  const escapedSep = MENTION_SEPARATOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const sepMentionRe = new RegExp(`(@[^@\\n${escapedSep}]+${escapedSep})`, 'g')
  const legacyMentionRe = /(@[^\s@]+)/g

  const renderParts = (parts, isMention, trimSep = false) => parts.map((part, i) => (
    isMention(part)
      ? (
        <span
          key={`${keyPrefix}-m${i}`}
          className="inline-flex items-center px-1.5 py-0.5 rounded-md border border-blue-300 bg-blue-50 text-blue-600 font-semibold"
        >
          {trimSep ? part.replaceAll(MENTION_SEPARATOR, '') : part}
        </span>
      )
      : part.replaceAll(MENTION_SEPARATOR, '')
  ))

  const sepParts = text.split(sepMentionRe)
  if (sepParts.length > 1) {
    const sepMentionExact = new RegExp(`^@[^@\\n${escapedSep}]+${escapedSep}$`)
    return renderParts(sepParts, (part) => sepMentionExact.test(part), true)
  }

  const legacyParts = text.split(legacyMentionRe)
  if (legacyParts.length > 1) {
    return renderParts(legacyParts, (part) => /^@[^\s@]+$/.test(part), false)
  }

  return text.replaceAll(MENTION_SEPARATOR, '')
}

function renderPostPreviewTokens(text, keyPrefix = 'preview') {
  if (typeof text !== 'string') return text

  const nodes = []
  const linkPattern = /(!?)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  let lastIndex = 0
  let match

  while ((match = linkPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(
        <span key={`${keyPrefix}-t${nodes.length}`}>
          {renderMentionTokens(text.slice(lastIndex, match.index), `${keyPrefix}-t${nodes.length}`)}
        </span>
      )
    }

    if (match[1] === '!') {
      nodes.push(
        <span key={`${keyPrefix}-img${nodes.length}`}>
          {renderMentionTokens(match[2], `${keyPrefix}-img${nodes.length}`)}
        </span>
      )
    } else {
      nodes.push(
        <span
          key={`${keyPrefix}-link${nodes.length}`}
          className="underline decoration-gray-400 underline-offset-2"
        >
          {renderMentionTokens(match[2], `${keyPrefix}-link${nodes.length}`)}
        </span>
      )
    }
    lastIndex = linkPattern.lastIndex
  }

  if (lastIndex < text.length) {
    nodes.push(
      <span key={`${keyPrefix}-t${nodes.length}`}>
        {renderMentionTokens(text.slice(lastIndex), `${keyPrefix}-t${nodes.length}`)}
      </span>
    )
  }

  return nodes.length > 0 ? nodes : renderMentionTokens(text, keyPrefix)
}

// @표시이름 을 테두리 배지 span 으로 치환 — ReactMarkdown children(문자열 노드)에 적용
function applyMentionColor(children) {
  const processNode = (child, keyPrefix) => {
    if (typeof child !== 'string') return child
    return renderMentionTokens(child, String(keyPrefix))
  }
  if (Array.isArray(children)) return children.map((c, i) => processNode(c, i))
  return processNode(children, 0)
}

const STT_UI_STATE_CACHE = new Map()

function canShowMeetingActionButtons(statusType = 'idle') {
  const s = String(statusType || 'idle')
  return s === 'idle' || s === 'failed' || s === 'canceled'
}

function ContentRenderer({ text = '', sttPostId = '', sttChannelId = '', contentFontStyle = null }) {
  const meetingRecording = useMeetingRecording()
  const isAiMeetingNote = String(text || '').includes('<!--ai-meeting-note-->')
  const isMailPostContent = isMailCardContent(text)
  const [isRecording, setIsRecording] = useState(false)
  const [isRecordingPaused, setIsRecordingPaused] = useState(false)
  const [availableMics, setAvailableMics] = useState([])
  const [selectedMicId, setSelectedMicId] = useState('')
  const [volumeLevel, setVolumeLevel] = useState(0)
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0)
  const [meetingId, setMeetingId] = useState('')
  const [meetingPendingChunks, setMeetingPendingChunks] = useState(0)
  const [meetingStatus, setMeetingStatus] = useState('')
  const [meetingDownload, setMeetingDownload] = useState(null)
  const [sttUploading, setSttUploading] = useState(false)
  const [sttStatus, setSttStatus] = useState('')
  const [sttStatusType, setSttStatusType] = useState('idle') // idle | processing | done | failed
  const [sttErrorReason, setSttErrorReason] = useState('')
  const [isBlinkOn, setIsBlinkOn] = useState(true)
  const [showSpeakerModal, setShowSpeakerModal] = useState(false)
  const [showCorrectionModal, setShowCorrectionModal] = useState(false)
  const [correctionSegments, setCorrectionSegments] = useState([])
  const [correctionLoading, setCorrectionLoading] = useState(false)
  const [featureFlags, setFeatureFlags] = useState({ USE_SPEAKER_REGISTRATION: true, USE_SPEAKER_CORRECTION: true })
  const mediaRecorderRef = useRef(null)
  const mediaStreamRef = useRef(null)
  const audioContextRef = useRef(null)
  const analyserRef = useRef(null)
  const meterRafRef = useRef(null)
  const bcRef = useRef(null)
  const meetingIdRef = useRef('')
  const meetingSequenceRef = useRef(0)
  const meetingStartedAtRef = useRef(0)
  const meetingUploadChainRef = useRef(Promise.resolve())
  const meetingChunkTasksRef = useRef(new Set())
  const meetingElapsedTimerRef = useRef(null)
  const meetingFinalizeRef = useRef(false)
  const sttFileInputRef = useRef(null)
  const sttPollTimerRef = useRef(null)
  const sttJobIdRef = useRef('')
  const activeSttPostIdRef = useRef('')
  const sttPollScopeRef = useRef({ postId: '', jobId: '' })

  const normalized = normalizeLatexDelimiters(normalizeBrokenOrderedListItems(
    normalizeDashNumberedLists(
      normalizeMarkdownCodeFence(
        String(text || '')
          .replace(/<!--[\s\S]*?-->/g, '')
          .replace('<!--ai-meeting-note-->', '')
          .replace('[새회의록작성]', '')
      )
    )
  ))
  const links = isMailPostContent ? [] : extractHttpUrls(text || '')

  useEffect(() => {
    apiFetch('/ai/stt/feature-flags').then((f) => {
      if (f && typeof f === 'object') setFeatureFlags(f)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    enumerateAudioDevices().catch(() => {})
  }, [])

  useEffect(() => {
    return () => {
      if (sttPollTimerRef.current) {
        clearInterval(sttPollTimerRef.current)
        sttPollTimerRef.current = null
      }
      // 녹음 객체의 이벤트 핸들러가 업로드와 종료 처리를 계속 소유한다.
      // 게시글/서비스 화면 전환만으로 활성 녹음을 중단하지 않는다.
    }
  }, [])

  useEffect(() => {
    if (sttStatusType !== 'processing') {
      setIsBlinkOn(true)
      return undefined
    }
    const timer = setInterval(() => {
      setIsBlinkOn((v) => !v)
    }, 2000)
    return () => clearInterval(timer)
  }, [sttStatusType])

  function pickRecordingMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ]
    return candidates.find((type) => globalThis.MediaRecorder?.isTypeSupported?.(type)) || ''
  }

  function formatRecordingTime(ms) {
    const total = Math.max(0, Math.floor(Number(ms || 0) / 1000))
    const hh = String(Math.floor(total / 3600)).padStart(2, '0')
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
    const ss = String(total % 60).padStart(2, '0')
    return `${hh}:${mm}:${ss}`
  }

  async function blobSha256(blob) {
    const data = await blob.arrayBuffer()
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  async function enumerateAudioDevices() {
    try {
      if (!navigator?.mediaDevices?.enumerateDevices) return
      const list = await navigator.mediaDevices.enumerateDevices()
      const mics = list.filter((d) => d.kind === 'audioinput')
      setAvailableMics(mics)
      if (!selectedMicId && mics[0]) setSelectedMicId(mics[0].deviceId)
    } catch (_) {}
  }

  async function requestRecordingWakeLock() {
    try {
      if (!('wakeLock' in navigator)) return null
      const w = await navigator.wakeLock.request('screen')
      return w
    } catch (_) { return null }
  }

  async function uploadMeetingChunk(id, chunk) {
    const form = new FormData()
    form.append('audio', chunk.blob, `chunk-${String(chunk.sequence).padStart(6, '0')}.webm`)
    form.append('sequence', String(chunk.sequence))
    form.append('started_at_ms', String(chunk.startedAtMs))
    form.append('duration_ms', String(chunk.durationMs))
    form.append('sha256', chunk.sha256)
    const response = await fetch(`/api/meetings/${id}/audio-chunks`, {
      method: 'POST',
      body: form,
      credentials: 'include',
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = new Error(data.error || `음성 조각 업로드 실패 (${response.status})`)
      error.status = response.status
      throw error
    }
    await deleteMeetingChunk(id, chunk.sequence)
    return data
  }

  async function persistAndQueueMeetingChunk(blob) {
    const id = meetingIdRef.current
    if (!id || !blob?.size) return
    const sequence = meetingSequenceRef.current
    meetingSequenceRef.current += 1
    const startedAtMs = sequence * 20_000
    const elapsed = Math.max(1, Date.now() - meetingStartedAtRef.current)
    const durationMs = Math.min(20_000, Math.max(1, elapsed - startedAtMs))
    const digest = await blobSha256(blob)
    const chunk = { meetingId: id, sequence, blob, startedAtMs, durationMs, sha256: digest }
    await saveMeetingChunk(chunk)
    await saveMeetingSession({
      postId: String(sttPostId), meetingId: id, nextSequence: meetingSequenceRef.current,
      elapsedMs: elapsed, contentType: blob.type || 'audio/webm', updatedAt: Date.now(),
    })
    setMeetingPendingChunks((v) => v + 1)
    meetingRecording.setRecordingState({ pendingChunks: meetingPendingChunks + 1, status: '음성 조각 저장 중' })
    meetingUploadChainRef.current = meetingUploadChainRef.current
      .then(() => uploadMeetingChunk(id, chunk))
      .then(() => setMeetingPendingChunks((v) => {
        const next = Math.max(0, v - 1)
        meetingRecording.setRecordingState({ pendingChunks: next, status: '서버 자동 저장 정상' })
        return next
      }))
      .catch((err) => {
        setMeetingStatus(`전송 대기: ${err.message}`)
        throw err
      })
    // 다음 조각 업로드가 이전 실패 뒤에도 재개되도록 체인을 복구한다.
    meetingUploadChainRef.current = meetingUploadChainRef.current.catch(() => {})
  }

  function startMeter(stream) {
    try {
      if (!stream) return
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)()
      const src = audioContextRef.current.createMediaStreamSource(stream)
      const analyser = audioContextRef.current.createAnalyser()
      analyser.fftSize = 256
      src.connect(analyser)
      analyserRef.current = analyser
      const data = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        analyser.getByteFrequencyData(data)
        let values = 0
        for (let i = 0; i < data.length; i++) values += data[i]
        const avg = values / data.length / 255
        setVolumeLevel(Math.min(1, avg))
        meterRafRef.current = requestAnimationFrame(tick)
      }
      tick()
    } catch (_) {}
  }

  function stopMeter() {
    try {
      if (meterRafRef.current) cancelAnimationFrame(meterRafRef.current)
      meterRafRef.current = null
      if (analyserRef.current) analyserRef.current.disconnect()
      analyserRef.current = null
      if (audioContextRef.current) audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
    } catch (_) {}
  }

  async function createSttForMeeting(id, attachmentId) {
    updateSttUiState(sttPostId, { status: 'STT 작업 생성중...', statusType: 'processing', errorReason: '' })
    const job = await apiFetch('/ai/stt/jobs', {
      method: 'POST',
      body: JSON.stringify({
        postId: sttPostId,
        attachmentId,
        options: { diarization: true, diarizationRequired: false, language: 'ko', chunkContextOverlapSec: 3 },
      }),
    })
    await apiFetch(`/meetings/${id}/stt-job`, {
      method: 'PATCH',
      body: JSON.stringify({ stt_job_id: job.jobId }),
    }).catch(() => {})
    updateSttUiState(sttPostId, {
      status: job?.deduplicated ? '기존 STT 작업 재사용중...' : 'STT 처리 대기중...',
      statusType: 'processing', errorReason: '', jobId: String(job.jobId || ''),
    })
    startSttPolling(sttPostId, job.jobId)
  }

  async function finalizeMeetingRecording() {
    if (meetingFinalizeRef.current) return
    meetingFinalizeRef.current = true
    const id = meetingIdRef.current
    try {
      setMeetingStatus('미전송 음성 확인 중...')
      await Promise.all(Array.from(meetingChunkTasksRef.current))
      await meetingUploadChainRef.current
      const pending = await listMeetingChunks(id)
      for (const chunk of pending) await uploadMeetingChunk(id, chunk)
      const lastSequence = meetingSequenceRef.current - 1
      if (lastSequence < 0) throw new Error('녹음된 음성이 없습니다.')
      setMeetingPendingChunks(0)
      setMeetingStatus('통합 음성 파일 생성 중...')
      const finished = await apiFetch(`/meetings/${id}/finish`, {
        method: 'POST',
        body: JSON.stringify({
          last_sequence: lastSequence,
          total_duration_ms: Math.max(1, Date.now() - meetingStartedAtRef.current),
        }),
      })
      await clearMeetingChunks(id)
      await deleteMeetingSession(sttPostId)
      setMeetingDownload({
        meetingId: id,
        fileName: finished.downloadFileName || '회의녹음.mp3',
        size: Number(finished.downloadSize || 0),
      })
      meetingRecording.setMeetingDownload({
        meetingId: id,
        fileName: finished.downloadFileName || '회의녹음.mp3',
        size: Number(finished.downloadSize || 0),
      })
      setMeetingStatus('통합 음성 생성 완료 · STT 처리 대기 중')
      await createSttForMeeting(id, finished.attachmentId)
    } catch (err) {
      setMeetingStatus(`녹음 처리 실패: ${err.message}`)
      meetingRecording.setRecordingState({ status: `녹음 처리 실패: ${err.message}`, error: String(err?.message || err) })
      updateSttUiState(sttPostId, {
        status: '회의록 작성 실패', statusType: 'failed', errorReason: String(err?.message || err),
      })
    } finally {
      meetingFinalizeRef.current = false
    }
  }

  async function handleStartMeetingRecording() {
    if (isRecording) return
    if (!navigator?.mediaDevices?.getUserMedia) {
      const secureHint = window.isSecureContext
        ? '현재 브라우저/환경에서 마이크 API를 지원하지 않습니다.'
        : '보안 컨텍스트(HTTPS 또는 localhost)가 아니어서 마이크를 사용할 수 없습니다.'
      alert(`마이크를 사용할 수 없습니다.\n${secureHint}`)
      return
    }
    try {
      // request specific device if selected
      const constraints = selectedMicId ? { audio: { deviceId: { exact: selectedMicId } } } : { audio: true }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      mediaStreamRef.current = stream
      const mimeType = pickRecordingMimeType()
      const created = await apiFetch('/meetings', {
        method: 'POST',
        body: JSON.stringify({
          post_id: sttPostId,
          recording_content_type: mimeType || 'audio/webm',
          force_new: true,
        }),
      })
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      meetingIdRef.current = String(created.meetingId)
      meetingSequenceRef.current = 0
      meetingStartedAtRef.current = Date.now()
      meetingUploadChainRef.current = Promise.resolve()
      meetingChunkTasksRef.current = new Set()
      meetingFinalizeRef.current = false
      setMeetingId(String(created.meetingId))
      setMeetingDownload(null)
      setMeetingPendingChunks(0)
      setMeetingStatus('서버 자동 저장 정상')
      meetingRecording.startRecording({
        meetingId: String(created.meetingId),
        postId: String(sttPostId),
        title: '회의 녹음',
        status: '녹음 중',
        elapsedMs: 0,
        pendingChunks: 0,
        error: null,
      })
      setRecordingElapsedMs(0)
      await saveMeetingSession({
        postId: String(sttPostId), meetingId: String(created.meetingId), nextSequence: 0,
        elapsedMs: 0, contentType: recorder.mimeType || mimeType, updatedAt: Date.now(),
      })
      mediaRecorderRef.current = recorder
      // start audio meter
      startMeter(stream)
      // try to acquire BroadcastChannel ownership to avoid duplicate recordings across tabs
      try {
        if (!bcRef.current) bcRef.current = new BroadcastChannel('easystation_meeting_record')
        let ownerPresent = false
        const ownerCheck = (e) => {
          if (e?.data?.type === 'owner-present') ownerPresent = true
        }
        bcRef.current.addEventListener('message', ownerCheck)
        bcRef.current.postMessage({ type: 'request-owner' })
        await new Promise((r) => setTimeout(r, 120))
        bcRef.current.removeEventListener('message', ownerCheck)
        if (ownerPresent) {
          alert('다른 탭에서 이미 녹음 중입니다. 해당 탭을 확인하세요.')
          try { recorder.stop() } catch (_) {}
          stopMeter()
          return
        }
        const respondToOwnerRequest = (event) => {
          if (event?.data?.type === 'request-owner' && recorder.state !== 'inactive') {
            bcRef.current?.postMessage({ type: 'owner-present', meetingId: String(created.meetingId) })
          }
        }
        bcRef.current.addEventListener('message', respondToOwnerRequest)
        recorder.addEventListener('stop', () => {
          bcRef.current?.removeEventListener('message', respondToOwnerRequest)
        }, { once: true })
        bcRef.current.postMessage({ type: 'owner-present' })
      } catch (_) {}

      // request wake lock
      try {
        const w = await requestRecordingWakeLock()
        if (w) {
          w.addEventListener('release', () => {})
        }
      } catch (_) {}
      recorder.ondataavailable = (event) => {
        if (!event.data?.size) return
        const task = persistAndQueueMeetingChunk(event.data).catch((err) => {
          setMeetingStatus(`로컬 임시 저장 실패: ${err.message}`)
        }).finally(() => {
          meetingChunkTasksRef.current.delete(task)
        })
        meetingChunkTasksRef.current.add(task)
      }
      recorder.onstop = () => {
        setIsRecording(false)
        meetingRecording.stopRecording({ status: '처리 중', pendingChunks: 0 })
        setIsRecordingPaused(false)
        if (meetingElapsedTimerRef.current) clearInterval(meetingElapsedTimerRef.current)
        const tracks = mediaStreamRef.current?.getTracks?.() || []
        tracks.forEach(track => {
          try { track.stop() } catch (_) {}
        })
        mediaStreamRef.current = null
        mediaRecorderRef.current = null
        stopMeter()
        try { bcRef.current?.postMessage({ type: 'owner-released' }) } catch (_) {}
        finalizeMeetingRecording()
      }
      recorder.onpause = () => {
        setIsRecordingPaused(true)
        meetingRecording.setRecordingState({ isPaused: true, status: '일시정지' })
      }
      recorder.onresume = () => {
        setIsRecordingPaused(false)
        meetingRecording.setRecordingState({ isPaused: false, status: '녹음 중' })
      }
      recorder.start(Number(created.chunkDurationMs || 20_000))
      setIsRecording(true)
      meetingElapsedTimerRef.current = setInterval(() => {
        const elapsedMs = Date.now() - meetingStartedAtRef.current
        setRecordingElapsedMs(elapsedMs)
        meetingRecording.setRecordingState({ elapsedMs })
      }, 1000)
    } catch (err) {
      const tracks = mediaStreamRef.current?.getTracks?.() || []
      tracks.forEach((track) => {
        try { track.stop() } catch (_) { /* 장치 정리는 최선 노력으로 수행 */ }
      })
      mediaStreamRef.current = null
      const name = String(err?.name || '')
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        alert('마이크 권한이 차단되었습니다.\n브라우저 주소창의 권한 설정에서 마이크를 허용해주세요.')
        return
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        alert('사용 가능한 마이크 장치를 찾을 수 없습니다.\n마이크 연결 상태를 확인해주세요.')
        return
      }
      if (name === 'NotReadableError' || name === 'TrackStartError') {
        alert('마이크 장치를 다른 앱이 사용 중이거나 접근할 수 없습니다.')
        return
      }
      if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
        alert('요청한 오디오 장치 조건을 만족하는 마이크를 찾지 못했습니다.')
        return
      }
      alert(`녹음을 시작하지 못했습니다.\n(${name || 'UnknownError'})`)
    }
  }

  function handlePauseMeetingRecording() {
    const recorder = mediaRecorderRef.current
    if (!recorder) return
    if (recorder.state === 'recording') recorder.pause()
    else if (recorder.state === 'paused') recorder.resume()
  }

  function handleStopMeetingRecording() {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    setMeetingStatus('마지막 음성 조각 저장 중...')
    recorder.stop()
  }

  async function handleAddMarker(type = 'important') {
    try {
      const id = meetingIdRef.current
      if (!id) return
      const offset = Math.max(0, Date.now() - meetingStartedAtRef.current)
      await apiFetch(`/meetings/${id}/markers`, {
        method: 'POST',
        body: JSON.stringify({ offset_ms: offset, type }),
      })
      setMeetingStatus('중요 발언 타임스탬프 저장됨')
    } catch (err) {
      setMeetingStatus(`마커 저장 실패: ${err.message}`)
    }
  }

  useEffect(() => meetingRecording.registerControls({
    togglePause: handlePauseMeetingRecording,
    stop: handleStopMeetingRecording,
    addMarker: handleAddMarker,
  }), [meetingRecording.registerControls, sttPostId])

  async function handleRecoverMeetingRecording() {
    const session = await getMeetingSession(sttPostId).catch(() => null)
    if (!session?.meetingId) return
    meetingIdRef.current = String(session.meetingId)
    meetingSequenceRef.current = Math.max(0, Number(session.nextSequence || 0))
    meetingStartedAtRef.current = Date.now() - Math.max(1, Number(session.elapsedMs || 0))
    meetingUploadChainRef.current = Promise.resolve()
    meetingChunkTasksRef.current = new Set()
    meetingFinalizeRef.current = false
    setMeetingId(String(session.meetingId))
    await finalizeMeetingRecording()
  }

  async function handleDownloadMeetingAudio() {
    const id = meetingDownload?.meetingId || meetingId
    if (!id) return
    triggerBrowserDownload(`/api/meetings/${id}/audio/download`, meetingDownload?.fileName || '회의녹음.mp3')
  }

  useEffect(() => {
    if (!isAiMeetingNote || !sttPostId) return undefined
    let canceled = false
    ;(async () => {
      const session = await getMeetingSession(sttPostId).catch(() => null)
      if (!session?.meetingId || canceled) {
        const latest = await apiFetch(`/meetings/post/${sttPostId}/latest`).catch(() => null)
        if (!latest || canceled) return
        setMeetingId(latest.meetingId)
        meetingIdRef.current = latest.meetingId
        if (latest.downloadReady) {
          setMeetingDownload({ meetingId: latest.meetingId, fileName: latest.downloadFileName, size: latest.downloadSize })
        } else if (latest.error?.message) {
          setMeetingStatus(`녹음 처리 실패: ${latest.error.message}`)
        }
        return
      }
      const remote = await apiFetch(`/meetings/${session.meetingId}`).catch(() => null)
      if (!remote || canceled) {
        await clearMeetingChunks(session.meetingId).catch(() => {})
        await deleteMeetingSession(sttPostId).catch(() => {})
        return
      }
      setMeetingId(session.meetingId)
      meetingIdRef.current = session.meetingId
      if (remote.downloadReady) {
        setMeetingDownload({ meetingId: session.meetingId, fileName: remote.downloadFileName, size: remote.downloadSize })
        await clearMeetingChunks(session.meetingId).catch(() => {})
        await deleteMeetingSession(sttPostId).catch(() => {})
      } else {
        const pending = await listMeetingChunks(session.meetingId).catch(() => [])
        setMeetingPendingChunks(pending.length)
        setMeetingStatus(pending.length ? `복구 가능한 미전송 조각 ${pending.length}개` : '중단된 녹음 세션이 있습니다.')
      }
    })()
    return () => { canceled = true }
  }, [isAiMeetingNote, sttPostId])

  useEffect(() => {
    if (!isRecording) return undefined
    const warn = (event) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [isRecording])

  function stopSttPolling() {
    if (sttPollTimerRef.current) {
      clearInterval(sttPollTimerRef.current)
      sttPollTimerRef.current = null
    }
    sttPollScopeRef.current = { postId: '', jobId: '' }
  }

  function updateSttUiState(postId, patch = {}, applyLocal = true) {
    const key = String(postId || '')
    if (!key) return

    const prev = STT_UI_STATE_CACHE.get(key) || {}
    const prevType = String(prev.statusType || '')
    const incomingType = String(patch.statusType || prevType || 'idle')
    const isTerminal = prevType === 'done' || prevType === 'failed'
    const incomingIsProcessing = incomingType === 'processing' || incomingType === 'queued'
    const incomingJobId = String(patch.jobId || prev.jobId || '')
    const prevJobId = String(prev.jobId || '')
    const sameJob = !incomingJobId || !prevJobId || incomingJobId === prevJobId

    if (isTerminal && incomingIsProcessing && sameJob) {
      return
    }

    const next = {
      status: typeof patch.status === 'string' ? patch.status : String(prev.status || ''),
      statusType: incomingType,
      errorReason: typeof patch.errorReason === 'string' ? patch.errorReason : String(prev.errorReason || ''),
      jobId: incomingJobId,
      updatedAt: Date.now(),
    }
    STT_UI_STATE_CACHE.set(key, next)

    if (applyLocal && activeSttPostIdRef.current === key) {
      setSttStatus(next.status)
      setSttStatusType(next.statusType || 'idle')
      setSttErrorReason(next.errorReason || '')
      sttJobIdRef.current = String(next.jobId || '')
    }
  }

  function inferSttStateFromText(rawText) {
    const src = String(rawText || '')
    if (!src.includes('## STT 상태')) return null
    if (src.includes('## STT 상태\n실패')) {
      return { type: 'failed', status: '회의록 작성 실패' }
    }
    if (src.includes('## STT 상태\n완료')) {
      return { type: 'done', status: '회의록 작성 완료' }
    }
    const m = src.match(/## STT 상태\s*[\r\n]+처리중\s*\((\d+)%\)/)
    if (m) {
      return { type: 'processing', status: `진행중 (${Number(m[1] || 0)}%)` }
    }
    return null
  }

  useEffect(() => {
    stopSttPolling()
    const postKey = String(sttPostId || '')
    activeSttPostIdRef.current = postKey
    const inferred = inferSttStateFromText(text)
    if (inferred && (inferred.type === 'done' || inferred.type === 'failed')) {
      updateSttUiState(postKey, {
        status: inferred.status,
        statusType: inferred.type,
        errorReason: inferred.type === 'failed' ? sttErrorReason : '',
      })
      return
    }
    const cached = postKey ? STT_UI_STATE_CACHE.get(postKey) : null
    if (cached) {
      sttJobIdRef.current = String(cached.jobId || '')
      setSttStatus(String(cached.status || ''))
      setSttStatusType(String(cached.statusType || 'idle'))
      setSttErrorReason(String(cached.errorReason || ''))
      if (cached.statusType === 'processing' && cached.jobId) {
        startSttPolling(postKey, String(cached.jobId))
      }
      return
    }
    if (inferred) {
      updateSttUiState(postKey, {
        status: inferred.status,
        statusType: inferred.type,
        errorReason: inferred.type === 'failed' ? sttErrorReason : '',
        jobId: '',
      })
      return
    }
    sttJobIdRef.current = ''
    setSttStatus('')
    setSttStatusType('idle')
    setSttErrorReason('')
  }, [sttPostId, text])

  function startSttPolling(postId, jobId) {
    const postKey = String(postId || '')
    if (!postKey || !jobId) return
    stopSttPolling()
    sttJobIdRef.current = jobId
    sttPollScopeRef.current = { postId: postKey, jobId: String(jobId) }
    sttPollTimerRef.current = setInterval(async () => {
      const scope = sttPollScopeRef.current
      if (scope.postId !== postKey || scope.jobId !== String(jobId)) return
      try {
        const data = await apiFetch(`/ai/stt/jobs/${jobId}`)
        if (data.status === 'queued' || data.status === 'processing') {
          updateSttUiState(postKey, {
            status: `진행중 (${Number(data.progress || 0)}%)`,
            statusType: 'processing',
            errorReason: '',
            jobId: String(jobId),
          }, activeSttPostIdRef.current === postKey)
          return
        }
        if (data.status === 'done') {
          updateSttUiState(postKey, {
            status: '회의록 작성 완료',
            statusType: 'done',
            errorReason: '',
            jobId: String(jobId),
          }, activeSttPostIdRef.current === postKey)
          stopSttPolling()
          return
        }
        if (data.status === 'failed') {
          const message = mapSttErrorToMessage(data?.error?.code, data?.error?.message)
          updateSttUiState(postKey, {
            status: '회의록 작성 실패',
            statusType: 'failed',
            errorReason: message,
            jobId: String(jobId),
          }, activeSttPostIdRef.current === postKey)
          stopSttPolling()
          return
        }
        if (data.status === 'canceled') {
          updateSttUiState(postKey, {
            status: '회의록 작성 실패',
            statusType: 'canceled',
            errorReason: '작업이 취소되었습니다.',
            jobId: String(jobId),
          }, activeSttPostIdRef.current === postKey)
          stopSttPolling()
        }
      } catch (_) {}
    }, 2500)
  }

  function mapSttErrorToMessage(code, fallback) {
    const table = {
      AUDIO_UNSUPPORTED_FORMAT: '지원하지 않는 음성 파일 형식입니다.',
      AUDIO_TOO_LONG: '음성 길이가 너무 깁니다. 파일을 분할해 주세요.',
      AUDIO_FILE_NOT_FOUND: '업로드된 음성 파일을 찾지 못했습니다.',
      AUDIO_DECODE_FAILED: '음성 디코딩에 실패했습니다.',
      MODEL_LOAD_FAILED: 'STT 모델 로딩에 실패했습니다.',
      DIARIZATION_FAILED: '화자 구분 처리에 실패했습니다.',
      TRANSCRIPTION_FAILED: '음성 전사 처리에 실패했습니다.',
      SUMMARY_FAILED: '회의 요약 생성에 실패했습니다.',
      POST_UPDATE_FAILED: '게시글 반영 중 충돌이 발생했습니다.',
      ATTACHMENT_NOT_READY: '첨부 업로드 완료 전에는 처리할 수 없습니다.',
    }
    return table[code] || fallback || 'STT 처리 중 오류가 발생했습니다.'
  }

  async function handleUploadRecordingFile(file) {
    if (!file) return
    if (!sttPostId || !sttChannelId) {
      alert('회의록 게시글에서만 업로드할 수 있습니다.')
      return
    }

    try {
      setSttUploading(true)
      updateSttUiState(sttPostId, {
        status: '파일 업로드 준비중...',
        statusType: 'processing',
        errorReason: '',
      })
      const prep = await apiFetch('/files/get-upload-url', {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          channelId: sttChannelId,
        }),
      })
      updateSttUiState(sttPostId, { status: '파일 업로드중...', statusType: 'processing' })
      await uploadFileWithProgress(prep.uploadUrl, file, () => {})
      updateSttUiState(sttPostId, { status: 'STT 작업 생성중...', statusType: 'processing' })
      const job = await apiFetch('/ai/stt/jobs', {
        method: 'POST',
        body: JSON.stringify({
          postId: sttPostId,
          attachmentId: prep.file_uuid,
          options: { diarization: true, diarizationRequired: false, language: 'ko' },
        }),
      })
      updateSttUiState(sttPostId, {
        status: job?.deduplicated ? '기존 STT 작업 재사용중...' : 'STT 처리 대기중...',
        statusType: 'processing',
        errorReason: '',
        jobId: String(job.jobId || ''),
      })
      startSttPolling(sttPostId, job.jobId)
    } catch (err) {
      updateSttUiState(sttPostId, {
        status: `오류: ${err.message}`,
        statusType: 'failed',
        errorReason: String(err?.message || '알 수 없는 오류'),
      })
    } finally {
      setSttUploading(false)
    }
  }

  async function handleRetryStt() {
    const jobId = sttJobIdRef.current
    if (!jobId) return
    try {
      await apiFetch(`/ai/stt/jobs/${jobId}/retry`, { method: 'POST' })
      updateSttUiState(sttPostId, {
        status: 'STT 재시도 대기중...',
        statusType: 'processing',
        errorReason: '',
        jobId: String(jobId),
      })
      startSttPolling(sttPostId, jobId)
    } catch (err) {
      updateSttUiState(sttPostId, {
        status: `재시도 실패: ${err.message}`,
        statusType: 'failed',
        errorReason: String(err?.message || '알 수 없는 오류'),
        jobId: String(jobId),
      })
    }
  }

  async function handleOpenCorrection() {
    const jobId = sttJobIdRef.current
    if (!jobId) return
    setCorrectionLoading(true)
    setShowCorrectionModal(true)
    try {
      const segs = await apiFetch(`/ai/stt/jobs/${jobId}/segments`)
      setCorrectionSegments(Array.isArray(segs) ? segs : [])
    } catch (_) {
      setCorrectionSegments([])
    } finally {
      setCorrectionLoading(false)
    }
  }

  async function handleCorrectionSave(segId, speakerName) {
    try {
      await apiFetch(`/ai/stt/segments/${segId}`, {
        method: 'PATCH',
        body: JSON.stringify({ speakerName }),
      })
      setCorrectionSegments((prev) =>
        prev.map((s) => (s.id === segId ? { ...s, speaker_name: speakerName } : s)),
      )
    } catch (_) {}
  }

  return (
    <div
      className="eds-markdown text-gray-700 leading-relaxed break-words select-text allow-copy cursor-text"
      style={contentFontStyle || undefined}
    >
      {isAiMeetingNote && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <label className="text-xs text-gray-500" htmlFor={`meeting-mic-${sttPostId}`}>마이크</label>
          <select
            id={`meeting-mic-${sttPostId}`}
            value={selectedMicId}
            onChange={(e) => setSelectedMicId(e.target.value)}
            onFocus={enumerateAudioDevices}
            disabled={isRecording}
            className="max-w-48 rounded-md border border-gray-300 px-2 py-1 text-xs disabled:opacity-60"
          >
            {availableMics.length === 0 && <option value="">기본 마이크</option>}
            {availableMics.map((mic) => (
              <option key={mic.deviceId} value={mic.deviceId}>{mic.label || '마이크'}</option>
            ))}
          </select>
          {isRecording && (
            <div className="h-2 w-20 overflow-hidden rounded bg-gray-200" title="마이크 입력 음량">
              <div className="h-full bg-emerald-500 transition-[width]" style={{ width: `${Math.round(volumeLevel * 100)}%` }} />
            </div>
          )}
          {canShowMeetingActionButtons(sttStatusType) && (
            <>
              <button
                type="button"
                onClick={handleStartMeetingRecording}
                disabled={isRecording || meetingPendingChunks > 0}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                  isRecording || meetingPendingChunks > 0
                    ? 'bg-red-50 text-red-600 border-red-200 cursor-not-allowed'
                    : 'bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700'
                }`}
              >
                웹 녹음 시작
              </button>
              <button
                type="button"
                onClick={() => sttFileInputRef.current?.click()}
                disabled={sttUploading}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors bg-emerald-100 text-emerald-700 border-emerald-300 hover:bg-emerald-200 disabled:opacity-60"
                title="녹음파일 업로드"
              >
                녹음파일 업로드
              </button>
            </>
          )}
          <input
            ref={sttFileInputRef}
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.webm"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) handleUploadRecordingFile(f)
            }}
          />
          {isRecording && (
            <>
              <span className="text-xs font-semibold text-red-600">
                🔴 {isRecordingPaused ? '일시정지' : '녹음 중'} {formatRecordingTime(recordingElapsedMs)}
              </span>
              <button
                type="button"
                onClick={handlePauseMeetingRecording}
                className="px-2 py-1 rounded-md text-[11px] font-semibold border border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100"
              >
                {isRecordingPaused ? '녹음 재개' : '일시정지'}
              </button>
              <button
                type="button"
                onClick={() => handleAddMarker('important')}
                className="px-2 py-1 rounded-md text-[11px] font-semibold border border-yellow-300 bg-yellow-50 text-yellow-700 hover:bg-yellow-100"
              >
                중요 발언
              </button>
              <button
                type="button"
                onClick={handleStopMeetingRecording}
                className="px-2 py-1 rounded-md text-[11px] font-semibold border border-red-300 bg-red-50 text-red-700 hover:bg-red-100"
              >
                녹음 종료
              </button>
              <span className="text-[11px] text-gray-500">
                {meetingStatus || '서버 자동 저장 중'}{meetingPendingChunks > 0 ? ` · 미전송 ${meetingPendingChunks}개` : ''}
              </span>
            </>
          )}
          {!isRecording && meetingStatus && (
            <span className="text-[11px] text-gray-500">{meetingStatus}</span>
          )}
          {!isRecording && meetingPendingChunks > 0 && (
            <button
              type="button"
              onClick={handleRecoverMeetingRecording}
              className="px-2 py-1 rounded-md text-[11px] font-semibold border border-violet-300 bg-violet-50 text-violet-700 hover:bg-violet-100"
            >
              미전송 녹음 복구
            </button>
          )}
          {meetingDownload?.meetingId && (
            <button
              type="button"
              onClick={handleDownloadMeetingAudio}
              className="px-2 py-1 rounded-md text-[11px] font-semibold border border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100"
              title={meetingDownload.fileName || '통합 음성 파일'}
            >
              통합 음성 다운로드
            </button>
          )}
          {!isRecording && sttStatus && (
            <span
              className={`text-xs font-semibold ${
                sttStatusType === 'processing'
                  ? (isBlinkOn ? 'text-amber-600' : 'text-amber-300')
                  : sttStatusType === 'done'
                    ? 'text-emerald-600'
                    : sttStatusType === 'failed'
                      ? 'text-red-600'
                      : 'text-gray-500'
              }`}
            >
              {sttStatus}
            </span>
          )}
          {!isRecording && sttStatusType === 'failed' && (
            <span className="text-xs text-red-500">사유: {sttErrorReason || '알 수 없는 오류'}</span>
          )}
          {!isRecording && sttStatusType === 'failed' && (
            <button
              type="button"
              onClick={handleRetryStt}
              className="px-2 py-1 rounded-md text-[11px] font-semibold border border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100"
            >
              재시도
            </button>
          )}
          {/* Stage 2: 화자 등록 관리 버튼 */}
          {featureFlags.USE_SPEAKER_REGISTRATION && sttChannelId && (
            <button
              type="button"
              onClick={() => setShowSpeakerModal(true)}
              className="px-2 py-1 rounded-md text-[11px] font-semibold border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
            >
              화자 관리
            </button>
          )}
          {/* Stage 3: 화자 수동 보정 버튼 (완료 시에만 표시) */}
          {featureFlags.USE_SPEAKER_CORRECTION && sttStatusType === 'done' && (
            <button
              type="button"
              onClick={handleOpenCorrection}
              className="px-2 py-1 rounded-md text-[11px] font-semibold border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
            >
              화자 보정
            </button>
          )}
        </div>
      )}

      {/* 화자 등록 관리 모달 */}
      {showSpeakerModal && (
        <SpeakerRegistrationModal
          channelId={sttChannelId}
          onClose={() => setShowSpeakerModal(false)}
        />
      )}

      {/* 화자 보정 모달 */}
      {showCorrectionModal && (
        <SpeakerCorrectionModal
          segments={correctionSegments}
          loading={correctionLoading}
          onSave={handleCorrectionSave}
          onClose={() => setShowCorrectionModal(false)}
        />
      )}
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkDisableSetextHeadings]}
        rehypePlugins={[rehypeKatex]}
        components={{
          p: ({ children }) => <p className="my-1.5 text-gray-700 leading-relaxed whitespace-pre-wrap break-words" style={{ fontSize: 'inherit' }}>{applyMentionColor(children)}</p>,
          h1: ({ children }) => <h1 className="mt-4 mb-2 text-gray-900 font-bold text-lg">{applyMentionColor(children)}</h1>,
          h2: ({ children }) => <h2 className="mt-4 mb-2 text-gray-900 font-bold text-base">{applyMentionColor(children)}</h2>,
          h3: ({ children }) => <h3 className="mt-3 mb-1.5 text-gray-900 font-semibold text-sm">{applyMentionColor(children)}</h3>,
          ul: ({ children }) => <ul className="list-disc pl-9 my-1.5 space-y-1">{children}</ul>,
          ol: ({ children, ...props }) => <ol {...props} className="list-decimal pl-5 my-1.5 space-y-1">{children}</ol>,
          li: ({ children }) => <li className="text-gray-700 break-words" style={{ fontSize: 'inherit' }}>{applyMentionColor(children)}</li>,
          hr: () => <hr className="border-gray-200 my-3" />,
          table: ({ children }) => (
            <div className="overflow-x-auto my-2">
              <table className="min-w-full border border-gray-200 rounded-lg overflow-hidden text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-gray-100 text-gray-900">{children}</thead>,
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => <tr className="border-b border-gray-200">{children}</tr>,
          th: ({ children }) => <th className="px-3 py-2 text-left font-semibold">{applyMentionColor(children)}</th>,
          td: ({ children }) => <td className="px-3 py-2 text-gray-700">{applyMentionColor(children)}</td>,
          pre: ({ children }) => <MarkdownPreBlock>{children}</MarkdownPreBlock>,
          code: ({ className, children }) => {
            const text = String(children ?? '')
            const isBlock = /language-/.test(String(className || '')) || text.includes('\n')
            if (!isBlock) {
              return <code className="bg-gray-200 text-indigo-600 px-1 rounded text-xs font-mono">{children}</code>
            }
            return <code className={`font-mono text-xs leading-relaxed ${className || ''}`.trim()}>{children}</code>
          },
        }}
      >
        {normalized}
      </ReactMarkdown>
      <LinkPreviewCards links={links} />
    </div>
  )
}

function SpeakerCorrectionModal({ segments, loading, onSave, onClose }) {
  const [editId, setEditId] = useState(null)
  const [editValue, setEditValue] = useState('')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-gray-900 font-bold text-base">화자 보정</h2>
            <p className="text-gray-400 text-xs mt-0.5">각 세그먼트의 화자 이름을 수정할 수 있습니다</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-1.5">
          {loading && <p className="text-center text-gray-400 text-sm py-8">불러오는 중...</p>}
          {!loading && segments.length === 0 && (
            <p className="text-center text-gray-400 text-sm py-8">세그먼트 데이터가 없습니다.</p>
          )}
          {segments.map((seg) => (
            <div key={seg.id} className="flex items-start gap-2 p-2.5 rounded-xl border border-gray-100 bg-gray-50 text-sm">
              <span className="text-[10px] text-gray-400 font-mono w-16 flex-shrink-0 pt-0.5">
                {String(Math.floor(seg.start_sec / 60)).padStart(2, '0')}:{String(Math.round(seg.start_sec % 60)).padStart(2, '0')}
              </span>
              {editId === seg.id ? (
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <input
                    className="border border-gray-200 rounded-lg px-2 py-0.5 text-xs w-28 focus:outline-none focus:border-sky-400"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { onSave(seg.id, editValue); setEditId(null) }
                      if (e.key === 'Escape') setEditId(null)
                    }}
                    autoFocus
                  />
                  <button
                    onClick={() => { onSave(seg.id, editValue); setEditId(null) }}
                    className="text-[10px] px-2 py-0.5 rounded bg-sky-600 text-white hover:bg-sky-700"
                  >확인</button>
                  <button onClick={() => setEditId(null)} className="text-[10px] text-gray-400 hover:text-gray-600">취소</button>
                </div>
              ) : (
                <button
                  onClick={() => { setEditId(seg.id); setEditValue(seg.speaker_name || seg.speaker_label || '') }}
                  className="text-[11px] font-semibold text-indigo-600 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-md flex-shrink-0 hover:bg-indigo-100"
                >
                  {seg.speaker_name || seg.speaker_label || 'SPEAKER'}
                </button>
              )}
              <span className="text-gray-700 text-xs leading-relaxed flex-1">{seg.text}</span>
            </div>
          ))}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl text-xs font-semibold border border-gray-200 text-gray-600 hover:bg-gray-100"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  )
}

// setext 제목 문법만 파서 단계에서 비활성화하는 remark 플러그인.
// - ATX 제목(`# 제목`, `## `, `### `)은 그대로 허용한다 (의도적 입력 → 예측 가능, Slack 캔버스와 동일).
// - setext 제목(텍스트 아래 `===` / `---` 밑줄)만 끈다 → 구분선 긋다가 의도치 않게 거대한 제목이
//   되는 사고를 막는다. (이번 게시글/댓글 렌더링 버그의 원인이 바로 setext였다.)
// - 본문 마크다운(굵게/리스트/표/코드블록/수평선 등)은 그대로 유지된다.
// - 수평선(`---` 단독 줄 = thematicBreak)은 별개 구문이라 영향 없음.
function remarkDisableSetextHeadings() {
  const data = this.data()
  const list = data.micromarkExtensions || (data.micromarkExtensions = [])
  list.push({ disable: { null: ['setextUnderline'] } })
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

function normalizeDashNumberedLists(text) {
  const lines = String(text || '').split('\n')
  let inFence = false

  return normalizeBrokenOrderedListItems(lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      return line
    }
    if (inFence) return line
    return line.replace(/^(\s*)-\s+(\d+)\.\s+(.+)$/, '$1$2. $3')
  }).join('\n'))
}

// ─── Compose bar with file attach ────────────────────────────

function ComposeBar({ onSubmit, isArchived, channelId, contentFontScale = 100 }) {
  const t = useT()
  const { currentUser, maxAttachmentFileSize } = useAuth()
  const { selectedChannel } = useChat()
  const [content, setContent] = useState('')
  const [files, setFiles] = useState([])
  const [dragOver, setDragOver] = useState(false)
  const [sending, setSending] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(null)
  const [duplicateFileDialog, setDuplicateFileDialog] = useState(null)
  const [focused, setFocused] = useState(false)
  const [securityLevel, setSecurityLevel] = useState(Math.min(1, currentUser?.security_level ?? 0))
  const maxSelectableLevel = currentUser?.role === 'site_admin' ? 4 : (currentUser?.security_level ?? 0)

  const contentRef = useRef(null)
  const fileInputRef = useRef(null)
  const dragCounter = useRef(0)
  const composeWrapRef = useRef(null)
  const mention = useMentionAutocomplete(channelId)

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

  function handleTextareaPaste(e) {
    const pastedImages = getPastedImageFiles(e)
    if (pastedImages.length === 0) return
    e.preventDefault()
    addFiles(pastedImages)
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
    const duplicateNames = findDuplicateFileNames(files)
    if (duplicateNames.length > 0) {
      setDuplicateFileDialog(duplicateNames)
      return
    }
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
    } catch (err) {
      if (err?.status !== 403) {
        alert(t.chat.sendError(err.message))
      }
    } finally {
      setSending(false)
      setUploadProgress(null)
    }
  }

  function handleKeyDown(e) {
    // mention 드롭다운이 열려있을 때 방향키/Enter/Tab/Escape 가로챔
    if (mention.open) {
      const handled = mention.handleKeyDown(e)
      if (handled) {
        e.preventDefault()
        if ((e.key === 'Enter' || e.key === 'Tab') && mention.users[mention.selectedIdx]) {
          mention.selectUser(mention.users[mention.selectedIdx], content, contentRef.current?.selectionStart ?? content.length, (newText, newCursor) => {
            setContent(newText)
            requestAnimationFrame(() => {
              if (contentRef.current) {
                contentRef.current.selectionStart = newCursor
                contentRef.current.selectionEnd = newCursor
              }
            })
          })
        }
        return
      }
    }
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
  }

  const hasContent = content.trim().length > 0 || files.length > 0
  const showActions = focused || hasContent
  const contentFontStyle = getContentFontStyle(contentFontScale)

  if (isArchived) {
    return (
      <div className="h-full min-h-0 px-4 py-8 border-t border-gray-200 flex flex-col items-center justify-center bg-white/2">
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
    <>
      <div className="h-full min-h-0 flex flex-col px-4 py-3 border-t border-gray-200">
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />

      <div
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={`flex-1 min-h-0 flex flex-col rounded-2xl border transition-all duration-150 relative overflow-hidden ${
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

        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {/* Content textarea row */}
          <div className="flex items-stretch gap-3 px-4 pt-3 pb-2 flex-1 min-h-0">
            {currentUser && (
              <div className="flex-shrink-0 self-start">
                <Avatar letters={currentUser.avatar} imageUrl={currentUser.image_url} size="sm" />
              </div>
            )}
            <div ref={composeWrapRef} className="flex-1 relative min-h-0 h-full">
              <textarea
                ref={contentRef}
                value={content}
                onChange={e => {
                  setContent(e.target.value)
                  mention.handleChange(e.target.value, e.target.selectionStart, e.target)
                }}
                onFocus={() => setFocused(true)}
                onClick={e => mention.handleChange(e.currentTarget.value, e.currentTarget.selectionStart, e.currentTarget)}
                onKeyUp={e => mention.handleChange(e.currentTarget.value, e.currentTarget.selectionStart, e.currentTarget)}
                onKeyDown={handleKeyDown}
                onPaste={handleTextareaPaste}
                onDragOver={handleTextareaDragOver}
                onDrop={handleTextareaDrop}
                placeholder={t.chat.messagePlaceholder}
                className="w-full h-full min-h-0 bg-transparent text-gray-800 placeholder-gray-400 leading-relaxed resize-none focus:outline-none pt-0.5 overflow-y-auto"
                style={contentFontStyle}
              />
              {mention.open && (
                <MentionDropdown
                  users={mention.users}
                  selectedIdx={mention.selectedIdx}
                  position={mention.cursorCoords}
                  onSelect={user => mention.selectUser(user, content, contentRef.current?.selectionStart ?? content.length, (newText, newCursor) => {
                    setContent(newText)
                    requestAnimationFrame(() => {
                      if (contentRef.current) {
                        contentRef.current.selectionStart = newCursor
                        contentRef.current.selectionEnd = newCursor
                        contentRef.current.focus()
                      }
                    })
                  })}
                />
              )}
            </div>
          </div>

          {/* Attached files preview */}
          {files.length > 0 && (
            <div className="px-4 pb-2 pl-[52px] flex-shrink-0 min-h-0">
              <div className="max-h-32 overflow-y-auto overscroll-contain pr-1 flex flex-wrap gap-2">
                {files.map(f => <FileChip key={f.id} file={f} onRemove={removeFile} />)}
              </div>
            </div>
          )}
        </div>

        {/* Action row — shown when focused or has content */}
        {showActions && (
          <div className="px-3 pb-3 pl-[52px] flex-shrink-0">
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

        <p className="text-gray-300 text-xs mt-1.5 px-1 flex-shrink-0">
          {t.chat.messageHint}
        </p>
      </div>
      {duplicateFileDialog && (
        <ConfirmDialog
          title={t.chat.fileAttachDuplicateTitle || '중복 파일명 경고'}
          titleTone="blue"
          message={t.chat.fileAttachDuplicateMessage || '첨부파일에 같은 이름이 있습니다. 파일명을 변경한 뒤 다시 게시해 주세요.'}
          highlightItems={duplicateFileDialog}
          confirmText={t.chat.confirm || '확인'}
          hideCancel
          onConfirm={() => setDuplicateFileDialog(null)}
          onCancel={() => setDuplicateFileDialog(null)}
        />
      )}
    </>
  )
}

// ─── Post List ────────────────────────────────────────────────

function PostList({ posts, onSelect, onOpenActionMenu, onSubmit, selectedPostId, onOpenDocumentList, contentFontScale = 100 }) {
  const t = useT()
  const {
    selectedChannel,
    selectedTeam,
    refreshTeams,
    markPostRead,
    fetchDeletedItems,
    restorePost,
    restoreComment,
    postPageMeta,
    loadOlderPosts,
  } = useChat()
  const pinnedPosts = posts
    .filter(p => p.pinned)
    .sort((a, b) => {
      const ta = new Date(a.pinned_at || a.createdAt || 0).getTime()
      const tb = new Date(b.pinned_at || b.createdAt || 0).getTime()
      return tb - ta
    })
  const normalPosts = posts.filter(p => !p.pinned)
  const normalRows = buildDateSeparatedRows(
    normalPosts,
    (p) => p.createdAt,
    (p) => `post-${p.id}`,
  )
  // 피드 맨 아래(가장 최근) 글. append 감지·자동 스크롤 기준점. (UI.md 1.4)
  const newestPost = normalPosts.length ? normalPosts[normalPosts.length - 1] : null
  const newestPostId = newestPost ? String(newestPost.id) : null
  const feedRef = useRef(null)
  const bottomRef = useRef(null)
  const initialScrollChannelRef = useRef(null)
  const pendingScrollRestoreRef = useRef(null)
  const scrollMetricsRef = useRef({ channelId: null, postsLength: 0, scrollHeight: 0, scrollTop: 0 })
  const prependInProgressRef = useRef(false)
  // 새 글 append 자동 스크롤(바닥 고정)용. (UI.md 1.4)
  const lastPostIdRef = useRef(null)
  const lastPostChannelRef = useRef(null)
  const isNearBottomRef = useRef(true)
  const [showManageModal, setShowManageModal] = useState(false)
  const [showDeletedModal, setShowDeletedModal] = useState(false)
  const { currentUser } = useAuth()
  const isAdmin = ['Admin', 'site_admin', 'channel_admin', 'team_admin'].includes(currentUser?.role)
  const pageState = postPageMeta?.[selectedChannel?.id] || {}

  useLayoutEffect(() => {
    const channelId = selectedChannel?.id
    if (!channelId || posts.length === 0 || initialScrollChannelRef.current === channelId) return
    bottomRef.current?.scrollIntoView({ behavior: 'auto' })
    initialScrollChannelRef.current = channelId
  }, [posts.length, selectedChannel?.id])

  // 새 글이 하단에 추가되면(append) 바닥으로 스크롤한다(바닥 고정 패턴). (UI.md 1.3~1.4)
  //   - 내가 방금 쓴 글이거나, 사용자가 이미 바닥 근처면 스크롤한다.
  //   - 위로 올려 과거 글을 읽는 중이면 끌어내리지 않는다.
  //   - 과거 글 로딩(prepend)/최초 진입 스크롤과는 충돌하지 않게 분리한다.
  useLayoutEffect(() => {
    const channelId = selectedChannel?.id
    if (!channelId) return

    // 채널 최초 계산: 기준점만 잡고 스킵(최초 바닥 스크롤은 위 효과가 담당).
    if (lastPostChannelRef.current !== channelId) {
      lastPostChannelRef.current = channelId
      lastPostIdRef.current = newestPostId
      isNearBottomRef.current = true
      return
    }

    const prevNewestId = lastPostIdRef.current
    lastPostIdRef.current = newestPostId
    // 맨 아래 글이 새로 바뀐 append만 대상. 최초 계산(prev=null)은 최초 스크롤이 처리했으므로 스킵.
    if (!newestPostId || newestPostId === prevNewestId || prevNewestId === null) return
    // 과거 글 로딩(prepend) 중이면 위치 보정과 충돌하므로 스킵.
    if (prependInProgressRef.current || pendingScrollRestoreRef.current) return

    const isOwnPost = newestPost?.author?.id != null && newestPost.author.id === currentUser?.id
    if (isOwnPost || isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [newestPostId, selectedChannel?.id])

  useLayoutEffect(() => {
    const pending = pendingScrollRestoreRef.current
    const feed = feedRef.current
    if (!feed) return
    const previous = scrollMetricsRef.current

    if (pending && posts.length > pending.postsLength) {
      feed.scrollTop = feed.scrollHeight - pending.scrollHeight + pending.scrollTop
      pendingScrollRestoreRef.current = null
      prependInProgressRef.current = false
    } else if (
      prependInProgressRef.current &&
      previous.channelId === selectedChannel?.id &&
      posts.length > previous.postsLength &&
      previous.scrollHeight > 0
    ) {
      feed.scrollTop = previous.scrollTop + (feed.scrollHeight - previous.scrollHeight)
      prependInProgressRef.current = false
    }

    scrollMetricsRef.current = {
      channelId: selectedChannel?.id || null,
      postsLength: posts.length,
      scrollHeight: feed.scrollHeight,
      scrollTop: feed.scrollTop,
    }
  }, [posts.length, selectedChannel?.id])

  useEffect(() => {
    const openDocuments = () => onOpenDocumentList?.()
    const openDeleted = () => setShowDeletedModal(true)
    const openManage = () => { if (isAdmin) setShowManageModal(true) }
    window.addEventListener('easy-board-open-documents', openDocuments)
    window.addEventListener('easy-board-open-deleted', openDeleted)
    window.addEventListener('easy-board-open-channel-manage', openManage)
    return () => {
      window.removeEventListener('easy-board-open-documents', openDocuments)
      window.removeEventListener('easy-board-open-deleted', openDeleted)
      window.removeEventListener('easy-board-open-channel-manage', openManage)
    }
  }, [isAdmin, onOpenDocumentList])

  useEffect(() => {
    if (pageState.loadingOlder || pageState.prefetching) {
      prependInProgressRef.current = true
    }
  }, [pageState.loadingOlder, pageState.prefetching])

  useEffect(() => {
    const feed = feedRef.current
    if (!feed) return
    scrollMetricsRef.current = {
      channelId: selectedChannel?.id || null,
      postsLength: posts.length,
      scrollHeight: feed.scrollHeight,
      scrollTop: feed.scrollTop,
    }
  }, [posts.length, selectedChannel?.id])

  useEffect(() => {
    pendingScrollRestoreRef.current = null
  }, [selectedChannel?.id])

  const handleFeedScroll = useCallback((event) => {
    const feed = event.currentTarget
    // 바닥 근처 여부를 갱신한다(새 글 append 자동 스크롤 판정용). (UI.md 1.4)
    isNearBottomRef.current = feed.scrollHeight - (feed.scrollTop + feed.clientHeight) <= 120
    if (selectedChannel?.id) {
      scrollMetricsRef.current = {
        channelId: selectedChannel.id,
        postsLength: posts.length,
        scrollHeight: feed.scrollHeight,
        scrollTop: feed.scrollTop,
      }
    }
    if (!selectedChannel?.id || !pageState.hasMore || pageState.loadingOlder || pageState.prefetching) return
    const nearOlderEdge = feed.scrollTop <= Math.max(160, feed.scrollHeight * 0.2)
    if (!nearOlderEdge) return
    pendingScrollRestoreRef.current = {
      scrollHeight: feed.scrollHeight,
      scrollTop: feed.scrollTop,
      postsLength: posts.length,
    }
    loadOlderPosts(selectedChannel.id)
  }, [
    loadOlderPosts,
    pageState.hasMore,
    pageState.loadingOlder,
    pageState.prefetching,
    posts.length,
    selectedChannel?.id,
  ])

  function handleSelectPost(post) {
    if (selectedPostId && String(selectedPostId) !== String(post.id)) {
      markPostRead(selectedChannel.id, selectedPostId)
    }
    onSelect(post)
  }

  function renderPostRows(rows) {
    return rows.map((row) => (
      row.type === 'divider' ? (
        <div key={row.key} className="flex items-center gap-3 my-2">
          <div className="flex-1 h-px bg-gray-200" />
          <span className="text-[13px] text-black font-medium whitespace-nowrap">
            {`──────── ${row.label} ────────`}
          </span>
          <div className="flex-1 h-px bg-gray-200" />
        </div>
      ) : (
        <PostCard
          key={row.key}
          post={row.item}
          onSelect={handleSelectPost}
          onOpenActionMenu={onOpenActionMenu}
          isSelected={row.item.id === selectedPostId}
          contentFontScale={contentFontScale}
        />
      )
    ))
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {showManageModal && (
        <ChannelManageModal
          onClose={() => setShowManageModal(false)}
          onSave={() => refreshTeams()}
        />
      )}

      {showDeletedModal && (
        <RecentlyDeletedModal
          channelId={selectedChannel.id}
          fetchDeletedItems={fetchDeletedItems}
          restorePost={restorePost}
          restoreComment={restoreComment}
          onClose={() => setShowDeletedModal(false)}
        />
      )}

      <PanelGroup
        direction="vertical"
        autoSaveId={`post-list-compose:${currentUser?.id ?? 'anon'}:${selectedChannel?.id ?? 'none'}`}
        className="flex-1 min-h-0"
      >
        <Panel defaultSize={72} minSize={25} className="overflow-hidden">
          {/* Feed */}
          <div
            ref={feedRef}
            onScroll={handleFeedScroll}
            className="h-full overflow-y-auto px-6 pt-1 pb-4"
          >
            {posts.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center py-16">
                <div className="w-16 h-16 rounded-2xl bg-indigo-50 border border-indigo-200 flex items-center justify-center text-3xl mb-4">📄</div>
                <h3 className="text-gray-900 font-semibold mb-1">{t.chat.noPostsTitle}</h3>
                <p className="text-gray-400 text-sm">{t.chat.noPostsDesc}</p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {pageState.loadingOlder && (
                  <div className="py-2 text-center text-xs font-semibold text-gray-400">
                    이전 글을 불러오는 중...
                  </div>
                )}
                {pinnedPosts.length > 0 && (
                  <div className="sticky top-0 z-20 -mx-2 px-2 py-2 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80 border-b border-amber-100 rounded-xl">
                    <div className="flex items-center gap-2 text-amber-600/70 text-xs font-medium uppercase tracking-widest mb-2">
                      <PinIcon /><span>{t.chat.pinnedPost}</span>
                    </div>
                    <div className="flex flex-col gap-2 max-h-[38vh] overflow-y-auto pr-1">
                      {pinnedPosts.map(p => <PostCard key={p.id} post={p} onSelect={handleSelectPost} onOpenActionMenu={onOpenActionMenu} pinned isSelected={p.id === selectedPostId} contentFontScale={contentFontScale} />)}
                    </div>
                  </div>
                )}
                {pinnedPosts.length > 0 && normalRows.length > 0 && (
                  <div className="border-t border-gray-100 my-1" />
                )}
                {renderPostRows(normalRows)}
                <div ref={bottomRef} />
              </div>
            )}
          </div>
        </Panel>
        <PanelResizeHandle className="h-1.5 bg-gray-200 hover:bg-indigo-400 active:bg-indigo-500 transition-colors flex-shrink-0" />
        <Panel defaultSize={28} minSize={12} className="overflow-hidden">
          <ComposeBar
            key={`compose-${currentUser?.id ?? 'anon'}-${selectedChannel?.id ?? 'none'}`}
            onSubmit={onSubmit}
            isArchived={selectedChannel?.is_archived}
            channelId={selectedChannel?.id}
            contentFontScale={contentFontScale}
          />
        </Panel>
      </PanelGroup>
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
    const isMd = isMdPage(post.content)
    const isSheet = isEasySheet(post.content)
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
    } else if (isMd) {
      items.push({
        key: `${post.id}-md`,
        kind: 'template',
        icon: '📝',
        title: getMdPageTitle(post.content, t.mdPage.title).slice(0, 100),
        post,
      })
    } else if (isSheet) {
      items.push({
        key: `${post.id}-sheet`,
        kind: 'template',
        icon: '📊',
        title: getEasySheetTitle(post.content, t.easySheet?.title || 'EasySheet').slice(0, 100),
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

function resolvePreviewUrl(rawUrl = '', withToken = false) {
  if (!rawUrl) return ''
  if (/^https?:\/\//i.test(rawUrl) || rawUrl.startsWith('blob:')) return rawUrl
  if (!withToken) return rawUrl
  const token = getToken()
  if (!token) return rawUrl
  return rawUrl.includes('?') ? `${rawUrl}&auth_token=${token}` : `${rawUrl}?auth_token=${token}`
}

function PostCardPreview({ post, rawForParsing = '', isTemplate = false, isMailCard = false }) {
  const [failed, setFailed] = useState(false)
  const width = Math.max(120, Math.round(480 / 3))
  const height = Math.max(72, Math.round(270 / 3))

  const preview = useMemo(() => {
    const previewAttachment = (post.attachments || []).find((f) => {
      const category = getFileCategory(String(f?.type || ''), String(f?.name || ''))
      // 이미지는 원본으로, 그 외(PDF·PPT·오피스 문서·영상 등)는 썸네일이 있으면 미리보기
      if (category === 'image') return Boolean(f?.url)
      return Boolean(f?.thumbnail_url)
    }) || null

    if (previewAttachment) {
      const category = getFileCategory(String(previewAttachment.type || ''), String(previewAttachment.name || ''))
      const src = category === 'image'
        ? resolvePreviewUrl(previewAttachment.url, true)
        : resolvePreviewUrl(previewAttachment.thumbnail_url, true)
      return src ? { kind: 'attachment', src, alt: previewAttachment.name || 'preview' } : null
    }

    if (!isTemplate && !isMailCard) {
      const firstUrl = extractHttpUrls(rawForParsing)[0]
      if (firstUrl) {
        return {
          kind: 'link',
          src: `/api/files/link-preview-image?url=${encodeURIComponent(firstUrl)}&width=480&height=270&auth_token=${encodeURIComponent(getToken() || '')}`,
          alt: 'link preview',
        }
      }
    }
    return null
  }, [isMailCard, isTemplate, post.attachments, rawForParsing])

  useEffect(() => {
    setFailed(false)
  }, [preview?.src])

  if (!preview) return null

  return (
    <div className="flex-shrink-0 self-start ml-2">
      <div
        className="rounded-lg overflow-hidden border border-gray-200 bg-gray-100"
        style={{ width, height }}
        onClick={(e) => e.stopPropagation()}
      >
        {!failed ? (
          <img
            src={preview.src}
            alt={preview.alt}
            loading="lazy"
            className="block w-full h-full object-cover"
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[10px] text-gray-400">
            preview
          </div>
        )}
      </div>
    </div>
  )
}

function PostCard({ post, onSelect, onOpenActionMenu, pinned, isSelected, contentFontScale = 100 }) {
  const t = useT()
  const isTemplate = isTemplateContent(post.content)
  const isMd = isMdPage(post.content)
  const isSheet = isEasySheet(post.content)
  const isMailCard = isMailCardContent(post.content)
  const templateMeta = isTemplate
    ? FORM_TEMPLATES.find(f => post.content.includes(`<title>${f.label}`))
    : null
  // MD 페이지는 마커를 제거한 뒤 파싱. EasySheet는 본문이 JSON이라 미리보기 텍스트를 만들지 않는다.
  const rawForParsing = isMd ? getMdPageContent(post.content) : (isSheet ? '' : (post.content || ''))
  const sanitizedRawForParsing = sanitizePostPreviewTextKeepLines(rawForParsing)
  const plain = isTemplate ? [] : sanitizedRawForParsing
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
    : isMd
      ? getMdPageTitle(post.content, t.mdPage.title).slice(0, 100)
      : isSheet
        ? `📊 ${getEasySheetTitle(post.content, t.easySheet?.title || 'EasySheet').slice(0, 100)}`
        : (String(post.content || '').includes('<!--ai-meeting-note-->') && post.title)
          ? `📋 ${post.title}`
          : (plain[0] || '')
  const bodyPreview = isTemplate
    ? ''
    : plain.slice(1).join('\n')
  const attachCount = post.attachments?.length || 0
  const metadataCommentCount = Number(post.comment_count)
  const commentCount = Number.isFinite(metadataCommentCount)
    ? metadataCommentCount
    : (post.comments?.length || 0)
  const trainingStatus = post.training_status || null
  const [copyToast, setCopyToast] = useState(null)
  const {
    handleMouseDown,
    handleMouseUp,
    handleClickCapture,
    shouldBlockClick,
  } = useSelectionClickGuard({ scope: 'post-card', dragThreshold: 4, blockOnAnySelection: true })
  const contentFontStyle = getContentFontStyle(contentFontScale)

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
        onContextMenu={(event) => {
          if (event.target?.closest?.('a, button, input, textarea, select, [data-attachment]')) return
          event.preventDefault()
          event.stopPropagation()
          setCopyToast(null)
          onOpenActionMenu?.(event, post)
        }}
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
            {post.isUnread && !pinned && (
              <span
                className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0"
                title={post.unreadCommentCount > 0 ? `읽지 않은 댓글 ${post.unreadCommentCount}개` : '읽지 않은 글'}
              />
            )}
            {pinned && <PinIcon />}
            {isMd && (
              <span
                title="EasyPage"
                aria-label="EasyPage 문서"
                className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-indigo-200 bg-indigo-100 px-1.5 py-0.5 text-[10px] font-bold leading-none text-indigo-700"
              >
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 3h9l3 3v15H6z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 3v4h4M9 11h6M9 15h6" />
                </svg>
                EasyPage
              </span>
            )}
            {leadLine && (
              <p className="text-gray-800 font-semibold leading-tight group-hover:text-indigo-600 transition-colors overflow-hidden text-ellipsis whitespace-nowrap select-text allow-copy cursor-text" style={{ ...contentFontStyle, fontSize: 'calc(0.875rem * var(--content-font-scale))' }}>
                {renderPostPreviewTokens(leadLine, `lead-${post.id}`)}
              </p>
            )}
          </div>
          {/* Meta */}
          <div className={`flex items-center gap-2 text-gray-400 select-text allow-copy ${(bodyPreview && !pinned) ? 'mb-1' : 'mb-0'}`} style={{ ...contentFontStyle, fontSize: 'calc(0.75rem * var(--content-font-scale))' }}>
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
                <TrainingStatusBadge status={trainingStatus} error={post.training_error} />
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
          {/* Body preview (second line onward) — 고정글은 제목/작성자/날짜만 노출하고 본문은 숨김 */}
          {bodyPreview && !pinned && (
            <p
              className="text-gray-400 leading-relaxed line-clamp-5 whitespace-pre-wrap break-words select-text allow-copy cursor-text"
              style={{ ...contentFontStyle, fontSize: 'calc(0.75rem * var(--content-font-scale))' }}
            >
              {renderPostPreviewTokens(bodyPreview, `body-${post.id}`)}
            </p>
          )}
        </div>
        <PostCardPreview post={post} rawForParsing={rawForParsing} isTemplate={isTemplate} isMailCard={isMailCard} />
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

export default function ChatArea({ autoOpenPostId, isMobile = false, onExitChannel }) {
  const {
    selectedChannel,
    posts,
    addPost,
    pendingOpenPostId,
    pendingOpenCommentId,
    pendingOpenAttachmentId,
    navigateToPost,
    fetchPost,
    clearPendingPost,
    setSelectedPostContext,
    clearSelectedPostContext,
  } = useChat()
  const t = useT()
  const [selectedPost, setSelectedPost] = useState(null)
  const [showDocumentList, setShowDocumentList] = useState(false)
  const [leftWidth, setLeftWidth] = useState(42) // percent
  const [resizing, setResizing] = useState(false)
  const [contentFontScale, setContentFontScale] = useState(100)
  const [pendingPostActionMenu, setPendingPostActionMenu] = useState(null)
  const containerRef = useRef(null)
  const selectedPostRef = useRef(null)
  const selectedChannelRef = useRef(null)
  const easyPageNavigationStackRef = useRef([])

  useEffect(() => { selectedPostRef.current = selectedPost }, [selectedPost])
  useEffect(() => { selectedChannelRef.current = selectedChannel }, [selectedChannel])

  const getEasyPageNavigationEntry = useCallback((channel = selectedChannelRef.current, post = selectedPostRef.current) => {
    if (!channel?.id || !post?.id || !isMdPage(post.content)) return null
    return {
      channelId: String(channel.id),
      postId: String(post.id),
      title: getMdPageTitle(post.content, 'EasyPage'),
      openedAt: Date.now(),
    }
  }, [])

  const buildPostUrl = useCallback((channelId, postId) => {
    if (typeof window === 'undefined') return ''
    const url = new URL(window.location.href)
    url.searchParams.set('channelId', String(channelId))
    url.searchParams.set('postId', String(postId))
    url.searchParams.delete('commentId')
    url.searchParams.delete('attachmentId')
    return `${url.pathname}${url.search}${url.hash}`
  }, [])

  const writeEasyPageHistory = useCallback((channelId, postId, { replace = false } = {}) => {
    if (typeof window === 'undefined' || !channelId || !postId) return
    const next = buildPostUrl(channelId, postId)
    const state = {
      ...(window.history.state || {}),
      easyPage: true,
      channelId: String(channelId),
      postId: String(postId),
    }
    if (replace) window.history.replaceState(state, '', next)
    else window.history.pushState(state, '', next)
  }, [buildPostUrl])

  const pushEasyPageNavigation = useCallback((entry) => {
    if (!entry?.channelId || !entry?.postId) return false
    const stack = easyPageNavigationStackRef.current
    const last = stack[stack.length - 1]
    if (last && last.channelId === entry.channelId && last.postId === entry.postId) return false
    stack.push(entry)
    return true
  }, [])

  const openEasyPageEntry = useCallback(async (entry) => {
    if (!entry?.channelId || !entry?.postId) return false
    const currentChannel = selectedChannelRef.current

    if (String(entry.channelId) === String(currentChannel?.id)) {
      const channelPosts = Array.isArray(posts[entry.channelId]) ? posts[entry.channelId] : []
      const localPost = channelPosts.find(p => String(p.id) === String(entry.postId))
      if (localPost) {
        setSelectedPost(localPost)
        writeEasyPageHistory(entry.channelId, entry.postId, { replace: true })
        return true
      }
      const fetched = await fetchPost(entry.channelId, entry.postId)
      if (fetched) {
        setSelectedPost(fetched)
        writeEasyPageHistory(entry.channelId, entry.postId, { replace: true })
        return true
      }
      return false
    }

    const opened = await navigateToPost(entry.channelId, entry.postId)
    if (opened) {
      writeEasyPageHistory(entry.channelId, entry.postId, { replace: true })
    }
    return Boolean(opened)
  }, [fetchPost, navigateToPost, posts, writeEasyPageHistory])

  const openPreviousEasyPageFromStack = useCallback(async () => {
    while (easyPageNavigationStackRef.current.length > 0) {
      const previous = easyPageNavigationStackRef.current.pop()
      try {
        const opened = await openEasyPageEntry(previous)
        if (opened) return true
      } catch (err) {
        console.error('Failed to open previous EasyPage:', err)
      }
    }
    return false
  }, [openEasyPageEntry])

  const clearEasyPageNavigationStack = useCallback(() => {
    easyPageNavigationStackRef.current = []
  }, [])

  const handleEasyPageBack = useCallback(async () => {
    if (easyPageNavigationStackRef.current.length > 0) {
      window.history.back()
      return
    }
    clearEasyPageNavigationStack()
    setSelectedPost(null)
  }, [clearEasyPageNavigationStack])

  useEffect(() => {
    apiFetch('/config/display')
      .then(data => setContentFontScale(normalizeContentFontScale(data?.contentFontScale)))
      .catch(() => {})
  }, [])

  useEffect(() => {
    clearEasyPageNavigationStack()
  }, [selectedChannel?.id, clearEasyPageNavigationStack])

  // 검색 결과로 선택된 게시글 자동 오픈
  useEffect(() => {
    if (!autoOpenPostId) return
    const channelPosts = Array.isArray(posts[selectedChannel?.id]) ? posts[selectedChannel?.id] : []
    const target = channelPosts.find(p => String(p.id) === String(autoOpenPostId))
    if (target) setSelectedPost(target)
  }, [autoOpenPostId, selectedChannel?.id, posts])

  // RAG 참고 문서 클릭으로 이동된 게시글 자동 오픈
  useEffect(() => {
    if (!pendingOpenPostId) return
    const channelPosts = Array.isArray(posts[selectedChannel?.id]) ? posts[selectedChannel?.id] : []
    const target = channelPosts.find(p => String(p.id) === String(pendingOpenPostId))
    if (target) {
      setSelectedPost(target)
      if (!pendingOpenCommentId && !pendingOpenAttachmentId) {
        clearPendingPost()
      }
    }
  }, [pendingOpenPostId, pendingOpenCommentId, pendingOpenAttachmentId, selectedChannel?.id, posts, clearPendingPost])

  const handleOpenPostLink = useCallback(async (targetChannelId, targetPostId) => {
    if (!targetChannelId || !targetPostId) return false

    const currentEntry = getEasyPageNavigationEntry()
    const isSamePost = currentEntry
      && String(currentEntry.channelId) === String(targetChannelId)
      && String(currentEntry.postId) === String(targetPostId)
    if (isSamePost) return true

    if (String(targetChannelId) === String(selectedChannel?.id)) {
      const channelPosts = Array.isArray(posts[targetChannelId]) ? posts[targetChannelId] : []
      const target = channelPosts.find(p => String(p.id) === String(targetPostId))
      if (target) {
        if (currentEntry) pushEasyPageNavigation(currentEntry)
        setSelectedPost(target)
        writeEasyPageHistory(targetChannelId, targetPostId)
        return true
      }
      try {
        const fetched = await fetchPost(targetChannelId, targetPostId)
        if (fetched) {
          if (currentEntry) pushEasyPageNavigation(currentEntry)
          setSelectedPost(fetched)
          writeEasyPageHistory(targetChannelId, targetPostId)
          return true
        }
      } catch (err) {
        console.error('Failed to open linked post:', err)
      }
    }

    const opened = await navigateToPost(targetChannelId, targetPostId)
    if (opened) {
      if (currentEntry) pushEasyPageNavigation(currentEntry)
      writeEasyPageHistory(targetChannelId, targetPostId)
    }
    return Boolean(opened)
  }, [
    fetchPost,
    getEasyPageNavigationEntry,
    navigateToPost,
    posts,
    pushEasyPageNavigation,
    selectedChannel?.id,
    writeEasyPageHistory,
  ])

  useEffect(() => {
    function handlePopState() {
      if (easyPageNavigationStackRef.current.length === 0) return
      openPreviousEasyPageFromStack()
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [openPreviousEasyPageFromStack])

  const handleSelectPost = useCallback((post) => {
    clearEasyPageNavigationStack()
    setPendingPostActionMenu(null)
    setSelectedPost(post)
  }, [clearEasyPageNavigationStack])

  const handleOpenPostActionMenu = useCallback((event, post) => {
    clearEasyPageNavigationStack()
    setSelectedPost(post)
    setPendingPostActionMenu({
      postId: post.id,
      x: event.clientX,
      y: event.clientY,
      requestId: Date.now(),
    })
  }, [clearEasyPageNavigationStack])

  const consumePostActionMenu = useCallback((requestId) => {
    setPendingPostActionMenu(current => current?.requestId === requestId ? null : current)
  }, [])

  const handleCloseSelectedPost = useCallback(() => {
    clearEasyPageNavigationStack()
    setPendingPostActionMenu(null)
    setSelectedPost(null)
  }, [clearEasyPageNavigationStack])

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
    const detailMinWidth = Math.min(520, containerRect.width * 0.72)
    const maxLeftWidth = Math.min(80, ((containerRect.width - detailMinWidth) / containerRect.width) * 100)
    const clampedWidth = Math.min(Math.max(newWidth, 20), maxLeftWidth)
    if (clampedWidth >= 20) setLeftWidth(clampedWidth)
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

  const channelPosts = Array.isArray(posts[selectedChannel?.id]) ? posts[selectedChannel?.id] : []
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
    setPendingPostActionMenu(null)
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

  // MD 페이지 선택 여부
  const isMdPageSelected = selectedPost && isMdPage(selectedPost.content)
  const isEasySheetSelected = selectedPost && isEasySheet(selectedPost.content)

  // ─── 모바일: 단일 컬럼 드릴다운 (목록 ↔ 상세를 한 번에 하나만 표시) ───
  if (isMobile) {
    // MD 페이지/문서함은 자체 전체화면 UI(닫기·뒤로)를 가지므로 그대로 사용
    if (isMdPageSelected) {
      return (
        <MDPageViewer
          key={selectedPost.id}
          post={selectedPost}
          channelId={selectedChannel.id}
          onClose={handleEasyPageBack}
          onOpenPostLink={handleOpenPostLink}
        />
      )
    }
    if (isEasySheetSelected) {
      return (
        <Suspense fallback={<div className="flex-1 flex items-center justify-center text-gray-400 text-sm">EasySheet 로딩 중…</div>}>
          <EasySheetViewer
            post={selectedPost}
            channelId={selectedChannel.id}
            onClose={handleCloseSelectedPost}
          />
        </Suspense>
      )
    }
    if (showDocumentList) {
      return (
        <ChannelDocumentListPage
          posts={channelPosts}
          onBack={() => setShowDocumentList(false)}
          onOpenPost={(post) => { handleSelectPost(post); setShowDocumentList(false) }}
        />
      )
    }

    const backToList = () => {
      if (selectedPost) { handleCloseSelectedPost(); return }
      onExitChannel?.()
    }
    const headerTitle = selectedPost ? (t.chat.postDetail || '게시글') : selectedChannel.name
    const backLabel = selectedPost ? (t.chat.backToList || '글 목록') : (t.chat.backToChannels || '채널')

    return (
      <div className="flex-1 flex flex-col min-h-0 min-w-0 bg-gray-50">
        <div className="flex items-center gap-2 px-2 h-12 border-b border-gray-200 bg-white flex-shrink-0">
          <button
            type="button"
            onClick={backToList}
            className="inline-flex items-center gap-0.5 pl-1 pr-2 py-1.5 rounded-lg text-indigo-600 hover:bg-indigo-50 text-sm font-medium"
            aria-label={backLabel}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            <span className="truncate max-w-[80px]">{backLabel}</span>
          </button>
          <span className="flex-1 text-center text-sm font-semibold text-gray-900 truncate px-1">{headerTitle}</span>
          <span className="w-12 flex-shrink-0" />
        </div>
        <div className="flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col">
          {selectedPost ? (
            <PostDetailPane
              post={selectedPost}
              channelId={selectedChannel.id}
              onClose={handleCloseSelectedPost}
              pendingOpenCommentId={pendingOpenCommentId}
              pendingOpenAttachmentId={pendingOpenAttachmentId}
              pendingActionMenu={pendingPostActionMenu}
              onConsumeActionMenu={consumePostActionMenu}
              onConsumePendingOpen={clearPendingPost}
              helpers={postDetailHelpers}
              isMobile
              contentFontScale={contentFontScale}
            />
          ) : (
            <PostList
              posts={channelPosts}
              selectedPostId={selectedPost?.id}
              onSelect={handleSelectPost}
              onOpenActionMenu={handleOpenPostActionMenu}
              onSubmit={handleNewPost}
              onOpenDocumentList={() => { handleCloseSelectedPost(); setShowDocumentList(true) }}
              contentFontScale={contentFontScale}
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex-1 flex min-w-0 bg-gray-50">
      {showDocumentList ? (
        <ChannelDocumentListPage
          posts={channelPosts}
          onBack={() => setShowDocumentList(false)}
          onOpenPost={(post) => {
            handleSelectPost(post)
            setShowDocumentList(false)
          }}
        />
      ) : isMdPageSelected ? (
        /* MD 페이지 — 전체 영역을 뷰어로 대체 */
        <MDPageViewer
          key={selectedPost.id}
          post={selectedPost}
          channelId={selectedChannel.id}
          onClose={handleEasyPageBack}
          onOpenPostLink={handleOpenPostLink}
        />
      ) : isEasySheetSelected ? (
        /* EasySheet — 전체 영역을 Univer 편집기로 대체 (지연 로딩) */
        <Suspense fallback={<div className="flex-1 flex items-center justify-center text-gray-400 text-sm">EasySheet 로딩 중…</div>}>
          <EasySheetViewer
            post={selectedPost}
            channelId={selectedChannel.id}
            onClose={handleCloseSelectedPost}
          />
        </Suspense>
      ) : (
        <>
      {/* Left panel — post list (narrows when detail is open) */}
      <div
        className={`flex flex-col min-h-0 bg-gray-50 ${selectedPost ? 'border-r border-gray-200' : 'flex-1'} ${resizing ? '' : 'transition-[width] duration-200'}`}
        style={{
          width: selectedPost ? `${leftWidth}%` : '100%',
          maxWidth: selectedPost ? 'calc(100% - min(520px, 72%))' : undefined,
        }}
      >
        <PostList
          posts={channelPosts}
          selectedPostId={selectedPost?.id}
          onSelect={handleSelectPost}
          onOpenActionMenu={handleOpenPostActionMenu}
          onSubmit={handleNewPost}
          onOpenDocumentList={() => {
            handleCloseSelectedPost()
            setShowDocumentList(true)
          }}
          contentFontScale={contentFontScale}
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
        <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden" style={{ minWidth: 'min(520px, 72%)' }}>
        <PostDetailPane
          post={selectedPost}
          channelId={selectedChannel.id}
          onClose={handleCloseSelectedPost}
          pendingOpenCommentId={pendingOpenCommentId}
          pendingOpenAttachmentId={pendingOpenAttachmentId}
          pendingActionMenu={pendingPostActionMenu}
          onConsumeActionMenu={consumePostActionMenu}
          onConsumePendingOpen={clearPendingPost}
          helpers={postDetailHelpers}
          contentFontScale={contentFontScale}
        />
        </div>
      )}
        </>
      )}
    </div>
  )
}
