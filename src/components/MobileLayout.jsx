import { useState, useEffect, useRef, useCallback } from 'react'
import { useChat } from '../contexts/ChatContext'
import { apiFetch } from '../lib/api'
import Sidebar from './Sidebar'
import ChatArea from './ChatArea'
import CalendarView from './CalendarView'
import DirectMessageView, { NewConversationModal } from './DirectMessageView'
import GroqPanel from './GroqPanel'

// ─── Bottom tab bar icons ─────────────────────────────────────
function HashIcon({ className = 'w-5 h-5' }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18M10 3v18M14 3v18" />
    </svg>
  )
}
function ChatBubbleIcon({ className = 'w-5 h-5' }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
    </svg>
  )
}
function CalendarIcon({ className = 'w-5 h-5' }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  )
}
function SparkleIcon({ className = 'w-5 h-5' }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.4 6.4L22 12l-6.6 2.6L13 21l-2.4-6.4L4 12l6.6-2.6L13 3z" />
    </svg>
  )
}

function TabButton({ active, label, badge, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex-1 flex flex-col items-center justify-center gap-0.5 py-1.5 transition-colors ${
        active ? 'text-indigo-600' : 'text-gray-400 hover:text-gray-600'
      }`}
    >
      <span className="relative">
        {children}
        {badge > 0 && (
          <span className="absolute -top-1.5 -right-2 bg-red-500 text-white text-[10px] leading-none rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center font-bold">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </span>
      <span className="text-[10px] font-medium">{label}</span>
    </button>
  )
}

// ─── DM conversation list (mobile DM tab) ─────────────────────
function MobileDmList({ activeConvId, onOpen, onNew }) {
  const [conversations, setConversations] = useState([])

  const refresh = useCallback(() => {
    apiFetch('/dm/conversations')
      .then(data => setConversations(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 5000)
    return () => clearInterval(interval)
  }, [refresh])

  return (
    <div className="flex flex-col h-full bg-gray-50">
      <div className="flex items-center justify-between px-4 h-12 border-b border-gray-200 flex-shrink-0 bg-white">
        <h2 className="text-gray-900 font-bold text-sm">Direct Message</h2>
        <button
          type="button"
          onClick={onNew}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-500"
        >
          <span className="text-base leading-none">+</span>새 대화
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 text-sm gap-2 px-6 text-center">
            <ChatBubbleIcon className="w-8 h-8 text-gray-300" />
            대화가 없습니다. 오른쪽 위 “새 대화”로 시작하세요.
          </div>
        ) : (
          conversations.map(conv => (
            <button
              key={conv.id}
              onClick={() => onOpen(conv)}
              className={`flex items-center gap-3 w-full px-4 py-3 text-left border-b border-gray-100 transition-colors ${
                activeConvId === conv.id ? 'bg-indigo-50' : 'hover:bg-gray-100'
              }`}
            >
              <div className="w-9 h-9 rounded-full bg-indigo-500 text-white flex items-center justify-center text-sm font-bold flex-shrink-0">
                {(conv.name || '?')[0]}
              </div>
              <span className="flex-1 truncate text-sm text-gray-900 font-medium">{conv.name}</span>
              {(Number(conv.unread_count) || 0) > 0 && (
                <span className="bg-red-500 text-white text-[10px] rounded-full px-1.5 py-0.5 font-bold min-w-[18px] text-center">
                  {Number(conv.unread_count)}
                </span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  )
}

// ─── AI bottom sheet (draggable to dismiss) ───────────────────
function AiBottomSheet({ onClose }) {
  const [dragY, setDragY] = useState(0)
  const [dragging, setDragging] = useState(false)
  const startYRef = useRef(null)

  const onTouchStart = (e) => { startYRef.current = e.touches[0].clientY; setDragging(true) }
  const onTouchMove = (e) => {
    if (startYRef.current == null) return
    const dy = e.touches[0].clientY - startYRef.current
    if (dy > 0) setDragY(dy)
  }
  const onTouchEnd = () => {
    if (dragY > 90) onClose()
    setDragY(0)
    setDragging(false)
    startYRef.current = null
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label="AI 패널">
      <button type="button" aria-label="닫기" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className="relative bg-gray-50 rounded-t-2xl shadow-2xl flex flex-col h-[80vh] max-h-[80vh] overflow-hidden"
        style={{ transform: `translateY(${dragY}px)`, transition: dragging ? 'none' : 'transform 0.2s ease' }}
      >
        <div
          className="flex-shrink-0 flex items-center justify-center pt-2 pb-1 cursor-grab active:cursor-grabbing touch-none"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          <div className="w-10 h-1.5 rounded-full bg-gray-300" />
        </div>
        <div className="flex items-center justify-between px-4 pb-1.5 border-b border-gray-200 flex-shrink-0">
          <span className="text-gray-900 font-bold text-sm">AI</span>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded-lg text-gray-400 hover:text-gray-900 hover:bg-gray-200 flex items-center justify-center"
            aria-label="닫기"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <GroqPanel width="100%" />
        </div>
      </div>
    </div>
  )
}

export default function MobileLayout() {
  const { teams, selectedTeam, selectedChannel, pendingOpenPostId } = useChat()

  // 'channels' | 'dm' | 'calendar'
  const [tab, setTab] = useState('channels')
  // channels 탭 내부 드릴다운: 'list'(채널 목록) | 'channel'(글 목록/상세)
  const [channelView, setChannelView] = useState('list')
  const [activeDMConv, setActiveDMConv] = useState(null)
  const [showNewDM, setShowNewDM] = useState(false)
  const [showAi, setShowAi] = useState(false)
  const [dmUnread, setDmUnread] = useState(0)

  // 검색/AgenticAI로 보내기 → AI 시트 자동 오픈 (기존 데스크톱 이벤트 재사용)
  useEffect(() => {
    function handleOpenAi() { setShowAi(true) }
    window.addEventListener('open-agentic-panel', handleOpenAi)
    return () => window.removeEventListener('open-agentic-panel', handleOpenAi)
  }, [])

  // 딥링크(게시글 바로 열기) → 채널 탭 + 채널 진입으로 전환
  // (외부에서 들어온 pendingOpenPostId 변화에 맞춰 탭/뷰를 동기화하는 의도된 패턴)
  useEffect(() => {
    if (pendingOpenPostId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTab('channels')
      setChannelView('channel')
    }
  }, [pendingOpenPostId])

  // DM 안 읽음 합계 (탭 배지)
  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      apiFetch('/dm/conversations')
        .then(data => {
          if (cancelled || !Array.isArray(data)) return
          setDmUnread(data.reduce((s, c) => s + (Number(c.unread_count) || 0), 0))
        })
        .catch(() => {})
    }
    refresh()
    const interval = setInterval(refresh, 10000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [activeDMConv])

  const channelUnread = (teams || []).reduce(
    (sum, t) => sum + (t.channels || []).reduce((s, c) => s + (Number(c.unread) || 0), 0),
    0,
  )

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0 w-full overflow-hidden">
      {/* 콘텐츠 영역 (flex-col: ChatArea의 flex-1 / Sidebar·Calendar의 h-full 모두 채워지도록) */}
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col">
        {tab === 'calendar' && (
          <CalendarView onClose={() => setTab('channels')} />
        )}

        {tab === 'dm' && (
          activeDMConv ? (
            <DirectMessageView
              conversation={activeDMConv}
              onClose={() => setActiveDMConv(null)}
              onConversationUpdated={(updated) => setActiveDMConv(updated)}
            />
          ) : (
            <MobileDmList
              activeConvId={activeDMConv?.id}
              onOpen={(conv) => setActiveDMConv(conv)}
              onNew={() => setShowNewDM(true)}
            />
          )
        )}

        {tab === 'channels' && (
          channelView === 'channel' && selectedChannel ? (
            <ChatArea
              isMobile
              onExitChannel={() => setChannelView('list')}
            />
          ) : (
            <Sidebar
              isMobile
              showCalendar={false}
              onToggleCalendar={() => setTab('calendar')}
              onCloseCalendar={() => {}}
              showDM={false}
              onToggleDM={() => setTab('dm')}
              onOpenDM={(conv) => { setActiveDMConv(conv); setTab('dm') }}
              onNewDM={() => { setShowNewDM(true); setTab('dm') }}
              activeDMConvId={activeDMConv?.id}
              onCloseMobile={() => setChannelView('channel')}
            />
          )
        )}
      </div>

      {/* 하단 탭바 */}
      <nav className="flex-shrink-0 flex items-stretch border-t border-gray-200 bg-white">
        <TabButton
          active={tab === 'channels'}
          label="채널"
          badge={channelUnread}
          onClick={() => { setTab('channels') }}
        >
          <HashIcon />
        </TabButton>
        <TabButton
          active={tab === 'dm'}
          label="DM"
          badge={dmUnread}
          onClick={() => { setTab('dm') }}
        >
          <ChatBubbleIcon />
        </TabButton>
        <TabButton
          active={tab === 'calendar'}
          label="캘린더"
          onClick={() => { setTab('calendar') }}
        >
          <CalendarIcon />
        </TabButton>
        <TabButton
          active={showAi}
          label="AI"
          onClick={() => setShowAi(v => !v)}
        >
          <SparkleIcon />
        </TabButton>
      </nav>

      {showAi && <AiBottomSheet onClose={() => setShowAi(false)} />}

      {showNewDM && (
        <NewConversationModal
          teamId={selectedTeam?.id}
          onCreated={(conv) => { setShowNewDM(false); setActiveDMConv(conv); setTab('dm') }}
          onCancel={() => setShowNewDM(false)}
        />
      )}
    </div>
  )
}
