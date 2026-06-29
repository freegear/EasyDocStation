import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../../../lib/api'
import { truncateSingleLine } from '../utils/markdown'

export default function InternalLinkAutocomplete({ editor }) {
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
      const matched = textBefore.match(/\[\[([^[\]]*)$/)
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
      const timer = window.setTimeout(() => {
        setItems([])
        setActiveIndex(0)
      }, 0)
      return () => window.clearTimeout(timer)
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
      } catch {
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
