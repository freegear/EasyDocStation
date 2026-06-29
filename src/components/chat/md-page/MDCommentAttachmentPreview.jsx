import { DEFAULT_PREVIEW_CONFIG } from './utils/constants'

export default function MDCommentAttachmentPreview({ attachment, resolveUrl, previewConfig }) {
  const name = String(attachment?.name || attachment?.id || '첨부파일')
  const type = String(attachment?.type || '').toLowerCase()
  const mainUrl = resolveUrl?.(attachment?.url) || attachment?.url || ''
  const thumbUrl = resolveUrl?.(attachment?.thumbnail_url) || attachment?.thumbnail_url || ''
  const isImage = type.startsWith('image/')
  const hasImagePreview = isImage || Boolean(thumbUrl)
  const previewSrc = isImage ? mainUrl : thumbUrl
  const dims = getCommentAttachmentPreviewSize({ name, type }, previewConfig)
  const previewWidth = Math.max(80, Math.round((Number(dims.width) || 480) / 2))
  const previewHeight = Math.max(60, Math.round((Number(dims.height) || 270) / 2))

  return (
    <a
      href={mainUrl}
      target="_blank"
      rel="noreferrer noopener"
      className="rounded-xl border border-blue-200 bg-white overflow-hidden hover:border-indigo-300 transition-colors"
      title={name}
      style={{ width: `${previewWidth}px` }}
    >
      {hasImagePreview ? (
        <img
          src={previewSrc}
          alt={name}
          className="w-full object-cover bg-gray-100"
          style={{ height: `${previewHeight}px` }}
          loading="lazy"
        />
      ) : (
        <div className="w-full bg-gray-100 flex items-center justify-center text-gray-400 text-xs" style={{ height: `${previewHeight}px` }}>
          Preview 없음
        </div>
      )}
      <div className="px-2.5 py-2 text-xs text-indigo-600 underline truncate">{name}</div>
    </a>
  )
}

function getCommentAttachmentPreviewSize(file, cfg) {
  const safe = cfg || DEFAULT_PREVIEW_CONFIG
  const name = String(file?.name || '').toLowerCase()
  const type = String(file?.type || '').toLowerCase()
  const isHtmlLike = /\.(html?|php|asp|aspx|jsp|cfm)($|\?)/i.test(name)

  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) {
    return safe.imagePreview || DEFAULT_PREVIEW_CONFIG.imagePreview
  }
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) {
    return safe.pdfPreview || DEFAULT_PREVIEW_CONFIG.pdfPreview
  }
  if (/\.pptx$/i.test(name)) return safe.pptxPreview || safe.pptPreview || DEFAULT_PREVIEW_CONFIG.pptxPreview
  if (/\.ppt$/i.test(name) || type.includes('presentation')) return safe.pptPreview || DEFAULT_PREVIEW_CONFIG.pptPreview
  if (/\.xlsx?$/i.test(name) || type.includes('excel') || type.includes('spreadsheet')) return safe.excelPreview || DEFAULT_PREVIEW_CONFIG.excelPreview
  if (/\.docx?$/i.test(name) || type.includes('word')) return safe.wordPreview || DEFAULT_PREVIEW_CONFIG.wordPreview
  if (isHtmlLike || type === 'text/html') return safe.htmlPreview || DEFAULT_PREVIEW_CONFIG.htmlPreview
  if (type.startsWith('video/')) return safe.moviePreview || DEFAULT_PREVIEW_CONFIG.moviePreview
  if (type.startsWith('text/') || /\.txt$/i.test(name)) return safe.txtPreview || DEFAULT_PREVIEW_CONFIG.txtPreview
  return safe.pdfPreview || DEFAULT_PREVIEW_CONFIG.pdfPreview
}
