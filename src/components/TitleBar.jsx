import { useState, useRef, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { ROLE_LABELS, ROLE_BADGE } from '../constants/roles'

const LANGUAGES = [
  { code: 'ko', label: '한국어' },
  { code: 'en', label: 'English' },
]

export default function TitleBar({ onOpenProfile, onOpenSiteAdmin }) {
  const { currentUser, language, setLanguage, logout } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)

  // Close on outside click
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

  function formatLoginTime(iso) {
    if (!iso) return '-'
    return new Date(iso).toLocaleString('ko-KR', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  return (
    <header className="flex items-center justify-between px-5 h-14 bg-[#1a1d2e] border-b border-white/10 flex-shrink-0 z-10">
      {/* App title */}
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold shadow">
          ED
        </div>
        <span className="text-white font-bold text-lg tracking-tight">EasyDocStation</span>
      </div>

      {/* Right section */}
      <div className="flex items-center gap-4">
        {/* Language selector */}
        <select
          value={language}
          onChange={e => setLanguage(e.target.value)}
          className="bg-white/10 text-white text-sm rounded-md px-2 py-1 border border-white/20 focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
        >
          {LANGUAGES.map(lang => (
            <option key={lang.code} value={lang.code} className="bg-[#1a1d2e]">{lang.label}</option>
          ))}
        </select>

        {/* User avatar + popup trigger */}
        {currentUser && (
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen(v => !v)}
              className="flex items-center gap-2.5 px-2 py-1.5 rounded-xl hover:bg-white/8 transition-colors group"
            >
              <div className="w-8 h-8 rounded-full bg-indigo-500 overflow-hidden flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                {currentUser.image_url ? (
                  <img src={currentUser.image_url} alt={currentUser.name} className="w-full h-full object-cover" />
                ) : (
                  currentUser.avatar
                )}
              </div>
              <div className="hidden sm:block text-left">
                <p className="text-white text-sm font-medium leading-none">{currentUser.name}</p>
                <p className="text-white/40 text-xs leading-none mt-0.5">{roleLabel}</p>
              </div>
              <svg className={`w-3.5 h-3.5 text-white/30 transition-transform ${menuOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
