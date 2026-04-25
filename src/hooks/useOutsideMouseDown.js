import { useEffect } from 'react'
import { hasAnyTextSelection } from '../lib/textSelection'
import { logSelectionDebug } from '../lib/selectionDebug'

/**
 * @typedef {Object} UseOutsideMouseDownOptions
 * @property {boolean} [enabled]
 * @property {React.RefObject<HTMLElement>} containerRef
 * @property {(event: MouseEvent) => void} onOutside
 * @property {boolean} [ignoreWhenTextSelected]
 * @property {string} [scope]
 */

/**
 * Reusable outside-click (mousedown) hook with optional text-selection guard.
 * @param {UseOutsideMouseDownOptions} options
 */
export function useOutsideMouseDown({
  enabled = true,
  containerRef,
  onOutside,
  ignoreWhenTextSelected = true,
  scope = 'outside-mousedown',
}) {
  useEffect(() => {
    if (!enabled) return

    /** @param {MouseEvent} event */
    function handleMouseDown(event) {
      if (ignoreWhenTextSelected && hasAnyTextSelection()) {
        logSelectionDebug(scope, 'outside-ignored-by-selection')
        return
      }

      const root = containerRef?.current
      if (!root) return
      if (root.contains(/** @type {Node} */ (event.target))) return

      logSelectionDebug(scope, 'outside-triggered')
      onOutside(event)
    }

    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [enabled, containerRef, onOutside, ignoreWhenTextSelected, scope])
}
