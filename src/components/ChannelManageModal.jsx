import { useState, useEffect } from 'react'
import { useChat } from '../contexts/ChatContext'
import { apiFetch } from '../lib/api'
import { useAuth } from '../contexts/AuthContext'

// MD 미리보기를 간단히 처리하는 헬퍼 (TeamManageModal과 동일)
function SimpleMDPreview({ text }) {
  const html = text
    .replace(/^### (.+)$/gm, '<h3 class="text-white/80 font-semibold text-sm mt-3 mb-1">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-white font-bold text-base mt-4 mb-1.5">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-white font-bold text-lg mt-4 mb-2">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-white font-semibold">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em class="text-white/70 italic">$1</em>')
    .replace(/`(.+?)`/g, '<code class="bg-white/10 text-indigo-300 px-1 rounded text-xs">$1</code>')
    .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc text-white/60 text-sm">$1</li>')
    .replace(/\n/g, '<br/>')
  return (
    <div
      className="text-white/60 text-sm leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export default function ChannelManageModal({ mode = 'manage', channel = null, onClose, onSave = () => {} }) {
  const { currentUser } = useAuth()
  const { selectedTeam, selectedChannel } = useChat()
  const targetChannel = channel || selectedChannel
  const isEdit = mode === 'manage' && !!targetChannel

  const [name, setName] = useState(targetChannel?.name || '')
  const [type, setType] = useState(targetChannel?.type || 'public')
  const [description, setDescription] = useState(targetChannel?.description || '')
  const [descTab, setDescTab] = useState('preview')

  const [admins, setAdmins] = useState([])
  const [members, setMembers] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchTarget, setSearchTarget] = useState(null) // 'admin' or 'member'
  const [searchResults, setSearchResults] = useState([])
  const [isSearching, setIsSearching] = useState(false)
  
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteConfirmName, setDeleteConfirmName] = useState('')

  const isSiteAdmin = currentUser?.role === 'site_admin'
  const isTeamAdmin = isSiteAdmin || selectedTeam?.admin_ids?.includes(currentUser?.id)
  
  // 권한 설정: 팀 관리자면 모든 관리 가능, 아니면 채널 관리자만 가능
  const canManage = isTeamAdmin || admins.some(a => a.id === currentUser?.id)

  useEffect(() => {
    if (isEdit) {
      loadChannelData()
    }
  }, [targetChannel?.id])

  async function loadChannelData() {
    setLoading(true)
    try {
      const [adminList, memberList] = await Promise.all([
        apiFetch(`/channels/${targetChannel.id}/admins`),
        apiFetch(`/channels/${targetChannel.id}/members`),
      ])
      setAdmins(adminList)
      setMembers(memberList)
    } catch (err) {
      console.error('Failed to load channel data:', err)
    } finally {
      setLoading(false)
    }
  }

  // 사용자 검색 디바운스
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchQuery.trim().length >= 1) searchUsers(searchQuery)
      else setSearchResults([])
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery, searchTarget])

  async function searchUsers(query) {
    setIsSearching(true)
    try {
      const results = await apiFetch(`/users/search?q=${encodeURIComponent(query)}`)
      const existingIds = searchTarget === 'admin' 
        ? admins.map(a => a.id) 
        : members.map(m => m.id)
      setSearchResults(results.filter(u => !existingIds.includes(u.id)))
    } catch (err) {
      console.error(err)
    } finally {
      setIsSearching(false)
    }
  }

  const handleAddUser = (user) => {
    if (searchTarget === 'admin') {
      setAdmins(prev => [...prev, user])
      if (!members.find(m => m.id === user.id)) {
        setMembers(prev => [...prev, user])
      }
    } else {
      setMembers(prev => [...prev, user])
    }
    setSearchQuery('')
    setSearchResults([])
  }

  const handleRemoveUser = (id, target) => {
    if (target === 'admin') {
      if (admins.length <= 1) {
        setError('채널 관리자는 최소 1명 이상이어야 합니다.')
        return
      }
      setAdmins(prev => prev.filter(a => a.id !== id))
    } else {
      setMembers(prev => prev.filter(m => m.id !== id))
    }
    setError('')
  }

  const handleSave = async () => {
    setError('')
    if (!name.trim()) { setError('채널 이름을 입력해주세요.'); return }
    if (admins.length === 0) { setError('최소 1명의 관리자를 지정해야 합니다.'); return }

    setLoading(true)
    try {
      const channelId = isEdit ? targetChannel.id : `ch-${Date.now()}`
      const payload = {
        name: name.trim(),
        type,
        description: description.trim(),
        team_id: selectedTeam.id,
        adminIds: admins.map(a => a.id),
        memberIds: members.map(m => m.id)
      }

      const result = await apiFetch(`/channels/${channelId}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      })

      onSave(result)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async () => {
    if (deleteConfirmName !== targetChannel.name) {
      setError('채널 이름이 일치하지 않습니다.')
      return
    }
    setLoading(true)
    try {
      await apiFetch(`/channels/${targetChannel.id}`, { method: 'DELETE' })
      onSave(null, targetChannel.id)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-xl bg-[#1e1c30] rounded-3xl border border-white/10 shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-white/10 bg-white/5 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-xl">{type === 'public' ? '🌐' : '🔒'}</span>
            <h2 className="text-white font-bold text-base">{isEdit ? `${targetChannel.name} — 채널 관리` : '채널 추가'}</h2>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-white/30 hover:text-white hover:bg-white/10 transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Error Message */}
          {error && (
            <div className="px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Row: Name and Type */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-white/50 text-xs font-medium mb-1.5">채널 이름 <span className="text-red-400">*</span></label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="채널명 입력"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:ring-1 focus:ring-indigo-500 outline-none transition-all"
              />
            </div>
            <div>
              <label className="block text-white/50 text-xs font-medium mb-1.5">채널 종류</label>
              <div className="flex gap-2">
                {['public', 'private'].map(t => (
                  <button
                    key={t}
                    onClick={() => setType(t)}
                    className={`flex-1 py-2.5 rounded-xl text-xs font-semibold border transition-all ${
                      type === t ? 'bg-indigo-600 border-indigo-500 text-white shadow-lg shadow-indigo-500/20' : 'bg-white/5 border-white/10 text-white/40 hover:text-white/60'
                    }`}
                  >
                    {t === 'public' ? '공개' : '비공개'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Admins (TeamManageModal 스타일) */}
          <div>
            <label className="block text-white/50 text-xs font-medium mb-2">
              채널 관리자 <span className="text-red-400">*</span>
              <span className="text-white/25 ml-1">(최소 1명)</span>
            </label>
            <div className="min-h-[44px] p-2 bg-white/5 rounded-xl border border-white/10 flex flex-wrap gap-1.5 mb-3">
              {admins.map(a => (
                <div key={a.id} className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 text-[11px] font-medium">
                  <span>{a.name}</span>
                  <button onClick={() => handleRemoveUser(a.id, 'admin')} className="text-indigo-400/60 hover:text-red-400 transition-colors">×</button>
                </div>
              ))}
              {admins.length === 0 && <span className="text-white/20 text-xs px-1 py-1">관리자를 추가해주세요</span>}
            </div>
            {searchTarget === 'admin' ? (
              <div className="relative">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  autoFocus
                  placeholder="이름 또는 아이디 검색..."
                  onBlur={() => { if (!searchQuery.trim()) { setSearchTarget(null); setSearchResults([]) } }}
                  className="w-full bg-indigo-500/10 border border-indigo-500/30 rounded-xl px-4 py-3 text-white text-sm placeholder-white/25 focus:ring-1 focus:ring-indigo-500 outline-none"
                />
                {searchQuery.trim() && (searchResults.length > 0 || isSearching) && (
                  <div className="absolute left-0 right-0 top-full mt-1 bg-[#161428] border border-white/10 rounded-xl shadow-2xl z-20 max-h-48 overflow-y-auto">
                    {isSearching && <div className="px-4 py-3 text-white/30 text-xs">검색 중...</div>}
                    {searchResults.map(u => (
                      <button key={u.id} onMouseDown={() => handleAddUser(u)} className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-white/8 border-b border-white/5 last:border-0 flex items-center gap-3">
                        <div className="w-7 h-7 rounded-full bg-indigo-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">{u.name[0]}</div>
                        <div>
                          <p className="font-medium text-xs text-white">{u.name}</p>
                          <p className="text-white/40 text-[10px]">@{u.username}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <button onClick={() => { setSearchTarget('admin'); setSearchQuery('') }} className="w-full py-3 rounded-xl border-2 border-dashed border-indigo-500/30 text-indigo-400 hover:border-indigo-500/60 hover:bg-indigo-500/10 transition-all text-sm font-semibold flex items-center justify-center gap-2"> + 관리자 추가 </button>
            )}
          </div>

          {/* Members (TeamManageModal 스타일) */}
          <div>
            <label className="block text-white/50 text-xs font-medium mb-2">채널 멤버</label>
            <div className="min-h-[44px] p-2 bg-white/5 rounded-xl border border-white/10 flex flex-wrap gap-1.5 mb-3">
              {members.map(m => (
                <div key={m.id} className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-white/8 border border-white/10 text-white/60 text-[11px]">
                  <span>{m.name}</span>
                  <button onClick={() => handleRemoveUser(m.id, 'member')} className="text-white/30 hover:text-red-400 transition-colors">×</button>
                </div>
              ))}
              {members.length === 0 && <span className="text-white/20 text-xs px-1 py-1">멤버 없음</span>}
            </div>
            {searchTarget === 'member' ? (
              <div className="relative">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  autoFocus
                  placeholder="이름 또는 아이디 검색..."
                  onBlur={() => { if (!searchQuery.trim()) { setSearchTarget(null); setSearchResults([]) } }}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm placeholder-white/25 focus:ring-1 focus:ring-indigo-500/60 outline-none"
                />
                {searchQuery.trim() && (searchResults.length > 0 || isSearching) && (
                  <div className="absolute left-0 right-0 top-full mt-1 bg-[#161428] border border-white/10 rounded-xl shadow-2xl z-20 max-h-48 overflow-y-auto">
                    {isSearching && <div className="px-4 py-3 text-white/30 text-xs">검색 중...</div>}
                    {searchResults.map(u => (
                      <button key={u.id} onMouseDown={() => handleAddUser(u)} className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-white/8 border-b border-white/5 last:border-0 flex items-center gap-3">
                        <div className="w-7 h-7 rounded-full bg-indigo-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">{u.name[0]}</div>
                        <div>
                          <p className="font-medium text-xs text-white">{u.name}</p>
                          <p className="text-white/40 text-[10px]">@{u.username}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <button onClick={() => { setSearchTarget('member'); setSearchQuery('') }} className="w-full py-3 rounded-xl border-2 border-dashed border-white/15 text-white/40 hover:border-white/30 hover:bg-white/5 hover:text-white/60 transition-all text-sm font-semibold flex items-center justify-center gap-2"> + 멤버 추가 </button>
            )}
          </div>

          {/* Channel Description (MD 편집) */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-white/50 text-xs font-medium">채널 설명</label>
              <div className="flex gap-1 bg-white/5 rounded-lg p-0.5">
                {['write', 'preview'].map(t => (
                  <button
                    key={t}
                    onClick={() => setDescTab(t)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                      descTab === t ? 'bg-indigo-600 text-white' : 'text-white/40 hover:text-white/70'
                    }`}
                  >
                    {t === 'write' ? '✏️ 편집' : '👁 미리보기'}
                  </button>
                ))}
              </div>
            </div>
            {descTab === 'write' ? (
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                rows={4}
                placeholder={'채널의 설명을 Markdown 형식으로 작성하세요.'}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm placeholder-white/15 focus:ring-1 focus:ring-indigo-500 outline-none resize-none leading-relaxed font-mono"
              />
            ) : (
              <div className="min-h-[100px] bg-white/5 border border-white/10 rounded-xl px-4 py-3">
                {description.trim() ? <SimpleMDPreview text={description} /> : <p className="text-white/20 text-sm">미리볼 내용이 없습니다.</p>}
              </div>
            )}
            <p className="text-white/20 text-[10px] mt-1.5 px-1">Markdown 형식 지원: **굵게**, *기울임*, `코드`, # 제목</p>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-white/5 border-t border-white/10 flex items-center justify-end gap-3 flex-shrink-0">
          {isEdit && (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              disabled={loading}
              className="mr-auto px-4 py-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs font-bold transition-all"
            >
              채널 삭제
            </button>
          )}
          <button onClick={onClose} className="px-4 py-2 text-white/40 text-xs font-bold hover:text-white transition-colors">취소</button>
          <button
            onClick={handleSave}
            disabled={loading}
            className="px-6 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-bold shadow-lg shadow-indigo-500/20 active:scale-95 transition-all"
          >
            {loading ? '처리 중...' : '저장'}
          </button>
        </div>

        {/* Delete Confirmation */}
        {showDeleteConfirm && (
          <div className="absolute inset-0 z-30 bg-[#1e1c30]/95 flex flex-col items-center justify-center p-8 space-y-5">
            <div className="text-4xl">⚠️</div>
            <h3 className="text-white font-bold text-center text-lg">채널을 정말 삭제하시겠습니까?</h3>
            <p className="text-white/40 text-sm text-center">확인을 위해 채널 이름 <strong className="text-white">[{targetChannel.name}]</strong>을(를) 입력하세요.</p>
            <input
              type="text"
              value={deleteConfirmName}
              onChange={e => setDeleteConfirmName(e.target.value)}
              placeholder="채널 이름 입력"
              className="w-full max-w-sm bg-white/5 border border-red-500/30 rounded-xl px-4 py-2.5 text-white text-sm focus:ring-1 focus:ring-red-500 outline-none text-center"
            />
            {error && <p className="text-red-400 text-xs">{error}</p>}
            <div className="flex gap-3">
              <button onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmName(''); setError('') }} className="px-6 py-2 text-white/40 text-sm font-bold hover:text-white">취소</button>
              <button
                onClick={handleDelete}
                disabled={deleteConfirmName !== targetChannel.name || loading}
                className="px-8 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-30 text-white text-sm font-bold shadow-lg shadow-red-500/20 transition-all"
              >
                {loading ? '삭제 중...' : '영구 삭제'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
