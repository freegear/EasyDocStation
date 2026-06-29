import { useEffect, useRef, useState } from 'react'

export default function useCommentPaneResize({ showComments }) {
  const [commentPaneWidth, setCommentPaneWidth] = useState(420)
  const [isResizingCommentPane, setIsResizingCommentPane] = useState(false)
  const splitAreaRef = useRef(null)
  const resizeStartRef = useRef({ x: 0, width: 420 })

  useEffect(() => {
    if (!showComments) return undefined

    const onMouseMove = (e) => {
      if (!isResizingCommentPane) return
      const area = splitAreaRef.current
      if (!(area instanceof HTMLElement)) return

      const bounds = area.getBoundingClientRect()
      const delta = e.clientX - resizeStartRef.current.x
      const desired = resizeStartRef.current.width - delta
      const minComment = 280
      const minEditor = 360
      const maxComment = Math.max(minComment, bounds.width - minEditor - 8)
      const nextWidth = Math.max(minComment, Math.min(maxComment, desired))
      setCommentPaneWidth(nextWidth)
    }

    const onMouseUp = () => {
      if (!isResizingCommentPane) return
      setIsResizingCommentPane(false)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [showComments, isResizingCommentPane])

  useEffect(() => () => {
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }, [])

  function handleCommentSplitterMouseDown(e) {
    if (!showComments) return
    e.preventDefault()
    resizeStartRef.current = { x: e.clientX, width: commentPaneWidth }
    setIsResizingCommentPane(true)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }

  return {
    commentPaneWidth,
    handleCommentSplitterMouseDown,
    isResizingCommentPane,
    splitAreaRef,
  }
}
