import { useState, useRef, useCallback, useEffect } from 'react'
import { apiFetch } from '../lib/api'

// @word 패턴 감지: 커서 직전 @로 시작하는 단어
function getMentionQuery(text, cursorPos) {
  const before = text.slice(0, cursorPos)
  const match = before.match(/@([^\s@]*)$/)
  if (!match) return null
  return match[1] // @ 이후 현재까지 입력된 글자
}

// 선택한 사용자를 @DisplayName 으로 치환
function applyMention(text, cursorPos, user) {
  const before = text.slice(0, cursorPos)
  const after = text.slice(cursorPos)
  const match = before.match(/@([^\s@]*)$/)
  if (!match) return { text, cursor: cursorPos }
  const mentionStart = cursorPos - match[0].length
  const displayName = user.display_name || user.name
  const inserted = `@${displayName} `
  return {
    text: before.slice(0, mentionStart) + inserted + after,
    cursor: mentionStart + inserted.length,
  }
}

export default function useMentionAutocomplete(teamId) {
  const [query, setQuery] = useState(null)        // null = 비활성, '' = @ 직후
  const [users, setUsers] = useState([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [open, setOpen] = useState(false)
  const fetchTimer = useRef(null)
  const activeQuery = useRef(null)

  // 쿼리 변경 시 사용자 검색
  useEffect(() => {
    if (query === null) { setOpen(false); return }
    clearTimeout(fetchTimer.current)
    fetchTimer.current = setTimeout(async () => {
      try {
        let results
        if (teamId && query === '') {
          // @ 입력 직후: 팀 전체 멤버 로드
          const data = await apiFetch(`/teams/${teamId}/members`)
          results = Array.isArray(data) ? data : (data?.members || [])
        } else {
          const data = await apiFetch(`/users/search?q=${encodeURIComponent(query)}`)
          results = Array.isArray(data) ? data : []
        }
        // 현재 쿼리가 바뀌지 않은 경우에만 반영
        if (activeQuery.current === query) {
          setUsers(results.slice(0, 10))
          setSelectedIdx(0)
          setOpen(results.length > 0)
        }
      } catch {
        setOpen(false)
      }
    }, query === '' ? 0 : 200)
  }, [query, teamId])

  // textarea onChange 에서 호출
  const handleChange = useCallback((value, cursorPos) => {
    const q = getMentionQuery(value, cursorPos)
    activeQuery.current = q
    setQuery(q)
  }, [])

  // 사용자 선택 → 텍스트 치환 후 콜백 호출
  const selectUser = useCallback((user, content, cursorPos, onResult) => {
    const { text, cursor } = applyMention(content, cursorPos, user)
    setOpen(false)
    setQuery(null)
    setUsers([])
    onResult(text, cursor)
  }, [])

  // keydown 에서 호출 → true 이면 기본 동작 막음
  const handleKeyDown = useCallback((e) => {
    if (!open) return false
    if (e.key === 'ArrowDown') {
      setSelectedIdx(i => Math.min(i + 1, users.length - 1))
      return true
    }
    if (e.key === 'ArrowUp') {
      setSelectedIdx(i => Math.max(i - 1, 0))
      return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      return true // 선택은 외부에서 처리
    }
    if (e.key === 'Escape') {
      setOpen(false)
      setQuery(null)
      return true
    }
    return false
  }, [open, users.length])

  const close = useCallback(() => {
    setOpen(false)
    setQuery(null)
    setUsers([])
  }, [])

  return { open, users, selectedIdx, handleChange, handleKeyDown, selectUser, close }
}
