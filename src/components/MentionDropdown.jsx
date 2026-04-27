import { useEffect, useRef } from 'react'

export default function MentionDropdown({ users, selectedIdx, onSelect, position }) {
  const ref = useRef(null)

  // 뷰포트 밖으로 벗어나지 않도록 위치 보정
  useEffect(() => {
    const el = ref.current
    if (!el || !position) return
    const { innerWidth, innerHeight } = window
    const r = el.getBoundingClientRect()

    let left = position.x
    let top = position.y

    if (left + r.width > innerWidth - 8) left = innerWidth - r.width - 8
    if (left < 8) left = 8
    // 아래 공간이 부족하면 커서 위로 표시
    if (top + r.height > innerHeight - 8) top = position.y - r.height - (parseFloat(window.getComputedStyle(el).lineHeight) || 20)

    el.style.left = `${left}px`
    el.style.top  = `${top}px`
  }, [position, users])

  if (!users || users.length === 0 || !position) return null

  return (
    <div
      ref={ref}
      style={{ position: 'fixed', left: position.x, top: position.y, zIndex: 9999 }}
      className="bg-white border border-gray-200 rounded-xl shadow-xl overflow-hidden w-64"
    >
      {users.map((user, i) => {
        const displayName = user.display_name || user.name
        const initials = displayName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
        return (
          <button
            key={user.id}
            type="button"
            onMouseDown={e => { e.preventDefault(); onSelect(user) }}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
              i === selectedIdx ? 'bg-indigo-50 text-indigo-700' : 'text-gray-800 hover:bg-gray-50'
            }`}
          >
            <span className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold flex items-center justify-center flex-shrink-0">
              {initials}
            </span>
            <span className="font-medium truncate">@{displayName}</span>
            {user.username && <span className="text-xs text-gray-400 truncate ml-auto">{user.username}</span>}
          </button>
        )
      })}
    </div>
  )
}
