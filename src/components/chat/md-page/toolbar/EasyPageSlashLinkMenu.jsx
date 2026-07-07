import { useCallback, useEffect, useMemo, useState } from 'react'
import { TextSelection } from '@tiptap/pm/state'
import { getMdPageTitle, isMdPage } from '../../../../templates/formTemplates'

function extractInternalPostLinks(content = '') {
  const links = []
  const text = String(content || '').replace(/&amp;/g, '&')
  const candidates = text.match(/\/?\?[^)\s"'<>]+/g) || []

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate, window.location.origin)
      if (url.origin !== window.location.origin) continue
      const channelId = url.searchParams.get('channelId') || url.searchParams.get('channelid')
      const postId = url.searchParams.get('postId') || url.searchParams.get('postid')
      if (channelId && postId) links.push({ channelId: String(channelId), postId: String(postId) })
    } catch {
      // Ignore malformed link-like text while scanning page content.
    }
  }

  return links
}

function buildEasyPageItems({ channelId, currentPost, channelPosts }) {
  const currentPostId = String(currentPost?.id || '')
  const pages = (Array.isArray(channelPosts) ? channelPosts : [])
    .filter(post => post?.id && isMdPage(post.content))
    .map(post => ({
      post,
      postId: String(post.id),
      channelId: String(post.channelId || post.channel_id || channelId || ''),
      title: getMdPageTitle(post.content, 'EasyPage'),
    }))
    .filter(item => item.channelId && item.postId)

  const pageById = new Map(pages.map(item => [item.postId, item]))
  const graph = new Map(pages.map(item => [item.postId, new Set()]))

  for (const item of pages) {
    const links = extractInternalPostLinks(item.post.content)
    for (const link of links) {
      if (String(link.channelId) !== String(item.channelId)) continue
      if (!pageById.has(String(link.postId))) continue
      graph.get(item.postId)?.add(String(link.postId))
      graph.get(String(link.postId))?.add(item.postId)
    }
  }

  const connectedIds = new Set()
  if (currentPostId && pageById.has(currentPostId)) {
    const queue = [currentPostId]
    connectedIds.add(currentPostId)
    while (queue.length > 0) {
      const id = queue.shift()
      for (const nextId of graph.get(id) || []) {
        if (connectedIds.has(nextId)) continue
        connectedIds.add(nextId)
        queue.push(nextId)
      }
    }
  }

  const connectedItems = pages
    .filter(item => connectedIds.has(item.postId) && item.postId !== currentPostId)
    .map(item => ({ ...item, relation: '연결된 EasyPage' }))

  const fallbackItems = pages
    .filter(item => item.postId !== currentPostId)
    .map(item => ({ ...item, relation: '현재 게시판 EasyPage' }))

  const source = connectedItems.length > 0 ? connectedItems : fallbackItems
  return source.sort((a, b) => a.title.localeCompare(b.title, 'ko'))
}

export default function EasyPageSlashLinkMenu({ editor, channelId, currentPost, channelPosts }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [replaceRange, setReplaceRange] = useState(null)
  const [menuPosition, setMenuPosition] = useState(null)
  const [activeIndex, setActiveIndex] = useState(0)

  const allItems = useMemo(() => (
    buildEasyPageItems({ channelId, currentPost, channelPosts })
  ), [channelId, currentPost, channelPosts])

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return allItems.slice(0, 10)
    return allItems
      .filter(item => item.title.toLowerCase().includes(q))
      .slice(0, 10)
  }, [allItems, query])

  useEffect(() => {
    if (!editor) return undefined

    const updateTrigger = () => {
      const { state } = editor
      const { selection } = state
      if (!selection.empty) {
        setOpen(false)
        return
      }

      const { $from } = selection
      if (!$from.parent.isTextblock) {
        setOpen(false)
        return
      }

      const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\0', '\0')
      const matched = textBefore.match(/(?:^|\s)\/([^\s/]*)$/)
      if (!matched) {
        setOpen(false)
        return
      }

      const slashOffset = (matched.index ?? 0) + matched[0].lastIndexOf('/')
      const from = $from.start() + slashOffset
      const to = $from.pos
      let nextPosition = null
      try {
        const coords = editor.view.coordsAtPos(to)
        const menuWidth = 384
        const menuMaxHeight = 320
        const viewportWidth = window.innerWidth || 0
        const viewportHeight = window.innerHeight || 0
        nextPosition = {
          left: Math.max(8, Math.min(coords.left, Math.max(8, viewportWidth - menuWidth - 8))),
          top: Math.max(8, Math.min(coords.bottom + 8, Math.max(8, viewportHeight - menuMaxHeight - 8))),
        }
      } catch {
        // Positioning is best-effort; the menu falls back to the viewport edge.
      }

      setQuery(String(matched[1] || ''))
      setReplaceRange({ from, to })
      setMenuPosition(nextPosition)
      setActiveIndex(0)
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

  const selectItem = useCallback((item) => {
    if (!editor || !replaceRange || !item) return
    const href = `/?channelId=${encodeURIComponent(item.channelId)}&postId=${encodeURIComponent(item.postId)}`
    const title = item.title || 'EasyPage'
    const { from, to } = replaceRange
    const { state, view } = editor
    const { schema } = state
    if (
      !Number.isFinite(from) || !Number.isFinite(to)
      || from < 0 || to > state.doc.content.size || from > to
    ) {
      setOpen(false)
      setMenuPosition(null)
      return
    }

    // 커맨드 체인/포커스 타이밍에 의존하지 않도록 ProseMirror 트랜잭션을 직접 dispatch한다.
    // `/검색어` 범위를 링크 mark가 적용된 제목 텍스트 + 공백으로 치환한다.
    const linkMark = schema.marks.link
    const linkedTitle = schema.text(title, linkMark ? [linkMark.create({ href })] : [])
    const trailingSpace = schema.text(' ')
    const tr = state.tr.replaceWith(from, to, [linkedTitle, trailingSpace])
    const caretPos = Math.min(from + title.length + 1, tr.doc.content.size)
    try {
      tr.setSelection(TextSelection.create(tr.doc, caretPos))
    } catch {
      // 선택 위치 복원은 best-effort. 실패해도 삽입 자체는 유지된다.
    }
    view.dispatch(tr.scrollIntoView())
    view.focus()

    setOpen(false)
    setMenuPosition(null)
  }, [editor, replaceRange])

  useEffect(() => {
    if (!open || !editor) return undefined

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopPropagation()
        setActiveIndex(prev => (items.length ? (prev + 1) % items.length : 0))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        setActiveIndex(prev => (items.length ? (prev - 1 + items.length) % items.length : 0))
        return
      }
      if (event.key === 'Enter' && items.length > 0) {
        event.preventDefault()
        event.stopPropagation()
        selectItem(items[activeIndex] || items[0])
      }
    }

    // capture 단계에서 가로채 ProseMirror의 기본 Enter(줄 분리)/방향키 처리보다 먼저 실행되게 한다.
    const dom = editor.view?.dom
    dom?.addEventListener('keydown', onKeyDown, true)
    return () => dom?.removeEventListener('keydown', onKeyDown, true)
  }, [activeIndex, editor, items, open, selectItem])

  if (!open) return null

  return (
    <div
      data-easypage-slash-link-menu="true"
      className="fixed z-30 w-96 rounded-lg border border-gray-200 bg-white shadow-lg"
      style={{
        left: menuPosition?.left ?? 8,
        top: menuPosition?.top ?? 8,
      }}
    >
      <div className="px-3 py-2 border-b border-gray-100 text-xs text-gray-500">
        EasyPage 링크: <span className="font-semibold text-gray-700">/{query}</span>
      </div>
      <div className="max-h-72 overflow-auto">
        {items.length === 0 ? (
          <div className="px-3 py-3 text-xs text-gray-500">
            {query.trim() ? '검색 결과가 없습니다.' : '연결된 EasyPage가 없습니다.'}
          </div>
        ) : (
          items.map((item, index) => (
            <button
              key={`${item.channelId}-${item.postId}`}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
                selectItem(item)
              }}
              className={`w-full text-left px-3 py-2 border-b border-gray-50 last:border-b-0 ${
                index === activeIndex ? 'bg-indigo-50' : 'hover:bg-gray-50'
              }`}
            >
              <p className="text-sm text-gray-800 font-medium truncate">{item.title}</p>
              <p className="text-[11px] text-gray-500 truncate">{item.relation}</p>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
