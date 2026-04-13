import { useChat } from '../contexts/ChatContext'
import { useT } from '../i18n/useT'

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

  async function handleItemClick(item) {
    const team = teams.find(tm => tm.name === item.teamName)
    const channel = team?.channels?.find(c => c.id === item.channelId)

    if (team && channel) {
      selectTeam(team)
      await selectChannel(channel)
      const postId = item.type === 'comment' ? item.postId : item.id
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

  return (
    <div className="flex-1 flex flex-col bg-[#1e1c30] min-w-0">
      {/* Header */}
      <div className="h-14 px-6 border-b border-white/10 flex items-center justify-between flex-shrink-0 bg-[#1e1c30]/50 backdrop-blur-md sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <button
            onClick={closeSearch}
            className="p-2 hover:bg-white/10 rounded-lg text-white/60 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </button>
          <div>
            <h2 className="text-white font-bold text-lg">{t.search.title}</h2>
            <p className="text-white/40 text-xs">{t.search.resultCount(searchTerm, searchResults.length)}</p>
          </div>
        </div>
      </div>

      {/* Results List */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto space-y-4">
          {isSearching ? (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <div className="w-10 h-10 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />
              <p className="text-white/40">{t.search.loading}</p>
            </div>
          ) : searchResults.length === 0 ? (
            <div className="text-center py-20">
              <div className="w-20 h-20 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-10 h-10 text-white/20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <p className="text-white/40 text-lg">{t.search.noResultsTerm(searchTerm)}</p>
              <button
                onClick={closeSearch}
                className="mt-4 text-indigo-400 hover:text-indigo-300 font-medium"
              >
                {t.search.back}
              </button>
            </div>
          ) : (
            searchResults.map((item, idx) => (
              <div
                key={`${item.id}-${idx}`}
                onClick={() => handleItemClick(item)}
                className="bg-white/5 border border-white/10 rounded-2xl p-5 hover:border-indigo-500/50 hover:bg-white/8 transition-all cursor-pointer group"
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                      item.type === 'post'
                        ? 'bg-indigo-500/20 text-indigo-300'
                        : 'bg-purple-500/20 text-purple-300'
                    }`}>
                      {item.type === 'post' ? t.search.post : t.search.comment}
                    </span>
                    <span className="text-white/30 text-xs">{item.teamName} › {item.channelName}</span>
                  </div>
                  <span className="text-white/20 text-xs">{formatDate(item.createdAt)}</span>
                </div>

                <div className="flex gap-4">
                  <div className="w-10 h-10 rounded-full bg-indigo-500/30 flex items-center justify-center text-white font-bold flex-shrink-0 border border-white/5 overflow-hidden">
                    {item.author?.image_url ? (
                      <img src={item.author.image_url} alt="" className="w-full h-full object-cover" />
                    ) : (
                      item.author?.name?.[0] || '?'
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-white/80 font-bold text-sm mb-1">{item.author?.name}</p>

                    {item.type === 'comment' && item.postContent && (
                      <div className="mb-2 p-3 bg-black/20 rounded-xl border border-white/5">
                        <p className="text-white/30 text-[11px] uppercase font-bold mb-1">{t.search.originalPost}</p>
                        <p className="text-white/40 text-xs line-clamp-1 italic">{item.postContent}</p>
                      </div>
                    )}

                    <div className="text-white/90 text-sm leading-relaxed whitespace-pre-wrap break-words">
                      {item.content}
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                  <span className="text-indigo-400 text-xs font-bold flex items-center gap-1">
                    {t.search.goto}
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
