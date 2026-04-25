import { useState, useEffect, useCallback, useRef } from 'react'
import { useChat } from '../../contexts/ChatContext'
import { useAuth } from '../../contexts/AuthContext'
import { useT } from '../../i18n/useT'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import ConfirmDialog from '../ConfirmDialog'
import { getMdPageContent } from '../../templates/formTemplates'

const MD_PAGE_MARKER = '<!--md-page-->'

export default function MDPageViewer({ post, channelId, onClose }) {
  const { updatePost } = useChat()
  const { currentUser } = useAuth()
  const t = useT()

  const [mode, setMode] = useState('preview')
  const [rawContent, setRawContent] = useState(() => getMdPageContent(post.content))
  const [savedContent, setSavedContent] = useState(() => getMdPageContent(post.content))
  const [saving, setSaving] = useState(false)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const showSaveDialogRef = useRef(false)

  useEffect(() => { showSaveDialogRef.current = showSaveDialog }, [showSaveDialog])

  const isChanged = rawContent !== savedContent
  const canEdit = post.author?.id === currentUser?.id
    || ['site_admin', 'team_admin', 'channel_admin'].includes(currentUser?.role)

  const pageTitle = rawContent.match(/^#{1,3}\s+(.+)/m)?.[1] || t.mdPage.title

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      await updatePost(channelId, post.id, { content: `${MD_PAGE_MARKER}\n${rawContent}` })
      setSavedContent(rawContent)
    } catch (e) {
      console.error('MD 페이지 저장 실패:', e)
    } finally {
      setSaving(false)
    }
  }, [channelId, post.id, rawContent, updatePost])

  // ESC 키: 편집 중 변경사항 있으면 저장 다이얼로그
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key !== 'Escape') return
      if (showSaveDialogRef.current) return
      if (mode === 'source' && isChanged) {
        setShowSaveDialog(true)
      } else {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [mode, isChanged, onClose])

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-white">
      {/* Top bar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-200 bg-white shadow-sm flex-shrink-0">
        <button
          onClick={() => {
            if (mode === 'source' && isChanged) setShowSaveDialog(true)
            else onClose()
          }}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 px-2 py-1 rounded-lg hover:bg-gray-100 transition-colors flex-shrink-0"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          {t.mdPage.back}
        </button>

        <div className="w-px h-5 bg-gray-200 flex-shrink-0" />

        <span className="text-sm text-gray-700 font-medium flex-1 truncate min-w-0">
          {pageTitle}
        </span>

        {/* View mode toggle */}
        <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs flex-shrink-0">
          <button
            onClick={() => setMode('source')}
            className={`px-3 py-1.5 transition-colors ${
              mode === 'source'
                ? 'bg-indigo-600 text-white'
                : 'text-gray-500 hover:bg-gray-50'
            }`}
          >
            {t.mdPage.viewSource}
          </button>
          <button
            onClick={() => setMode('preview')}
            className={`px-3 py-1.5 border-l border-gray-200 transition-colors ${
              mode === 'preview'
                ? 'bg-indigo-600 text-white'
                : 'text-gray-500 hover:bg-gray-50'
            }`}
          >
            {t.mdPage.viewPreview}
          </button>
        </div>

        {canEdit && mode === 'source' && isChanged && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-medium rounded-lg transition-colors flex-shrink-0"
          >
            {saving ? t.mdPage.saving : t.mdPage.save}
          </button>
        )}
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-auto min-h-0">
        {mode === 'source' ? (
          <textarea
            className="w-full h-full p-6 font-mono text-sm text-gray-800 bg-gray-50 resize-none focus:outline-none focus:bg-white transition-colors"
            value={rawContent}
            onChange={canEdit ? e => setRawContent(e.target.value) : undefined}
            readOnly={!canEdit}
            spellCheck={false}
            placeholder={t.mdPage.sourcePlaceholder}
          />
        ) : (
          <div className="max-w-4xl mx-auto px-8 py-8">
            <MdPreview content={rawContent} />
          </div>
        )}
      </div>

      {/* 저장 여부 다이얼로그 */}
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

function MdPreview({ content }) {
  return (
    <div className="text-gray-800 leading-relaxed select-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="text-3xl font-bold text-gray-900 mt-8 mb-4 pb-2 border-b border-gray-200 first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="text-2xl font-bold text-gray-900 mt-6 mb-3">{children}</h2>,
          h3: ({ children }) => <h3 className="text-xl font-semibold text-gray-900 mt-5 mb-2">{children}</h3>,
          h4: ({ children }) => <h4 className="text-lg font-semibold text-gray-800 mt-4 mb-2">{children}</h4>,
          p: ({ children }) => <p className="my-3 text-gray-700 leading-7">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-6 my-3 space-y-1.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-6 my-3 space-y-1.5">{children}</ol>,
          li: ({ children }) => <li className="text-gray-700 leading-6">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="pl-4 border-l-4 border-indigo-300 my-4 text-gray-600 italic bg-indigo-50/50 py-2 pr-3 rounded-r-lg">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-gray-200 my-6" />,
          code({ inline, children, className }) {
            return inline
              ? <code className="bg-gray-100 text-indigo-700 px-1.5 py-0.5 rounded text-sm font-mono">{children}</code>
              : <pre className="bg-gray-900 text-gray-100 p-4 rounded-xl my-4 overflow-x-auto"><code className={`text-sm font-mono ${className || ''}`}>{children}</code></pre>
          },
          table: ({ children }) => (
            <div className="overflow-x-auto my-4">
              <table className="min-w-full border border-gray-200 rounded-xl overflow-hidden text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-gray-100 text-gray-900">{children}</thead>,
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => <tr className="border-b border-gray-200">{children}</tr>,
          th: ({ children }) => <th className="px-4 py-2.5 text-left font-semibold">{children}</th>,
          td: ({ children }) => <td className="px-4 py-2.5 text-gray-700">{children}</td>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline">
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <img src={src} alt={alt} className="max-w-full rounded-lg my-3 shadow-sm" />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
