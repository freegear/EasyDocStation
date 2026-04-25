import { useState, useEffect, useCallback, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from 'tiptap-markdown'
import { useChat } from '../../contexts/ChatContext'
import { useAuth } from '../../contexts/AuthContext'
import { useT } from '../../i18n/useT'
import ConfirmDialog from '../ConfirmDialog'
import { getMdPageContent } from '../../templates/formTemplates'
import '../../styles/tiptap.css'

const MD_PAGE_MARKER = '<!--md-page-->'

export default function MDPageViewer({ post, channelId, onClose }) {
  const { updatePost } = useChat()
  const { currentUser } = useAuth()
  const t = useT()

  const [mode, setMode] = useState('preview')
  const [savedContent, setSavedContent] = useState(() => getMdPageContent(post.content))
  const [sourceText, setSourceText] = useState(() => getMdPageContent(post.content))
  const [isChanged, setIsChanged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const showSaveDialogRef = useRef(false)

  useEffect(() => { showSaveDialogRef.current = showSaveDialog }, [showSaveDialog])

  const canEdit = post.author?.id === currentUser?.id
    || ['site_admin', 'team_admin', 'channel_admin'].includes(currentUser?.role)

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: t.mdPage.sourcePlaceholder }),
      Markdown.configure({ html: false, transformCopiedText: true, transformPastedText: true }),
    ],
    content: getMdPageContent(post.content),
    editable: canEdit && mode === 'preview',
    onUpdate({ editor }) {
      const md = editor.storage.markdown.getMarkdown()
      setIsChanged(md !== savedContent)
    },
  })

  // mode 변경 시 editor editable 상태 동기화
  useEffect(() => {
    if (!editor) return
    editor.setEditable(canEdit && mode === 'preview')
  }, [editor, canEdit, mode])

  // 소스 → 미리보기 전환: 소스 텍스트를 에디터에 반영
  function switchToPreview() {
    if (mode === 'source' && editor) {
      editor.commands.setContent(sourceText)
      setIsChanged(sourceText !== savedContent)
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
    return editor?.storage.markdown.getMarkdown() || ''
  }, [mode, sourceText, editor])

  const handleSave = useCallback(async () => {
    const md = getCurrentMarkdown()
    setSaving(true)
    try {
      await updatePost(channelId, post.id, { content: `${MD_PAGE_MARKER}\n${md}` })
      setSavedContent(md)
      setIsChanged(false)
    } catch (e) {
      console.error('MD 페이지 저장 실패:', e)
    } finally {
      setSaving(false)
    }
  }, [channelId, getCurrentMarkdown, post.id, updatePost])

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

  const pageTitle = getCurrentMarkdown().match(/^#{1,3}\s+(.+)/m)?.[1] || t.mdPage.title

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
      </div>

      {/* ── TipTap Toolbar (미리보기+편집 가능 모드에서만 표시) ── */}
      {canEdit && mode === 'preview' && editor && (
        <TipTapToolbar editor={editor} />
      )}

      {/* ── Content area ── */}
      <div className="flex-1 overflow-auto min-h-0">
        {mode === 'source' ? (
          /* 소스 모드: 마크다운 텍스트 표시 */
          <textarea
            className="w-full h-full p-6 font-mono text-sm text-gray-800 bg-gray-50 resize-none focus:outline-none focus:bg-white transition-colors"
            value={sourceText}
            onChange={canEdit ? e => {
              setSourceText(e.target.value)
              setIsChanged(e.target.value !== savedContent)
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
function TipTapToolbar({ editor }) {
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
      {sep('s4')}
      {btn(false, () => editor.chain().focus().undo().run(), '↩ 실행취소', '실행취소 (Ctrl+Z)')}
      {btn(false, () => editor.chain().focus().redo().run(), '↪ 다시실행', '다시실행 (Ctrl+Y)')}
    </div>
  )
}
