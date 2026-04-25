import { useState, useEffect, useCallback, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Dropcursor from '@tiptap/extension-dropcursor'
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

function extractImageMeta(mdText = '') {
  const match = mdText.match(/<!--md-image-meta:([A-Za-z0-9+/=_-]+)-->\s*$/m)
  if (!match?.[1]) return {}
  try {
    return JSON.parse(atob(match[1])) || {}
  } catch {
    return {}
  }
}

function stripImageMeta(mdText = '') {
  return mdText.replace(/\n?<!--md-image-meta:[A-Za-z0-9+/=_-]+-->\s*$/m, '')
}

function attachImageMeta(mdText = '', imageMeta = {}) {
  const plain = stripImageMeta(mdText || '')
  const keys = Object.keys(imageMeta || {})
  if (keys.length === 0) return plain
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(imageMeta))))
  return `${plain}\n${MD_IMAGE_META_PREFIX}${encoded}-->`
}

function collectImageMetaFromDoc(doc) {
  const map = {}
  doc.descendants((node) => {
    if (node.type.name !== 'image') return
    const src = String(node.attrs?.src || '').trim()
    if (!src) return
    map[src] = {
      width: node.attrs?.width ?? null,
      containerStyle: node.attrs?.containerStyle ?? null,
      wrapperStyle: node.attrs?.wrapperStyle ?? null,
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

export default function MDPageViewer({ post, channelId, onClose }) {
  const { updatePost } = useChat()
  const { currentUser } = useAuth()
  const t = useT()
  const initialMdRaw = String(post.content || '').replace(/^<!--md-page-->\n?/, '')

  const [mode, setMode] = useState('preview')
  const [savedContent, setSavedContent] = useState(() => stripImageMeta(initialMdRaw))
  const [sourceText, setSourceText] = useState(() => stripImageMeta(initialMdRaw))
  const [imageMeta, setImageMeta] = useState(() => extractImageMeta(initialMdRaw))
  const [savedImageMeta, setSavedImageMeta] = useState(() => extractImageMeta(initialMdRaw))
  const [isChanged, setIsChanged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [isUploadingImage, setIsUploadingImage] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const showSaveDialogRef = useRef(false)
  const imageInputRef = useRef(null)

  useEffect(() => { showSaveDialogRef.current = showSaveDialog }, [showSaveDialog])

  const canEdit = post.author?.id === currentUser?.id
    || ['site_admin', 'team_admin', 'channel_admin'].includes(currentUser?.role)

  const editor = useEditor({
    extensions: [
      StarterKit,
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
      const nextImageMeta = collectImageMetaFromDoc(editor.state.doc)
      setImageMeta(nextImageMeta)
      setIsChanged(md !== savedContent || !sameImageMeta(nextImageMeta, savedImageMeta))
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
      if (!src || !imageMeta[src]) return
      const meta = imageMeta[src]
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
      editor.commands.setContent(sourceText)
      setIsChanged(sourceText !== savedContent || !sameImageMeta(imageMeta, savedImageMeta))
    }
    setMode('preview')
  }

  // 미리보기 → 소스 전환: 에디터 내용을 마크다운으로 추출
  function switchToSource() {
    if (mode === 'preview' && editor) {
      setSourceText(editor.storage.markdown.getMarkdown())
    }
    setMode('source')
  }

  const getCurrentMarkdown = useCallback(() => {
    if (mode === 'source') return sourceText
    return stripImageMeta(editor?.storage.markdown.getMarkdown() || '')
  }, [mode, sourceText, editor])

  const handleSave = useCallback(async () => {
    const md = getCurrentMarkdown()
    const mdWithMeta = attachImageMeta(md, imageMeta)
    setSaving(true)
    try {
      await updatePost(channelId, post.id, { content: `${MD_PAGE_MARKER}\n${mdWithMeta}` })
      setSavedContent(md)
      setSavedImageMeta(imageMeta)
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
        className={`flex-1 overflow-auto min-h-0 ${isDragOver ? 'bg-indigo-50/50' : ''}`}
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
          <div className="max-w-4xl mx-auto px-8 py-8">
            <EditorContent editor={editor} className="tiptap-editor" />
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
