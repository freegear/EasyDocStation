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
import { WELCOME_BOARD_TEMPLATE } from './templates/formTemplates'
import { apiFetch } from './lib/api'
import { getRecentPosts, makeWelcomePostSnapshot } from './lib/recentPosts'

// 서버 실행 옵션 --showWelcomeBoard (VITE_SHOW_WELCOME_BOARD)로 노출되는 빌드타임 플래그.
const SHOW_WELCOME_BOARD = import.meta.env.VITE_SHOW_WELCOME_BOARD === '1'

const WELCOME_WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

// 캘린더 이벤트 dt 객체(오전/오후 12시간제)를 24시간제 분(minute) 총합으로 변환. (WelcomeBoard.md 14절)
function welcomeEventStartMinutes(dt) {
  if (!dt || !Number.isInteger(dt.hour)) return 0
  let h = Number(dt.hour) % 12
  if (dt.ampm === '오후') h += 12
  return h * 60 + (Number(dt.minute) || 0)
}

// dt 객체 → "HH:MM"(24시간제) 표기.
function welcomeEventHHMM(dt) {
  const total = welcomeEventStartMinutes(dt)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

// URL에 채널/포스트/메일 딥링크 파라미터가 있으면 Welcome 보드 자동 오픈보다 우선한다.
function hasDeepLinkParams() {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  return Boolean(
    params.get('channelId') ||
    params.get('postId') ||
    params.get('mailMessageId') ||
    params.get('mailTenantId')
  )
}

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

// 가운데 메인 패널에 서비스(Welcome 보드 등)를 인패널로 렌더 (WelcomeBoard.md 8절)
function PanelServicePage({ service, onClose, onNavigate, injectType, injectData }) {
  const iframeRef = useRef(null)
  const [iframeReady, setIframeReady] = useState(false)

  const handleEscape = useCallback((e) => {
    if (e.key === 'Escape') onClose?.()
  }, [onClose])

  useEffect(() => {
    window.addEventListener('keydown', handleEscape, true)
    return () => window.removeEventListener('keydown', handleEscape, true)
  }, [handleEscape])

  // iframe(srcDoc) 내부 버튼 → 부모 라우팅 (WelcomeBoard.md 9절)
  // srcDoc iframe은 event.origin이 "null"로 올 수 있어 source/type 으로 검증한다.
  useEffect(() => {
    const onMessage = (e) => {
      if (e.source !== iframeRef.current?.contentWindow) return
      if (e.data?.type !== 'welcome-board:navigate') return
      onNavigate?.(e.data.target, e.data)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [onNavigate])

  // 부모 → iframe 데이터 주입 (WelcomeBoard.md 12절). iframe 로드 완료 후, 데이터 변경 시 재전송.
  useEffect(() => {
    if (!iframeReady || !injectType || !injectData) return
    iframeRef.current?.contentWindow?.postMessage({ type: injectType, payload: injectData }, '*')
  }, [iframeReady, injectType, injectData])

  // 서비스가 바뀌면 로드 상태 초기화(새 iframe onLoad 대기)
  useEffect(() => {
    setIframeReady(false)
  }, [service?.id])

  if (!service) return null

  return (
    <div className="flex flex-1 min-h-0 flex-col bg-white">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#C9DAF7] bg-[#E8F0FF] flex-shrink-0">
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-[#2F5FE0] hover:text-[#1E52DB] transition-colors"
        >
          ← 채널로
        </button>
        {service.iconImg && (
          <img
            src={service.iconImg}
            alt=""
            className="w-7 h-7 flex-shrink-0 object-contain"
          />
        )}
        <span className="text-[21px] text-[#5B6B8C] truncate">{service.headerLabel || service.label}</span>
      </div>
      <iframe
        ref={iframeRef}
        title={service.label}
        srcDoc={service.content}
        onLoad={() => setIframeReady(true)}
        className="flex-1 w-full border-0"
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
  const [calendarFocusEvent, setCalendarFocusEvent] = useState(null)
  const [showMail, setShowMail] = useState(false)
  const [mailDeepLink, setMailDeepLink] = useState(null)
  const [mailInitialFolder, setMailInitialFolder] = useState(null)  // Welcome 보드 → 중요 편지함 등 진입 폴더
  const [showDM, setShowDM] = useState(false)
  const [activeDMConv, setActiveDMConv] = useState(null)
  const [showNewDM, setShowNewDM] = useState(false)
  const [showAccessDeniedDialog, setShowAccessDeniedDialog] = useState(false)
  const [fullscreenService, setFullscreenService] = useState(null)
  const [welcomeService, setWelcomeService] = useState(null)  // 가운데 패널 인패널 서비스 (WelcomeBoard.md 8절)
  const [welcomeBoardData, setWelcomeBoardData] = useState(null)  // Welcome 보드 카드 주입 데이터 (WelcomeBoard.md 12절)
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

  const openMailDeepLink = useCallback(({ messageId, tenantId, targetLanguage = '' } = {}) => {
    const nextMessageId = String(messageId || '').trim()
    const nextTenantId = String(tenantId || '').trim()
    if (!nextMessageId || !nextTenantId) return false

    setMailDeepLink({
      messageId: nextMessageId,
      tenantId: nextTenantId,
      targetLanguage: String(targetLanguage || ''),
      openedAt: Date.now(),
    })
    setShowMail(true)
    setShowCalendar(false)
    setShowDM(false)
    setActiveDMConv(null)
    return true
  }, [])

  const openMailDeepLinkFromUrl = useCallback((href, { replaceUrl = true } = {}) => {
    if (typeof window === 'undefined') return false
    let url
    try {
      url = new URL(href || window.location.href, window.location.origin)
    } catch {
      return false
    }
    const messageId = url.searchParams.get('mailMessageId')
    const tenantId = url.searchParams.get('mailTenantId')
    if (!messageId || !tenantId) return false

    const opened = openMailDeepLink({
      messageId,
      tenantId,
      targetLanguage: url.searchParams.get('mailTargetLanguage') || '',
    })

    if (opened && replaceUrl && url.origin === window.location.origin) {
      url.searchParams.delete('mailMessageId')
      url.searchParams.delete('mailTenantId')
      url.searchParams.delete('mailTargetLanguage')
      const next = `${url.pathname}${url.search}${url.hash}`
      window.history.replaceState({}, '', next)
    }
    return opened
  }, [openMailDeepLink])

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
    setCalendarFocusEvent(null)
    setShowMail(false)
    setMailDeepLink(null)
    setMailInitialFolder(null)
    setShowDM(false)
    setActiveDMConv(null)
    setShowNewDM(false)
    setShowAccessDeniedDialog(false)
    setFullscreenService(null)
    deepLinkHandledRef.current = false
    // --showWelcomeBoard 실행 시: 로그인/새로고침/메인 재진입 때 Welcome 보드를 기본 화면으로 띄운다.
    // 단, URL 딥링크(채널/포스트/메일)로 진입한 경우엔 해당 대상이 우선하므로 자동 오픈하지 않는다. (WelcomeBoard.md 11절)
    if (SHOW_WELCOME_BOARD && !hasDeepLinkParams()) {
      setWelcomeService(WELCOME_BOARD_TEMPLATE)
    } else {
      setWelcomeService(null)
    }
  }, [currentUser?.id])

  // Welcome 보드 오픈 시 카드 데이터(오늘의 일정 + 안 읽은 중요 메일)를 로드해 주입 (WelcomeBoard.md 12·13·14절)
  useEffect(() => {
    if (welcomeService?.id !== 'welcome-board') {
      setWelcomeBoardData(null)
      return
    }
    let cancelled = false

    // 오늘의 일정: 캘린더 이벤트 중 "오늘" 시작하는 것만 시간순 정렬. (WelcomeBoard.md 14절)
    const loadTodaySchedule = async () => {
      try {
        const events = await apiFetch('/events')
        const now = new Date()
        const y = now.getFullYear(), mo = now.getMonth() + 1, d = now.getDate()
        const startMin = ev => (ev.allDay ? -1 : welcomeEventStartMinutes(ev.startDt))
        return (Array.isArray(events) ? events : [])
          .filter(ev => ev?.startDt?.year === y && ev.startDt.month === mo && ev.startDt.day === d)
          .sort((a, b) => startMin(a) - startMin(b))  // 종일 먼저, 그다음 시작 시각 오름차순
          .map(ev => ({
            time: ev.allDay ? '종일' : welcomeEventHHMM(ev.startDt),
            title: ev.title || '',
            // 색상은 스타일 주입 대상이라 hex만 허용(그 외는 기본색). CSS 주입 방지.
            color: /^#[0-9a-f]{3,8}$/i.test(ev.color || '') ? ev.color : '#7C5CFF',
            allDay: !!ev.allDay,
          }))
      } catch {
        return []
      }
    }

    // 중요 메일: 안 읽은 중요(별표) 메일만. (WelcomeBoard.md 12·13절)
    const loadImportantMail = async () => {
      try {
        const accounts = await apiFetch('/mail/accounts')
        const tenantId = (Array.isArray(accounts) ? accounts : []).find(a => a?.tenant_id)?.tenant_id
        if (!tenantId) return []
        const params = new URLSearchParams({
          tenantId,
          scope: 'unified',
          unifiedKey: 'starred',
          folderType: '',
          folderName: '',
          limit: '30',
          offset: '0',
        })
        const rows = await apiFetch(`/mail/messages?${params.toString()}`)
        return (Array.isArray(rows) ? rows : [])
          .filter(m => !m.is_read)
          .map(m => ({
            id: m.id,               // 클릭 시 해당 메일로 딥링크 이동 (WelcomeBoard.md 16절)
            tenantId,
            name: m.from_name || m.from_email || '',
            subject: m.subject || '',
            snippet: m.snippet || '',
            received_at: m.received_at || null,
          }))
      } catch {
        return []
      }
    }

    // 최근에 업데이트 된 글: 가입/접근 가능한 채널의 미열람 원글을 채널 경계 없이 최신순으로 모은다. (WelcomeBoard.md 15.6)
    const loadRecentUpdates = async () => {
      const channels = (Array.isArray(teams) ? teams : [])
        .flatMap(team => (Array.isArray(team.channels) ? team.channels : [])
          .filter(channel => channel?.id && !channel.is_archived)
          .map(channel => ({ team, channel })))
      if (!channels.length) return []
      const batches = await Promise.all(channels.map(async ({ team, channel }) => {
        try {
          const data = await apiFetch(`/posts?channelId=${encodeURIComponent(channel.id)}&limit=100`)
          const posts = Array.isArray(data) ? data : (Array.isArray(data?.posts) ? data.posts : [])
          return posts
            // 미열람 활동이 있는 글: 새 원글 · 새 댓글 · 수정된 원글 · 수정된 댓글 모두 포함 (WelcomeBoard.md 15.7)
            .filter(post => post?.isUnread)
            .map(post => {
              // 정렬/상대시각은 "가장 최근 미열람 활동 시각" 우선 → 방금 댓글·수정된 글이 위로 온다.
              const activityAt = post.unreadActivityAt || post.createdAt || post.updatedAt || Date.now()
              return {
                ...makeWelcomePostSnapshot({
                  post,
                  channel,
                  team,
                  viewedAt: new Date(activityAt).getTime() || Date.now(),
                }),
                summary: '',
                unreadPost: !!post.unreadPost,
                unreadCommentCount: Number(post.unreadCommentCount) || 0,
              }
            })
        } catch {
          return []
        }
      }))
      return batches
        .flat()
        .sort((a, b) => (Number(b.viewedAt) || 0) - (Number(a.viewedAt) || 0))
        .slice(0, 30)
    }

    const loadRecentPosts = async () => {
      try {
        const rows = await apiFetch('/recent-post-views?limit=20')
        return Array.isArray(rows) ? rows : []
      } catch {
        return getRecentPosts(currentUser?.id)
      }
    }

    ;(async () => {
      const now = new Date()
      const todayLabel = `${now.getMonth() + 1}월 ${now.getDate()}일 ${WELCOME_WEEKDAYS[now.getDay()]}요일`
      // 최근에 본 문서: 서버 DB 스냅샷을 최신순으로 읽고, 실패 시 브라우저 캐시로 폴백. (WelcomeBoard.md 15절)
      const [todaySchedule, importantMail, recentUpdates, recentPosts] = await Promise.all([
        loadTodaySchedule(),
        loadImportantMail(),
        loadRecentUpdates(),
        loadRecentPosts(),
      ])
      if (cancelled) return
      setWelcomeBoardData({ importantMail, todaySchedule, todayLabel, recentPosts, recentUpdates })
    })()
    return () => { cancelled = true }
  }, [welcomeService?.id, currentUser?.id, teams])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const timer = window.setTimeout(() => openMailDeepLinkFromUrl(window.location.href), 0)
    return () => window.clearTimeout(timer)
  }, [openMailDeepLinkFromUrl])

  useEffect(() => {
    function handleMailOpenLink(event) {
      const detail = event.detail || {}
      if (detail.messageId && detail.tenantId) {
        openMailDeepLink(detail)
        return
      }
      openMailDeepLinkFromUrl(detail.href || window.location.href)
    }
    window.addEventListener('easy-mail-open-link', handleMailOpenLink)
    return () => window.removeEventListener('easy-mail-open-link', handleMailOpenLink)
  }, [openMailDeepLink, openMailDeepLinkFromUrl])

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
                <MailPage
                  onBackToMain={() => setShowMail(false)}
                  initialMailLink={mailDeepLink}
                  initialFolder={mailInitialFolder}
                  onOpenCalendarEvent={(eventId) => {
                    setCalendarFocusEvent({ eventId, openedAt: Date.now() })
                    setShowCalendar(true)
                    setShowMail(false)
                    setShowDM(false)
                    setActiveDMConv(null)
                  }}
                />
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
                    onToggleCalendar={() => { setShowCalendar(v => !v); setShowDM(false); setShowMail(false); setWelcomeService(null) }}
                    onCloseCalendar={() => setShowCalendar(false)}
                    showDM={showDM}
                    onToggleDM={() => setShowDM(v => !v)}
                    onOpenDM={(conv) => { setActiveDMConv(conv); setShowDM(true); setShowCalendar(false); setShowMail(false); setWelcomeService(null) }}
                    onNewDM={() => setShowNewDM(true)}
                    onOpenServicePage={setFullscreenService}
                    onOpenServiceInPanel={(tpl) => {
                      setWelcomeService(tpl)
                      setShowCalendar(false)
                      setShowDM(false)
                      setShowMail(false)
                      setActiveDMConv(null)
                    }}
                    onCloseWelcome={() => setWelcomeService(null)}
                    onOpenMail={() => {
                      setShowMail(true)
                      setMailDeepLink(null)
                      setMailInitialFolder(null)
                      setShowCalendar(false)
                      setShowDM(false)
                      setActiveDMConv(null)
                      setWelcomeService(null)
                    }}
                    activeDMConvId={activeDMConv?.id}
                    isMobile={false}
                  />
                )}

                {showCalendar ? (
                  <CalendarView onClose={() => setShowCalendar(false)} focusEvent={calendarFocusEvent} />
                ) : showDM && activeDMConv ? (
                  <DirectMessageView
                    conversation={activeDMConv}
                    onClose={() => { setShowDM(false); setActiveDMConv(null) }}
                    onConversationUpdated={(updated) => setActiveDMConv(updated)}
                  />
                ) : welcomeService ? (
                  <PanelServicePage
                    service={welcomeService}
                    injectType="welcome-board:data"
                    injectData={welcomeBoardData}
                    onClose={() => setWelcomeService(null)}
                    onNavigate={(target, data) => {
                      if (target === 'calendar') {
                        setShowCalendar(true)
                        setWelcomeService(null)
                        setShowDM(false)
                        setShowMail(false)
                        setActiveDMConv(null)
                      } else if (target === 'mail-important') {
                        setShowMail(true)
                        setMailDeepLink(null)
                        setMailInitialFolder({ key: 'unified:starred', openedAt: Date.now() })
                        setWelcomeService(null)
                        setShowCalendar(false)
                        setShowDM(false)
                        setActiveDMConv(null)
                      } else if (target === 'mail' && data?.messageId && data?.tenantId) {
                        // 중요 메일 항목 클릭 → 해당 메일로 딥링크 이동. (WelcomeBoard.md 16절)
                        setWelcomeService(null)
                        setMailInitialFolder(null)
                        openMailDeepLink({ messageId: String(data.messageId), tenantId: String(data.tenantId) })
                      } else if (target === 'post' && data?.channelId && data?.postId) {
                        // 최근에 본 문서 클릭 → 해당 게시글로 이동. (WelcomeBoard.md 15절)
                        setWelcomeService(null)
                        setShowCalendar(false)
                        setShowMail(false)
                        setShowDM(false)
                        setActiveDMConv(null)
                        navigateToPost(String(data.channelId), String(data.postId))
                      }
                    }}
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
