import { useState, useEffect } from 'react'
import { useChat } from '../contexts/ChatContext'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from '../lib/api'
import TeamManageModal from './TeamManageModal'
import ChannelManageModal from './ChannelManageModal'
import { useT } from '../i18n/useT'

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

export default function Sidebar() {
  const { teams, setTeams, selectedTeam, selectedChannel, selectTeam, selectChannel, refreshTeams } = useChat()
  const { currentUser } = useAuth()
  const t = useT()
  const [dmCollapsed, setDmCollapsed] = useState(false)
  const [channelsCollapsed, setChannelsCollapsed] = useState(false)
  const [showTeamModal, setShowTeamModal] = useState(false)
  const [editingTeam, setEditingTeam] = useState(null)
  const [showChannelModal, setShowChannelModal] = useState(false)
  const [channelModalMode, setChannelModalMode] = useState('add')
  const [editingChannel, setEditingChannel] = useState(null)
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    apiFetch('/config/version')
      .then(data => setAppVersion(data.version || ''))
      .catch(() => {})
  }, [])

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

  return (
    <aside className="w-64 flex-shrink-0 bg-[#19172d] flex flex-col h-full border-r border-white/5">
      {/* Team selector */}
      <div className="px-3 py-3 border-b border-white/10">
        <p className="text-white/40 text-xs uppercase tracking-widest mb-2 px-2">{t.sidebar.teams}</p>
        <div className="flex flex-col gap-1">
          {teams.map(team => {
            const teamUnread = team.channels.reduce((s, c) => s + c.unread, 0)
            const isActive = team.id === selectedTeam.id
            return (
              <button
                key={team.id}
                onClick={() => selectTeam(team)}
                onDoubleClick={() => {
                  if (!canManageTeam()) return
                  setEditingTeam(team)
                  setShowTeamModal(true)
                }}
                className={`flex items-center gap-2.5 w-full px-2 py-2 rounded-lg text-sm text-left transition-all ${isActive
                    ? 'bg-indigo-600 text-white shadow-lg'
                    : 'text-white/60 hover:bg-white/8 hover:text-white'
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
              className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-white/30 hover:text-white/60 hover:bg-white/5 text-sm transition-all mt-1"
            >
              <span className="text-lg leading-none">+</span>
              <span>{t.sidebar.addTeam}</span>
            </button>
          )}
        </div>
      </div>

      {/* Scrollable channels/DMs */}
      <div className="flex-1 overflow-y-auto py-2">
        {/* Channels section */}
        <div className="mb-2">
          <button
            className="flex items-center justify-between w-full px-3 py-1.5 text-white/40 hover:text-white/70 text-xs uppercase tracking-widest transition-colors"
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
                    onClick={() => selectChannel(ch)}
                    onDoubleClick={() => {
                      if (!canManageChannel(ch)) return  // 권한 없으면 아무 동작 없음
                      setEditingChannel(ch)
                      setChannelModalMode('manage')
                      setShowChannelModal(true)
                    }}
                    title={canManageChannel(ch) ? t.sidebar.channelManageTitle : undefined}
                    className={`flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-sm text-left transition-all ${isActive
                        ? 'bg-indigo-500/30 text-white'
                        : ch.unread > 0
                          ? 'text-white hover:bg-white/8'
                          : 'text-white/50 hover:bg-white/5 hover:text-white/80'
                      }`}
                  >
                    <span className={`flex-shrink-0 ${isActive ? 'text-indigo-300' : 'text-white/40'}`}>
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
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-white/30 hover:text-white/60 text-sm transition-colors hover:bg-white/5"
                >
                  <span className="text-lg leading-none">+</span>
                  <span>{t.sidebar.addChannel}</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Direct Messages */}
        <div>
          <button
            className="flex items-center justify-between w-full px-3 py-1.5 text-white/40 hover:text-white/70 text-xs uppercase tracking-widest transition-colors"
            onClick={() => setDmCollapsed(v => !v)}
          >
            <span>{t.sidebar.directMessages}</span>
            <span className="text-base">{dmCollapsed ? '▸' : '▾'}</span>
          </button>

          {!dmCollapsed && (
            <div className="flex flex-col gap-0.5 px-2">
              {selectedTeam.directMessages.map(dm => (
                <button
                  key={dm.id}
                  className="flex items-center gap-2.5 w-full px-2 py-1.5 rounded-md text-white/50 hover:bg-white/5 hover:text-white/80 text-sm text-left transition-all"
                >
                  <div className="relative flex-shrink-0">
                    <div className="w-6 h-6 rounded-md bg-indigo-500 overflow-hidden flex items-center justify-center text-white text-[10px] font-bold">
                      {dm.image_url ? (
                        <img src={dm.image_url} alt={dm.name} className="w-full h-full object-cover" />
                      ) : (
                        dm.avatar
                      )}
                    </div>
                    <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[#19172d] ${dm.online ? 'bg-green-400' : 'bg-white/20'}`} />
                  </div>
                  <span className="truncate">{dm.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Version */}
      <div className="px-4 py-2.5 border-t border-white/5 mt-auto">
        <p className="text-white/20 text-[10px] text-center tracking-widest">
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
