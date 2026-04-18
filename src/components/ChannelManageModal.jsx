import { useState, useEffect } from 'react'
import { useChat } from '../contexts/ChatContext'
import { apiFetch } from '../lib/api'
import { useAuth } from '../contexts/AuthContext'
import { useT } from '../i18n/useT'
import ConfirmDialog from './ConfirmDialog'

// MD 미리보기를 간단히 처리하는 헬퍼 (TeamManageModal과 동일)
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

export default function ChannelManageModal({ mode = 'manage', channel = null, onClose, onSave = () => {} }) {
  const { currentUser } = useAuth()
  const { selectedTeam, selectedChannel } = useChat()
  const t = useT()
  const targetChannel = channel || selectedChannel
  const isEdit = mode === 'manage' && !!targetChannel

  const [name, setName] = useState(targetChannel?.name || '')
  const [type, setType] = useState(targetChannel?.type || 'public')
  const [isArchived, setIsArchived] = useState(targetChannel?.is_archived || false)
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
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false)
  const [deleteConfirmName, setDeleteConfirmName] = useState('')

  const isSiteAdmin = currentUser?.role === 'site_admin'
  const isTeamAdmin = isSiteAdmin || selectedTeam?.admin_ids?.includes(currentUser?.id)
  
  // 권한 설정: 팀 관리자면 모든 관리 가능, 아니면 채널 관리자만 가능
  const canManage = isTeamAdmin || admins.some(a => a.id === currentUser?.id)

  useEffect(() => {
    const handleEsc = (e) => {
      if (e.key !== 'Escape') return
      if (showDeleteConfirm) {
        setShowDeleteConfirm(false)
        setDeleteConfirmName('')
        setError('')
        return
      }
      if (showArchiveConfirm) {
        setShowArchiveConfirm(false)
        return
      }
      onClose()
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [onClose, showDeleteConfirm, showArchiveConfirm])

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
        setError(t.channel.minOneAdmin)
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
    if (!name.trim()) { setError(t.channel.nameRequired); return }
    if (admins.length === 0) { setError(t.channel.minOneAdmin); return }

    setLoading(true)
    try {
      const channelId = isEdit ? targetChannel.id : `ch-${Date.now()}`
      const payload = {
        name: name.trim(),
        type,
        is_archived: isArchived,
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

  const confirmArchive = async () => {
    setLoading(true)
    try {
      const payload = {
        name: name.trim(),
        type,
        is_archived: true,
        description: description.trim(),
        team_id: selectedTeam.id,
        adminIds: admins.map(a => a.id),
        memberIds: members.map(m => m.id)
      }
      await apiFetch(`/channels/${targetChannel.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      })
      onSave()
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
      setShowArchiveConfirm(false)
    }
  }

  const handleDelete = async () => {
    if (deleteConfirmName !== targetChannel.name) {
      setError(t.channel.nameNotMatch)
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
      <div className="relative w-full max-w-xl bg-gray-50 rounded-3xl border border-gray-200 shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-100 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-xl">{type === 'public' ? '🌐' : '🔒'}</span>
            <h2 className="text-gray-900 font-bold text-base">{isEdit ? t.channel.editHeader(targetChannel.name) : t.channel.addTitle}</h2>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-900 hover:bg-gray-200 transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Error Message */}
          {error && (
            <div className="px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* 채널 이름 + Is Private */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-gray-500 text-xs font-medium mb-1.5">Channel Name <span className="text-red-400">*</span></label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t.channel.channelNamePlaceholder}
                className="w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-900 text-sm focus:ring-1 focus:ring-indigo-500 outline-none transition-all"
              />
            </div>
            <div>
              <label className="block text-gray-500 text-xs font-medium mb-1.5">Is Private</label>
              <div className="flex gap-2">
                {[
                  { value: 'public',  label: t.channel.typePublic, icon: '🌐' },
                  { value: 'private', label: t.channel.typePrivate, icon: '🔒' },
                ].map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setType(opt.value)}
                    className={`flex-1 py-2.5 rounded-xl text-xs font-semibold border transition-all flex items-center justify-center gap-1 ${
                      type === opt.value
                        ? 'bg-indigo-600 border-indigo-500 text-white shadow-lg shadow-indigo-200'
                        : 'bg-gray-100 border-gray-200 text-gray-400 hover:text-gray-500'
                    }`}
                  >
                    {opt.icon} {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Admins (TeamManageModal 스타일) */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-gray-500 text-xs font-medium">
                {t.channel.admins} <span className="text-red-400">*</span>
              </label>
              {searchTarget !== 'admin' && (
                <button onClick={() => { setSearchTarget('admin'); setSearchQuery('') }} className="px-2.5 py-1 rounded-lg border border-indigo-200 text-indigo-600 hover:bg-indigo-50 transition-all text-xs font-semibold">{t.channel.addAdmins}</button>
              )}
            </div>
            <div className="min-h-[44px] p-2 bg-gray-100 rounded-xl border border-gray-200 flex flex-wrap gap-1.5 mb-2">
              {admins.map(a => (
                <div key={a.id} className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-indigo-100 border border-indigo-200 text-indigo-600 text-[11px] font-medium">
                  <span>{a.name}</span>
                  <button onClick={() => handleRemoveUser(a.id, 'admin')} className="text-indigo-600/60 hover:text-red-400 transition-colors">×</button>
                </div>
              ))}
              {admins.length === 0 && <span className="text-gray-300 text-xs px-1 py-1">{t.channel.noAdmins}</span>}
            </div>
            {searchTarget === 'admin' && (
              <div className="relative">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  autoFocus
                  placeholder={t.channel.addAdminsPlaceholder}
                  onBlur={() => { if (!searchQuery.trim()) { setSearchTarget(null); setSearchResults([]) } }}
                  className="w-full bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-3 text-gray-900 text-sm placeholder-gray-400 focus:ring-1 focus:ring-indigo-500 outline-none"
                />
                {searchQuery.trim() && (searchResults.length > 0 || isSearching) && (
                  <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-2xl z-20 max-h-48 overflow-y-auto">
                    {isSearching && <div className="px-4 py-3 text-gray-400 text-xs">{t.channel.searching}</div>}
                    {searchResults.map(u => (
                      <button key={u.id} onMouseDown={() => handleAddUser(u)} className="w-full px-4 py-2.5 text-left text-sm text-gray-900 hover:bg-gray-200 border-b border-gray-100 last:border-0 flex items-center gap-3">
                        <div className="w-7 h-7 rounded-full bg-indigo-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">{u.name[0]}</div>
                        <div>
                          <p className="font-medium text-xs text-gray-900">{u.name}</p>
                          <p className="text-gray-400 text-[10px]">@{u.username}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Members (TeamManageModal 스타일) */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-gray-500 text-xs font-medium">{t.channel.members}</label>
              {searchTarget !== 'member' && (
                <button onClick={() => { setSearchTarget('member'); setSearchQuery('') }} className="px-2.5 py-1 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-100 transition-all text-xs font-semibold">{t.channel.addMembers}</button>
              )}
            </div>
            <div className="min-h-[44px] p-2 bg-gray-100 rounded-xl border border-gray-200 flex flex-wrap gap-1.5 mb-2">
              {members.map(m => (
                <div key={m.id} className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-gray-200 border border-gray-200 text-gray-500 text-[11px]">
                  <span>{m.name}</span>
                  <button onClick={() => handleRemoveUser(m.id, 'member')} className="text-gray-400 hover:text-red-400 transition-colors">×</button>
                </div>
              ))}
              {members.length === 0 && <span className="text-gray-300 text-xs px-1 py-1">{t.channel.noMembers}</span>}
            </div>
            {searchTarget === 'member' && (
              <div className="relative">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  autoFocus
                  placeholder={t.channel.addMembersPlaceholder}
                  onBlur={() => { if (!searchQuery.trim()) { setSearchTarget(null); setSearchResults([]) } }}
                  className="w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-3 text-gray-900 text-sm placeholder-gray-400 focus:ring-1 focus:ring-indigo-500/60 outline-none"
                />
                {searchQuery.trim() && (searchResults.length > 0 || isSearching) && (
                  <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-2xl z-20 max-h-48 overflow-y-auto">
                    {isSearching && <div className="px-4 py-3 text-gray-400 text-xs">{t.channel.searching}</div>}
                    {searchResults.map(u => (
                      <button key={u.id} onMouseDown={() => handleAddUser(u)} className="w-full px-4 py-2.5 text-left text-sm text-gray-900 hover:bg-gray-200 border-b border-gray-100 last:border-0 flex items-center gap-3">
                        <div className="w-7 h-7 rounded-full bg-indigo-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">{u.name[0]}</div>
                        <div>
                          <p className="font-medium text-xs text-gray-900">{u.name}</p>
                          <p className="text-gray-400 text-[10px]">@{u.username}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Channel Description (MD 편집) */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-gray-500 text-xs font-medium">{t.channel.description}</label>
              <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
                {[{ key: 'write', label: t.channel.descWrite }, { key: 'preview', label: t.channel.descPreview }].map(tab => (
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
                rows={4}
                placeholder={t.channel.descriptionPlaceholder}
                className="w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-3 text-gray-900 text-sm placeholder-white/15 focus:ring-1 focus:ring-indigo-500 outline-none resize-none leading-relaxed font-mono"
              />
            ) : (
              <div className="min-h-[100px] bg-gray-100 border border-gray-200 rounded-xl px-4 py-3">
                {description.trim() ? <SimpleMDPreview text={description} /> : <p className="text-gray-300 text-sm">{t.channel.descEmpty}</p>}
              </div>
            )}
          </div>

        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-gray-100 border-t border-gray-200 flex items-center justify-end gap-3 flex-shrink-0">
          {isEdit && (
            <>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                disabled={loading}
                className="px-4 py-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs font-bold transition-all"
              >
                {t.channel.delete}
              </button>
              <button
                onClick={() => setShowArchiveConfirm(true)}
                disabled={loading || isArchived}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
                  isArchived
                    ? 'bg-amber-500/20 text-amber-500 cursor-not-allowed'
                    : 'bg-amber-50 hover:bg-amber-500/20 text-amber-500'
                }`}
              >
                {isArchived ? t.channel.unarchive : t.channel.archive}
              </button>
            </>
          )}
          <div className="flex-1" />
          <button onClick={onClose} className="px-4 py-2 text-gray-400 text-xs font-bold hover:text-gray-900 transition-colors">{t.channel.cancel}</button>
          <button
            onClick={handleSave}
            disabled={loading}
            className="px-6 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-bold shadow-lg shadow-indigo-200 active:scale-95 transition-all"
          >
            {loading ? t.channel.processing : t.channel.save}
          </button>
        </div>

        {/* Delete Confirmation */}
        {showDeleteConfirm && (
          <div className="absolute inset-0 z-30 bg-gray-50/95 flex flex-col items-center justify-center p-8 space-y-5">
            <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center text-red-500 text-3xl mb-2">⚠️</div>
            <h3 className="text-gray-900 font-bold text-center text-lg">{t.channel.deleteConfirmTitle}</h3>
            <p className="text-gray-400 text-[11px] text-center mt-2">{t.channel.deleteConfirmHint(targetChannel.name)}</p>
            <input
              type="text"
              value={deleteConfirmName}
              onChange={e => setDeleteConfirmName(e.target.value)}
              placeholder={t.channel.deleteConfirmPlaceholder}
              className="w-full max-w-sm bg-gray-100 border border-red-200 rounded-xl px-4 py-3 text-gray-900 text-sm focus:ring-1 focus:ring-red-500 outline-none text-center font-bold"
            />
            {error && <p className="text-red-400 text-xs">{error}</p>}
            <div className="flex gap-4 mt-4">
              <button onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmName(''); setError('') }} className="px-6 py-2 text-gray-400 text-sm font-bold hover:text-gray-900 transition-colors">{t.channel.cancel}</button>
              <button
                onClick={handleDelete}
                disabled={deleteConfirmName !== targetChannel.name || loading}
                className="px-10 py-3 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-30 text-white text-sm font-black shadow-xl shadow-red-600/20 active:scale-95 transition-all"
              >
                {loading ? t.channel.processing : t.channel.permanentDelete}
              </button>
            </div>
          </div>
        )}

        {showArchiveConfirm && (
          <ConfirmDialog
            title={t.channel.archive}
            message={t.channel.archiveConfirm}
            confirmText={t.channel.archive}
            cancelText={t.channel.cancel}
            loading={loading}
            onConfirm={confirmArchive}
            onCancel={() => setShowArchiveConfirm(false)}
          />
        )}
      </div>
    </div>
  )
}
