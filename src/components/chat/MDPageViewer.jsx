import { useState, useEffect, useCallback, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { useReactToPrint } from 'react-to-print'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Dropcursor from '@tiptap/extension-dropcursor'
import Link from '@tiptap/extension-link'
import ImageResize from 'tiptap-extension-resize-image'
import { Markdown } from 'tiptap-markdown'
import { useChat } from '../../contexts/ChatContext'
import { useAuth } from '../../contexts/AuthContext'
import { useT } from '../../i18n/useT'
import ConfirmDialog from '../ConfirmDialog'
import { getMdPageContent, getMdPageTitle } from '../../templates/formTemplates'
import { apiFetch, getToken } from '../../lib/api'
import '../../styles/tiptap.css'

const MD_PAGE_MARKER = '<!--md-page-->'
const MD_IMAGE_META_PREFIX = '<!--md-image-meta:'
const ResizableImage = ImageResize.extend({ name: 'image' })
const FILE_VIEW_URL_PATTERN = /(https?:\/\/[^\s)"']+\/api\/files\/view\/[A-Za-z0-9-]+(?:\?[^\s)"']*)?|\/api\/files\/view\/[A-Za-z0-9-]+(?:\?[^\s)"']*)?)/g

function extractImageMeta(mdText = '') {
  const match = mdText.match(/<!--md-image-meta:([A-Za-z0-9+/=_-]+)-->\s*$/m)
  if (!match?.[1]) return {}
  try {
    const decoded = atob(match[1])
    try {
      return normalizeImageMetaKeys(JSON.parse(decoded) || {})
    } catch {
      // Backward/forward safety for unicode payloads.
      return normalizeImageMetaKeys(JSON.parse(decodeURIComponent(escape(decoded))) || {})
    }
  } catch {
    return {}
  }
}

function stripImageMeta(mdText = '') {
  return mdText.replace(/\n?<!--md-image-meta:[A-Za-z0-9+/=_-]+-->\s*$/m, '')
}

function attachImageMeta(mdText = '', imageMeta = {}) {
  const plain = stripImageMeta(mdText || '')
  const normalizedMeta = normalizeImageMetaKeys(imageMeta || {})
  const keys = Object.keys(normalizedMeta)
  if (keys.length === 0) return plain
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(normalizedMeta))))
  return `${plain}\n${MD_IMAGE_META_PREFIX}${encoded}-->`
}

function mapFileViewUrl(url, mutateParams) {
  try {
    const input = String(url || '').trim()
    if (!input) return input
    const absolute = /^https?:\/\//i.test(input)
    const parsed = new URL(input, window.location.origin)
    if (!parsed.pathname.startsWith('/api/files/view/')) return input
    mutateParams(parsed.searchParams)
    if (absolute) return parsed.toString()
    const q = parsed.searchParams.toString()
    return `${parsed.pathname}${q ? `?${q}` : ''}${parsed.hash || ''}`
  } catch {
    return String(url || '')
  }
}

function normalizeFileViewUrlKey(url) {
  try {
    const input = String(url || '').trim()
    if (!input) return ''
    const parsed = new URL(input, window.location.origin)
    if (!parsed.pathname.startsWith('/api/files/view/')) return input
    parsed.searchParams.delete('auth_token')
    const entries = Array.from(parsed.searchParams.entries())
    entries.sort(([a], [b]) => a.localeCompare(b))
    const query = new URLSearchParams(entries).toString()
    return `${parsed.pathname}${query ? `?${query}` : ''}`
  } catch {
    return String(url || '').trim()
  }
}

function stripAuthTokenFromFileViewUrl(url) {
  return mapFileViewUrl(url, (params) => {
    params.delete('auth_token')
  })
}

function ensureAuthTokenInFileViewUrl(url, token) {
  return mapFileViewUrl(url, (params) => {
    params.delete('auth_token')
    if (token) params.set('auth_token', token)
  })
}

function rewriteFileViewUrlsInMarkdown(md = '', rewriteFn = (v) => v) {
  return String(md || '').replace(FILE_VIEW_URL_PATTERN, (matched) => rewriteFn(matched))
}

function stripAuthTokenFromMarkdown(md = '') {
  return rewriteFileViewUrlsInMarkdown(md, stripAuthTokenFromFileViewUrl)
}

function injectAuthTokenIntoMarkdown(md = '', token = '') {
  return rewriteFileViewUrlsInMarkdown(md, (url) => ensureAuthTokenInFileViewUrl(url, token))
}

function normalizeImageMetaKeys(imageMeta = {}) {
  const entries = Object.entries(imageMeta || {})
  if (entries.length === 0) return {}
  const normalized = {}
  for (const [key, val] of entries) {
    const nextKey = normalizeFileViewUrlKey(stripAuthTokenFromFileViewUrl(String(key || '').trim()))
    if (!nextKey) continue
    normalized[nextKey] = val || {}
  }
  return normalized
}

function hasSizingMeta(meta = {}) {
  if (!meta || typeof meta !== 'object') return false
  return (
    meta.width != null
    || Boolean(meta.containerStyle)
    || Boolean(meta.wrapperStyle)
  )
}

function collectImageMetaFromDoc(doc, fallbackMap = {}) {
  const normalizedFallbackMap = normalizeImageMetaKeys(fallbackMap || {})
  const map = {}
  doc.descendants((node) => {
    if (node.type.name !== 'image') return
    const src = normalizeFileViewUrlKey(stripAuthTokenFromFileViewUrl(String(node.attrs?.src || '').trim()))
    if (!src) return
    const current = {
      width: node.attrs?.width ?? null,
      containerStyle: node.attrs?.containerStyle ?? null,
      wrapperStyle: node.attrs?.wrapperStyle ?? null,
    }
    const fallback = normalizedFallbackMap?.[src] || {}
    map[src] = hasSizingMeta(current) ? current : {
      width: fallback.width ?? current.width ?? null,
      containerStyle: fallback.containerStyle ?? current.containerStyle ?? null,
      wrapperStyle: fallback.wrapperStyle ?? current.wrapperStyle ?? null,
    }
  })
  return map
}

function sameImageMeta(a = {}, b = {}) {
  const aKeys = Object.keys(a).sort()
  const bKeys = Object.keys(b).sort()
  if (aKeys.length !== bKeys.length) return false
  for (let i = 0; i < aKeys.length; i += 1) {
    if (aKeys[i] !== bKeys[i]) return false
    const av = a[aKeys[i]] || {}
    const bv = b[bKeys[i]] || {}
    if ((av.width ?? null) !== (bv.width ?? null)) return false
    if ((av.containerStyle ?? null) !== (bv.containerStyle ?? null)) return false
    if ((av.wrapperStyle ?? null) !== (bv.wrapperStyle ?? null)) return false
  }
  return true
}

function normalizeLinkUrl(input = '') {
  const raw = String(input || '').trim()
  if (!raw) return ''
  if (/^(https?:\/\/|mailto:|tel:|\/|#)/i.test(raw)) return raw
  return `https://${raw}`
}

function truncateSingleLine(text = '', max = 60) {
  const oneLine = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim())
    .find(Boolean) || ''
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max - 1)}…`
}

export default function MDPageViewer({ post, channelId, onClose }) {
  const { updatePost } = useChat()
  const { currentUser } = useAuth()
  const t = useT()
  const authToken = getToken() || ''
  const initialMdStored = stripAuthTokenFromMarkdown(String(post.content || '').replace(/^<!--md-page-->\n?/, ''))
  const initialMdRaw = injectAuthTokenIntoMarkdown(initialMdStored, authToken)

  const [mode, setMode] = useState('preview')
  const [savedContent, setSavedContent] = useState(() => stripImageMeta(initialMdStored))
  const [sourceText, setSourceText] = useState(() => stripImageMeta(initialMdStored))
  const [imageMeta, setImageMeta] = useState(() => extractImageMeta(initialMdStored))
  const [savedImageMeta, setSavedImageMeta] = useState(() => extractImageMeta(initialMdStored))
  const [isChanged, setIsChanged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [isUploadingImage, setIsUploadingImage] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const showSaveDialogRef = useRef(false)
  const imageInputRef = useRef(null)
  const printContentRef = useRef(null)
  const imageMetaRef = useRef(imageMeta)
  const savedContentRef = useRef(savedContent)
  const savedImageMetaRef = useRef(savedImageMeta)
  const sourceBaselineRef = useRef('')

  useEffect(() => { showSaveDialogRef.current = showSaveDialog }, [showSaveDialog])
  useEffect(() => { imageMetaRef.current = imageMeta }, [imageMeta])
  useEffect(() => { savedContentRef.current = savedContent }, [savedContent])
  useEffect(() => { savedImageMetaRef.current = savedImageMeta }, [savedImageMeta])

  const canEdit = post.author?.id === currentUser?.id
    || ['site_admin', 'team_admin', 'channel_admin'].includes(currentUser?.role)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: false,
        dropcursor: false,
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
        HTMLAttributes: {
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
        },
      }),
      ResizableImage.configure({
        minWidth: 120,
        maxWidth: 1200,
      }),
      Dropcursor.configure({
        color: '#6366f1',
        width: 2,
      }),
      Placeholder.configure({ placeholder: t.mdPage.sourcePlaceholder }),
      Markdown.configure({ html: false, transformCopiedText: true, transformPastedText: true }),
    ],
    content: stripImageMeta(initialMdRaw),
    editable: canEdit && mode === 'preview',
    onUpdate({ editor }) {
      const md = stripImageMeta(editor.storage.markdown.getMarkdown())
      const nextImageMeta = collectImageMetaFromDoc(editor.state.doc, imageMetaRef.current)
      setImageMeta(prev => (sameImageMeta(prev, nextImageMeta) ? prev : nextImageMeta))
      setIsChanged(
        md !== savedContentRef.current
        || !sameImageMeta(nextImageMeta, savedImageMetaRef.current)
      )
    },
  })

  // mode 변경 시 editor editable 상태 동기화
  useEffect(() => {
    if (!editor) return
    editor.setEditable(canEdit && mode === 'preview')
  }, [editor, canEdit, mode])

  useEffect(() => {
    if (!editor) return
    if (!imageMeta || Object.keys(imageMeta).length === 0) return
    const tr = editor.state.tr
    let changed = false

    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'image') return
      const src = String(node.attrs?.src || '').trim()
      const normalizedSrc = normalizeFileViewUrlKey(stripAuthTokenFromFileViewUrl(src))
      const meta = imageMeta[normalizedSrc] || imageMeta[normalizeFileViewUrlKey(src)] || imageMeta[stripAuthTokenFromFileViewUrl(src)] || imageMeta[src]
      if (!src || !meta) return
      const nextAttrs = {
        ...node.attrs,
        ...(meta.width != null ? { width: meta.width } : {}),
        ...(meta.containerStyle ? { containerStyle: meta.containerStyle } : {}),
        ...(meta.wrapperStyle ? { wrapperStyle: meta.wrapperStyle } : {}),
      }
      if (JSON.stringify(nextAttrs) !== JSON.stringify(node.attrs)) {
        tr.setNodeMarkup(pos, undefined, nextAttrs)
        changed = true
      }
    })

    if (changed) {
      editor.view.dispatch(tr)
    }
  }, [editor, imageMeta])

  // 소스 → 미리보기 전환: 소스 텍스트를 에디터에 반영
  function switchToPreview() {
    if (mode === 'source' && editor) {
      const normalizedSource = stripAuthTokenFromMarkdown(sourceText || '')
      const baseline = sourceBaselineRef.current || ''
      // 소스가 실제로 변경되지 않았다면 setContent를 건너뛰어
      // 이미지 노드 attrs(width/containerStyle) 손실을 방지한다.
      if (normalizedSource !== baseline) {
        const withToken = injectAuthTokenIntoMarkdown(normalizedSource, getToken() || '')
        editor.commands.setContent(withToken)
      }
      setIsChanged(sourceText !== savedContent || !sameImageMeta(imageMeta, savedImageMeta))
    }
    setMode('preview')
  }

  // 미리보기 → 소스 전환: 에디터 내용을 마크다운으로 추출
  function switchToSource() {
    if (mode === 'preview' && editor) {
      const md = stripAuthTokenFromMarkdown(editor.storage.markdown.getMarkdown())
      sourceBaselineRef.current = md
      setSourceText(md)
    }
    setMode('source')
  }

  const getCurrentMarkdown = useCallback(() => {
    if (mode === 'source') return stripAuthTokenFromMarkdown(sourceText)
    return stripAuthTokenFromMarkdown(stripImageMeta(editor?.storage.markdown.getMarkdown() || ''))
  }, [mode, sourceText, editor])

  const handleSave = useCallback(async () => {
      const md = stripAuthTokenFromMarkdown(getCurrentMarkdown())
      const mdWithMeta = attachImageMeta(md, normalizeImageMetaKeys(imageMeta))
    setSaving(true)
    try {
      await updatePost(channelId, post.id, { content: `${MD_PAGE_MARKER}\n${mdWithMeta}` })
      setSavedContent(md)
      setSavedImageMeta(normalizeImageMetaKeys(imageMeta))
      setIsChanged(false)
    } catch (e) {
      console.error('MD 페이지 저장 실패:', e)
    } finally {
      setSaving(false)
    }
  }, [channelId, getCurrentMarkdown, imageMeta, post.id, updatePost])

  // ESC 키 핸들러
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key !== 'Escape') return
      if (showSaveDialogRef.current) return
      if (isChanged) setShowSaveDialog(true)
      else onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isChanged, onClose])

  const pageTitle = getMdPageTitle(getCurrentMarkdown(), t.mdPage.title)
  const handlePrint = useReactToPrint({
    contentRef: printContentRef,
    documentTitle: pageTitle || t.mdPage.title || 'EasyPage',
    pageStyle: `
      @page { margin: 16mm; }
      html, body { background: #fff !important; color: #111827 !important; }
      .easy-page-print-root { width: 100% !important; max-width: 900px !important; margin: 0 auto !important; }
      * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      img { max-width: 100% !important; height: auto !important; page-break-inside: avoid; }
    `,
  })

  function isImageFile(file) {
    if (!file) return false
    const type = (file.type || '').toLowerCase()
    if (type.startsWith('image/')) return true
    return /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(file.name || '')
  }

  async function uploadAndInsertImage(file, insertPos = null) {
    if (!editor || !isImageFile(file)) return

    setIsUploadingImage(true)
    try {
      const prep = await apiFetch('/files/get-upload-url', {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          channelId,
        }),
      })

      const uploadResp = await fetch(prep.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      })
      if (!uploadResp.ok) {
        throw new Error(`이미지 업로드 실패 (${uploadResp.status})`)
      }

      const authToken = getToken()
      const src = `/api/files/view/${prep.file_uuid}${authToken ? `?auth_token=${encodeURIComponent(authToken)}` : ''}`
      const chain = editor.chain().focus()
      if (Number.isFinite(insertPos)) chain.setTextSelection(insertPos)
      chain.setImage({ src, alt: file.name, title: file.name }).run()
    } catch (e) {
      console.error('MD 이미지 업로드 실패:', e)
      alert(t.mdPage.imageUploadFail || '이미지 업로드에 실패했습니다.')
    } finally {
      setIsUploadingImage(false)
    }
  }

  async function handleImageInputChange(e) {
    const files = Array.from(e.target.files || []).filter(isImageFile)
    if (files.length === 0) {
      e.target.value = ''
      return
    }
    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop
      await uploadAndInsertImage(file)
    }
    e.target.value = ''
  }

  function handleImagePickClick() {
    if (!canEdit || mode !== 'preview' || isUploadingImage) return
    imageInputRef.current?.click()
  }

  async function handleEditorDrop(e) {
    if (!canEdit || mode !== 'preview') return
    const files = Array.from(e.dataTransfer?.files || []).filter(isImageFile)
    if (files.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    let insertPos = null
    if (editor?.view?.posAtCoords) {
      const coords = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })
      if (coords && Number.isFinite(coords.pos)) insertPos = coords.pos
    }

    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop
      await uploadAndInsertImage(file, insertPos)
      insertPos = null
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-white">

      {/* ── Top bar ── */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-200 bg-white shadow-sm flex-shrink-0">
        <button
          onClick={() => { if (isChanged) setShowSaveDialog(true); else onClose() }}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 px-2 py-1 rounded-lg hover:bg-gray-100 transition-colors flex-shrink-0"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          {t.mdPage.back}
        </button>

        <div className="w-px h-5 bg-gray-200 flex-shrink-0" />
        <span className="text-sm text-gray-700 font-medium flex-1 truncate min-w-0">{pageTitle}</span>

        {/* View toggle */}
        <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs flex-shrink-0">
          <button
            onClick={switchToSource}
            className={`px-3 py-1.5 transition-colors ${mode === 'source' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-50'}`}
          >
            {t.mdPage.viewSource}
          </button>
          <button
            onClick={switchToPreview}
            className={`px-3 py-1.5 border-l border-gray-200 transition-colors ${mode === 'preview' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-50'}`}
          >
            {t.mdPage.viewPreview}
          </button>
        </div>

        {canEdit && isChanged && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-medium rounded-lg transition-colors flex-shrink-0"
          >
            {saving ? t.mdPage.saving : t.mdPage.save}
          </button>
        )}

        <button
          onClick={handlePrint}
          className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors flex-shrink-0"
        >
          {t.mdPage.print || '인쇄'}
        </button>

        {canEdit && mode === 'preview' && isUploadingImage && (
          <span className="text-xs text-indigo-600 font-medium">{t.mdPage.imageUploading || '이미지 업로드 중...'}</span>
        )}
      </div>

      {/* ── TipTap Toolbar (미리보기+편집 가능 모드에서만 표시) ── */}
      {canEdit && mode === 'preview' && editor && (
        <TipTapToolbar
          editor={editor}
          onInsertImage={handleImagePickClick}
          isUploadingImage={isUploadingImage}
        />
      )}

      {/* ── Content area ── */}
      <div
        ref={printContentRef}
        className={`easy-page-print-root flex-1 overflow-auto min-h-0 ${isDragOver ? 'bg-indigo-50/50' : ''}`}
        onDragOver={(e) => {
          if (!canEdit || mode !== 'preview') return
          if ((e.dataTransfer?.files?.length || 0) > 0) {
            e.preventDefault()
            setIsDragOver(true)
          }
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleEditorDrop}
      >
        {mode === 'source' ? (
          /* 소스 모드: 마크다운 텍스트 표시 */
          <textarea
            className="w-full h-full p-6 font-mono text-sm text-gray-800 bg-gray-50 resize-none focus:outline-none focus:bg-white transition-colors"
            value={sourceText}
            onChange={canEdit ? e => {
              const nextSource = e.target.value
              setSourceText(nextSource)
              setIsChanged(nextSource !== savedContent || !sameImageMeta(imageMeta, savedImageMeta))
            } : undefined}
            readOnly={!canEdit}
            spellCheck={false}
            placeholder={t.mdPage.sourcePlaceholder}
          />
        ) : (
          /* 미리보기 모드: TipTap WYSIWYG 에디터 */
          <div className="max-w-4xl mx-auto px-8 py-8 relative">
            {canEdit && (
              <LinkBubbleMenu editor={editor} />
            )}
            <EditorContent editor={editor} className="tiptap-editor" />
            {canEdit && (
              <InternalLinkAutocomplete editor={editor} />
            )}
          </div>
        )}
      </div>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleImageInputChange}
      />

      {/* ── 저장 다이얼로그 ── */}
      {showSaveDialog && (
        <ConfirmDialog
          title={t.mdPage.saveDialogTitle}
          message={t.mdPage.saveDialogMessage}
          confirmText={t.mdPage.saveDialogSave}
          cancelText={t.mdPage.saveDialogDiscard}
          titleTone="blue"
          loading={saving}
          onConfirm={async () => {
            await handleSave()
            setShowSaveDialog(false)
            onClose()
          }}
          onCancel={() => {
            setShowSaveDialog(false)
            onClose()
          }}
        />
      )}
    </div>
  )
}

/* ─────────────────────────────────────────
   TipTap 툴바 컴포넌트
───────────────────────────────────────── */
function TipTapToolbar({ editor, onInsertImage, isUploadingImage = false }) {
  if (!editor) return null

  const btn = (active, onClick, label, title) => (
    <button
      key={label}
      onMouseDown={e => { e.preventDefault(); onClick() }}
      title={title}
      className={`px-2 py-1 rounded text-sm transition-colors ${
        active
          ? 'bg-indigo-100 text-indigo-700 font-semibold'
          : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800'
      }`}
    >
      {label}
    </button>
  )

  const sep = (key) => <div key={key} className="w-px h-5 bg-gray-200 mx-0.5" />

  return (
    <div className="flex items-center gap-0.5 px-4 py-1.5 border-b border-gray-100 bg-gray-50 flex-wrap flex-shrink-0">
      {btn(editor.isActive('bold'),      () => editor.chain().focus().toggleBold().run(),      'B',  '굵게 (Ctrl+B)')}
      {btn(editor.isActive('italic'),    () => editor.chain().focus().toggleItalic().run(),    'I',  '기울임 (Ctrl+I)')}
      {btn(editor.isActive('strike'),    () => editor.chain().focus().toggleStrike().run(),    'S̶',  '취소선')}
      {btn(editor.isActive('code'),      () => editor.chain().focus().toggleCode().run(),      '<>',  '인라인 코드')}
      {sep('s1')}
      {btn(editor.isActive('heading', { level: 1 }), () => editor.chain().focus().toggleHeading({ level: 1 }).run(), 'H1', '제목 1')}
      {btn(editor.isActive('heading', { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run(), 'H2', '제목 2')}
      {btn(editor.isActive('heading', { level: 3 }), () => editor.chain().focus().toggleHeading({ level: 3 }).run(), 'H3', '제목 3')}
      {sep('s2')}
      {btn(editor.isActive('bulletList'),  () => editor.chain().focus().toggleBulletList().run(),  '•  목록',  '글머리 기호 목록')}
      {btn(editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run(), '1. 목록', '번호 목록')}
      {sep('s3')}
      {btn(editor.isActive('blockquote'),  () => editor.chain().focus().toggleBlockquote().run(),   '"  인용',   '인용구')}
      {btn(editor.isActive('codeBlock'),   () => editor.chain().focus().toggleCodeBlock().run(),    '코드 블록', '코드 블록')}
      {btn(false, () => editor.chain().focus().setHorizontalRule().run(), '── 구분선', '가로 구분선')}
      {btn(false, onInsertImage, isUploadingImage ? '업로드 중' : '이미지', '이미지 업로드 및 삽입')}
      {sep('s4')}
      {btn(false, () => editor.chain().focus().undo().run(), '↩ 실행취소', '실행취소 (Ctrl+Z)')}
      {btn(false, () => editor.chain().focus().redo().run(), '↪ 다시실행', '다시실행 (Ctrl+Y)')}
    </div>
  )
}

function LinkBubbleMenu({ editor }) {
  const [isEditing, setIsEditing] = useState(false)
  const [url, setUrl] = useState('')

  useEffect(() => {
    if (!editor) return undefined
    const closeOnEmptySelection = () => {
      if (editor.state.selection.empty) {
        setIsEditing(false)
      }
    }
    editor.on('selectionUpdate', closeOnEmptySelection)
    return () => {
      editor.off('selectionUpdate', closeOnEmptySelection)
    }
  }, [editor])

  if (!editor) return null

  const openEdit = () => {
    const currentHref = String(editor.getAttributes('link')?.href || '')
    setUrl(currentHref)
    setIsEditing(true)
  }

  const applyLink = () => {
    const normalized = normalizeLinkUrl(url)
    if (!normalized) return
    editor.chain().focus().extendMarkRange('link').setLink({ href: normalized }).run()
    setIsEditing(false)
  }

  const unsetLink = () => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
    setIsEditing(false)
  }

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor: ed, from, to }) => ed.isEditable && from !== to}
      tippyOptions={{ duration: 120, placement: 'top', maxWidth: 360 }}
      className="rounded-lg border border-gray-200 bg-white shadow-md px-2 py-1 flex items-center gap-1"
    >
      {isEditing ? (
        <div className="flex items-center gap-1">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                applyLink()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setIsEditing(false)
              }
            }}
            placeholder="https://example.com"
            className="h-8 w-56 px-2 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button
            onMouseDown={(e) => { e.preventDefault(); applyLink() }}
            className="h-8 px-2 rounded-md bg-indigo-600 text-white text-xs hover:bg-indigo-500"
          >
            적용
          </button>
          <button
            onMouseDown={(e) => { e.preventDefault(); setIsEditing(false) }}
            className="h-8 px-2 rounded-md text-xs text-gray-600 hover:bg-gray-100"
          >
            취소
          </button>
        </div>
      ) : (
        <>
          <button
            onMouseDown={(e) => { e.preventDefault(); openEdit() }}
            className="h-8 px-2 rounded-md text-xs text-gray-700 hover:bg-gray-100"
          >
            {editor.isActive('link') ? '링크 수정' : '링크 추가'}
          </button>
          {editor.isActive('link') && (
            <button
              onMouseDown={(e) => { e.preventDefault(); unsetLink() }}
              className="h-8 px-2 rounded-md text-xs text-red-600 hover:bg-red-50"
            >
              링크 해제
            </button>
          )}
        </>
      )}
    </BubbleMenu>
  )
}

function InternalLinkAutocomplete({ editor }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [replaceRange, setReplaceRange] = useState(null)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    if (!editor) return undefined

    const updateTrigger = () => {
      const { state } = editor
      const { selection } = state
      if (!selection.empty) {
        setOpen(false)
        setItems([])
        return
      }

      const { $from } = selection
      if (!$from.parent.isTextblock) {
        setOpen(false)
        setItems([])
        return
      }

      const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\0', '\0')
      const matched = textBefore.match(/\[\[([^\[\]]*)$/)
      if (!matched) {
        setOpen(false)
        setItems([])
        return
      }

      const typedQuery = String(matched[1] || '')
      const from = $from.start() + (matched.index ?? 0)
      const to = $from.pos

      setQuery(typedQuery)
      setReplaceRange({ from, to })
      setOpen(true)
    }

    editor.on('update', updateTrigger)
    editor.on('selectionUpdate', updateTrigger)
    updateTrigger()

    return () => {
      editor.off('update', updateTrigger)
      editor.off('selectionUpdate', updateTrigger)
    }
  }, [editor])

  useEffect(() => {
    if (!open) return undefined
    const q = query.trim()
    if (!q) {
      setItems([])
      setActiveIndex(0)
      return undefined
    }

    let cancelled = false
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const results = await apiFetch(`/posts/search?q=${encodeURIComponent(q)}`)
        if (cancelled) return

        const dedup = new Map()
        for (const row of Array.isArray(results) ? results : []) {
          const postId = row.type === 'comment' ? row.postId : row.id
          if (!postId || !row.channelId) continue
          if (!dedup.has(postId)) {
            const labelSource = row.type === 'comment' ? (row.postContent || row.content) : row.content
            dedup.set(postId, {
              postId,
              channelId: row.channelId,
              label: truncateSingleLine(labelSource || '문서', 64),
              subtitle: `${row.teamName || '-'} › ${row.channelName || '-'}`,
            })
          }
        }
        setItems(Array.from(dedup.values()).slice(0, 8))
        setActiveIndex(0)
      } catch (e) {
        if (!cancelled) {
          setItems([])
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }, 180)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, query])

  const selectItem = useCallback((item) => {
    if (!editor || !replaceRange || !item) return
    const href = `/?channelId=${encodeURIComponent(item.channelId)}&postId=${encodeURIComponent(item.postId)}`
    editor
      .chain()
      .focus()
      .deleteRange(replaceRange)
      .insertContent({
        type: 'text',
        text: item.label || '문서 링크',
        marks: [{ type: 'link', attrs: { href } }],
      })
      .insertContent(' ')
      .run()
    setOpen(false)
    setItems([])
  }, [editor, replaceRange])

  useEffect(() => {
    if (!open || !editor) return undefined

    const onKeyDown = (e) => {
      if (!open) return
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex(prev => (items.length ? (prev + 1) % items.length : 0))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex(prev => (items.length ? (prev - 1 + items.length) % items.length : 0))
        return
      }
      if (e.key === 'Enter') {
        if (!items.length) return
        e.preventDefault()
        selectItem(items[activeIndex] || items[0])
      }
    }

    const dom = editor.view?.dom
    dom?.addEventListener('keydown', onKeyDown)
    return () => dom?.removeEventListener('keydown', onKeyDown)
  }, [open, editor, items, activeIndex, selectItem])

  if (!open) return null

  return (
    <div className="absolute left-8 top-10 z-20 w-96 rounded-lg border border-gray-200 bg-white shadow-lg">
      <div className="px-3 py-2 border-b border-gray-100 text-xs text-gray-500">
        내부 문서 링크: <span className="font-semibold text-gray-700">[[{query}</span>
      </div>
      <div className="max-h-64 overflow-auto">
        {loading ? (
          <div className="px-3 py-3 text-xs text-gray-500">검색 중...</div>
        ) : items.length === 0 ? (
          <div className="px-3 py-3 text-xs text-gray-500">검색 결과가 없습니다.</div>
        ) : (
          items.map((item, index) => (
            <button
              key={`${item.channelId}-${item.postId}`}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                selectItem(item)
              }}
              className={`w-full text-left px-3 py-2 border-b border-gray-50 last:border-b-0 ${
                index === activeIndex ? 'bg-indigo-50' : 'hover:bg-gray-50'
              }`}
            >
              <p className="text-sm text-gray-800 font-medium truncate">{item.label}</p>
              <p className="text-[11px] text-gray-500 truncate">{item.subtitle}</p>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
