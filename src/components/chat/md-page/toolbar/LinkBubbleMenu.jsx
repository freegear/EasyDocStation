import { useEffect, useState } from 'react'
import { BubbleMenu } from '@tiptap/react/menus'
import { normalizeLinkUrl } from '../utils/markdown'

export default function LinkBubbleMenu({ editor }) {
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
