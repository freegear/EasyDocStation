import { useChat } from '../contexts/ChatContext'
import { useT } from '../i18n/useT'
import { useSelectionClickGuard } from '../hooks/useSelectionClickGuard'

export default function SearchResultsArea({ onSelectResult }) {
  const {
    searchTerm,
    searchResults,
    isSearching,
    closeSearch,
    selectTeam,
    selectChannel,
    teams
  } = useChat()
  const t = useT()
  const {
    handleMouseDown,
    handleMouseUp,
    handleClickCapture,
    shouldBlockClick,
  } = useSelectionClickGuard({ scope: 'search-result-card', dragThreshold: 4, blockOnAnySelection: true })

  async function handleItemClick(item, e) {
    if (shouldBlockClick(e, { useDragThreshold: true })) return
    const team = teams.find(tm => tm.name === item.teamName)
    const channel = team?.channels?.find(c => c.id === item.channelId)

    if (team && channel) {
      selectTeam(team)
      await selectChannel(channel)
      const postId = item.type === 'comment' || item.type === 'image_attachment'
        ? item.postId
        : item.id
      onSelectResult?.({ id: postId })
      closeSearch()
    }
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleString('ko-KR', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  function makePreview(text = '') {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim()
    if (!normalized) return '(내용 없음)'
    return normalized.length > 160 ? `${normalized.slice(0, 160)}...` : normalized
  }

  function makeResultLink(item) {
    const postId = item.type === 'comment' || item.type === 'image_attachment' ? item.postId : (item.postId || item.id)
    if (!item.channelId || !postId) return ''
    const params = new URLSearchParams()
    params.set('channelId', item.channelId)
    params.set('postId', postId)
    if (item.type === 'comment' && item.id) params.set('commentId', item.id)
    if (item.type === 'image_attachment' && item.commentId) params.set('commentId', item.commentId)
    if (item.type === 'image_attachment' && item.attachmentId) params.set('attachmentId', item.attachmentId)
    const base = typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}`
      : ''
    return `${base}?${params.toString()}`
  }

  function openResultLink(item, e) {
    e.stopPropagation()
    handleItemClick(item, e)
  }

  function resultTypeLabel(type) {
    if (type === 'post') return t.search.post
    if (type === 'image_attachment') return '이미지'
    return t.search.comment
  }

  return (
    <div className="flex-1 flex flex-col bg-gray-50 min-w-0">
      {/* Header */}
      <div className="h-14 px-6 border-b border-gray-200 flex items-center justify-between flex-shrink-0 bg-gray-50/50 backdrop-blur-md sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <button
            onClick={closeSearch}
            className="p-2 hover:bg-gray-200 rounded-lg text-gray-500 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </button>
          <div>
            <h2 className="text-gray-900 font-bold text-lg">{t.search.title}</h2>
            <p className="text-gray-400 text-xs">{t.search.resultCount(searchTerm, searchResults.length)}</p>
          </div>
        </div>
      </div>

      {/* Results List */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto space-y-4">
          {isSearching ? (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <div className="w-10 h-10 border-4 border-indigo-200 border-t-indigo-500 rounded-full animate-spin" />
              <p className="text-gray-400">{t.search.loading}</p>
            </div>
          ) : searchResults.length === 0 ? (
            <div className="text-center py-20">
              <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-10 h-10 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <p className="text-gray-400 text-lg">{t.search.noResultsTerm(searchTerm)}</p>
              <button
                onClick={closeSearch}
                className="mt-4 text-indigo-600 hover:text-indigo-600 font-medium"
              >
                {t.search.back}
              </button>
            </div>
          ) : (
            searchResults.map((item, idx) => {
              const resultLink = makeResultLink(item)
              return (
              <div
                key={`${item.id}-${idx}`}
                onMouseDown={handleMouseDown}
                onMouseUp={handleMouseUp}
                onClickCapture={handleClickCapture}
                onClick={(e) => handleItemClick(item, e)}
                className="bg-gray-100 border border-gray-200 rounded-2xl p-5 hover:border-indigo-500/50 hover:bg-gray-200 transition-all cursor-pointer group"
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                      item.type === 'post'
                        ? 'bg-indigo-100 text-indigo-600'
                        : item.type === 'image_attachment'
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-purple-100 text-purple-700'
                    }`}>
                      {idx + 1}. {resultTypeLabel(item.type)}
                    </span>
                    <span className="text-gray-400 text-xs">{item.teamName} › {item.channelName}</span>
                  </div>
                  <span className="text-gray-900 text-xs">{formatDate(item.createdAt)}</span>
                </div>

                <div className="flex gap-4">
                  <div className="w-10 h-10 rounded-full bg-indigo-500/30 flex items-center justify-center text-gray-900 font-bold flex-shrink-0 border border-gray-100 overflow-hidden">
                    {item.author?.image_url ? (
                      <img src={item.author.image_url} alt="" className="w-full h-full object-cover" />
                    ) : (
                      item.author?.name?.[0] || '?'
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-gray-700 font-bold text-sm mb-1">{item.author?.name}</p>

                    <div className="text-gray-800 text-sm leading-relaxed break-words select-text allow-copy cursor-text">
                      {makePreview(item.content)}
                    </div>

                    {resultLink && (
                      <button
                        type="button"
                        onClick={(e) => openResultLink(item, e)}
                        className="mt-3 block max-w-full text-left text-[11px] text-indigo-600 hover:text-indigo-700 underline decoration-indigo-300 underline-offset-2 break-all"
                        title={resultLink}
                      >
                        {resultLink}
                      </button>
                    )}
                  </div>
                </div>

                <div className="mt-4 flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                  <span className="text-indigo-600 text-xs font-bold flex items-center gap-1">
                    {t.search.goto}
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </span>
                </div>
              </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
