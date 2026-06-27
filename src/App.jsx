import { useState, useRef, useCallback, useEffect } from 'react'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ChatProvider, useChat } from './contexts/ChatContext'
import { ToastProvider } from './contexts/ToastContext'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import ChatArea from './components/ChatArea'
import GroqPanel from './components/GroqPanel'
import MobileLayout from './components/MobileLayout'
import LoginScreen from './components/LoginScreen'
import UserProfileModal from './components/UserProfileModal'
import SiteAdminPage from './components/SiteAdminPage'
import SearchResultsArea from './components/SearchResultsArea'
import CalendarView from './components/CalendarView'
import DirectMessageView, { NewConversationModal } from './components/DirectMessageView'
import ConfirmDialog from './components/ConfirmDialog'
import SelectionGuardPlaywrightFixture from './components/dev/SelectionGuardPlaywrightFixture'
import MailPage from './features/mail/MailPage'

function FullscreenServicePage({ service, onClose }) {
  const iframeRef = useRef(null)
  const lastEscapeAtRef = useRef(0)

  const handleEscape = useCallback((e) => {
    if (e.key !== 'Escape') return
    const now = Date.now()
    if (now - lastEscapeAtRef.current <= 700) {
      e.preventDefault()
      lastEscapeAtRef.current = 0
      onClose?.()
      return
    }
    lastEscapeAtRef.current = now
  }, [onClose])

  useEffect(() => {
    window.addEventListener('keydown', handleEscape, true)
    return () => window.removeEventListener('keydown', handleEscape, true)
  }, [handleEscape])

  const attachIframeEscapeHandler = useCallback(() => {
    const win = iframeRef.current?.contentWindow
    if (!win) return
    win.removeEventListener('keydown', handleEscape, true)
    win.addEventListener('keydown', handleEscape, true)
  }, [handleEscape])

  useEffect(() => {
    const win = iframeRef.current?.contentWindow
    return () => {
      win?.removeEventListener('keydown', handleEscape, true)
    }
  }, [handleEscape, service])

  if (!service) return null

  return (
    <div className="fixed inset-0 z-[10000] bg-slate-950">
      <button
        type="button"
        aria-label="닫기"
        onClick={onClose}
        className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-md bg-white/90 text-slate-700 shadow-lg hover:bg-white"
      >
        <span aria-hidden="true" className="text-xl leading-none">×</span>
      </button>
      <iframe
        ref={iframeRef}
        title={service.label}
        srcDoc={service.content}
        onLoad={attachIframeEscapeHandler}
        className="h-full w-full border-0"
      />
    </div>
  )
}

function MainLayout() {
  const SIDEBAR_STORAGE_KEY = 'ui.sidebar.visible'
  const accessDeniedMessage = '당신은 권한이 없습니다. 필요하시면 채널관리자/팀 관리자/채널관리자 에게 연락하여 주시기바랍니다.'
  const [showProfile, setShowProfile] = useState(false)
  const [showProfileSavedDialog, setShowProfileSavedDialog] = useState(false)
  const [showSiteAdmin, setShowSiteAdmin] = useState(false)
  const [siteAdminInitialTab, setSiteAdminInitialTab] = useState('users')
  const [searchSelectedPost, setSearchSelectedPost] = useState(null)
  const [showCalendar, setShowCalendar] = useState(false)
  const [showMail, setShowMail] = useState(false)
  const [showDM, setShowDM] = useState(false)
  const [activeDMConv, setActiveDMConv] = useState(null)
  const [showNewDM, setShowNewDM] = useState(false)
  const [showAccessDeniedDialog, setShowAccessDeniedDialog] = useState(false)
  const [fullscreenService, setFullscreenService] = useState(null)
  const { currentUser } = useAuth()
  const { isSearchMode, teams, selectedTeam, navigateToPost, recoverFromAccessDenied } = useChat()
  const deepLinkHandledRef = useRef(false)
  const lastUserIdRef = useRef(null)

  const [groqWidth, setGroqWidth] = useState(320)
  const [resizingGroq, setResizingGroq] = useState(false)
  const [showAgenticPanel, setShowAgenticPanel] = useState(false)
  const [isMobileLayout, setIsMobileLayout] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia('(max-width: 768px)').matches
  })
  const [showSidebar, setShowSidebar] = useState(() => {
    if (typeof window === 'undefined') return true
    const saved = window.localStorage.getItem(SIDEBAR_STORAGE_KEY)
    if (saved === 'true') return true
    if (saved === 'false') return false
    return !window.matchMedia('(max-width: 768px)').matches
  })
  const mainRef = useRef(null)

  const clearPostDeepLinkParams = useCallback(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    url.searchParams.delete('channelId')
    url.searchParams.delete('postId')
    url.searchParams.delete('commentId')
    url.searchParams.delete('attachmentId')
    const next = `${url.pathname}${url.search}${url.hash}`
    window.history.replaceState({}, '', next)
  }, [])

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
    } else {
      window.removeEventListener('mousemove', onGroqMouseMove)
      window.removeEventListener('mouseup', stopGroqResize)
      document.body.style.cursor = ''
    }
    return () => {
      window.removeEventListener('mousemove', onGroqMouseMove)
      window.removeEventListener('mouseup', stopGroqResize)
      document.body.style.cursor = ''
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
    const userId = currentUser?.id || null
    if (!userId || lastUserIdRef.current === userId) {
      lastUserIdRef.current = userId
      return
    }
    lastUserIdRef.current = userId
    setSearchSelectedPost(null)
    setShowCalendar(false)
    setShowMail(false)
    setShowDM(false)
    setActiveDMConv(null)
    setShowNewDM(false)
    setShowAccessDeniedDialog(false)
    setFullscreenService(null)
    deepLinkHandledRef.current = false
  }, [currentUser?.id])

  useEffect(() => {
    if (!Array.isArray(teams) || teams.length === 0) return

    const params = new URLSearchParams(window.location.search)
    const channelId = params.get('channelId')
    const postId = params.get('postId')
    const commentId = params.get('commentId')
    const attachmentId = params.get('attachmentId')

    if (!channelId || !postId) return
    const signature = `${channelId}|${postId}|${commentId || ''}|${attachmentId || ''}`
    if (deepLinkHandledRef.current === signature) return

    setShowCalendar(false)
    setShowMail(false)
    setShowDM(false)
    setActiveDMConv(null)

    navigateToPost(channelId, postId, { commentId, attachmentId })
      .then((opened) => {
        if (!opened) {
          deepLinkHandledRef.current = signature
          clearPostDeepLinkParams()
          setShowAccessDeniedDialog(true)
          return
        }
        deepLinkHandledRef.current = signature
        clearPostDeepLinkParams()
      })
  }, [teams, navigateToPost, clearPostDeepLinkParams])

  useEffect(() => {
    function handleOpenAgenticPanel() {
      setShowAgenticPanel(true)
    }
    window.addEventListener('open-agentic-panel', handleOpenAgenticPanel)
    return () => window.removeEventListener('open-agentic-panel', handleOpenAgenticPanel)
  }, [])

  useEffect(() => {
    async function handleChannelAccessDenied() {
      clearPostDeepLinkParams()
      const recovered = await recoverFromAccessDenied?.()
      if (!recovered) {
        setShowAccessDeniedDialog(true)
      }
    }
    window.addEventListener('channel-access-denied', handleChannelAccessDenied)
    return () => window.removeEventListener('channel-access-denied', handleChannelAccessDenied)
  }, [recoverFromAccessDenied, clearPostDeepLinkParams])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(showSidebar))
  }, [showSidebar])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const mq = window.matchMedia('(max-width: 768px)')
    const handleChange = (e) => setIsMobileLayout(e.matches)
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handleChange)
      return () => mq.removeEventListener('change', handleChange)
    }
    mq.addListener(handleChange)
    return () => mq.removeListener(handleChange)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return undefined
    const root = document.documentElement
    const updateViewportOffset = () => {
      const topOffset = Math.max(0, Math.round(window.visualViewport.offsetTop || 0))
      root.style.setProperty('--app-viewport-top', `${topOffset}px`)
    }
    updateViewportOffset()
    window.visualViewport.addEventListener('resize', updateViewportOffset)
    window.visualViewport.addEventListener('scroll', updateViewportOffset)
    window.addEventListener('orientationchange', updateViewportOffset)
    return () => {
      window.visualViewport.removeEventListener('resize', updateViewportOffset)
      window.visualViewport.removeEventListener('scroll', updateViewportOffset)
      window.removeEventListener('orientationchange', updateViewportOffset)
      root.style.removeProperty('--app-viewport-top')
    }
  }, [])

  return (
    <div className="app-shell flex flex-col bg-gray-50 overflow-hidden">
      <TitleBar
        onOpenProfile={() => setShowProfile(true)}
        onOpenSiteAdmin={() => { setSiteAdminInitialTab('users'); setShowSiteAdmin(true) }}
        onSelectSearchResult={handleSearchSelect}
        showSidebar={showSidebar}
        onToggleSidebar={() => setShowSidebar(v => !v)}
        showAgenticPanel={showAgenticPanel}
        onToggleAgenticPanel={() => setShowAgenticPanel(v => !v)}
        isMobileLayout={isMobileLayout}
      />
      <div ref={mainRef} className="flex flex-1 min-h-0">
        {isMobileLayout ? (
          <MobileLayout onOpenServicePage={setFullscreenService} />
        ) : (
          <>
            {showMail ? (
              <>
                <MailPage onBackToMain={() => setShowMail(false)} />
                {showAgenticPanel && (
                  <>
                    <div
                      onMouseDown={startGroqResize}
                      className="group relative w-1 flex-shrink-0 cursor-col-resize z-10"
                    >
                      <div className={`absolute inset-y-0 -left-1 -right-1 transition-colors group-hover:bg-indigo-500/30 ${resizingGroq ? 'bg-indigo-500/50' : ''}`} />
                    </div>
                    <GroqPanel width={groqWidth} />
                  </>
                )}
              </>
            ) : (
              <>
                {showSidebar && (
                  <Sidebar
                    showCalendar={showCalendar}
                    onToggleCalendar={() => { setShowCalendar(v => !v); setShowDM(false); setShowMail(false) }}
                    onCloseCalendar={() => setShowCalendar(false)}
                    showDM={showDM}
                    onToggleDM={() => setShowDM(v => !v)}
                    onOpenDM={(conv) => { setActiveDMConv(conv); setShowDM(true); setShowCalendar(false); setShowMail(false) }}
                    onNewDM={() => setShowNewDM(true)}
                    onOpenServicePage={setFullscreenService}
                    onOpenMail={() => {
                      setShowMail(true)
                      setShowCalendar(false)
                      setShowDM(false)
                      setActiveDMConv(null)
                    }}
                    activeDMConvId={activeDMConv?.id}
                    isMobile={false}
                  />
                )}

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
              </>
            )}
          </>
        )}
      </div>

      {showProfile && (
        <UserProfileModal
          onClose={() => setShowProfile(false)}
          onSaved={() => setShowProfileSavedDialog(true)}
        />
      )}
      {showSiteAdmin && (
        <SiteAdminPage
          initialTab={siteAdminInitialTab}
          onClose={() => setShowSiteAdmin(false)}
        />
      )}
      {showNewDM && (
        <NewConversationModal
          teamId={selectedTeam?.id}
          onCreated={(conv) => { setShowNewDM(false); setActiveDMConv(conv); setShowDM(true); setShowCalendar(false); setShowMail(false) }}
          onCancel={() => setShowNewDM(false)}
        />
      )}
      {fullscreenService && (
        <FullscreenServicePage
          service={fullscreenService}
          onClose={() => setFullscreenService(null)}
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
      {showAccessDeniedDialog && (
        <ConfirmDialog
          title="권한 없음"
          message={accessDeniedMessage}
          confirmText="확인"
          onConfirm={() => setShowAccessDeniedDialog(false)}
          onCancel={() => setShowAccessDeniedDialog(false)}
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
    <ToastProvider>
      <ChatProvider>
        <MainLayout />
      </ChatProvider>
    </ToastProvider>
  )
}

export default function App() {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search)
    if (params.get('e2e') === 'selection-guard') {
      return <SelectionGuardPlaywrightFixture />
    }
  }

  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  )
}
