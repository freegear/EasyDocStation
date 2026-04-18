import { useState, useRef, useCallback, useEffect } from 'react'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ChatProvider, useChat } from './contexts/ChatContext'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import ChatArea from './components/ChatArea'
import GroqPanel from './components/GroqPanel'
import LoginScreen from './components/LoginScreen'
import UserProfileModal from './components/UserProfileModal'
import SiteAdminPage from './components/SiteAdminPage'
import SearchResultsArea from './components/SearchResultsArea'
import CalendarView from './components/CalendarView'
import DirectMessageView, { NewConversationModal } from './components/DirectMessageView'
import ConfirmDialog from './components/ConfirmDialog'

function MainLayout() {
  const [showProfile, setShowProfile] = useState(false)
  const [showProfileSavedDialog, setShowProfileSavedDialog] = useState(false)
  const [showSiteAdmin, setShowSiteAdmin] = useState(false)
  const [searchSelectedPost, setSearchSelectedPost] = useState(null)
  const [showCalendar, setShowCalendar] = useState(false)
  const [showDM, setShowDM] = useState(false)
  const [activeDMConv, setActiveDMConv] = useState(null)
  const [showNewDM, setShowNewDM] = useState(false)
  const { isSearchMode, teams, navigateToPost } = useChat()
  const deepLinkHandledRef = useRef(false)

  const [groqWidth, setGroqWidth] = useState(320)
  const [resizingGroq, setResizingGroq] = useState(false)
  const [showAgenticPanel, setShowAgenticPanel] = useState(true)
  const mainRef = useRef(null)

  const startGroqResize = useCallback((e) => {
    e.preventDefault()
    setResizingGroq(true)
  }, [])

  const stopGroqResize = useCallback(() => setResizingGroq(false), [])

  const onGroqMouseMove = useCallback((e) => {
    if (!resizingGroq || !mainRef.current) return
    const rect = mainRef.current.getBoundingClientRect()
    const newWidth = rect.right - e.clientX
    if (newWidth >= 200 && newWidth <= 600) setGroqWidth(newWidth)
  }, [resizingGroq])

  useEffect(() => {
    if (resizingGroq) {
      window.addEventListener('mousemove', onGroqMouseMove)
      window.addEventListener('mouseup', stopGroqResize)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    } else {
      window.removeEventListener('mousemove', onGroqMouseMove)
      window.removeEventListener('mouseup', stopGroqResize)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    return () => {
      window.removeEventListener('mousemove', onGroqMouseMove)
      window.removeEventListener('mouseup', stopGroqResize)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [resizingGroq, onGroqMouseMove, stopGroqResize])

  // 검색 결과 클릭 시 → 해당 채널이 selectChannel로 바뀌고,
  // ChatArea에 선택된 포스트 ID를 전달하여 자동 오픈
  function handleSearchSelect(post) {
    setSearchSelectedPost(post)
    // 짧은 딜레이 후 초기화 (ChatArea가 받은 후)
    setTimeout(() => setSearchSelectedPost(null), 500)
  }

  useEffect(() => {
    if (deepLinkHandledRef.current) return
    if (!Array.isArray(teams) || teams.length === 0) return

    const params = new URLSearchParams(window.location.search)
    const channelId = params.get('channelId')
    const postId = params.get('postId')

    deepLinkHandledRef.current = true
    if (!channelId || !postId) return

    setShowCalendar(false)
    setShowDM(false)
    setActiveDMConv(null)

    navigateToPost(channelId, postId)
      .finally(() => {
        const url = new URL(window.location.href)
        url.searchParams.delete('channelId')
        url.searchParams.delete('postId')
        const next = `${url.pathname}${url.search}${url.hash}`
        window.history.replaceState({}, '', next)
      })
  }, [teams, navigateToPost])

  return (
    <div className="flex flex-col h-screen bg-gray-50 overflow-hidden">
      <TitleBar
        onOpenProfile={() => setShowProfile(true)}
        onOpenSiteAdmin={() => setShowSiteAdmin(true)}
        onSelectSearchResult={handleSearchSelect}
        showAgenticPanel={showAgenticPanel}
        onToggleAgenticPanel={() => setShowAgenticPanel(v => !v)}
      />
      <div ref={mainRef} className="flex flex-1 min-h-0">
        <Sidebar
          showCalendar={showCalendar}
          onToggleCalendar={() => { setShowCalendar(v => !v); setShowDM(false) }}
          onCloseCalendar={() => setShowCalendar(false)}
          showDM={showDM}
          onToggleDM={() => setShowDM(v => !v)}
          onOpenDM={(conv) => { setActiveDMConv(conv); setShowDM(true); setShowCalendar(false) }}
          onNewDM={() => setShowNewDM(true)}
          activeDMConvId={activeDMConv?.id}
        />

        {showCalendar ? (
          <CalendarView onClose={() => setShowCalendar(false)} />
        ) : showDM && activeDMConv ? (
          <DirectMessageView
            conversation={activeDMConv}
            onClose={() => { setShowDM(false); setActiveDMConv(null) }}
            onConversationUpdated={(updated) => setActiveDMConv(updated)}
          />
        ) : isSearchMode ? (
          <SearchResultsArea onSelectResult={handleSearchSelect} />
        ) : (
          <ChatArea autoOpenPostId={searchSelectedPost?.id} />
        )}

        {/* Resize handle & GroqPanel: 캘린더/DM 모드에서는 CSS로 숨김 (언마운트 X → state 유지) */}
        <div style={{ display: (showCalendar || showDM || !showAgenticPanel) ? 'none' : 'contents' }}>
          <div
            onMouseDown={startGroqResize}
            className="group relative w-1 flex-shrink-0 cursor-col-resize z-10"
          >
            <div className={`absolute inset-y-0 -left-1 -right-1 transition-colors group-hover:bg-indigo-500/30 ${resizingGroq ? 'bg-indigo-500/50' : ''}`} />
          </div>
          <GroqPanel width={groqWidth} />
        </div>
      </div>

      {showProfile && (
        <UserProfileModal
          onClose={() => setShowProfile(false)}
          onSaved={() => setShowProfileSavedDialog(true)}
        />
      )}
      {showSiteAdmin && <SiteAdminPage onClose={() => setShowSiteAdmin(false)} />}
      {showNewDM && (
        <NewConversationModal
          onCreated={(conv) => { setShowNewDM(false); setActiveDMConv(conv); setShowDM(true); setShowCalendar(false) }}
          onCancel={() => setShowNewDM(false)}
        />
      )}
      {showProfileSavedDialog && (
        <ConfirmDialog
          title="확인"
          message="사용자 정보가 저장되었습니다."
          confirmText="확인"
          hideCancel
          onConfirm={() => setShowProfileSavedDialog(false)}
          onCancel={() => setShowProfileSavedDialog(false)}
        />
      )}
    </div>
  )
}

function AppContent() {
  const { currentUser, loading } = useAuth()

  if (loading) {
    return (
      <div className="h-screen bg-gray-100 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold animate-pulse">
            ED
          </div>
          <div className="w-5 h-5 border-2 border-indigo-200 border-t-indigo-500 rounded-full animate-spin" />
        </div>
      </div>
    )
  }

  if (!currentUser) return <LoginScreen />

  // 로그인 성공 후에만 ChatProvider를 마운트
  // → useEffect의 refreshTeams()가 인증 토큰이 있는 상태에서 실행됨
  return (
    <ChatProvider>
      <MainLayout />
    </ChatProvider>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  )
}
