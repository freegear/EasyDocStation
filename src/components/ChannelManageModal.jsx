import { useState, useEffect } from 'react'
import { useChat } from '../contexts/ChatContext'
import { apiFetch } from '../lib/api'

export default function ChannelManageModal({ mode = 'manage', channel = null, onClose, onSave = () => {} }) {
  const { selectedTeam, selectedChannel } = useChat()
  const targetChannel = channel || selectedChannel
  
  const [name, setName] = useState(targetChannel?.name || '')
  const [type, setType] = useState(targetChannel?.type || 'public')
  const [admins, setAdmins] = useState([])
  const [members, setMembers] = useState([])
  const [stats, setStats] = useState({ message_count: 0, file_count: 0, total_size: 0 })
  
  const [loading, setLoading] = useState(mode === 'manage')
  const [saving, setSaving] = useState(false)
  
  const [userSearch, setUserSearch] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchTarget, setSearchTarget] = useState('member') // 'admin' or 'member'
  
  const [deleteConfirmName, setDeleteConfirmName] = useState('')
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  useEffect(() => {
    if (mode === 'manage' && targetChannel) {
      loadChannelData()
    }
  }, [mode, targetChannel?.id])

  async function loadChannelData() {
    setLoading(true)
    try {
      const [adminList, memberList, channelStats] = await Promise.all([
        apiFetch(`/channels/${targetChannel.id}/admins`),
        apiFetch(`/channels/${targetChannel.id}/members`),
        apiFetch(`/channels/${targetChannel.id}/stats`)
      ])
      setAdmins(adminList)
      setMembers(memberList)
      setStats(channelStats)
    } catch (err) {
      console.error('Failed to load channel data:', err)
    } finally {
      setLoading(false)
    }
  }

  // User search logic
  useEffect(() => {
    const timer = setTimeout(() => {
      if (userSearch.trim().length >= 1) {
        searchUsers(userSearch)
      } else {
        setSearchResults([])
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [userSearch])

  async function searchUsers(query) {
    try {
      const results = await apiFetch(`/users/search?q=${encodeURIComponent(query)}`)
      const existingIds = searchTarget === 'admin' ? admins.map(a => a.id) : members.map(m => m.id)
      setSearchResults(results.filter(u => !existingIds.includes(u.id)))
    } catch (err) {
      console.error(err)
    }
  }

  const handleAddUser = (user) => {
    if (searchTarget === 'admin') {
      setAdmins([...admins, user])
    } else {
      setMembers([...members, user])
    }
    setUserSearch('')
    setSearchResults([])
  }

  const handleRemoveUser = (id, target) => {
    if (target === 'admin') {
      setAdmins(admins.filter(a => a.id !== id))
    } else {
      setMembers(members.filter(m => m.id !== id))
    }
  }

  const handleSave = async () => {
    if (!name.trim()) return alert('채널 이름을 입력해주세요.')
    setSaving(true)
    try {
      const id = mode === 'add' ? `ch-${Date.now()}` : targetChannel.id
      const payload = {
        name,
        type,
        team_id: selectedTeam.id,
        adminIds: admins.map(a => a.id),
        memberIds: members.map(m => m.id)
      }

      const result = await apiFetch(`/channels/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      })

      // Sync admins and members if needed (In a real app, the PUT would handle this or separate calls)
      // For now we'll assume the backend handles it via the payload or we could add calls here.
      
      onSave(result)
      onClose()
    } catch (err) {
      alert(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (deleteConfirmName !== targetChannel.name) {
      alert('채널 이름이 일치하지 않습니다.')
      return
    }
    setSaving(true)
    try {
      await apiFetch(`/channels/${targetChannel.id}`, { method: 'DELETE' })
      onSave(null, targetChannel.id)
      onClose()
    } catch (err) {
      alert(err.message)
    } finally {
      setSaving(false)
    }
  }

  function formatStatsSize(bytes) {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-xl bg-[#1e1c30] rounded-3xl border border-white/10 shadow-2xl flex flex-col max-h-[90vh] overflow-hidden">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-white/10 bg-white/5 flex items-center justify-between">
          <h2 className="text-white font-bold text-sm">{mode === 'add' ? '채널 추가 창' : '채널 관리'}</h2>
          <button onClick={onClose} className="text-white/30 hover:text-white">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-6">
          {/* Channel Name */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-white/50 text-xs font-medium mb-1.5">채널 이름</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="채널명 입력"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-white text-sm focus:ring-1 focus:ring-indigo-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-white/50 text-xs font-medium mb-1.5">채널 종류</label>
              <div className="flex gap-2">
                {['public', 'private'].map(t => (
                  <button
                    key={t}
                    onClick={() => setType(t)}
                    className={`flex-1 py-2 rounded-xl text-xs font-medium border transition-all ${
                      type === t ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-white/5 border-white/10 text-white/40 hover:text-white/60'
                    }`}
                  >
                    {t === 'public' ? '공개 채널' : '비공개 채널'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6">
            {/* Admins */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-white/50 text-xs font-medium">채널 관리자</label>
                <button onClick={() => { setSearchTarget('admin'); setUserSearch('') }} className="text-indigo-400 text-[10px] hover:underline">+ 추가</button>
              </div>
              <div className="min-h-[60px] p-2 bg-white/5 rounded-xl border border-white/10 flex flex-wrap gap-1.5">
                {admins.map(a => (
                  <div key={a.id} className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-500 text-[10px]">
                    <span>{a.name}</span>
                    <button onClick={() => handleRemoveUser(a.id, 'admin')}>×</button>
                  </div>
                ))}
                {admins.length === 0 && <span className="text-white/10 text-[10px] py-1">미지정</span>}
              </div>
            </div>

            {/* Members */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-white/50 text-xs font-medium">채널 멤버</label>
                <button onClick={() => { setSearchTarget('member'); setUserSearch('') }} className="text-indigo-400 text-[10px] hover:underline">+ 추가</button>
              </div>
              <div className="min-h-[60px] p-2 bg-white/5 rounded-xl border border-white/10 flex flex-wrap gap-1.5">
                {members.map(m => (
                  <div key={m.id} className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-[10px]">
                    <span>{m.name}</span>
                    <button onClick={() => handleRemoveUser(m.id, 'member')}>×</button>
                  </div>
                ))}
                {members.length === 0 && <span className="text-white/10 text-[10px] py-1">미지정</span>}
              </div>
            </div>
          </div>

          {/* User Search Input (Fixed location or absolute) */}
          {(setSearchTarget && userSearch !== null) && (
            <div className="relative">
              <input
                type="text"
                value={userSearch}
                onChange={e => setUserSearch(e.target.value)}
                placeholder={`${searchTarget === 'admin' ? '관리자' : '멤버'} 아이디 검색 및 추가...`}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-white text-[11px] focus:ring-1 focus:ring-indigo-500 outline-none"
              />
              {userSearch.trim() && searchResults.length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-1 bg-[#25233d] border border-white/10 rounded-xl shadow-2xl z-20 max-h-40 overflow-y-auto">
                  {searchResults.map(u => (
                    <button key={u.id} onClick={() => handleAddUser(u)} className="w-full px-4 py-2 text-left text-xs text-white hover:bg-white/10 border-b border-white/5 last:border-0">
                      {u.name} ({u.username})
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Stats Section (Only for Manage mode) */}
          {mode === 'manage' && (
            <div className="pt-4 border-t border-white/10 grid grid-cols-3 gap-4">
              <div className="bg-white/5 rounded-2xl p-3 border border-white/10 flex flex-col items-center">
                <span className="text-white/30 text-[10px] uppercase mb-1">메시지 수</span>
                <span className="text-white font-bold text-lg">{stats.message_count}</span>
              </div>
              <div className="bg-white/5 rounded-2xl p-3 border border-white/10 flex flex-col items-center">
                <span className="text-white/30 text-[10px] uppercase mb-1">파일 수</span>
                <span className="text-white font-bold text-lg">{stats.file_count}</span>
              </div>
              <div className="bg-white/5 rounded-2xl p-3 border border-white/10 flex flex-col items-center">
                <span className="text-white/30 text-[10px] uppercase mb-1">데이터 크기</span>
                <span className="text-white font-bold text-lg">{formatStatsSize(parseInt(stats.total_size))}</span>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-white/5 border-t border-white/10 flex items-center justify-end gap-3">
          {mode === 'manage' && (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="mr-auto px-4 py-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-500 text-xs font-bold transition-all"
            >
              삭제
            </button>
          )}
          <button onClick={onClose} className="px-4 py-2 text-white/40 text-xs font-bold hover:text-white">취소</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-6 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-lg shadow-indigo-500/30 transition-all active:scale-95"
          >
            {saving ? '처리 중...' : '저장'}
          </button>
        </div>

        {/* Delete Confirmation Overlay */}
        {showDeleteConfirm && (
          <div className="absolute inset-0 z-30 bg-[#1e1c30] flex flex-col items-center justify-center p-8 space-y-4">
            <h3 className="text-white font-bold text-center">정말 이 채널을 삭제하시겠습니까?<br/><span className="text-red-400 font-normal text-xs">삭제 되면 복구할 수 없습니다.</span></h3>
            <p className="text-white/40 text-[11px] text-center">확인을 위해 채널 이름 <strong className="text-white">[{targetChannel.name}]</strong>을(를) 아래에 입력해주세요.</p>
            <input
              type="text"
              value={deleteConfirmName}
              onChange={e => setDeleteConfirmName(e.target.value)}
              placeholder="채널 이름을 입력하세요"
              className="w-full max-w-sm bg-white/5 border border-red-500/30 rounded-xl px-4 py-2 text-white text-sm focus:ring-1 focus:ring-red-500 outline-none"
            />
            <div className="flex gap-3 pt-2">
              <button onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmName('') }} className="px-6 py-2 text-white/40 text-xs font-bold">취소</button>
              <button
                onClick={handleDelete}
                disabled={deleteConfirmName !== targetChannel.name || saving}
                className="px-8 py-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-30 text-white text-xs font-bold shadow-lg shadow-red-500/20 transition-all"
              >
                삭제 확인
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
