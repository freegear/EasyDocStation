import { useMemo, useState } from 'react'
import { buildEasyPageTree } from './easyPageTree'

function TreeItem({ node, currentPostId, expandedIds, onToggle, onOpen }) {
  const hasChildren = node.children.length > 0
  const expanded = expandedIds.has(node.postId)
  const current = node.postId === String(currentPostId)
  return (
    <li role="treeitem" aria-current={current ? 'page' : undefined} aria-expanded={hasChildren ? expanded : undefined}>
      <div
        className={`group flex items-center rounded-lg text-sm ${current ? 'bg-indigo-100 font-bold text-indigo-800' : 'text-gray-700 hover:bg-gray-100'}`}
        style={{ paddingLeft: `${8 + node.depth * 14}px` }}
      >
        <button
          type="button"
          aria-label={hasChildren ? `${node.title} ${expanded ? '접기' : '펼치기'}` : undefined}
          disabled={!hasChildren}
          onClick={() => hasChildren && onToggle(node.postId)}
          className="flex h-7 w-6 flex-shrink-0 items-center justify-center text-gray-400 disabled:opacity-0"
        >
          {expanded ? '▾' : '▸'}
        </button>
        <button
          type="button"
          title={node.title}
          onClick={() => onOpen(node.channelId, node.postId)}
          className="min-w-0 flex-1 truncate py-2 pr-2 text-left"
        >
          {node.title}
        </button>
      </div>
      {hasChildren && expanded && (
        <ul role="group">
          {node.children.map(child => (
            <TreeItem
              key={child.postId}
              node={child}
              currentPostId={currentPostId}
              expandedIds={expandedIds}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

export default function EasyPageNavigationPanel({ channelId, currentPostId, channelPosts, onOpen }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('easy-page-nav-collapsed') === 'true')
  const [mobileOpen, setMobileOpen] = useState(false)
  const [expandedIds, setExpandedIds] = useState(() => new Set())
  const tree = useMemo(() => buildEasyPageTree({ channelId, currentPostId, channelPosts }), [channelId, currentPostId, channelPosts])
  const visibleExpandedIds = useMemo(() => {
    const path = []
    let id = String(currentPostId || '')
    const guard = new Set()
    while (id && !guard.has(id)) {
      guard.add(id)
      const parentId = tree.parentIdByChild.get(id)
      if (!parentId) break
      path.push(parentId)
      id = parentId
    }
    return new Set([...expandedIds, ...path, tree.rootId].filter(Boolean))
  }, [currentPostId, expandedIds, tree.parentIdByChild, tree.rootId])

  const toggleCollapsed = () => {
    setCollapsed(value => {
      localStorage.setItem('easy-page-nav-collapsed', String(!value))
      return !value
    })
  }

  const treeContent = tree.root ? (
    <ul role="tree">
      <TreeItem
        node={tree.root}
        currentPostId={currentPostId}
        expandedIds={visibleExpandedIds}
        onToggle={(id) => setExpandedIds(previous => {
          const next = new Set(previous)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })}
        onOpen={(targetChannelId, targetPostId) => {
          setMobileOpen(false)
          onOpen(targetChannelId, targetPostId)
        }}
      />
    </ul>
  ) : <p className="px-2 py-4 text-xs text-gray-400">표시할 EasyPage가 없습니다.</p>

  if (collapsed) {
    return (
      <>
        <aside className="hidden w-12 flex-shrink-0 border-r border-gray-200 bg-gray-50 md:flex md:flex-col md:items-center md:py-3">
          <button type="button" onClick={toggleCollapsed} title="EasyPage 목차 펼치기" aria-label="EasyPage 목차 펼치기" className="rounded-lg p-2 text-gray-500 hover:bg-gray-200">☰</button>
        </aside>
        <button type="button" onClick={() => setMobileOpen(true)} className="fixed bottom-5 left-4 z-40 rounded-full bg-indigo-600 px-4 py-3 text-sm font-bold text-white shadow-lg md:hidden">목차</button>
        {mobileOpen && (
          <div className="fixed inset-0 z-[80] bg-black/40 md:hidden" onClick={() => setMobileOpen(false)}>
            <nav aria-label="EasyPage 목차" className="h-full w-[82vw] max-w-xs bg-white shadow-xl" onClick={event => event.stopPropagation()}>
              <div className="flex items-center justify-between border-b px-4 py-3"><strong>페이지 목차</strong><button type="button" onClick={() => setMobileOpen(false)}>✕</button></div>
              <div className="overflow-y-auto p-2">{treeContent}</div>
            </nav>
          </div>
        )}
      </>
    )
  }

  return (
    <>
      <nav aria-label="EasyPage 목차" className="hidden w-64 flex-shrink-0 flex-col border-r border-gray-200 bg-gray-50 md:flex">
        <div className="flex items-center justify-between border-b border-gray-200 px-3 py-3">
          <span className="text-xs font-bold uppercase tracking-wide text-gray-500">페이지 목차</span>
          <button type="button" onClick={toggleCollapsed} title="목차 접기" aria-label="EasyPage 목차 접기" className="rounded p-1 text-gray-400 hover:bg-gray-200">◀</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">{treeContent}</div>
      </nav>
      <button type="button" onClick={() => setMobileOpen(true)} className="fixed bottom-5 left-4 z-40 rounded-full bg-indigo-600 px-4 py-3 text-sm font-bold text-white shadow-lg md:hidden">목차</button>
      {mobileOpen && (
        <div className="fixed inset-0 z-[80] bg-black/40 md:hidden" onClick={() => setMobileOpen(false)}>
          <nav aria-label="EasyPage 목차" className="h-full w-[82vw] max-w-xs bg-white shadow-xl" onClick={event => event.stopPropagation()}>
            <div className="flex items-center justify-between border-b px-4 py-3"><strong>페이지 목차</strong><button type="button" onClick={() => setMobileOpen(false)}>✕</button></div>
            <div className="overflow-y-auto p-2">{treeContent}</div>
          </nav>
        </div>
      )}
    </>
  )
}
