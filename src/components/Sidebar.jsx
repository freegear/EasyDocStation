import { useState } from 'react'
import { useChat } from '../contexts/ChatContext'
import TeamManageModal from './TeamManageModal'
import ChannelManageModal from './ChannelManageModal'

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
  const [dmCollapsed, setDmCollapsed] = useState(false)
  const [channelsCollapsed, setChannelsCollapsed] = useState(false)
  const [showTeamModal, setShowTeamModal] = useState(false)
  const [editingTeam, setEditingTeam] = useState(null)
  const [showChannelModal, setShowChannelModal] = useState(false)
  const [channelModalMode, setChannelModalMode] = useState('add')
  const [editingChannel, setEditingChannel] = useState(null)

  const totalUnread = selectedTeam.channels.reduce((sum, ch) => sum + ch.unread, 0)

  return (
    <aside className="w-64 flex-shrink-0 bg-[#19172d] flex flex-col h-full border-r border-white/5">
      {/* Team selector */}
      <div className="px-3 py-3 border-b border-white/10">
        <p className="text-white/40 text-xs uppercase tracking-widest mb-2 px-2">Teams</p>
        <div className="flex flex-col gap-1">
          {teams.map(team => {
            const teamUnread = team.channels.reduce((s, c) => s + c.unread, 0)
            const isActive = team.id === selectedTeam.id
            return (
              <button
                key={team.id}
                onClick={() => selectTeam(team)}
                onDoubleClick={() => { setEditingTeam(team); setShowTeamModal(true) }}
                className={`flex items-center gap-2.5 w-full px-2 py-2 rounded-lg text-sm text-left transition-all ${
                  isActive
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
          
          {/* Add Team Button at the bottom of the list */}
          <button
            onClick={() => { setEditingTeam(null); setShowTeamModal(true) }}
            className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-white/30 hover:text-white/60 hover:bg-white/5 text-sm transition-all mt-1"
          >
            <span className="text-lg leading-none">+</span>
            <span>팀 추가</span>
          </button>
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
            <span>Channels</span>
            <span className="text-base">{channelsCollapsed ? '▸' : '▾'}</span>
          </button>

          {!channelsCollapsed && (
            <div className="flex flex-col gap-0.5 px-2">
              {[...selectedTeam.channels].sort((a, b) => a.name.localeCompare(b.name)).map(ch => {
                const isActive = ch.id === selectedChannel?.id
                return (
                  <button
                    key={ch.id}
                    onClick={() => selectChannel(ch)}
                    onDoubleClick={() => {
                      setEditingChannel(ch)
                      setChannelModalMode('manage')
                      setShowChannelModal(true)
                    }}
                    className={`flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-sm text-left transition-all ${
                      isActive
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

              {/* Add channel */}
              <button
                onClick={() => {
                  setEditingChannel(null)
                  setChannelModalMode('add')
                  setShowChannelModal(true)
                }}
                className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-white/30 hover:text-white/60 text-sm transition-colors hover:bg-white/5"
              >
                <span className="text-lg leading-none">+</span>
                <span>채널 추가</span>
              </button>
            </div>
          )}
        </div>

        {/* Direct Messages */}
        <div>
          <button
            className="flex items-center justify-between w-full px-3 py-1.5 text-white/40 hover:text-white/70 text-xs uppercase tracking-widest transition-colors"
            onClick={() => setDmCollapsed(v => !v)}
          >
            <span>Direct Messages</span>
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
                    <div className="w-6 h-6 rounded-md bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white text-xs font-bold">
                      {dm.avatar}
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
