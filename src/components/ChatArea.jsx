import { useState, useRef, useEffect, useCallback } from 'react'
import { useChat } from '../contexts/ChatContext'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch, getToken } from '../lib/api'
import config from '../config.json'
import ChannelManageModal from './ChannelManageModal'


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

function getPreviewDimensions(f, moviePreviewOverride, htmlPreviewOverride) {
  const name = (f.name || '').toLowerCase()
  if (name.endsWith('.pptx')) return config.pptxPreview || config.imagePreview
  if (name.endsWith('.ppt')) return config.pptPreview || config.imagePreview
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) return config.excelPreview || config.imagePreview
  if (name.endsWith('.docx') || name.endsWith('.doc')) return config.wordPreview || config.imagePreview
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

function Avatar({ letters, imageUrl, size = 'md' }) {
  const cls = size === 'sm' ? 'w-6 h-6 text-xs' : size === 'lg' ? 'w-10 h-10 text-base' : 'w-8 h-8 text-sm'
  return (
    <div className={`${cls} rounded-full bg-indigo-500 overflow-hidden flex items-center justify-center text-white font-bold flex-shrink-0 border border-white/10 shadow-inner`}>
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

// ─── PDF first-page preview ───────────────────────────────────

function PdfPagePreview({ fileId, width = 400 }) {
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
      <div className="flex items-center justify-center h-24 bg-white/5 rounded-xl text-white/30 text-sm">
        PDF 미리보기 불가
      </div>
    )
  }
  return (
    <div className="relative">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/5 rounded-xl">
          <div className="w-5 h-5 border-2 border-white/20 border-t-red-400 rounded-full animate-spin" />
        </div>
      )}
      <canvas
        ref={canvasRef}
        className={`rounded-xl w-full ${loading ? 'opacity-0' : 'opacity-100'} transition-opacity`}
      />
    </div>
  )
}

// ─── Image lightbox ───────────────────────────────────────────

function ImageLightbox({ file, fileUrl, onClose }) {
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
          <span className="text-white/60 text-xs">{file.name}</span>
          <a
            href={fileUrl}
            download={file.name}
            className="px-3 py-1.5 rounded-lg bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-300 text-xs font-semibold border border-indigo-500/30 transition-colors"
            onClick={e => e.stopPropagation()}
          >
            다운로드
          </a>
        </div>
      </div>
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors"
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
          <div className="flex flex-col items-center gap-4 px-10 py-8 bg-white/5 rounded-2xl border border-white/10">
            <svg className="w-14 h-14 text-pink-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.069A1 1 0 0121 8.868v6.264a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <p className="text-white/70 text-sm text-center">
              이 형식({file.name?.split('.').pop()?.toUpperCase()})은<br />브라우저에서 직접 재생할 수 없습니다.
            </p>
            <a
              href={fileUrl}
              download={file.name}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-colors"
              onClick={e => e.stopPropagation()}
            >
              파일 다운로드
            </a>
          </div>
        )}
        <div className="flex items-center gap-3">
          <span className="text-white/50 text-xs truncate max-w-xs">{file.name}</span>
          <a
            href={fileUrl}
            download={file.name}
            className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white/70 text-xs font-medium transition-colors flex-shrink-0"
            onClick={e => e.stopPropagation()}
          >
            다운로드
          </a>
        </div>
      </div>
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

// ─── Attachment list in post detail ──────────────────────────

function AttachmentList({ attachments, compact = false }) {
  const [moviePreviewSize, setMoviePreviewSize] = useState(config.moviePreview || { width: 480, height: 270 })
  const [htmlPreviewSize, setHtmlPreviewSize] = useState(config.htmlPreview || { width: 480, height: 270 })
  const [lightboxFile, setLightboxFile] = useState(null)
  const [videoFile, setVideoFile] = useState(null)

  useEffect(() => {
    apiFetch('/config/display')
      .then(data => {
        if (data.moviePreview) setMoviePreviewSize(data.moviePreview)
        if (data.htmlPreview) setHtmlPreviewSize(data.htmlPreview)
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

  // 일반 파일 클릭 → 브라우저 새 탭
  function handleFileClick(e, f) {
    e.preventDefault()
    const url = fileUrl(f)
    if (url) window.open(url, '_blank')
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

  const NativeOpenBtn = ({ f }) => (
    <button
      title="네이티브 앱으로 열기"
      onClick={e => openNative(e, f)}
      className="flex-shrink-0 p-1 rounded-md text-white/30 hover:text-white/70 hover:bg-white/10 transition-colors"
    >
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
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

      <div className="mt-6 border-t border-white/8 pt-5">
        <h4 className="text-white/50 text-xs font-semibold uppercase tracking-widest mb-3 flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
          첨부파일 {attachments.length}개
        </h4>

        <div className="flex flex-wrap gap-3">
          {attachments.map(f => {
            const category = getFileCategory(f.type || '', f.name || '')
            const dims = getPreviewDimensions(f, moviePreviewSize, htmlPreviewSize)
            const MAX_W = compact ? 180 : Infinity
            const MAX_THUMB_H = compact ? 140 : 240
            const w = Math.min(dims.width, MAX_W)
            const h = Math.min(dims.height, MAX_THUMB_H)

            // ── Video → 비디오 플레이어 모달 ──────────────────
            if (category === 'video') {
              const tUrl = thumbUrl(f)
              return (
                <div key={f.id}
                  className="rounded-2xl overflow-hidden border border-white/10 hover:border-pink-500/50 transition-colors group cursor-pointer flex-shrink-0 relative"
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
                      <svg className="w-5 h-5 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </div>
                  </div>
                  <div className="px-3 py-2 flex items-center justify-between bg-black/60">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <FileTypeIcon category="video" className="w-3.5 h-3.5 flex-shrink-0" />
                      <span className="text-white/70 text-xs font-medium truncate">{f.name}</span>
                    </div>
                    <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                      <span className="text-white/30 text-xs">{formatSize(f.size)}</span>
                      <NativeOpenBtn f={f} />
                    </div>
                  </div>
                </div>
              )
            }

            // ── Image → 라이트박스 ─────────────────────────────
            if (category === 'image') {
              return (
                <div key={f.id}
                  className="rounded-2xl overflow-hidden border border-white/10 hover:border-indigo-500/50 transition-colors group cursor-pointer flex-shrink-0"
                  style={{ width: w, maxWidth: '100%' }}
                  onClick={e => handleImageClick(e, f)}
                >
                  <img src={fileUrl(f)} alt={f.name}
                    className="block group-hover:opacity-90 transition-opacity"
                    style={{ width: w, height: h, maxWidth: '100%', objectFit: 'cover' }}
                  />
                  <div className="px-3 py-2 flex items-center justify-between bg-white/4">
                    <span className="text-white/60 text-xs font-medium truncate">{f.name}</span>
                    <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                      <span className="text-white/30 text-xs">{formatSize(f.size)}</span>
                      <NativeOpenBtn f={f} />
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
                    className="rounded-2xl overflow-hidden border border-white/10 hover:border-indigo-500/50 transition-colors group cursor-pointer flex-shrink-0"
                    style={{ width: w, maxWidth: '100%' }}
                    onClick={e => handleFileClick(e, f)}
                  >
                    <img src={tUrl} alt={f.name}
                      className="block group-hover:opacity-90 transition-opacity bg-white/5"
                      style={{ width: w, height: h, maxWidth: '100%', objectFit: 'cover' }}
                      onError={e => { e.target.style.display = 'none' }}
                    />
                    <div className="px-3 py-2 flex items-center justify-between bg-white/4">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileTypeIcon category="pdf" className="w-4 h-4 flex-shrink-0" />
                        <span className="text-white/60 text-xs truncate">{f.name}</span>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <span className="text-white/30 text-xs">{formatSize(f.size)}</span>
                        <NativeOpenBtn f={f} />
                      </div>
                    </div>
                  </div>
                )
              }
              return (
                <div key={f.id}
                  className="rounded-2xl overflow-hidden border border-white/10 cursor-pointer hover:border-indigo-500/50 transition-colors flex-shrink-0"
                  style={{ maxWidth: w }}
                  onClick={e => handleFileClick(e, f)}
                >
                  <PdfPagePreview fileId={f.id} width={w} />
                  <div className="px-3 py-2 flex items-center justify-between bg-white/4">
                    <div className="flex items-center gap-2 min-w-0">
                      <FileTypeIcon category="pdf" className="w-4 h-4 flex-shrink-0" />
                      <span className="text-white/60 text-xs truncate">{f.name}</span>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <span className="text-white/30 text-xs">{formatSize(f.size)}</span>
                      <NativeOpenBtn f={f} />
                    </div>
                  </div>
                </div>
              )
            }

            // ── HTML → iframe 인라인 미리보기 ────────────────────
            if (category === 'html') {
              return (
                <div key={f.id}
                  className="rounded-2xl overflow-hidden border border-white/10 hover:border-amber-500/50 transition-colors group cursor-pointer flex-shrink-0"
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
                  <div className="px-3 py-2 flex items-center justify-between bg-white/4">
                    <div className="flex items-center gap-2 min-w-0">
                      <svg className="w-4 h-4 text-amber-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                      </svg>
                      <span className="text-white/60 text-xs font-medium truncate">{f.name}</span>
                    </div>
                    <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                      <span className="text-white/30 text-xs">{formatSize(f.size)}</span>
                      <NativeOpenBtn f={f} />
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
                  className="rounded-2xl overflow-hidden border border-white/10 hover:border-indigo-500/50 transition-colors group cursor-pointer flex-shrink-0"
                  style={{ width: w, maxWidth: '100%' }}
                  onClick={e => handleFileClick(e, f)}
                >
                  <img src={tUrl} alt={f.name}
                    className="block group-hover:opacity-90 transition-opacity bg-white/5"
                    style={{ width: w, height: h, maxWidth: '100%', objectFit: 'cover' }}
                    onError={e => { e.target.style.display = 'none' }}
                  />
                  <div className="px-3 py-2 flex items-center justify-between bg-white/4">
                    <div className="flex items-center gap-2 min-w-0">
                      <FileTypeIcon category={category} className="w-4 h-4 flex-shrink-0" />
                      <span className="text-white/60 text-xs font-medium truncate">{f.name}</span>
                    </div>
                    <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                      <span className="text-white/30 text-xs">{formatSize(f.size)}</span>
                      <NativeOpenBtn f={f} />
                    </div>
                  </div>
                </div>
              )
            }

            // ── 썸네일 없는 파일 → 브라우저 새 탭 ───────────────
            return (
              <div key={f.id} className="flex items-center gap-3 px-3.5 py-3 rounded-xl bg-white/4 border border-white/8 cursor-pointer hover:border-white/20 transition-colors"
                onClick={e => handleFileClick(e, f)}
              >
                <FileTypeIcon category={category} className="w-5 h-5" />
                <div className="flex-1 min-w-0">
                  <p className="text-white/80 text-sm font-medium truncate">{f.name}</p>
                  <p className="text-white/30 text-xs">{formatSize(f.size)}</p>
                </div>
                <NativeOpenBtn f={f} />
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

// ─── Content renderer ─────────────────────────────────────────

function ContentRenderer({ text = '' }) {
  const lines = (text || '').split('\n')
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

function ComposeBar({ onSubmit, isArchived }) {
  const { currentUser } = useAuth()
  const { selectedChannel } = useChat()
  const [content, setContent] = useState('')
  const [files, setFiles] = useState([])
  const [dragOver, setDragOver] = useState(false)
  const [sending, setSending] = useState(false)
  const [focused, setFocused] = useState(false)

  const contentRef = useRef(null)
  const fileInputRef = useRef(null)
  const dragCounter = useRef(0)

  function addFiles(newFiles) {
    if (files.length + newFiles.length > 10) {
      alert("10개까지의 첨부 파일을 지원합니다.")
      return
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
    dragCounter.current++
    if (e.dataTransfer.types.includes('Files')) setDragOver(true)
  }
  function handleDragLeave(e) {
    e.preventDefault()
    dragCounter.current--
    if (dragCounter.current === 0) setDragOver(false)
  }
  function handleDragOver(e) { e.preventDefault() }
  function handleDrop(e) {
    e.preventDefault()
    dragCounter.current = 0
    setDragOver(false)
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files)
  }

  async function handleSend() {
    if (!content.trim() && files.length === 0) { contentRef.current?.focus(); return }
    setSending(true)
    try {
      const attachmentIds = []

      // Upload each file to Mock S3 first
      for (const fObj of files) {
        const { uploadUrl, file_uuid } = await apiFetch('/files/get-upload-url', {
          method: 'POST',
          body: JSON.stringify({
            filename: fObj.name,
            contentType: fObj.type,
            channelId: selectedChannel.id,
          }),
        })
        await fetch(uploadUrl, { method: 'PUT', body: fObj.file })
        attachmentIds.push(file_uuid)
      }

      await onSubmit({ content: content.trim(), attachmentIds })

      files.forEach(f => URL.revokeObjectURL(f.url))
      setContent('')
      setFiles([])
      setFocused(false)
      if (contentRef.current) {
        contentRef.current.style.height = 'auto'
      }
    } catch (err) {
      alert('전송 중 오류가 발생했습니다: ' + err.message)
    } finally {
      setSending(false)
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
      <div className="flex-shrink-0 px-4 py-8 border-t border-white/10 flex flex-col items-center justify-center bg-white/2">
        <div className="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center text-amber-500 mb-3">
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
          </svg>
        </div>
        <p className="text-white font-bold text-sm mb-1">보관된 채널입니다</p>
        <p className="text-white/30 text-[11px]">이 채널은 현재 읽기 전용 상태이며, 새로운 메시지를 전송하거나 편집할 수 없습니다.</p>
      </div>
    )
  }

  return (
    <div className="flex-shrink-0 px-4 py-3 border-t border-white/10">
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />

      <div
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={`flex flex-col rounded-2xl border transition-all duration-150 relative overflow-hidden ${
          dragOver
            ? 'border-indigo-400/70 bg-indigo-500/10 shadow-lg shadow-indigo-500/20'
            : showActions
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

        {/* Content textarea row */}
        <div className="flex items-start gap-3 px-4 pt-3 pb-2">
          {currentUser && <Avatar letters={currentUser.avatar} size="sm" />}
          <textarea
            ref={contentRef}
            value={content}
            onChange={e => setContent(e.target.value)}
            onFocus={() => setFocused(true)}
            onKeyDown={handleKeyDown}
            placeholder="메시지를 입력하세요... (Shift+Enter 줄바꿈)"
            rows={1}
            className="flex-1 bg-transparent text-white/90 placeholder-white/25 text-sm leading-relaxed resize-none focus:outline-none pt-0.5"
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

            <div className="flex-1" />

            {/* Cancel + Send */}
            <button
              type="button"
              onClick={handleCancel}
              className="px-2.5 py-1.5 rounded-lg text-white/30 hover:text-white/60 text-xs transition-colors hover:bg-white/5"
            >
              취소
            </button>
            <button
              type="button"
              onClick={handleSend}
              disabled={!hasContent || sending}
              className="w-9 h-9 rounded-xl flex items-center justify-center transition-all disabled:opacity-30 disabled:cursor-not-allowed enabled:bg-indigo-600 enabled:hover:bg-indigo-500 enabled:shadow-lg enabled:shadow-indigo-500/25 enabled:active:scale-95"
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
        )}
      </div>

      <p className="text-white/15 text-xs mt-1.5 px-1">
        Enter로 전송 · Shift+Enter 줄바꿈 · 클립 또는 드래그 앤 드롭으로 파일 첨부
      </p>
    </div>
  )
}

// ─── Post List ────────────────────────────────────────────────

function PostList({ posts, onSelect, onSubmit, selectedPostId }) {
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

        <div className="flex-1" />

        {isAdmin && (
          <button
            onClick={() => setShowManageModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 hover:bg-indigo-500/20 transition-all text-xs font-semibold"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            채널 관리
          </button>
        )}
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
            <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-3xl mb-4">📄</div>
            <h3 className="text-white font-semibold mb-1">아직 게시글이 없습니다</h3>
            <p className="text-white/40 text-sm">아래 입력창에 메시지를 입력해보세요!</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {pinnedPosts.length > 0 && (
              <>
                <div className="flex items-center gap-2 text-amber-400/60 text-xs font-medium uppercase tracking-widest mb-1">
                  <PinIcon /><span>고정된 게시글</span>
                </div>
                {pinnedPosts.map(p => <PostCard key={p.id} post={p} onSelect={onSelect} pinned isSelected={p.id === selectedPostId} />)}
                {normalPosts.length > 0 && <div className="border-t border-white/5 my-1" />}
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

function PostCard({ post, onSelect, pinned, isSelected }) {
  const plain = (post.content || '')
    .replace(/#{1,3} /g, '').replace(/\*\*/g, '').replace(/`/g, '')
    .split('\n').filter(l => l.trim() && !l.startsWith('|') && !l.startsWith('-'))
  const leadLine = plain[0]?.slice(0, 100) || ''
  const bodyPreview = plain.slice(1).join(' ').slice(0, 120)
  const attachCount = post.attachments?.length || 0
  const commentCount = post.comments?.length || 0

  return (
    <button
      onClick={() => onSelect(post)}
      className={`w-full text-left px-5 py-4 rounded-2xl border transition-all group ${
        isSelected
          ? 'bg-indigo-500/10 border-indigo-500/40'
          : pinned
          ? 'bg-amber-500/5 border-amber-500/15 hover:bg-amber-500/10 hover:border-amber-500/30'
          : 'bg-white/4 border-white/8 hover:bg-white/7 hover:border-white/15'
      }`}
    >
      <div className="flex items-start gap-3">
        <Avatar letters={post.author?.avatar || '?'} imageUrl={post.author?.image_url} />
        <div className="flex-1 min-w-0">
          {/* Lead line */}
          <div className="flex items-center gap-2 mb-1">
            {pinned && <PinIcon />}
            {leadLine && (
              <p className="text-white/90 font-semibold text-sm leading-tight group-hover:text-indigo-300 transition-colors truncate">{leadLine}</p>
            )}
          </div>
          {/* Meta */}
          <div className="flex items-center gap-2 text-white/35 text-xs mb-2">
            <span className="font-medium text-white/60">{post.author?.name}</span>
            {post.author?.username && (
              <span className="text-white/25">@{post.author.username}</span>
            )}
            <span>·</span>
            <span>{formatDate(post.createdAt)}</span>
            {attachCount > 0 && (
              <>
                <span>·</span>
                <span className="flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                  {attachCount}
                </span>
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
          {bodyPreview && <p className="text-white/40 text-xs leading-relaxed line-clamp-2">{bodyPreview}</p>}
        </div>
      </div>
    </button>
  )
}

// ─── Post Detail ──────────────────────────────────────────────

function PostDetail({ post, channelId, onClose }) {
  const { addComment, incrementViews, deletePost, updatePost, deleteComment, updateComment, posts, refreshTeams, selectedChannel } = useChat()
  const { currentUser } = useAuth()
  const [comment, setComment] = useState('')
  const [viewed, setViewed] = useState(false)
  const [showManageModal, setShowManageModal] = useState(false)
  
  // Post Edit State
  const [isEditingPost, setIsEditingPost] = useState(false)
  const [postContent, setPostContent] = useState('')
  const [postFiles, setPostFiles] = useState([])
  
  // Comment Edit State
  const [editingCommentId, setEditingCommentId] = useState(null)
  const [commentEditContent, setCommentEditContent] = useState('')
  const [commentEditFiles, setCommentEditFiles] = useState([])

  const [files, setFiles] = useState([])
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const commentsEndRef = useRef(null)
  const fileInputRef = useRef(null)
  const dragCounter = useRef(0)

  const isAdmin = ['Admin', 'site_admin', 'channel_admin', 'team_admin'].includes(currentUser?.role)

  function addFiles(newFiles) {
    if (files.length + newFiles.length > 10) {
      alert('첨부파일은 최대 10개까지만 가능합니다.')
      return
    }
    if (newFiles.length > 0 && !comment.trim()) {
      setComment(newFiles[0].name)
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
  function handleDragOver(e) { e.preventDefault() }
  function handleDrop(e) {
    e.preventDefault()
    dragCounter.current = 0
    setDragOver(false)
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files)
  }

  useEffect(() => {
    if (!viewed) { incrementViews(channelId, post.id); setViewed(true) }
  }, [])

  const freshPost = posts[channelId]?.find(p => p.id === post.id) || post
  const isOwn = freshPost.author?.name === currentUser?.name

  async function handleComment(e) {
    e.preventDefault()
    if ((!comment.trim() && files.length === 0) || !currentUser) return
    
    setUploading(true)
    try {
      const attachmentIds = []
      for (const fObj of files) {
        const { uploadUrl, file_uuid } = await apiFetch('/files/get-upload-url', {
          method: 'POST',
          body: JSON.stringify({
            filename: fObj.name,
            contentType: fObj.type,
            channelName: selectedChannel?.name || 'general',
          }),
        })
        await fetch(uploadUrl, { method: 'PUT', body: fObj.file })
        attachmentIds.push(file_uuid)
      }

      await addComment(channelId, post.id, comment.trim(), currentUser, attachmentIds)
      
      files.forEach(f => URL.revokeObjectURL(f.url))
      setComment('')
      setFiles([])
      setTimeout(() => commentsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
    } catch (err) {
      alert('댓글 전송 중 오류가 발생했습니다: ' + err.message)
    } finally {
      setUploading(false)
    }
  }

  // Handlers for Post Edit
  function startPostEdit() {
    setPostContent(freshPost.content)
    setPostFiles(freshPost.attachments || [])
    setIsEditingPost(true)
  }

  async function handlePostUpdate() {
    setUploading(true)
    try {
      const attachments = [...postFiles]
      updatePost(channelId, post.id, { content: postContent, attachments })
      setIsEditingPost(false)
    } catch (err) {
      alert('저장 중 오류가 발생했습니다: ' + err.message)
    } finally {
      setUploading(false)
    }
  }

  function handleDelete() {
    if (window.confirm('이 게시글을 삭제하시겠습니까?')) { deletePost(channelId, post.id); onClose() }
  }

  // Handlers for Comment Edit/Delete
  function startCommentEdit(c) {
    setEditingCommentId(c.id)
    setCommentEditContent(c.text)
    setCommentEditFiles(c.attachments || [])
  }

  function handleCommentDelete(cId) {
    if (window.confirm('이 댓글을 삭제하시겠습니까?')) {
      deleteComment(channelId, post.id, cId)
    }
  }

  function handleCommentUpdate(cId) {
    updateComment(channelId, post.id, cId, { text: commentEditContent, attachments: commentEditFiles })
    setEditingCommentId(null)
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-3 px-6 py-3 border-b border-white/10 flex-shrink-0">
        <div className="flex-1" />
        {isOwn && !isEditingPost && !selectedChannel?.is_archived && (
          <div className="flex items-center gap-2">
            <button onClick={startPostEdit} className="flex items-center gap-1 text-white/40 hover:text-white text-xs transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
              수정
            </button>
            <button onClick={handleDelete} className="flex items-center gap-1 text-red-400/60 hover:text-red-400 text-xs transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              삭제
            </button>
          </div>
        )}
        {isAdmin && (
          <button
            onClick={() => setShowManageModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 hover:bg-indigo-500/20 transition-all text-xs font-semibold"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            채널 관리
          </button>
        )}
        {/* Close right panel */}
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-lg text-white/30 hover:text-white hover:bg-white/10 flex items-center justify-center transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {showManageModal && (
        <ChannelManageModal 
          onClose={() => setShowManageModal(false)} 
          onSave={() => refreshTeams()}
        />
      )}

      <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-6">
        {/* Meta */}
        <div className="mb-6">
          {freshPost.pinned && <div className="flex items-center gap-1.5 text-amber-400 text-xs font-medium mb-3"><PinIcon /><span>고정된 게시글</span></div>}
          <div className="flex items-center gap-4 mb-6 p-4 rounded-2xl bg-white/4 border border-white/8">
            <Avatar letters={freshPost.author?.avatar || '?'} imageUrl={freshPost.author?.image_url} size="lg" />
            <div className="min-w-0 flex-1">
              <p className="text-white font-semibold text-base leading-tight">{freshPost.author?.name}</p>
              {freshPost.author?.username && (
                <p className="text-indigo-400/70 text-xs mt-0.5">@{freshPost.author.username}</p>
              )}
              <p className="text-white/30 text-xs mt-1" title={formatFull(freshPost.createdAt)}>
                작성: {formatFull(freshPost.createdAt)}
              </p>
            </div>
          </div>
        </div>

        <div className="border-t border-white/8 mb-6" />

        {/* Body & Attachments */}
        {isEditingPost ? (
          <div className="bg-white/5 rounded-2xl border border-indigo-500/40 p-4 mb-6">
            <textarea
              value={postContent}
              onChange={e => setPostContent(e.target.value)}
              className="w-full bg-transparent text-white/90 placeholder-white/25 text-sm leading-relaxed resize-none focus:outline-none mb-4"
              rows={8}
            />
            {postFiles.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-4">
                {postFiles.map(f => <FileChip key={f.id} file={f} onRemove={(id) => setPostFiles(prev => prev.filter(x => x.id !== id))} />)}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setIsEditingPost(false)} className="px-3 py-1.5 rounded-lg text-white/40 hover:text-white text-xs transition-colors">취소</button>
              <button onClick={handlePostUpdate} className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-colors">저장하기</button>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-4">
              <ContentRenderer text={freshPost.content} />
            </div>
            <AttachmentList attachments={freshPost.attachments} />
          </>
        )}

        {/* Comments list — 스크롤 영역 안 */}
        <div className="border-t border-white/8 pt-6 mt-6 pb-4">
          <h3 className="text-white font-semibold text-sm mb-4">댓글 {(freshPost.comments || []).length}개</h3>
          {(freshPost.comments || []).length === 0 ? (
            <p className="text-white/30 text-sm">첫 번째 댓글을 남겨보세요.</p>
          ) : (
            <div className="flex flex-col gap-4">
              {(freshPost.comments || []).map(c => (
                <div key={c.id} className="flex items-start gap-3 group">
                  <Avatar letters={c.author?.avatar || '?'} imageUrl={c.author?.image_url} size="sm" />
                  <div className="flex-1 bg-white/5 rounded-xl px-4 py-3 border border-white/8">
                    <div className="flex items-baseline gap-2 mb-1.5">
                      <span className="text-white/80 text-xs font-semibold">{c.author?.name}</span>
                      {c.author?.username && (
                        <span className="text-indigo-400/50 text-[10px]">@{c.author.username}</span>
                      )}
                      <span className="text-white/25 text-xs">{formatDate(c.createdAt)}</span>
                      {c.author?.name === currentUser?.name && editingCommentId !== c.id && !selectedChannel?.is_archived && (
                        <div className="ml-auto flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={() => startCommentEdit(c)} className="text-white/30 hover:text-white text-[10px] font-medium uppercase tracking-tight">수정</button>
                          <button onClick={() => handleCommentDelete(c.id)} className="text-red-400/40 hover:text-red-400 text-[10px] font-medium uppercase tracking-tight">삭제</button>
                        </div>
                      )}
                    </div>

                    {editingCommentId === c.id ? (
                      <div className="mt-1">
                        <textarea
                          value={commentEditContent}
                          onChange={e => setCommentEditContent(e.target.value)}
                          className="w-full bg-white/5 border border-white/10 rounded-lg p-2 text-white/80 text-sm focus:outline-none focus:border-indigo-500/40 resize-none"
                          rows={2}
                        />
                        {commentEditFiles.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {commentEditFiles.map(f => <FileChip key={f.id} file={f} onRemove={(id) => setCommentEditFiles(prev => prev.filter(x => x.id !== id))} />)}
                          </div>
                        )}
                        <div className="flex justify-end gap-2 mt-2">
                          <button onClick={() => setEditingCommentId(null)} className="text-white/40 hover:text-white text-xs">취소</button>
                          <button onClick={() => handleCommentUpdate(c.id)} className="text-indigo-400 hover:text-indigo-300 text-xs font-semibold">저장</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="text-white/70 overflow-hidden">
                          <ContentRenderer text={c.text} />
                        </div>
                        {c.attachments && c.attachments.length > 0 && (
                          <div className="mt-3">
                            <AttachmentList attachments={c.attachments} compact />
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}
              <div ref={commentsEndRef} />
            </div>
          )}
        </div>
      </div>

      {/* 댓글 입력 — 스크롤 영역 밖, 항상 하단 고정 */}
      <div className="flex-shrink-0 border-t border-white/10 px-6 py-3 bg-[#1a1828]">
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={e => { if(e.target.files?.length) addFiles(e.target.files); e.target.value = '' }} />
        {!selectedChannel?.is_archived ? (
          <form onSubmit={handleComment} className="flex items-start gap-3">
            {currentUser && <Avatar letters={currentUser.avatar} imageUrl={currentUser.image_url} size="sm" />}
            <div
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              className={`flex-1 rounded-xl border transition-all duration-150 relative overflow-hidden ${
                dragOver
                  ? 'border-indigo-400/70 bg-indigo-500/10 shadow-lg shadow-indigo-500/20'
                  : 'bg-white/5 border-white/10 focus-within:border-indigo-500/40'
              }`}
            >
              {dragOver && (
                <div className="absolute inset-0 flex flex-col items-center justify-center z-10 pointer-events-none">
                  <svg className="w-8 h-8 text-indigo-400 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                  <p className="text-indigo-300 text-sm font-semibold">파일을 놓아 첨부하세요</p>
                </div>
              )}
              <textarea
                value={comment}
                onChange={e => setComment(e.target.value)}
                placeholder="댓글을 입력하세요..."
                rows={2}
                className="w-full bg-transparent text-white/80 placeholder-white/20 text-sm px-4 pt-3 pb-2 resize-none focus:outline-none leading-relaxed"
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleComment(e) } }}
              />
              {files.length > 0 && (
                <div className="px-4 pb-2">
                  <div className="flex flex-wrap gap-2">
                    {files.map(f => <FileChip key={f.id} file={f} onRemove={removeFile} />)}
                  </div>
                </div>
              )}
              <div className="flex items-center px-3 pb-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="p-1.5 rounded-lg text-white/30 hover:text-white/70 hover:bg-white/8 transition-colors"
                  title="파일 첨부"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                </button>
                <div className="flex-1" />
                <button type="submit" disabled={(!comment.trim() && files.length === 0) || uploading} className="px-3 py-1.5 rounded-lg bg-indigo-600 disabled:bg-white/10 enabled:hover:bg-indigo-500 text-white text-xs font-semibold transition-colors flex items-center gap-2">
                  {uploading && <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                  {uploading ? '전송 중...' : '댓글 달기'}
                </button>
              </div>
            </div>
          </form>
        ) : (
          <div className="flex items-center justify-center py-2 gap-2 text-white/25 text-xs italic">
            <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            보관된 채널에서는 댓글을 작성할 수 없습니다.
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────

export default function ChatArea({ autoOpenPostId }) {
  const { selectedChannel, posts, addPost, pendingOpenPostId } = useChat()
  const [selectedPost, setSelectedPost] = useState(null)
  const [leftWidth, setLeftWidth] = useState(42) // percent
  const [resizing, setResizing] = useState(false)
  const containerRef = useRef(null)

  // 검색 결과로 선택된 게시글 자동 오픈
  useEffect(() => {
    if (!autoOpenPostId) return
    const channelPosts = posts[selectedChannel?.id] || []
    const target = channelPosts.find(p => p.id === autoOpenPostId)
    if (target) setSelectedPost(target)
  }, [autoOpenPostId, selectedChannel?.id, posts])

  // RAG 참고 문서 클릭으로 이동된 게시글 자동 오픈
  useEffect(() => {
    if (!pendingOpenPostId) return
    const channelPosts = posts[selectedChannel?.id] || []
    const target = channelPosts.find(p => p.id === pendingOpenPostId)
    if (target) {
      setSelectedPost(target)
      // clearPendingPost() // PostDetail 내부에서 스크롤 후 호출하도록 이동
    }
  }, [pendingOpenPostId, selectedChannel?.id, posts])

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
      document.body.style.userSelect = 'none'
    } else {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', stopResizing)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', stopResizing)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [resizing, onMouseMove, stopResizing])

  const channelPosts = posts[selectedChannel?.id] || []

  // 채널 전환 시 기존 선택된 게시글 초기화 (단, 이동 중인 경우에는 유지)
  useEffect(() => { 
    if (!pendingOpenPostId) {
      setSelectedPost(null) 
    }
  }, [selectedChannel?.id, pendingOpenPostId])

  async function handleNewPost(data) {
    await addPost(selectedChannel.id, data)
  }

  if (!selectedChannel) {
    return <div className="flex-1 flex items-center justify-center text-white/30 bg-[#1e1c30]">채널을 선택하세요</div>
  }

  return (
    <div ref={containerRef} className="flex-1 flex min-w-0 bg-[#1e1c30]">
      {/* Left panel — post list (narrows when detail is open) */}
      <div 
        className={`flex flex-col min-h-0 bg-[#1e1c30] ${selectedPost ? 'border-r border-white/10' : 'flex-1'} ${resizing ? '' : 'transition-[width] duration-200'}`}
        style={{ width: selectedPost ? `${leftWidth}%` : '100%' }}
      >
        <PostList
          posts={channelPosts}
          selectedPostId={selectedPost?.id}
          onSelect={setSelectedPost}
          onSubmit={handleNewPost}
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
          <PostDetail
            post={selectedPost}
            channelId={selectedChannel.id}
            onClose={() => setSelectedPost(null)}
          />
        </div>
      )}
    </div>
  )
}
