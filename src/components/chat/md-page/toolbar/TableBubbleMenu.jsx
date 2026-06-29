import { useCallback, useEffect, useRef, useState } from 'react'

export default function TableBubbleMenu({ editor }) {
  const [menuState, setMenuState] = useState({ open: false, x: 0, y: 0 })
  const menuRef = useRef(null)
  const isTableSelection = useCallback(() => (
    editor?.isActive('table')
    || editor?.isActive('tableCell')
    || editor?.isActive('tableHeader')
    || editor?.isActive('tableRow')
  ), [editor])

  useEffect(() => {
    if (!editor) return undefined

    const dom = editor.view?.dom
    if (!dom) return undefined

    const handleDoubleClick = (event) => {
      const rawTarget = event.target
      const target = rawTarget instanceof Element ? rawTarget : rawTarget?.parentElement
      if (!(target instanceof Element)) return

      const inTableDom = Boolean(target.closest('table, td, th'))
      if (!inTableDom) return

      const x = Number(event.clientX || 0)
      const y = Number(event.clientY || 0)

      requestAnimationFrame(() => {
        if (isTableSelection()) {
          setMenuState({ open: true, x, y })
        }
      })
    }

    const handlePointerDown = (event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : []
      if (menuRef.current && path.includes(menuRef.current)) return
      const target = event.target
      if (menuRef.current && target instanceof Node && menuRef.current.contains(target)) return
      setMenuState((prev) => ({ ...prev, open: false }))
    }

    const handleSelectionUpdate = () => {
      if (!isTableSelection()) {
        setMenuState((prev) => ({ ...prev, open: false }))
      }
    }

    dom.addEventListener('dblclick', handleDoubleClick)
    document.addEventListener('pointerdown', handlePointerDown)
    editor.on('selectionUpdate', handleSelectionUpdate)

    return () => {
      dom.removeEventListener('dblclick', handleDoubleClick)
      document.removeEventListener('pointerdown', handlePointerDown)
      editor.off('selectionUpdate', handleSelectionUpdate)
    }
  }, [editor, isTableSelection])

  if (!editor) return null
  if (!menuState.open) return null

  const MENU_WIDTH = 520
  const MARGIN = 12
  const left = Math.max(MARGIN, Math.min(menuState.x, window.innerWidth - MENU_WIDTH - MARGIN))
  const top = Math.max(MARGIN, Math.min(menuState.y + 12, window.innerHeight - 180))

  return (
    <div
      ref={menuRef}
      className="table-toolbar"
      style={{
        position: 'fixed',
        left: `${left}px`,
        top: `${top}px`,
        zIndex: 2000,
      }}
    >
      <div className="table-toolbar-row">
        <button onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().addColumnBefore().run() }}>
          왼쪽 열 추가
        </button>
        <button onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().addColumnAfter().run() }}>
          오른쪽 열 추가
        </button>
        <button onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().addRowBefore().run() }}>
          위 행 추가
        </button>
        <button onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().addRowAfter().run() }}>
          아래 행 추가
        </button>
        <button onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().mergeCells().run() }}>
          셀 병합
        </button>
      </div>
      <div className="table-toolbar-row">
        <button onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().splitCell().run() }}>
          셀 분할
        </button>
        <button onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().deleteColumn().run() }}>
          열 삭제
        </button>
        <button onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().deleteRow().run() }}>
          행 삭제
        </button>
        <button onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleHeaderRow().run() }}>
          헤더 토글
        </button>
        <button onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().deleteTable().run() }}>
          표 삭제
        </button>
      </div>
    </div>
  )
}
