import { useState, useEffect } from 'react'
import { useChat } from '../contexts/ChatContext'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from '../lib/api'
import TeamManageModal from './TeamManageModal'
import ChannelManageModal from './ChannelManageModal'
import { useT } from '../i18n/useT'
import { FORM_TEMPLATES } from '../templates/formTemplates'

function ChatBubbleIcon() {
  return (
    <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
    </svg>
  )
}

function HashIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18M10 3v18M14 3v18" />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
  )
}

export default function Sidebar({
  showCalendar,
  onToggleCalendar,
  onCloseCalendar,
  showDM,
  onToggleDM,
  onOpenDM,
  onNewDM,
  activeDMConvId,
  isMobile = false,
  onCloseMobile,
  panelId,
}) {
  const { teams, setTeams, selectedTeam, selectedChannel, selectTeam, selectChannel, refreshTeams, addPost } = useChat()
  const { currentUser } = useAuth()
  const t = useT()
  const [teamsCollapsed, setTeamsCollapsed] = useState(false)
  const [formsCollapsed, setFormsCollapsed] = useState(false)
  const [channelsCollapsed, setChannelsCollapsed] = useState(false)
  const [showTeamModal, setShowTeamModal] = useState(false)
  const [editingTeam, setEditingTeam] = useState(null)
  const [showChannelModal, setShowChannelModal] = useState(false)
  const [channelModalMode, setChannelModalMode] = useState('add')
  const [editingChannel, setEditingChannel] = useState(null)
  const [appVersion, setAppVersion] = useState('')
  const [dmConversations, setDmConversations] = useState([])
  const [dmCollapsedList, setDmCollapsedList] = useState(false)

  function refreshDmConversations() {
    apiFetch('/dm/conversations')
      .then(data => setDmConversations(Array.isArray(data) ? data : []))
      .catch(() => {})
  }

  useEffect(() => {
    apiFetch('/config/version')
      .then(data => setAppVersion(data.version || ''))
      .catch(() => {})
  }, [])

  useEffect(() => {
    refreshDmConversations()
  }, [showDM, activeDMConvId])

  useEffect(() => {
    const interval = setInterval(refreshDmConversations, 5000)
    return () => clearInterval(interval)
  }, [])

  const totalDmUnread = dmConversations.reduce((sum, conv) => sum + (Number(conv.unread_count) || 0), 0)

  // 채널 관리 권한 체크
  // - site_admin: 모든 채널 관리 가능
  // - team_admin: 해당 팀의 모든 채널 관리 가능 (team admin_ids에 포함 여부 확인)
  // - channel_admin: 해당 채널의 admin_ids에 포함된 경우만 가능
  // - user: 불가
  function canManageChannel(ch) {
    if (!currentUser) return false
    const role = currentUser.role
    if (role === 'site_admin') return true
    if (role === 'team_admin') {
      // 현재 팀의 관리자인지 확인
      const teamAdminIds = selectedTeam?.admin_ids || []
      return teamAdminIds.includes(currentUser.id)
    }
    if (role === 'channel_admin' || role === 'user') {
      // 해당 채널의 관리자 목록에 포함되어 있는지 확인
      const channelAdminIds = ch.admin_ids || []
      return channelAdminIds.includes(currentUser.id)
    }
    return false
  }

  // 팀 관리 권한 체크
  function canManageTeam() {
    if (!currentUser) return false
    const role = currentUser.role
    if (role === 'site_admin') return true
    if (role === 'team_admin') {
      const teamAdminIds = selectedTeam?.admin_ids || []
      return teamAdminIds.includes(currentUser.id)
    }
    return false
  }

  // 팀 추가 버튼: site_admin만
  function canAddTeam() {
    return currentUser?.role === 'site_admin'
  }

  // 채널 추가 버튼: site_admin 또는 현재 팀의 team_admin
  function canAddChannel() {
    if (!currentUser) return false
    if (currentUser.role === 'site_admin') return true
    if (currentUser.role === 'team_admin') {
      const teamAdminIds = selectedTeam?.admin_ids || []
      return teamAdminIds.includes(currentUser.id)
    }
    return false
  }

  const totalUnread = (selectedTeam?.channels || []).reduce((sum, ch) => sum + (ch.unread || 0), 0)
  const closeMobileIfNeeded = () => {
    if (isMobile) onCloseMobile?.()
  }

  return (
    <aside
      id={panelId}
      className={`${isMobile ? 'w-full' : 'w-64'} flex-shrink-0 bg-gray-200 flex flex-col h-full border-r border-gray-100`}
    >
      {/* Scrollable: 팀 목록 + 채널/DM/서식 전체 포함 (9.6) */}
      <div className="flex-1 overflow-y-auto py-2">
        {/* Team selector */}
        <div className="px-3 pb-2 mb-1 border-b border-gray-300">
          <button
            className="flex items-center justify-between w-full px-2 py-1 text-gray-400 hover:text-gray-600 text-xs uppercase tracking-widest transition-colors mb-1"
            onClick={() => setTeamsCollapsed(v => !v)}
          >
            <span>{t.sidebar.teams}</span>
            <span className="text-base">{teamsCollapsed ? '▸' : '▾'}</span>
          </button>
          {!teamsCollapsed && <div className="flex flex-col gap-1">
            {teams.map(team => {
              const teamUnread = team.channels.reduce((s, c) => s + c.unread, 0)
              const isActive = team.id === selectedTeam.id
              return (
                <button
                  key={team.id}
                  onClick={() => { selectTeam(team); onCloseCalendar?.(); closeMobileIfNeeded() }}
                  onDoubleClick={() => {
                    if (!canManageTeam()) return
                    setEditingTeam(team)
                    setShowTeamModal(true)
                  }}
                  className={`flex items-center gap-2.5 w-full px-2 py-2 rounded-lg text-sm text-left transition-all ${isActive
                      ? 'bg-indigo-600 text-white shadow-lg'
                      : 'text-gray-500 hover:bg-gray-200 hover:text-gray-900'
                    }`}
                >
                  <span className="text-base">{team.icon}</span>
                  <span className="flex-1 font-medium truncate">{team.name}</span>
                  {teamUnread > 0 && !isActive && (
                    <span className="bg-red-500 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center font-bold">
                      {teamUnread}
                    </span>
                  )}
                </button>
              )
            })}

            {/* Add Team Button: site_admin만 표시 */}
            {canAddTeam() && (
              <button
                onClick={() => { setEditingTeam(null); setShowTeamModal(true) }}
                className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-gray-400 hover:text-gray-500 hover:bg-gray-100 text-sm transition-all mt-1"
              >
                <span className="text-lg leading-none">+</span>
                <span>{t.sidebar.addTeam}</span>
              </button>
            )}
          </div>}
        </div>
        {/* Channels section */}
        <div className="mb-2">
          <button
            className="flex items-center justify-between w-full px-3 py-1.5 text-gray-400 hover:text-gray-600 text-xs uppercase tracking-widest transition-colors"
            onClick={() => setChannelsCollapsed(v => !v)}
          >
            <span>{t.sidebar.channels}</span>
            <span className="text-base">{channelsCollapsed ? '▸' : '▾'}</span>
          </button>

          {!channelsCollapsed && (
            <div className="flex flex-col gap-0.5 px-2">
              {[...selectedTeam.channels]
                .filter(ch => !ch.is_archived) // 보관된 채널은 숨김 처리
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(ch => {
                const isActive = ch.id === selectedChannel?.id
                return (
                  <button
                    key={ch.id}
                    onClick={() => { selectChannel(ch); onCloseCalendar?.(); closeMobileIfNeeded() }}
                    onDoubleClick={() => {
                      if (!canManageChannel(ch)) return  // 권한 없으면 아무 동작 없음
                      setEditingChannel(ch)
                      setChannelModalMode('manage')
                      setShowChannelModal(true)
                    }}
                    title={canManageChannel(ch) ? t.sidebar.channelManageTitle : undefined}
                    className={`flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-sm text-left transition-all ${isActive
                        ? 'bg-indigo-500/30 text-gray-900'
                        : ch.unread > 0
                          ? 'text-gray-900 hover:bg-gray-200'
                          : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
                      }`}
                  >
                    <span className={`flex-shrink-0 ${isActive ? 'text-indigo-600' : 'text-gray-400'}`}>
                      {ch.type === 'private' ? <LockIcon /> : <HashIcon />}
                    </span>
                    <span className="flex-1 truncate font-medium">{ch.name}</span>
                    {ch.unread > 0 && (
                      <span className="bg-red-500 text-white text-xs rounded-full px-1.5 py-0.5 font-bold min-w-[18px] text-center">
                        {ch.unread}
                      </span>
                    )}
                  </button>
                )
              })}

              {/* Add channel: site_admin 또는 현재 팀의 team_admin만 표시 */}
              {canAddChannel() && (
                <button
                  onClick={() => {
                    setEditingChannel(null)
                    setChannelModalMode('add')
                    setShowChannelModal(true)
                  }}
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-gray-400 hover:text-gray-500 text-sm transition-colors hover:bg-gray-100"
                >
                  <span className="text-lg leading-none">+</span>
                  <span>{t.sidebar.addChannel}</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Form Templates */}
        <div className="mt-2">
          <button
            className="flex items-center justify-between w-full px-3 py-1.5 text-gray-400 hover:text-gray-600 text-xs uppercase tracking-widest transition-colors"
            onClick={() => setFormsCollapsed(v => !v)}
          >
            <span>{t.sidebar.formTemplates}</span>
            <span className="text-base">{formsCollapsed ? '▸' : '▾'}</span>
          </button>

          {!formsCollapsed && (
            <div className="flex flex-col gap-0.5 px-2">
              {FORM_TEMPLATES.map(form => {
                const needsDoubleClick = true
                const displayLabel = form.id === 'md-page' ? 'EasyPage' : form.label
                const registerForm = async () => {
                  if (!selectedChannel) return alert('채널을 먼저 선택해주세요.')
                  try {
                    await addPost(selectedChannel.id, { content: form.content, security_level: 1 })
                  } catch (_) {}
                }
                return (
                  <button
                    key={form.id}
                    onClick={needsDoubleClick ? undefined : registerForm}
                    onDoubleClick={needsDoubleClick ? registerForm : undefined}
                    title={needsDoubleClick ? '더블클릭하여 등록' : undefined}
                    className="flex items-center gap-2.5 w-full px-2 py-1.5 rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700 text-sm text-left transition-all"
                  >
                    <span className="text-base leading-none">{form.icon}</span>
                    <span className="truncate">{displayLabel}</span>
                    {needsDoubleClick && <span className="ml-auto text-[9px] text-gray-300 whitespace-nowrap">더블클릭</span>}
                  </button>
                )
              })}
              <button
                type="button"
                className="flex items-center gap-2.5 w-full px-2 py-1.5 rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700 text-sm text-left transition-all"
                title="AI회의록 (준비중)"
                aria-disabled="true"
              >
                <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6M7 4h7l5 5v11a2 2 0 01-2 2H7a2 2 0 01-2-2V6a2 2 0 012-2z" />
                </svg>
                <span className="font-medium">AI회의록</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Direct Message button */}
      <div className="px-3 pt-2 border-t border-gray-200">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setDmCollapsedList(v => !v)}
            onDoubleClick={() => {
              if (dmConversations.length > 0) {
                onOpenDM?.(dmConversations[0])
                closeMobileIfNeeded()
                return
              }
              onNewDM?.()
              closeMobileIfNeeded()
            }}
            className={`flex items-center gap-2.5 flex-1 px-2 py-2 rounded-lg text-sm text-left transition-all ${
              showDM
                ? 'bg-indigo-600 text-white shadow-lg'
                : 'text-gray-500 hover:bg-gray-200 hover:text-gray-900'
            }`}
            title="클릭: 대화 목록 접기/펼치기 · 더블클릭: Direct Message 페이지 열기"
          >
            <ChatBubbleIcon />
            <span className="font-medium flex-1">Direct Message</span>
            {totalDmUnread > 0 && (
              <span className="bg-red-500 text-white text-xs rounded-full px-1.5 py-0.5 font-bold min-w-[18px] text-center">
                {totalDmUnread}
              </span>
            )}
            <span className={`text-xs ${showDM ? 'text-white/80' : 'text-gray-400'}`}>{dmCollapsedList ? '▸' : '▾'}</span>
          </button>
          <button
            onClick={() => {
              onNewDM?.()
              closeMobileIfNeeded()
            }}
            className={`w-8 h-8 flex items-center justify-center rounded-lg text-lg leading-none transition-colors ${
              showDM
                ? 'text-white/85 bg-indigo-600 hover:bg-indigo-700'
                : 'text-gray-500 hover:bg-gray-200 hover:text-gray-700'
            }`}
            title="새 Direct Message 창 만들기"
            aria-label="새 Direct Message 창 만들기"
          >
            +
          </button>
        </div>

        {/* DM conversation list (collapsed/expanded) */}
        {!dmCollapsedList && dmConversations.length > 0 && (
          <div className="flex flex-col gap-0.5 mt-1 pb-1">
            {dmConversations.slice(0, 8).map(conv => (
              <button
                key={conv.id}
                onClick={() => {
                  onOpenDM?.(conv)
                  closeMobileIfNeeded()
                }}
                className={`flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs text-left transition-all ${
                  activeDMConvId === conv.id
                    ? 'bg-indigo-500/20 text-gray-900 font-medium'
                    : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 flex-shrink-0" />
                <span className="truncate flex-1">{conv.name}</span>
                {(Number(conv.unread_count) || 0) > 0 && (
                  <span className="bg-red-500 text-white text-[10px] rounded-full px-1.5 py-0.5 font-bold min-w-[16px] text-center">
                    {Number(conv.unread_count)}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Calendar button */}
      <div className="px-3 pb-1 pt-1">
        <button
          onClick={() => {
            onToggleCalendar?.()
            closeMobileIfNeeded()
          }}
          className={`flex items-center gap-2.5 w-full px-2 py-2 rounded-lg text-sm text-left transition-all ${
            showCalendar
              ? 'bg-indigo-600 text-white shadow-lg'
              : 'text-gray-500 hover:bg-gray-200 hover:text-gray-900'
          }`}
        >
          <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span className="font-medium">{t.sidebar.calendar || '캘린더'}</span>
        </button>
      </div>

      {/* Version */}
      <div className="px-4 py-2 border-t border-gray-100">
        <p className="text-blue-800 font-extrabold text-xs text-center tracking-widest">
          EasyStation {appVersion && `v${appVersion}`}
        </p>
      </div>

      {showTeamModal && (
        <TeamManageModal
          team={editingTeam}
          onClose={() => setShowTeamModal(false)}
          onSave={(data, deletedId) => {
            refreshTeams()
            if (deletedId && selectedTeam.id === deletedId) {
              // select first available if current deleted
            }
          }}
        />
      )}

      {showChannelModal && (
        <ChannelManageModal
          mode={channelModalMode}
          channel={editingChannel}
          onClose={() => setShowChannelModal(false)}
          onSave={() => {
            refreshTeams() // Sync entire UI with DB
          }}
        />
      )}
    </aside>
  )
}
