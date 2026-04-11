import { useState, useEffect } from 'react'
import { useChat } from '../contexts/ChatContext'
import { apiFetch } from '../lib/api'

export default function ChannelManageModal({ onClose }) {
  const { selectedChannel } = useChat()
  const [channelName, setChannelName] = useState(selectedChannel?.name || '')
  const [channelType, setChannelType] = useState(selectedChannel?.type || 'public')
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showAddMember, setShowAddMember] = useState(false)
  const [newMemberId, setNewMemberId] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [isSearching, setIsSearching] = useState(false)

  useEffect(() => {
    if (selectedChannel?.id) {
      loadChannelData()
    }
  }, [selectedChannel?.id])

  useEffect(() => {
    const timer = setTimeout(() => {
      if (newMemberId.trim().length >= 1) {
        searchUsers(newMemberId)
      } else {
        setSearchResults([])
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [newMemberId])

  async function searchUsers(query) {
    setIsSearching(true)
    try {
      const results = await apiFetch(`/users/search?q=${encodeURIComponent(query)}`)
      // Filter out users who are already members
      const existingMemberIds = members.map(m => m.id)
      setSearchResults(results.filter(u => !existingMemberIds.includes(u.id)))
    } catch (err) {
      console.error('Search failed:', err)
    } finally {
      setIsSearching(false)
    }
  }

  async function loadChannelData() {
    setLoading(true)
    try {
      // First try to get existing channel, if 404, we'll create it on first save
      try {
        const data = await apiFetch(`/channels/${selectedChannel.id}`)
        setChannelName(data.name)
        setChannelType(data.type)
      } catch (e) {
        console.log('Channel not in DB yet, using default from context')
      }

      const memberList = await apiFetch(`/channels/${selectedChannel.id}/members`)
      setMembers(memberList)
    } catch (err) {
      console.error('Failed to load channel data:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleAddMember = async (user) => {
    // If user is not provided, try to find by ID/name in results (if user pressed Enter)
    const targetUser = user || searchResults.find(u => u.username === newMemberId || u.name === newMemberId)
    
    if (!targetUser) {
      if (newMemberId.trim()) alert('목록에서 사용자를 선택해주세요.')
      return
    }

    try {
      // Ensure channel exists in the database first (Foreign Key constraint requirement)
      await apiFetch(`/channels/${selectedChannel.id}`, {
        method: 'PUT',
        body: JSON.stringify({ 
          name: channelName || selectedChannel.name, 
          type: channelType 
        })
      })

      await apiFetch(`/channels/${selectedChannel.id}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: targetUser.id })
      })
      await loadChannelData()
      setNewMemberId('')
      setSearchResults([])
      setShowAddMember(false)
    } catch (err) {
      alert(err.message)
    }
  }

  const handleRemoveMember = async (id) => {
    try {
      await apiFetch(`/channels/${selectedChannel.id}/members/${id}`, {
        method: 'DELETE'
      })
      setMembers(members.filter(m => m.id !== id))
    } catch (err) {
      alert(err.message)
    }
  }

  const handleArchive = async () => {
    if (!window.confirm('이 채널을 Archive 하시겠습니까?')) return
    try {
      await apiFetch(`/channels/${selectedChannel.id}/archive`, {
        method: 'PATCH'
      })
      alert('채널이 Archive 되었습니다.')
      onClose()
    } catch (err) {
      alert(err.message)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await apiFetch(`/channels/${selectedChannel.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: channelName, type: channelType })
      })
      alert('설정이 저장되었습니다.')
      onClose()
    } catch (err) {
      alert(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
        <div className="relative w-full max-w-lg bg-[#1e1c30] rounded-3xl border border-white/10 p-12 flex flex-col items-center">
          <div className="w-8 h-8 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin mb-4" />
          <p className="text-white/40 text-sm">정보를 불러오는 중...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-lg bg-[#1e1c30] rounded-3xl border border-white/10 shadow-2xl shadow-black/50 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h2 className="text-white font-bold text-base">채널 정보 관리</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg text-white/30 hover:text-white hover:bg-white/10 flex items-center justify-center transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-6">
          {/* Channel Name */}
          <div>
            <label className="block text-white/50 text-xs font-medium mb-1.5">채널 이름</label>
            <input
              type="text"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
              placeholder="채널 이름"
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 transition-all"
            />
          </div>

          {/* Channel Property */}
          <div>
            <label className="block text-white/50 text-xs font-medium mb-1.5">채널 속성 선택</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer group">
                <input
                  type="radio"
                  name="channelType"
                  value="public"
                  checked={channelType === 'public'}
                  onChange={() => setChannelType('public')}
                  className="hidden"
                />
                <div className={`w-4 h-4 rounded-full border flex items-center justify-center transition-colors ${channelType === 'public' ? 'border-indigo-500 bg-indigo-500' : 'border-white/20'}`}>
                  {channelType === 'public' && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                </div>
                <span className={`text-sm ${channelType === 'public' ? 'text-white' : 'text-white/40 group-hover:text-white/60'}`}>공개 채널</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer group">
                <input
                  type="radio"
                  name="channelType"
                  value="private"
                  checked={channelType === 'private'}
                  onChange={() => setChannelType('private')}
                  className="hidden"
                />
                <div className={`w-4 h-4 rounded-full border flex items-center justify-center transition-colors ${channelType === 'private' ? 'border-indigo-500 bg-indigo-500' : 'border-white/20'}`}>
                  {channelType === 'private' && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                </div>
                <span className={`text-sm ${channelType === 'private' ? 'text-white' : 'text-white/40 group-hover:text-white/60'}`}>비공개 채널</span>
              </label>
            </div>
          </div>

          {/* Archive Button */}
          <div className="pt-2">
            <button
              onClick={handleArchive}
              className="px-4 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm font-medium hover:bg-red-500/20 transition-all flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
              </svg>
              채널 Archive
            </button>
            <p className="text-white/20 text-[11px] mt-2">Archive 된 채널은 읽기 전용으로 보관됩니다.</p>
          </div>

          <div className="border-t border-white/10 pt-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-semibold text-sm">채널 멤버 테이블</h3>
              <button
                onClick={() => setShowAddMember(true)}
                className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-colors flex items-center gap-1.5"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                채널 멤버 추가
              </button>
            </div>

            {showAddMember && (
              <div className="mb-4 bg-white/5 rounded-xl p-4 border border-white/10 relative">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newMemberId}
                    onChange={(e) => setNewMemberId(e.target.value)}
                    placeholder="멤버 아이디 입력..."
                    className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
                    autoFocus
                    onKeyDown={(e) => e.key === 'Enter' && handleAddMember()}
                  />
                  <button
                    onClick={() => setShowAddMember(false)}
                    className="px-3 py-1.5 rounded-lg bg-white/5 text-white/50 text-xs font-semibold hover:bg-white/10"
                  >
                    취소
                  </button>
                </div>

                {/* Search Results Dropdown */}
                {newMemberId.trim() && (searchResults.length > 0 || isSearching) && (
                  <div className="absolute left-4 right-4 top-full mt-1 bg-[#2d2a4a] border border-white/10 rounded-xl shadow-2xl z-10 overflow-hidden">
                    {isSearching && searchResults.length === 0 ? (
                      <div className="px-4 py-3 text-white/40 text-xs italic">검색 중...</div>
                    ) : searchResults.length > 0 ? (
                      <div className="max-h-48 overflow-y-auto">
                        {searchResults.map(user => (
                          <button
                            key={user.id}
                            onClick={() => handleAddMember(user)}
                            className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-white/10 text-left transition-colors border-b border-white/5 last:border-0"
                          >
                            <div className="w-7 h-7 rounded-full bg-indigo-500/30 flex items-center justify-center text-[10px] font-bold text-indigo-400">
                              {user.avatar}
                            </div>
                            <div className="flex flex-col">
                              <span className="text-white text-xs font-medium">{user.username}</span>
                              <span className="text-white/40 text-[10px]">{user.name} ({user.email})</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="px-4 py-3 text-white/40 text-xs italic">일치하는 멤버가 없습니다.</div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="bg-white/5 rounded-2xl border border-white/10 overflow-hidden">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 bg-white/5 text-white/40">
                    <th className="px-4 py-2 font-medium">멤버</th>
                    <th className="px-4 py-2 font-medium">역할</th>
                    <th className="px-4 py-2 font-medium text-right">관리</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {members.map((member) => (
                    <tr key={member.id} className="text-white/80 group">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-indigo-500 flex items-center justify-center text-[10px] font-bold text-white">
                            {member.avatar || member.name[0]}
                          </div>
                          <div className="flex flex-col">
                            <span className="font-medium text-xs text-white">{member.name}</span>
                            <span className="text-[10px] text-white/20">{member.email}</span>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-md border ${member.role === 'Admin' || member.role === 'site_admin' ? 'border-amber-500/20 text-amber-500 bg-amber-500/5' : 'border-white/10 text-white/40'}`}>
                          {member.role === 'Admin' || member.role === 'site_admin' ? '관리자' : '멤버'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleRemoveMember(member.id)}
                          className="text-white/20 hover:text-red-400 transition-colors p-1"
                          title="멤버 내보내기"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7a4 4 0 11-8 0 4 4 0 018 0zM9 14a6 6 0 00-6 6v1h12v-1a6 6 0 00-6-6zM21 12h-6" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {members.length === 0 && (
                <div className="p-8 text-center text-white/20 text-xs italic">
                  멤버가 없습니다.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-white/10 bg-white/5">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-white/50 text-sm font-semibold hover:text-white transition-colors"
          >
            닫기
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-6 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold shadow-lg shadow-indigo-500/30 transition-all active:scale-95"
          >
            {saving ? '저장 중...' : '설정 저장'}
          </button>
        </div>
      </div>
    </div>
  )
}
