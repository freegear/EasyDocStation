import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'

export default function TeamManageModal({ team = null, onClose, onSave }) {
  const [name, setName] = useState(team?.name || '')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchTarget, setSearchTarget] = useState('admin') // 'admin' or 'member'
  const [selectedAdmins, setSelectedAdmins] = useState([])
  const [selectedMembers, setSelectedMembers] = useState([])
  const [searchResults, setSearchResults] = useState([])
  const [isSearching, setIsSearching] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (team) {
      loadTeamData()
    }
  }, [team])

  async function loadTeamData() {
    try {
      const [admins, members] = await Promise.all([
        apiFetch(`/teams/${team.id}/admins`),
        apiFetch(`/teams/${team.id}/members`)
      ])
      setSelectedAdmins(admins)
      setSelectedMembers(members)
    } catch (err) {
      console.error('Failed to load team data:', err)
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchQuery.trim().length >= 1) {
        searchUsers(searchQuery)
      } else {
        setSearchResults([])
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  async function searchUsers(query) {
    setIsSearching(true)
    try {
      const results = await apiFetch(`/users/search?q=${encodeURIComponent(query)}`)
      const existingIds = searchTarget === 'admin' 
        ? selectedAdmins.map(a => a.id) 
        : selectedMembers.map(m => m.id)
      setSearchResults(results.filter(u => !existingIds.includes(u.id)))
    } catch (err) {
      console.error(err)
    } finally {
      setIsSearching(false)
    }
  }

  const handleAddUser = (user) => {
    if (searchTarget === 'admin') {
      setSelectedAdmins([...selectedAdmins, user])
      // Admins should also be members
      if (!selectedMembers.find(m => m.id === user.id)) {
        setSelectedMembers([...selectedMembers, user])
      }
    } else {
      setSelectedMembers([...selectedMembers, user])
    }
    setSearchQuery('')
    setSearchResults([])
  }

  const handleRemoveUser = (id, target) => {
    if (target === 'admin') {
      if (selectedAdmins.length <= 1) return alert('팀 관리자는 최소 1명 이상이어야 합니다.')
      setSelectedAdmins(selectedAdmins.filter(a => a.id !== id))
    } else {
      setSelectedMembers(selectedMembers.filter(m => m.id !== id))
    }
  }

  const handleSubmit = async () => {
    if (!name.trim()) return alert('팀 이름을 입력해주세요.')
    if (selectedAdmins.length === 0) return alert('최소 1명의 관리자를 지정해야 합니다.')

    setLoading(true)
    try {
      const payload = {
        name,
        adminIds: selectedAdmins.map(a => a.id),
        memberIds: selectedMembers.map(m => m.id)
      }

      let result
      if (team) {
        result = await apiFetch(`/teams/${team.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        })
      } else {
        result = await apiFetch('/teams', {
          method: 'POST',
          body: JSON.stringify(payload)
        })
      }
      
      onSave(result)
      onClose()
    } catch (err) {
      alert(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!window.confirm('정말 이 팀을 삭제하시겠습니까?')) return
    setLoading(true)
    try {
      await apiFetch(`/teams/${team.id}`, { method: 'DELETE' })
      onSave(null, team.id)
      onClose()
    } catch (err) {
      alert(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-[#1e1c30] rounded-3xl border border-white/10 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="px-6 py-4 border-b border-white/10 bg-white/5 flex items-center justify-between">
          <h2 className="text-white font-bold text-sm">{team ? 'Team 정보 창' : 'Team 추가'}</h2>
          <button onClick={onClose} className="text-white/30 hover:text-white">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto">
          <div>
            <label className="block text-white/50 text-xs font-medium mb-1.5">Team 이름</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="팀 명칭 입력"
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-white text-sm focus:ring-1 focus:ring-indigo-500 outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Admins */}
            <div>
              <div className="flex justify-between items-center mb-1.5">
                <label className="text-white/50 text-xs font-medium">관리자</label>
                <button onClick={() => { setSearchTarget('admin'); setSearchQuery('') }} className="text-indigo-400 text-[10px]">+ 추가</button>
              </div>
              <div className="min-h-[50px] p-2 bg-white/5 rounded-xl border border-white/10 flex flex-wrap gap-1">
                {selectedAdmins.map(a => (
                  <div key={a.id} className="px-2 py-0.5 rounded-lg bg-indigo-500/20 text-indigo-300 text-[10px] flex items-center gap-1">
                    <span>{a.name}</span>
                    <button onClick={() => handleRemoveUser(a.id, 'admin')}>×</button>
                  </div>
                ))}
              </div>
            </div>
            {/* Members */}
            <div>
              <div className="flex justify-between items-center mb-1.5">
                <label className="text-white/50 text-xs font-medium">멤버</label>
                <button onClick={() => { setSearchTarget('member'); setSearchQuery('') }} className="text-indigo-400 text-[10px]">+ 추가</button>
              </div>
              <div className="min-h-[50px] p-2 bg-white/5 rounded-xl border border-white/10 flex flex-wrap gap-1">
                {selectedMembers.map(m => (
                  <div key={m.id} className="px-2 py-0.5 rounded-lg bg-white/5 text-white/60 text-[10px] flex items-center gap-1">
                    <span>{m.name}</span>
                    <button onClick={() => handleRemoveUser(m.id, 'member')}>×</button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={`${searchTarget === 'admin' ? '관리자' : '멤버'} 검색 및 추가...`}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-white text-xs outline-none focus:ring-1 focus:ring-indigo-500"
            />
            {searchQuery.trim() && (searchResults.length > 0 || isSearching) && (
              <div className="absolute left-0 right-0 top-full mt-1 bg-[#161428] border border-white/10 rounded-xl shadow-2xl z-20 max-h-40 overflow-y-auto">
                {searchResults.map(u => (
                  <button key={u.id} onClick={() => handleAddUser(u)} className="w-full px-4 py-2 text-left text-xs text-white hover:bg-white/5 border-b border-white/5 last:border-0">
                    {u.name} ({u.username})
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="px-6 py-4 bg-white/5 border-t border-white/10 flex items-center justify-end gap-3">
          {team && (
            <button
              onClick={handleDelete}
              disabled={loading}
              className="mr-auto px-4 py-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs font-bold transition-all"
            >
              삭제
            </button>
          )}
          <button onClick={onClose} className="px-4 py-2 text-white/40 text-xs font-bold hover:text-white">취소</button>
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="px-6 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-lg shadow-indigo-500/20 active:scale-95 transition-all"
          >
            {loading ? '처리 중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  )
}
