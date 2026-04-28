import { useState, useRef, useCallback, useEffect } from 'react'
import { apiFetch } from '../lib/api'

export const MENTION_SEPARATOR = '\u2063'

// @word 패턴 감지: 커서 직전 @로 시작하는 단어
function getMentionQuery(text, cursorPos) {
  const before = text.slice(0, cursorPos)
  const match = before.match(/@([^\s@]*)$/)
  if (!match) return null
  return match[1]
}

// 선택한 사용자를 @DisplayName 으로 치환
function applyMention(text, cursorPos, user) {
  const before = text.slice(0, cursorPos)
  const after = text.slice(cursorPos)
  const match = before.match(/@([^\s@]*)$/)
  if (!match) return { text, cursor: cursorPos }
  const mentionStart = cursorPos - match[0].length
  const displayName = user.display_name || user.name
  const inserted = `@${displayName}${MENTION_SEPARATOR} `
  return {
    text: before.slice(0, mentionStart) + inserted + after,
    cursor: mentionStart + inserted.length,
  }
}

// 미러 div 기법으로 textarea 내 커서의 화면 좌표 계산
export function getCursorCoords(textarea) {
  if (!textarea) return null
  const { value, selectionStart } = textarea
  const rect = textarea.getBoundingClientRect()
  const style = window.getComputedStyle(textarea)

  const mirror = document.createElement('div')
  mirror.style.cssText = [
    'position:absolute', 'visibility:hidden', 'pointer-events:none',
    'white-space:pre-wrap', 'word-break:break-word', 'overflow-wrap:break-word',
    `top:${rect.top + window.scrollY}px`,
    `left:${rect.left + window.scrollX}px`,
    `width:${style.width}`,
    `font-size:${style.fontSize}`,
    `font-family:${style.fontFamily}`,
    `font-weight:${style.fontWeight}`,
    `letter-spacing:${style.letterSpacing}`,
    `line-height:${style.lineHeight}`,
    `padding:${style.padding}`,
    `border:${style.border}`,
    `box-sizing:${style.boxSizing}`,
  ].join(';')

  const textBeforeCursor = value.slice(0, selectionStart)
  mirror.textContent = textBeforeCursor

  const marker = document.createElement('span')
  marker.textContent = '​'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)

  const markerRect = marker.getBoundingClientRect()
  document.body.removeChild(mirror)

  const lineHeight = parseFloat(style.lineHeight) || 20
  const scrollTop = textarea.scrollTop || 0

  // 뷰포트 기준 좌표 (fixed 포지션용)
  return {
    x: markerRect.left,
    y: markerRect.top + lineHeight - scrollTop,
  }
}

export default function useMentionAutocomplete(teamId) {
  const [query, setQuery] = useState(null)
  const [users, setUsers] = useState([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [open, setOpen] = useState(false)
  const [cursorCoords, setCursorCoords] = useState(null)
  const [teamMembers, setTeamMembers] = useState([])
  const fetchTimer = useRef(null)
  const activeQuery = useRef(null)

  useEffect(() => {
    let disposed = false
    ;(async () => {
      if (!teamId) {
        setTeamMembers([])
        return
      }
      try {
        const data = await apiFetch(`/teams/${teamId}/members`)
        const members = Array.isArray(data) ? data : (data?.members || [])
        if (!disposed) setTeamMembers(members)
      } catch {
        if (!disposed) setTeamMembers([])
      }
    })()
    return () => { disposed = true }
  }, [teamId])

  useEffect(() => {
    if (query === null) { setOpen(false); return }
    clearTimeout(fetchTimer.current)
    fetchTimer.current = setTimeout(async () => {
      try {
        let results
        if (teamId) {
          const q = String(query || '').trim().toLowerCase()
          results = (teamMembers || []).filter((u) => {
            if (!q) return true
            const name = String(u?.name || '').toLowerCase()
            const displayName = String(u?.display_name || '').toLowerCase()
            const username = String(u?.username || '').toLowerCase()
            return name.startsWith(q) || displayName.startsWith(q) || username.startsWith(q)
          })
        } else {
          const data = await apiFetch(`/users/search?q=${encodeURIComponent(query)}`)
          results = Array.isArray(data) ? data : []
        }
        if (activeQuery.current === query) {
          setUsers(results.slice(0, 10))
          setSelectedIdx(0)
          setOpen(results.length > 0)
        }
      } catch {
        setOpen(false)
      }
    }, query === '' ? 0 : 200)
  }, [query, teamId, teamMembers])

  // textarea onChange 에서 호출 — textareaEl 을 넘기면 커서 좌표도 갱신
  const handleChange = useCallback((value, cursorPos, textareaEl) => {
    const q = getMentionQuery(value, cursorPos)
    activeQuery.current = q
    setQuery(q)
    if (q !== null && textareaEl) {
      setCursorCoords(getCursorCoords(textareaEl))
    } else if (q === null) {
      setCursorCoords(null)
    }
  }, [])

  const selectUser = useCallback((user, content, cursorPos, onResult) => {
    const { text, cursor } = applyMention(content, cursorPos, user)
    setOpen(false)
    setQuery(null)
    setUsers([])
    setCursorCoords(null)
    onResult(text, cursor)
  }, [])

  const handleKeyDown = useCallback((e) => {
    if (!open) return false
    if (e.key === 'ArrowDown') { setSelectedIdx(i => Math.min(i + 1, users.length - 1)); return true }
    if (e.key === 'ArrowUp')   { setSelectedIdx(i => Math.max(i - 1, 0)); return true }
    if (e.key === 'Enter' || e.key === 'Tab') return true
    if (e.key === 'Escape') { setOpen(false); setQuery(null); setCursorCoords(null); return true }
    return false
  }, [open, users.length])

  const close = useCallback(() => {
    setOpen(false); setQuery(null); setUsers([]); setCursorCoords(null)
  }, [])

  return { open, users, selectedIdx, cursorCoords, handleChange, handleKeyDown, selectUser, close }
}
