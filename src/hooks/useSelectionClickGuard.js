import { useRef } from 'react'
import { getSelectedText, hasAnyTextSelection, hasTextSelectionInside } from '../lib/textSelection'
import { logSelectionDebug } from '../lib/selectionDebug'

/**
 * @typedef {Object} SelectionClickGuardOptions
 * @property {string} [scope]
 * @property {number} [dragThreshold]
 * @property {boolean} [blockOnAnySelection]
 */

/**
 * @typedef {Object} BlockClickOptions
 * @property {boolean} [useDragThreshold]
 */

/**
 * Click guard for selectable text inside clickable containers.
 * @param {SelectionClickGuardOptions} [options]
 */
export function useSelectionClickGuard({
  scope = 'selection',
  dragThreshold = 4,
  blockOnAnySelection = true,
} = {}) {
  const suppressClickRef = useRef(false)
  const mouseDownPosRef = useRef(null)

  function handleMouseDown(e) {
    mouseDownPosRef.current = { x: e.clientX, y: e.clientY }
    logSelectionDebug(scope, 'mousedown', { x: e.clientX, y: e.clientY })
  }

  function handleMouseUp(e) {
    const currentTarget = e?.currentTarget
    const hasInsideSelection = hasTextSelectionInside(currentTarget)
    const selectedText = hasInsideSelection ? getSelectedText() : ''
    suppressClickRef.current = Boolean(selectedText)
    logSelectionDebug(scope, 'mouseup', {
      hasInsideSelection,
      selectedTextLength: selectedText.length,
      suppressNextClick: suppressClickRef.current,
    })
    return selectedText
  }

  function handleClickCapture(e) {
    const currentTarget = e?.currentTarget
    const hasInsideSelection = hasTextSelectionInside(currentTarget)
    const hasSelection = blockOnAnySelection ? hasAnyTextSelection() : hasInsideSelection
    if (!hasSelection || !hasInsideSelection) return
    logSelectionDebug(scope, 'click-capture-blocked', {
      hasSelection,
      hasInsideSelection,
    })
    e.preventDefault()
    e.stopPropagation()
  }

  /**
   * @param {MouseEvent & { currentTarget: EventTarget }} e
   * @param {BlockClickOptions} [options]
   */
  function shouldBlockClick(e, { useDragThreshold = true } = {}) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      logSelectionDebug(scope, 'click-blocked-suppress')
      return true
    }

    if (useDragThreshold) {
      const start = mouseDownPosRef.current
      if (start) {
        const dx = Math.abs(e.clientX - start.x)
        const dy = Math.abs(e.clientY - start.y)
        if (dx > dragThreshold || dy > dragThreshold) {
          logSelectionDebug(scope, 'click-blocked-drag-threshold', { dx, dy, dragThreshold })
          return true
        }
      }
    }

    const currentTarget = e?.currentTarget
    const hasInsideSelection = hasTextSelectionInside(currentTarget)
    const hasSelection = blockOnAnySelection ? hasAnyTextSelection() : hasInsideSelection
    if (hasSelection) {
      logSelectionDebug(scope, 'click-blocked-selection', {
        hasSelection,
        hasInsideSelection,
      })
      return true
    }
    return false
  }

  return {
    handleMouseDown,
    handleMouseUp,
    handleClickCapture,
    shouldBlockClick,
  }
}
