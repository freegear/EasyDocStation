import { useState, useRef, useEffect, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useChat } from '../contexts/ChatContext'
import { apiFetch } from '../lib/api'
import { ROLE_LABELS, ROLE_BADGE } from '../constants/roles'

const LANGUAGES = [
  { code: 'ko', label: '한국어' },
  { code: 'en', label: 'English' },
]

// ─── Search Bar ───────────────────────────────────────────────
function SearchBar({ onSelectResult }) {
  const { teams, posts, selectTeam, selectChannel, performSearch } = useChat()
  const { selectTeam: ctxSelectTeam, selectChannel: ctxSelectChannel } = useChat()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const inputRef = useRef(null)
  const containerRef = useRef(null)

  // 바깥 클릭 시 닫기
  useEffect(() => {
    function handler(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const runSearch = useCallback(async (q) => {
    if (!q.trim()) { setResults([]); return }
    setSearching(true)
    try {
      // 모든 채널의 로드된 포스트에서 in-memory 검색 (실시간 미리보기용)
      const matched = []
      for (const team of teams) {
        for (const ch of (team.channels || [])) {
          const channelPosts = posts[ch.id] || []
          for (const post of channelPosts) {
            const inContent = post.content?.toLowerCase().includes(q.toLowerCase())
            const inComments = (post.comments || []).some(c =>
              c.content?.toLowerCase().includes(q.toLowerCase()) ||
              c.text?.toLowerCase().includes(q.toLowerCase())
            )
            if (inContent || inComments) {
              matched.push({ post, channel: ch, team, matchType: inContent ? 'post' : 'comment' })
            }
          }
        }
      }
      setResults(matched.slice(0, 10))
    } finally {
      setSearching(false)
    }
  }, [teams, posts])

  // 디바운스 (미리보기)
  useEffect(() => {
    const t = setTimeout(() => {
      if (query.trim().length >= 1) runSearch(query)
      else { setResults([]) }
    }, 300)
    return () => clearTimeout(t)
  }, [query, runSearch])

  function handleSubmit(e) {
    e.preventDefault()
    if (query.trim()) {
      performSearch(query)
      setOpen(false)
    }
  }

  async function handleSelect(item) {
    setOpen(false)
    setQuery('')
    setResults([])
    // 팀 → 채널 → 게시글 선택
    ctxSelectTeam(item.team)
    await ctxSelectChannel(item.channel)
    onSelectResult?.(item.post)
  }

  function highlight(text, q) {
    const idx = text?.toLowerCase().indexOf(q.toLowerCase())
    if (!text || idx === -1) return text
    return (
      <>
        {text.slice(0, idx)}
        <mark className="bg-indigo-400/30 text-indigo-200 rounded px-0.5">{text.slice(idx, idx + q.length)}</mark>
        {text.slice(idx + q.length)}
      </>
    )
  }

  return (
    <div ref={containerRef} className="relative flex-1 max-w-md">
      <form onSubmit={handleSubmit} className="flex items-center gap-0">
        <div className="relative flex-1">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => { setQuery(e.target.value); setOpen(true) }}
            onFocus={() => { if (results.length > 0) setOpen(true) }}
            placeholder="게시글 및 댓글 검색..."
            className="w-full bg-white border border-gray-200 rounded-l-xl pl-8 pr-3 py-1.5 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-indigo-500/60 focus:border-indigo-400 transition-all"
          />
        </div>
        <button
          type="submit"
          className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-r-xl border border-indigo-500 transition-colors whitespace-nowrap flex-shrink-0"
        >
          검색
        </button>
      </form>

      {/* 검색 결과 드롭다운 */}
      {open && query.trim() && (
        <div className="absolute left-0 right-0 top-full mt-1.5 bg-[#1a1828] border border-white/10 rounded-2xl shadow-2xl shadow-black/50 z-50 overflow-hidden max-h-[400px] overflow-y-auto">
          {searching && (
            <div className="px-4 py-3 text-white/30 text-sm flex items-center gap-2">
              <div className="w-3 h-3 border border-indigo-400/40 border-t-indigo-400 rounded-full animate-spin" />
              검색 중...
            </div>
          )}
          {!searching && results.length === 0 && (
            <div className="px-4 py-3 text-white/25 text-sm">"{query}"에 대한 결과가 없습니다.</div>
          )}
          {!searching && results.map((item, i) => {
            const preview = (item.post.content || '').slice(0, 120)
            return (
              <button
                key={`${item.post.id}-${i}`}
                onMouseDown={() => handleSelect(item)}
                className="w-full px-4 py-3 text-left hover:bg-white/6 border-b border-white/5 last:border-0 transition-colors"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wide ${
                    item.matchType === 'post'
                      ? 'bg-indigo-500/20 text-indigo-300'
                      : 'bg-purple-500/20 text-purple-300'
                  }`}>
                    {item.matchType === 'post' ? '게시글' : '댓글'}
                  </span>
                  <span className="text-white/30 text-[10px]">{item.team.name} › {item.channel.name}</span>
                  {item.post.author?.name && (
                    <span className="text-white/25 text-[10px] ml-auto">{item.post.author.name}</span>
                  )}
                </div>
                <p className="text-white/80 text-xs leading-relaxed line-clamp-2">
                  {highlight(preview, query)}
                </p>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── TitleBar ─────────────────────────────────────────────────
export default function TitleBar({ onOpenProfile, onOpenSiteAdmin, onSelectSearchResult }) {
  const { currentUser, language, setLanguage, logout } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)

  useEffect(() => {
    function handleClickOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false)
      }
    }
    if (menuOpen) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen])

  const isSiteAdmin = currentUser?.role === 'site_admin'
  const roleBadge = ROLE_BADGE[currentUser?.role] ?? ROLE_BADGE.user
  const roleLabel = ROLE_LABELS[currentUser?.role] ?? ''
  const langLabel = LANGUAGES.find(l => l.code === language)?.label ?? '한국어'

  function formatLoginTime(iso) {
    if (!iso) return '-'
    return new Date(iso).toLocaleString('ko-KR', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  return (
    <header className="flex items-center justify-between px-5 h-14 bg-[#1a1d2e] border-b border-white/10 flex-shrink-0 z-10">
      {/* 왼쪽 끝: 새로운 로고(SVG) + 타이틀 */}
      <div className="flex items-center gap-2.5 flex-shrink-0 cursor-pointer" onClick={() => window.location.href = '/'}>
        <img src="/img/logo.png" alt="Logo" className="w-8 h-8 object-contain" />
        <span className="text-white font-bold text-lg tracking-tight hidden sm:inline">EasyStation</span>
      </div>

      {/* 오른쪽 끝: 검색 + 언어 + 사용자 */}
      <div className="flex items-center gap-3">

        {/* Search bar */}
        <SearchBar onSelectResult={onSelectSearchResult} />

        {/* Language toggle button */}
        <div className="flex items-center bg-white/6 border border-white/10 rounded-lg overflow-hidden flex-shrink-0">
          {LANGUAGES.map(lang => (
            <button
              key={lang.code}
              onClick={() => setLanguage(lang.code)}
              className={`px-2.5 py-1 text-xs font-medium transition-all ${
                language === lang.code
                  ? 'bg-indigo-600 text-white'
                  : 'text-white/40 hover:text-white/70 hover:bg-white/5'
              }`}
            >
              {lang.label}
            </button>
          ))}
        </div>

        {/* User avatar + popup trigger */}
        {currentUser && (
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen(v => !v)}
              className="flex items-center gap-2 px-2 py-1.5 rounded-xl hover:bg-white/8 transition-colors group"
            >
              <div className="w-7 h-7 rounded-full bg-indigo-500 overflow-hidden flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                {currentUser.image_url ? (
                  <img src={currentUser.image_url} alt={currentUser.name} className="w-full h-full object-cover" />
                ) : (
                  currentUser.avatar
                )}
              </div>
              <div className="hidden sm:block text-left">
                <p className="text-white text-xs font-medium leading-none">{currentUser.name}</p>
                <p className="text-white/40 text-[10px] leading-none mt-0.5">{roleLabel}</p>
              </div>
              <svg className={`w-3 h-3 text-white/30 transition-transform ${menuOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {/* Dropdown menu */}
            {menuOpen && (
              <div className="absolute right-0 top-full mt-2 w-64 bg-[#1e1c30] border border-white/10 rounded-2xl shadow-2xl shadow-black/40 overflow-hidden z-50">
                {/* User summary */}
                <div className="px-4 py-3 border-b border-white/8">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-indigo-500 overflow-hidden flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                      {currentUser.image_url ? (
                        <img src={currentUser.image_url} alt={currentUser.name} className="w-full h-full object-cover" />
                      ) : (
                        currentUser.avatar
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-white font-semibold text-sm truncate">{currentUser.name}</p>
                      <p className="text-white/40 text-xs truncate">{currentUser.email}</p>
                      <span className={`inline-block mt-1 px-2 py-0.5 rounded-md text-xs font-medium border ${roleBadge}`}>
                        {roleLabel}
                      </span>
                    </div>
                  </div>
                  {currentUser.last_login_at && (
                    <p className="text-white/25 text-xs mt-2">
                      마지막 로그인: {formatLoginTime(currentUser.last_login_at)}
                    </p>
                  )}
                </div>

                {/* Menu items */}
                <div className="py-1">
                  <MenuItem
                    icon={
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                      </svg>
                    }
                    label="사용자 정보 편집"
                    onClick={() => { setMenuOpen(false); onOpenProfile?.() }}
                  />

                  {isSiteAdmin && (
                    <MenuItem
                      icon={
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                      }
                      label="사이트 관리"
                      badge="관리자"
                      onClick={() => { setMenuOpen(false); onOpenSiteAdmin?.() }}
                    />
                  )}
                </div>

                <div className="border-t border-white/8 py-1">
                  <MenuItem
                    icon={
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                      </svg>
                    }
                    label="로그아웃"
                    danger
                    onClick={() => { setMenuOpen(false); logout() }}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  )
}

function MenuItem({ icon, label, badge, danger, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors text-left ${
        danger
          ? 'text-red-400/70 hover:text-red-400 hover:bg-red-500/8'
          : 'text-white/60 hover:text-white hover:bg-white/6'
      }`}
    >
      <span className="flex-shrink-0">{icon}</span>
      <span className="flex-1">{label}</span>
      {badge && (
        <span className="px-1.5 py-0.5 rounded text-xs bg-indigo-500/20 text-indigo-300 border border-indigo-500/20">
          {badge}
        </span>
      )}
    </button>
  )
}
