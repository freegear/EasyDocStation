import { useState, useEffect, useCallback } from 'react'

function formatRemaining(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// 최근 삭제됨(1분 내 복구 가능) 목록 모달
export default function RecentlyDeletedModal({ channelId, onClose, fetchDeletedItems, restorePost, restoreComment }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [restoringId, setRestoringId] = useState(null)
  const [loadedAt, setLoadedAt] = useState(0)
  const [now, setNow] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchDeletedItems(channelId)
      const ts = Date.now()
      setLoadedAt(ts)
      setNow(ts)
      setItems(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err.message || '목록을 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }, [channelId, fetchDeletedItems])

  useEffect(() => { load() }, [load])

  // 1초마다 현재 시각만 갱신 (남은 시간은 렌더에서 계산)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  async function handleRestore(item) {
    setRestoringId(`${item.type}:${item.id}`)
    try {
      if (item.type === 'post') {
        await restorePost(channelId, item.id)
      } else {
        await restoreComment(channelId, item.postId, item.id)
      }
      setItems((prev) => prev.filter((it) => !(it.type === item.type && it.id === item.id)))
    } catch (err) {
      setError(err.message || '복구에 실패했습니다.')
    } finally {
      setRestoringId(null)
    }
  }

  const elapsed = loadedAt ? now - loadedAt : 0
  const visibleItems = items.filter((it) => (it.remainingMs - elapsed) > 0)

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/45 px-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white border border-gray-200 shadow-2xl flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div>
            <h3 className="text-gray-900 font-bold text-base">최근 삭제됨</h3>
            <p className="text-gray-400 text-xs mt-0.5">삭제 후 1분 이내에 복구할 수 있습니다.</p>
          </div>
          <button
            onClick={onClose}
            aria-label="닫기"
            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <p className="text-gray-400 text-sm text-center py-10">불러오는 중…</p>
          ) : error ? (
            <p className="text-red-500 text-sm text-center py-10 whitespace-pre-wrap">{error}</p>
          ) : visibleItems.length === 0 ? (
            <p className="text-gray-400 text-sm text-center py-10">최근 삭제된 항목이 없습니다.</p>
          ) : (
            <ul className="space-y-2">
              {visibleItems.map((item) => {
                const remaining = item.remainingMs - elapsed
                const key = `${item.type}:${item.id}`
                return (
                  <li key={key} className="flex items-center gap-3 rounded-xl border border-gray-200 px-3 py-2.5">
                    <span className={`shrink-0 px-2 py-0.5 rounded-md text-[11px] font-semibold ${item.type === 'post' ? 'bg-indigo-50 text-indigo-600' : 'bg-emerald-50 text-emerald-600'}`}>
                      {item.type === 'post' ? '게시글' : '댓글'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-gray-700 text-sm truncate">{item.preview || '(내용 없음)'}</p>
                      <p className="text-gray-400 text-xs mt-0.5">남은 시간 {formatRemaining(remaining)}</p>
                    </div>
                    <button
                      onClick={() => handleRestore(item)}
                      disabled={restoringId === key}
                      className="shrink-0 px-3 py-1.5 rounded-xl text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {restoringId === key ? '복구 중…' : '복구'}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
