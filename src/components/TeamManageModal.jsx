import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'
import { useAuth } from '../contexts/AuthContext'

// MD 미리보기를 간단히 처리하는 헬퍼
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

export default function TeamManageModal({ team = null, onClose, onSave }) {
  const { currentUser } = useAuth()
  const isEdit = !!team

  const [name, setName] = useState(team?.name || '')
  const [description, setDescription] = useState(team?.description || '')
  const [descTab, setDescTab] = useState('preview')

  const [searchQuery, setSearchQuery] = useState('')
  const [searchTarget, setSearchTarget] = useState('admin')
  const [selectedAdmins, setSelectedAdmins] = useState([])
  const [selectedMembers, setSelectedMembers] = useState([])
  const [searchResults, setSearchResults] = useState([])
  const [isSearching, setIsSearching] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteConfirmName, setDeleteConfirmName] = useState('')

  const isSiteAdmin = currentUser?.role === 'site_admin'
  const isTeamAdmin = isSiteAdmin || selectedAdmins.some(a => a.id === currentUser?.id)
  const canManage = !isEdit || isTeamAdmin

  // ESC 키로 창 닫기
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key !== 'Escape') return
      if (showDeleteConfirm) {
        setShowDeleteConfirm(false)
        setDeleteConfirmName('')
        setError('')
      } else {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [showDeleteConfirm, onClose])

  // 팀 편집 시 기존 데이터 로드
  useEffect(() => {
    if (team) loadTeamData()
  }, [team?.id])

  async function loadTeamData() {
    try {
      const [admins, members] = await Promise.all([
        apiFetch(`/teams/${team.id}/admins`),
        apiFetch(`/teams/${team.id}/members`),
      ])
      setSelectedAdmins(admins)
      setSelectedMembers(members)
    } catch (err) {
      console.error('Failed to load team data:', err)
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
      setSelectedAdmins(prev => [...prev, user])
      if (!selectedMembers.find(m => m.id === user.id)) {
        setSelectedMembers(prev => [...prev, user])
      }
    } else {
      setSelectedMembers(prev => [...prev, user])
    }
    setSearchQuery('')
    setSearchResults([])
  }

  const handleRemoveUser = (id, target) => {
    if (target === 'admin') {
      if (selectedAdmins.length <= 1) {
        setError('팀 관리자는 최소 1명 이상이어야 합니다.')
        return
      }
      setSelectedAdmins(prev => prev.filter(a => a.id !== id))
    } else {
      setSelectedMembers(prev => prev.filter(m => m.id !== id))
    }
    setError('')
  }

  const handleSubmit = async () => {
    setError('')
    if (!name.trim()) { setError('팀 이름을 입력해주세요.'); return }
    if (selectedAdmins.length === 0) { setError('최소 1명의 관리자를 지정해야 합니다.'); return }

    setLoading(true)
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        adminIds: selectedAdmins.map(a => a.id),
        memberIds: selectedMembers.map(m => m.id),
      }
      const result = isEdit
        ? await apiFetch(`/teams/${team.id}`, { method: 'PUT', body: JSON.stringify(payload) })
        : await apiFetch('/teams', { method: 'POST', body: JSON.stringify(payload) })

      onSave(result)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async () => {
    if (deleteConfirmName !== team.name) {
      setError('팀 이름이 일치하지 않습니다.')
      return
    }
    setLoading(true)
    try {
      await apiFetch(`/teams/${team.id}`, { method: 'DELETE' })
      onSave(null, team.id)
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
            <span className="text-2xl">{team?.icon || '🏢'}</span>
            <h2 className="text-white font-bold text-base">{isEdit ? `${team.name} — 팀 정보` : 'Team 추가'}</h2>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-white/30 hover:text-white hover:bg-white/10 transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">

          {/* Error */}
          {error && (
            <div className="px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Team 이름 */}
          <div>
            <label className="block text-white/50 text-xs font-medium mb-1.5">Team 이름 <span className="text-red-400">*</span></label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="팀 이름을 입력하세요"
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm placeholder-white/20 focus:ring-1 focus:ring-indigo-500 outline-none transition-all"
            />
          </div>

          {/* 관리자 */}
          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="text-white/50 text-xs font-medium">
                Team 관리자 <span className="text-red-400">*</span>
                <span className="text-white/25 ml-1">(최소 1명)</span>
              </label>
            </div>
            {/* 관리자 태그 목록 */}
            <div className="min-h-[44px] p-2 bg-white/5 rounded-xl border border-white/10 flex flex-wrap gap-1.5 mb-3">
              {selectedAdmins.map(a => (
                <div key={a.id} className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 text-[11px] font-medium">
                  <span>{a.name}</span>
                  <button
                    onClick={() => handleRemoveUser(a.id, 'admin')}
                    className="text-indigo-400/60 hover:text-red-400 transition-colors text-sm leading-none"
                  >×</button>
                </div>
              ))}
              {selectedAdmins.length === 0 && (
                <span className="text-white/20 text-xs px-1 py-1">관리자를 추가해주세요</span>
              )}
            </div>
            {/* 관리자 추가: 버튼 or 인라인 검색 */}
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
                      <button
                        key={u.id}
                        onMouseDown={() => handleAddUser(u)}
                        className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-white/8 border-b border-white/5 last:border-0 flex items-center gap-3"
                      >
                        <div className="w-7 h-7 rounded-full bg-indigo-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                          {u.name[0]}
                        </div>
                        <div>
                          <p className="font-medium">{u.name}</p>
                          <p className="text-white/40 text-xs">@{u.username}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                {searchQuery.trim() && !isSearching && searchResults.length === 0 && (
                  <p className="text-white/25 text-xs mt-1 px-1">검색 결과가 없습니다.</p>
                )}
              </div>
            ) : (
              <button
                onClick={() => { setSearchTarget('admin'); setSearchQuery('') }}
                className="w-full py-3 rounded-xl border-2 border-dashed border-indigo-500/30 text-indigo-400 hover:border-indigo-500/60 hover:bg-indigo-500/10 transition-all text-sm font-semibold flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
                관리자 추가
              </button>
            )}
          </div>

          {/* 멤버 */}
          <div>
            <label className="block text-white/50 text-xs font-medium mb-2">Team 멤버</label>
            <div className="min-h-[44px] p-2 bg-white/5 rounded-xl border border-white/10 flex flex-wrap gap-1.5 mb-3">
              {selectedMembers.map(m => (
                <div key={m.id} className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-white/8 border border-white/10 text-white/60 text-[11px]">
                  <span>{m.name}</span>
                  <button
                    onClick={() => handleRemoveUser(m.id, 'member')}
                    className="text-white/30 hover:text-red-400 transition-colors"
                  >×</button>
                </div>
              ))}
              {selectedMembers.length === 0 && (
                <span className="text-white/20 text-xs px-1 py-1">멤버 없음</span>
              )}
            </div>

            {/* 멤버 추가: 버튼 or 인라인 검색 */}
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
                      <button
                        key={u.id}
                        onMouseDown={() => handleAddUser(u)}
                        className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-white/8 border-b border-white/5 last:border-0 flex items-center gap-3"
                      >
                        <div className="w-7 h-7 rounded-full bg-indigo-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                          {u.name[0]}
                        </div>
                        <div>
                          <p className="font-medium">{u.name}</p>
                          <p className="text-white/40 text-xs">@{u.username}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                {searchQuery.trim() && !isSearching && searchResults.length === 0 && (
                  <p className="text-white/25 text-xs mt-1 px-1">검색 결과가 없습니다.</p>
                )}
              </div>
            ) : (
              <button
                onClick={() => { setSearchTarget('member'); setSearchQuery('') }}
                className="w-full py-3 rounded-xl border-2 border-dashed border-white/15 text-white/40 hover:border-white/30 hover:bg-white/5 hover:text-white/60 transition-all text-sm font-semibold flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
                멤버 추가
              </button>
            )}
          </div>

          {/* 팀 설명 (MD 편집) */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-white/50 text-xs font-medium">Team 설명</label>
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
                rows={6}
                placeholder={'팀의 목적과 설명을 Markdown 형식으로 작성하세요.\n\n예:\n# 팀 소개\n이 팀은 **개발**과 **디자인**을 담당합니다.\n\n- 주요 업무 1\n- 주요 업무 2'}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm placeholder-white/15 focus:ring-1 focus:ring-indigo-500 outline-none resize-none leading-relaxed font-mono"
              />
            ) : (
              <div className="min-h-[120px] bg-white/5 border border-white/10 rounded-xl px-4 py-3">
                {description.trim()
                  ? <SimpleMDPreview text={description} />
                  : <p className="text-white/20 text-sm">미리볼 내용이 없습니다.</p>
                }
              </div>
            )}
            <p className="text-white/20 text-[10px] mt-1.5 px-1">Markdown 형식 지원: **굵게**, *기울임*, `코드`, # 제목, - 목록</p>
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
              팀 삭제
            </button>
          )}
          <button onClick={onClose} className="px-4 py-2 text-white/40 text-xs font-bold hover:text-white transition-colors">
            취소
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="px-6 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-bold shadow-lg shadow-indigo-500/20 active:scale-95 transition-all"
          >
            {loading ? '처리 중...' : '저장'}
          </button>
        </div>

        {/* 삭제 확인 오버레이 */}
        {showDeleteConfirm && (
          <div className="absolute inset-0 z-30 bg-[#1e1c30]/95 flex flex-col items-center justify-center p-8 space-y-5">
            <div className="text-4xl">⚠️</div>
            <h3 className="text-white font-bold text-center text-lg">팀을 정말 삭제하시겠습니까?</h3>
            <p className="text-white/40 text-sm text-center leading-relaxed">
              이 팀에 속한 <span className="text-orange-400 font-medium">모든 채널과 게시글</span>이<br/>함께 삭제되며 복구할 수 없습니다.
            </p>
            <p className="text-white/40 text-xs text-center">
              확인을 위해 팀 이름 <strong className="text-white">[{team?.name}]</strong>을(를) 입력하세요.
            </p>
            <input
              type="text"
              value={deleteConfirmName}
              onChange={e => setDeleteConfirmName(e.target.value)}
              placeholder="팀 이름 입력"
              className="w-full max-w-sm bg-white/5 border border-red-500/30 rounded-xl px-4 py-2.5 text-white text-sm focus:ring-1 focus:ring-red-500 outline-none text-center"
            />
            {error && <p className="text-red-400 text-xs">{error}</p>}
            <div className="flex gap-3">
              <button
                onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmName(''); setError('') }}
                className="px-6 py-2 text-white/40 text-sm font-bold hover:text-white"
              >
                취소
              </button>
              <button
                onClick={handleDelete}
                disabled={deleteConfirmName !== team?.name || loading}
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
