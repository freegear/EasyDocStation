import { useState } from 'react'

export default function LikeButton({ liked, count, onClick, fetchLikers, label = '좋아요' }) {
  const [likersOpen, setLikersOpen] = useState(false)
  const [likers, setLikers] = useState([])
  const [likersLoading, setLikersLoading] = useState(false)
  const likerCount = Number(count || 0)

  async function handleLikersClick(e) {
    e.preventDefault()
    e.stopPropagation()
    if (likerCount <= 0 || likersLoading) return
    if (likersOpen) {
      setLikersOpen(false)
      return
    }
    setLikersLoading(true)
    try {
      const data = await fetchLikers?.()
      setLikers(Array.isArray(data) ? data : [])
      setLikersOpen(true)
    } catch (err) {
      alert(`좋아요 목록을 불러오지 못했습니다: ${err.message || err}`)
    } finally {
      setLikersLoading(false)
    }
  }

  return (
    <div className="relative inline-flex items-center gap-1">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onClick?.()
        }}
        className={`inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs transition-colors ${
          liked
            ? 'text-red-600 hover:bg-red-50'
            : 'text-gray-400 hover:bg-gray-100 hover:text-red-500'
        }`}
        title={label}
        aria-label={label}
        aria-pressed={Boolean(liked)}
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill={liked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8">
          <path strokeLinecap="round" strokeLinejoin="round" d="M20.8 4.6c-1.8-1.8-4.7-1.8-6.5 0L12 6.9 9.7 4.6c-1.8-1.8-4.7-1.8-6.5 0s-1.8 4.7 0 6.5L12 19.9l8.8-8.8c1.8-1.8 1.8-4.7 0-6.5Z" />
        </svg>
        <span className="min-w-3 tabular-nums">{likerCount}</span>
      </button>
      <button
        type="button"
        onClick={handleLikersClick}
        disabled={likerCount <= 0 || likersLoading}
        className={`inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
          likerCount > 0
            ? 'text-gray-500 hover:bg-gray-100 hover:text-gray-800'
            : 'text-gray-300 opacity-40 cursor-default'
        }`}
        title="좋아요를 누른 사람"
        aria-label="좋아요를 누른 사람"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 7.5a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.5 20.25a7.5 7.5 0 0 1 15 0" />
        </svg>
      </button>
      {likersOpen && (
        <div
          className="absolute left-0 top-8 z-30 min-w-36 max-w-56 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-700 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="max-h-40 overflow-y-auto">
            {likers.map((user) => (
              <div key={user.id} className="truncate py-1">{user.name}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
