export default function MentionDropdown({ users, selectedIdx, onSelect }) {
  if (!users || users.length === 0) return null
  return (
    <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[9999] bg-white border border-gray-200 rounded-xl shadow-2xl overflow-hidden w-72">
      <p className="px-3 py-1.5 text-[11px] text-gray-400 border-b border-gray-100 font-medium tracking-wide">
        멘션할 사용자 선택
      </p>
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
