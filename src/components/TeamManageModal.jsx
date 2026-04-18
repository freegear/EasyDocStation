import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'
import { useAuth } from '../contexts/AuthContext'
import { useT } from '../i18n/useT'

// MD 미리보기를 간단히 처리하는 헬퍼
function SimpleMDPreview({ text }) {
  const html = text
    .replace(/^### (.+)$/gm, '<h3 class="text-gray-700 font-semibold text-sm mt-3 mb-1">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-gray-900 font-bold text-base mt-4 mb-1.5">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-gray-900 font-bold text-lg mt-4 mb-2">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-gray-900 font-semibold">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em class="text-gray-600 italic">$1</em>')
    .replace(/`(.+?)`/g, '<code class="bg-gray-200 text-indigo-600 px-1 rounded text-xs">$1</code>')
    .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc text-gray-500 text-sm">$1</li>')
    .replace(/\n/g, '<br/>')
  return (
    <div
      className="text-gray-500 text-sm leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export default function TeamManageModal({ team = null, onClose, onSave }) {
  const { currentUser } = useAuth()
  const t = useT()
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
        setError(t.team.minOneAdmin)
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
    if (!name.trim()) { setError(t.team.nameRequired); return }
    if (selectedAdmins.length === 0) { setError(t.team.minOneAdmin); return }

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
      setError(t.team.nameNotMatch)
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
      <div className="relative w-full max-w-xl bg-gray-50 rounded-3xl border border-gray-200 shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">

        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-100 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{team?.icon || '🏢'}</span>
            <h2 className="text-gray-900 font-bold text-base">{isEdit ? t.team.editHeader(team.name) : t.team.addTitle}</h2>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-900 hover:bg-gray-200 transition-colors">
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
            <label className="block text-gray-500 text-xs font-medium mb-1.5">{t.team.teamName} <span className="text-red-400">*</span></label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t.team.teamNamePlaceholder}
              className="w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-900 text-sm placeholder-gray-400 focus:ring-1 focus:ring-indigo-500 outline-none transition-all"
            />
          </div>

          {/* 관리자 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-gray-500 text-xs font-medium">
                {t.team.admins} <span className="text-red-400">*</span>
              </label>
              {searchTarget !== 'admin' && (
                <button
                  onClick={() => { setSearchTarget('admin'); setSearchQuery('') }}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-indigo-200 text-indigo-600 hover:bg-indigo-50 hover:border-indigo-400 transition-all text-xs font-semibold"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                  {t.team.addAdmins}
                </button>
              )}
            </div>
            {/* 관리자 태그 목록 */}
            <div className="min-h-[44px] p-2 bg-gray-100 rounded-xl border border-gray-200 flex flex-wrap gap-1.5 mb-2">
              {selectedAdmins.map(a => (
                <div key={a.id} className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-indigo-100 border border-indigo-200 text-indigo-600 text-[11px] font-medium">
                  <span>{a.name}</span>
                  <button
                    onClick={() => handleRemoveUser(a.id, 'admin')}
                    className="text-indigo-600/60 hover:text-red-400 transition-colors text-sm leading-none"
                  >×</button>
                </div>
              ))}
              {selectedAdmins.length === 0 && (
                <span className="text-gray-300 text-xs px-1 py-1">{t.team.noAdmins}</span>
              )}
            </div>
            {/* 관리자 인라인 검색 */}
            {searchTarget === 'admin' && (
              <div className="relative mt-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  autoFocus
                  placeholder={t.team.addAdminsPlaceholder}
                  onBlur={() => { if (!searchQuery.trim()) { setSearchTarget(null); setSearchResults([]) } }}
                  className="w-full bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-3 text-gray-900 text-sm placeholder-gray-400 focus:ring-1 focus:ring-indigo-500 outline-none"
                />
                {searchQuery.trim() && (searchResults.length > 0 || isSearching) && (
                  <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-2xl z-20 max-h-48 overflow-y-auto">
                    {isSearching && <div className="px-4 py-3 text-gray-400 text-xs">{t.team.searching}</div>}
                    {searchResults.map(u => (
                      <button
                        key={u.id}
                        onMouseDown={() => handleAddUser(u)}
                        className="w-full px-4 py-2.5 text-left text-sm text-gray-900 hover:bg-gray-200 border-b border-gray-100 last:border-0 flex items-center gap-3"
                      >
                        <div className="w-7 h-7 rounded-full bg-indigo-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                          {u.name[0]}
                        </div>
                        <div>
                          <p className="font-medium">{u.name}</p>
                          <p className="text-gray-400 text-xs">@{u.username}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                {searchQuery.trim() && !isSearching && searchResults.length === 0 && (
                  <p className="text-gray-400 text-xs mt-1 px-1">{t.team.searchNoResults}</p>
                )}
              </div>
            )}
          </div>

          {/* 멤버 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-gray-500 text-xs font-medium">{t.team.members}</label>
              {searchTarget !== 'member' && (
                <button
                  onClick={() => { setSearchTarget('member'); setSearchQuery('') }}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-100 hover:border-gray-400 transition-all text-xs font-semibold"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                  {t.team.addMembers}
                </button>
              )}
            </div>
            <div className="min-h-[44px] p-2 bg-gray-100 rounded-xl border border-gray-200 flex flex-wrap gap-1.5 mb-2">
              {selectedMembers.map(m => (
                <div key={m.id} className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-gray-200 border border-gray-200 text-gray-500 text-[11px]">
                  <span>{m.name}</span>
                  <button
                    onClick={() => handleRemoveUser(m.id, 'member')}
                    className="text-gray-400 hover:text-red-400 transition-colors"
                  >×</button>
                </div>
              ))}
              {selectedMembers.length === 0 && (
                <span className="text-gray-300 text-xs px-1 py-1">{t.team.noMembers}</span>
              )}
            </div>

            {/* 멤버 인라인 검색 */}
            {searchTarget === 'member' && (
              <div className="relative mt-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  autoFocus
                  placeholder={t.team.addMembersPlaceholder}
                  onBlur={() => { if (!searchQuery.trim()) { setSearchTarget(null); setSearchResults([]) } }}
                  className="w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-3 text-gray-900 text-sm placeholder-gray-400 focus:ring-1 focus:ring-indigo-500/60 outline-none"
                />
                {searchQuery.trim() && (searchResults.length > 0 || isSearching) && (
                  <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-2xl z-20 max-h-48 overflow-y-auto">
                    {isSearching && <div className="px-4 py-3 text-gray-400 text-xs">{t.team.searching}</div>}
                    {searchResults.map(u => (
                      <button
                        key={u.id}
                        onMouseDown={() => handleAddUser(u)}
                        className="w-full px-4 py-2.5 text-left text-sm text-gray-900 hover:bg-gray-200 border-b border-gray-100 last:border-0 flex items-center gap-3"
                      >
                        <div className="w-7 h-7 rounded-full bg-indigo-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                          {u.name[0]}
                        </div>
                        <div>
                          <p className="font-medium">{u.name}</p>
                          <p className="text-gray-400 text-xs">@{u.username}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                {searchQuery.trim() && !isSearching && searchResults.length === 0 && (
                  <p className="text-gray-400 text-xs mt-1 px-1">{t.team.searchNoResults}</p>
                )}
              </div>
            )}
          </div>

          {/* 팀 설명 (MD 편집) */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-gray-500 text-xs font-medium">{t.team.description}</label>
              <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
                {[{ key: 'write', label: t.team.descWrite }, { key: 'preview', label: t.team.descPreview }].map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => setDescTab(tab.key)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                      descTab === tab.key ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-600'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
            {descTab === 'write' ? (
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                rows={6}
                placeholder={t.team.descriptionPlaceholder}
                className="w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-3 text-gray-900 text-sm placeholder-white/15 focus:ring-1 focus:ring-indigo-500 outline-none resize-none leading-relaxed font-mono"
              />
            ) : (
              <div className="min-h-[120px] bg-gray-100 border border-gray-200 rounded-xl px-4 py-3">
                {description.trim()
                  ? <SimpleMDPreview text={description} />
                  : <p className="text-gray-300 text-sm">{t.team.descEmpty}</p>
                }
              </div>
            )}
          </div>

        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-gray-100 border-t border-gray-200 flex items-center justify-end gap-3 flex-shrink-0">
          {isEdit && (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              disabled={loading}
              className="mr-auto px-4 py-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs font-bold transition-all"
            >
              {t.team.deleteTitle}
            </button>
          )}
          <button onClick={onClose} className="px-4 py-2 text-gray-400 text-xs font-bold hover:text-gray-900 transition-colors">
            {t.team.cancel}
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="px-6 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-bold shadow-lg shadow-indigo-200 active:scale-95 transition-all"
          >
            {loading ? t.team.processing : t.team.save}
          </button>
        </div>

        {/* 삭제 확인 오버레이 */}
        {showDeleteConfirm && (
          <div className="absolute inset-0 z-30 bg-gray-50/95 flex flex-col items-center justify-center p-8 space-y-5">
            <div className="text-4xl">⚠️</div>
            <h3 className="text-gray-900 font-bold text-center text-lg">{t.team.deleteConfirmTitle}</h3>
            <p className="text-gray-400 text-sm text-center leading-relaxed">{t.team.deleteWarning}</p>
            <p className="text-gray-400 text-xs text-center">{t.team.deleteConfirmInput(team?.name)}</p>
            <input
              type="text"
              value={deleteConfirmName}
              onChange={e => setDeleteConfirmName(e.target.value)}
              placeholder={t.team.deleteConfirmPlaceholder}
              className="w-full max-w-sm bg-gray-100 border border-red-200 rounded-xl px-4 py-2.5 text-gray-900 text-sm focus:ring-1 focus:ring-red-500 outline-none text-center"
            />
            {error && <p className="text-red-400 text-xs">{error}</p>}
            <div className="flex gap-3">
              <button
                onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmName(''); setError('') }}
                className="px-6 py-2 text-gray-400 text-sm font-bold hover:text-gray-900"
              >
                {t.team.cancel}
              </button>
              <button
                onClick={handleDelete}
                disabled={deleteConfirmName !== team?.name || loading}
                className="px-8 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-30 text-white text-sm font-bold shadow-lg shadow-red-500/20 transition-all"
              >
                {loading ? t.team.processing : t.team.permanentDelete}
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
