import { useLayoutEffect, useRef, useState } from 'react'

export function useAnchoredMenuPosition(x, y, { margin = 8 } = {}) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    // 가로: 오른쪽으로 넘치면 왼쪽으로 당기고, 그래도 음수면 여백으로.
    let left = Math.min(x, vw - rect.width - margin)
    if (left < margin) left = margin
    // 세로: 아래 공간이 충분하면 커서 아래, 부족하면 위로 펼친다. 뷰포트보다 크면 상단 정렬.
    let top = (y + rect.height + margin <= vh) ? y : Math.max(margin, y - rect.height)
    if (top + rect.height + margin > vh) top = Math.max(margin, vh - rect.height - margin)
    setPos({ left, top })
  }, [x, y, margin])
  const style = {
    left: pos ? pos.left : x,
    top: pos ? pos.top : y,
    maxHeight: `calc(100vh - ${margin * 2}px)`,
    overflowY: 'auto',
    visibility: pos ? 'visible' : 'hidden',
  }
  return { ref, style }
}

export function useAnchoredSubmenuPosition(anchorRect, { margin = 8, gap = 4 } = {}) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !anchorRect) {
      setPos(null)
      return
    }
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const openRight = anchorRect.right + gap + rect.width + margin <= vw
    let left = openRight ? anchorRect.right + gap : anchorRect.left - rect.width - gap
    if (left < margin) left = margin
    if (left + rect.width + margin > vw) left = Math.max(margin, vw - rect.width - margin)
    let top = anchorRect.top
    if (top + rect.height + margin > vh) top = Math.max(margin, vh - rect.height - margin)
    setPos({ left, top })
  }, [anchorRect, margin, gap])
  const style = {
    left: pos ? pos.left : anchorRect?.right ?? 0,
    top: pos ? pos.top : anchorRect?.top ?? 0,
    maxHeight: `calc(100vh - ${margin * 2}px)`,
    overflowY: 'auto',
    visibility: pos ? 'visible' : 'hidden',
  }
  return { ref, style }
}
