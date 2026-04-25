export function getSelectedText() {
  return window.getSelection?.()?.toString?.().trim?.() || ''
}

export function hasTextSelectionInside(container) {
  if (!container) return false
  const selection = window.getSelection?.()
  const text = selection?.toString?.().trim?.() || ''
  if (!text || !selection?.rangeCount) return false

  const range = selection.getRangeAt(0)
  const commonNode = range?.commonAncestorContainer
  if (commonNode && container.contains(commonNode)) return true

  const anchor = selection.anchorNode
  const focus = selection.focusNode
  return (
    (anchor ? container.contains(anchor) : false) ||
    (focus ? container.contains(focus) : false)
  )
}
