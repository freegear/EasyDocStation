import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'
import { ROLE_LABELS, ROLE_BADGE, ROLE_OPTIONS } from '../constants/roles'
import { useAuth } from '../contexts/AuthContext'
import GroqPanel from './GroqPanel'

// ─── helpers ─────────────────────────────────────────────────

function formatDate(iso) {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('ko-KR', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function RoleBadge({ role }) {
  const cls = ROLE_BADGE[role] ?? ROLE_BADGE.user
  return (
    <span className={`px-2 py-0.5 rounded-md text-xs font-medium border ${cls}`}>
      {ROLE_LABELS[role] ?? role}
    </span>
  )
}

function Avatar({ name, imageUrl, size = 8 }) {
  const letters = name?.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) ?? '?'
  return (
    <div className={`w-${size} h-${size} rounded-full bg-indigo-500 overflow-hidden flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0 border border-white/10`}>
      {imageUrl ? (
        <img src={imageUrl} alt={name} className="w-full h-full object-cover" />
      ) : (
        letters
      )}
    </div>
  )
}

// ─── User form modal ──────────────────────────────────────────

function UserFormModal({ user, onClose, onSave }) {
  const isEdit = !!user
  const [form, setForm] = useState({
    username: user?.username ?? '',
    name: user?.name ?? '',
    email: user?.email ?? '',
    role: user?.role ?? 'user',
    password: '',
    confirmPassword: '',
    is_active: user?.is_active ?? true,
    image_url: user?.image_url ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function set(key, val) { setForm(p => ({ ...p, [key]: val })) }

  // 비밀번호 일치 여부 (입력 중 실시간 표시)
  const pwEntered = form.password.length > 0 || form.confirmPassword.length > 0
  const pwMatch = form.password === form.confirmPassword

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    // 비밀번호 입력이 있는 경우 검증
    if (form.password || !isEdit) {
      if (form.password.length < 6) {
        setError('비밀번호는 6자 이상이어야 합니다.')
        return
      }
      if (form.password !== form.confirmPassword) {
        setError('비밀번호가 일치하지 않습니다.')
        return
      }
    }

    setSaving(true)
    try {
      let result
      if (isEdit) {
        const body = { name: form.name, email: form.email, role: form.role, is_active: form.is_active, image_url: form.image_url }
        if (form.password) body.password = form.password
        result = await apiFetch(`/users/${user.id}`, { method: 'PUT', body: JSON.stringify(body) })
      } else {
        result = await apiFetch('/users', {
          method: 'POST',
          body: JSON.stringify({ 
            username: form.username, name: form.name, email: form.email, 
            password: form.password, role: form.role, image_url: form.image_url 
          }),
        })
      }
      onSave(result)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-[#1e1c30] rounded-3xl border border-white/10 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h3 className="text-white font-bold text-base">{isEdit ? '사용자 편집' : '새 사용자 추가'}</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-lg text-white/30 hover:text-white hover:bg-white/10 flex items-center justify-center transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 flex flex-col gap-4">
          {error && <div className="px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">{error}</div>}

          {/* Image Upload / Preview */}
          <div className="flex items-center gap-4 py-2 border-b border-white/5 mb-2">
            <Avatar name={form.name} imageUrl={form.image_url} size={16} />
            <div className="flex-1">
              <label className="text-white/50 text-xs font-medium block mb-1">사용자 이미지 (100x100 권장)</label>
              <input
                type="text"
                value={form.image_url}
                onChange={e => set('image_url', e.target.value)}
                placeholder="이미지 URL"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-white text-xs placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
              />
            </div>
          </div>

          {!isEdit && (
            <FormField label="아이디" value={form.username} onChange={v => set('username', v)} placeholder="username" required />
          )}
          <FormField label="이름" value={form.name} onChange={v => set('name', v)} placeholder="홍길동" required />
          <FormField label="이메일" type="email" value={form.email} onChange={v => set('email', v)} placeholder="user@example.com" required />
          {/* 비밀번호 */}
          <FormField
            label={isEdit ? '비밀번호 변경 (선택)' : '비밀번호'}
            type="password"
            value={form.password}
            onChange={v => set('password', v)}
            placeholder={isEdit ? '변경 시에만 입력' : '6자 이상'}
            required={!isEdit}
          />

          {/* 비밀번호 재확인 — 신규: 항상 표시, 편집: 비밀번호 입력 시 표시 */}
          {(!isEdit || form.password.length > 0) && (
            <div>
              <label className="block text-white/50 text-xs font-medium mb-1.5">
                비밀번호 재확인
              </label>
              <div className="relative">
                <input
                  type="password"
                  value={form.confirmPassword}
                  onChange={e => set('confirmPassword', e.target.value)}
                  placeholder="비밀번호를 다시 입력하세요"
                  required={!isEdit}
                  className={`w-full bg-white/5 border rounded-xl px-4 py-2.5 text-white text-sm placeholder-white/20 focus:outline-none focus:ring-2 transition-all pr-10 ${pwEntered
                    ? pwMatch
                      ? 'border-green-500/50 focus:ring-green-500/30 focus:border-green-500/50'
                      : 'border-red-500/50 focus:ring-red-500/30 focus:border-red-500/50'
                    : 'border-white/10 focus:ring-indigo-500/40 focus:border-indigo-500/40'
                    }`}
                />
                {/* 일치 여부 아이콘 */}
                {pwEntered && (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2">
                    {pwMatch ? (
                      <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    )}
                  </span>
                )}
              </div>
              {pwEntered && !pwMatch && (
                <p className="text-red-400 text-xs mt-1.5 ml-1">비밀번호가 일치하지 않습니다.</p>
              )}
              {pwEntered && pwMatch && form.password.length > 0 && (
                <p className="text-green-400 text-xs mt-1.5 ml-1">비밀번호가 일치합니다.</p>
              )}
            </div>
          )}

          {/* Role */}
          <div>
            <label className="block text-white/50 text-xs font-medium mb-1.5">권한</label>
            <select
              value={form.role}
              onChange={e => set('role', e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-all"
            >
              {ROLE_OPTIONS.map(r => (
                <option key={r.value} value={r.value} className="bg-[#1e1c30]">{r.label}</option>
              ))}
            </select>
          </div>

          {/* Active toggle (edit only) */}
          {isEdit && (
            <div className="flex items-center justify-between py-2 px-4 rounded-xl bg-white/4 border border-white/8">
              <span className="text-white/70 text-sm">계정 활성화</span>
              <button
                type="button"
                onClick={() => set('is_active', !form.is_active)}
                className={`w-10 h-5 rounded-full transition-colors relative ${form.is_active ? 'bg-indigo-500' : 'bg-white/20'}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${form.is_active ? 'left-5' : 'left-0.5'}`} />
              </button>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-xl text-white/50 hover:text-white/80 text-sm border border-white/10 hover:bg-white/5 transition-colors">
              취소
            </button>
            <button type="submit" disabled={saving} className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-semibold transition-colors">
              {saving ? '저장 중...' : (isEdit ? '저장' : '추가')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function FormField({ label, type = 'text', value, onChange, placeholder, required }) {
  return (
    <div>
      <label className="block text-white/50 text-xs font-medium mb-1.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-all"
      />
    </div>
  )
}

// ─── Main SiteAdminPage ───────────────────────────────────────

export default function SiteAdminPage({ onClose }) {
  const { currentUser } = useAuth()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editUser, setEditUser] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [activeTab, setActiveTab] = useState('users') // 'users', 'db', or 'display'
  const [dbStats, setDbStats] = useState(null)
  const [dbLoading, setDbLoading] = useState(false)
  const [displayForm, setDisplayForm] = useState({ width: 512, height: 512 })
  const [savingConfig, setSavingConfig] = useState(false)

  async function loadUsers() {
    setLoading(true)
    try {
      const data = await apiFetch('/users')
      setUsers(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function loadDbStats() {
    setDbLoading(true)
    try {
      const data = await apiFetch('/admin/stats')
      setDbStats(data)
      if (data.display) {
        setDisplayForm({ 
          width: data.display.width || 512, 
          height: data.display.height || 512 
        })
      }
    } catch (err) {
      console.error('Failed to load DB stats:', err)
    } finally {
      setDbLoading(false)
    }
  }

  useEffect(() => { loadUsers() }, [])
  useEffect(() => { 
    if (activeTab === 'db' || activeTab === 'display') loadDbStats() 
  }, [activeTab])

  function handleSave(saved) {
    setUsers(prev => {
      const exists = prev.find(u => u.id === saved.id)
      return exists ? prev.map(u => u.id === saved.id ? saved : u) : [saved, ...prev]
    })
    setShowForm(false)
    setEditUser(null)
  }

  async function handleDelete(user) {
    if (user.id === currentUser.id) return
    if (!window.confirm(`'${user.name}' 계정을 삭제하시겠습니까?`)) return
    try {
      await apiFetch(`/users/${user.id}`, { method: 'DELETE' })
      setUsers(prev => prev.filter(u => u.id !== user.id))
    } catch (err) {
      alert(err.message)
    }
  }

  async function handleSaveConfig() {
    setSavingConfig(true)
    try {
      const result = await apiFetch('/admin/config', {
        method: 'PUT',
        body: JSON.stringify({ 
          imagePreview: { 
            width: parseInt(displayForm.width), 
            height: parseInt(displayForm.height) 
          } 
        })
      })
      if (result.success) {
        alert('설정이 저장되었습니다.')
        loadDbStats() // Refresh
      }
    } catch (err) {
      alert('저장 실패: ' + err.message)
    } finally {
      setSavingConfig(false)
    }
  }

  const filtered = users.filter(u => {
    const matchSearch = !search || u.name.includes(search) || u.email.includes(search) || u.username.includes(search)
    const matchRole = roleFilter === 'all' || u.role === roleFilter
    return matchSearch && matchRole
  })

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0f0e1a]/95 backdrop-blur-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 bg-[#1a1d2e] border-b border-white/10 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold">
            ED
          </div>
          <div>
            <h1 className="text-white font-bold text-base">사이트 관리</h1>
            <p className="text-white/30 text-xs">
              {activeTab === 'users' ? '전체 사용자 관리' : '시스템 및 데이터베이스 관리'}
            </p>
          </div>
        </div>

        <button
          onClick={onClose}
          className="flex items-center gap-2 px-3 py-2 rounded-xl text-white/50 hover:text-white hover:bg-white/8 text-sm transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
          닫기
        </button>
      </div>

      <div className="flex-1 flex min-h-0 bg-[#0f0e1a] relative">
        {/* Left Side: Button Plane (Sidebar) */}
        <div className="w-64 border-r border-white/5 bg-[#141324] px-4 py-6 flex flex-col gap-2 flex-shrink-0">
          <button
            onClick={() => setActiveTab('users')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${activeTab === 'users' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'text-white/30 hover:text-white/60 hover:bg-white/5'}`}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 01-12 0v-1z" />
            </svg>
            전체 사용자 관리
          </button>
          <button
            onClick={() => setActiveTab('db')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${activeTab === 'db' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'text-white/30 hover:text-white/60 hover:bg-white/5'}`}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
            </svg>
            DB 관리
          </button>
          <button
            onClick={() => setActiveTab('display')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${activeTab === 'display' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'text-white/30 hover:text-white/60 hover:bg-white/5'}`}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            Display 설정
          </button>
        </div>

        {/* Center: Main Content area */}
        <div className="flex-1 overflow-auto px-8 py-6">
        {activeTab === 'users' ? (
          <>
            {/* Stats bar */}
            <div className="grid grid-cols-4 gap-3 mb-5">
              {[
                { label: '전체 사용자', value: users.length, color: 'text-white' },
                { label: '사이트 관리자', value: users.filter(u => u.role === 'site_admin').length, color: 'text-red-400' },
                { label: '팀 관리자', value: users.filter(u => u.role === 'team_admin').length, color: 'text-orange-400' },
                { label: '활성 계정', value: users.filter(u => u.is_active).length, color: 'text-green-400' },
              ].map(s => (
                <div key={s.label} className="bg-white/4 border border-white/8 rounded-2xl px-4 py-3">
                  <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
                  <p className="text-white/40 text-xs mt-0.5">{s.label}</p>
                </div>
              ))}
            </div>

            {/* Toolbar */}
            <div className="flex items-center gap-3 mb-4">
              <div className="flex-1 relative">
                <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="이름, 이메일, 아이디 검색..."
                  className="w-full bg-white/5 border border-white/10 rounded-xl pl-9 pr-4 py-2.5 text-white text-sm placeholder-white/20 focus:outline-none focus:border-indigo-500/40 focus:ring-1 focus:ring-indigo-500/40"
                />
              </div>

              <select
                value={roleFilter}
                onChange={e => setRoleFilter(e.target.value)}
                className="bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-indigo-500/40"
              >
                <option value="all" className="bg-[#1e1c30]">전체 권한</option>
                {ROLE_OPTIONS.map(r => (
                  <option key={r.value} value={r.value} className="bg-[#1e1c30]">{r.label}</option>
                ))}
              </select>

              <button
                onClick={() => { setEditUser(null); setShowForm(true) }}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-colors shadow-lg shadow-indigo-500/20 flex-shrink-0"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                사용자 추가
              </button>
            </div>

            {/* Error */}
            {error && (
              <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">{error}</div>
            )}

            {/* User table */}
            <div className="bg-white/3 border border-white/8 rounded-2xl overflow-hidden">
              <div className="grid grid-cols-[auto_1fr_1fr_auto_auto_auto] gap-4 px-5 py-3 border-b border-white/8 text-white/30 text-xs font-semibold uppercase tracking-wider">
                <span>사용자</span><span></span>
                <span>이메일</span>
                <span>권한</span>
                <span>마지막 로그인</span>
                <span>상태</span>
                <span></span>
              </div>

              {loading ? (
                <div className="flex items-center justify-center py-16 text-white/30 text-sm">
                  <div className="w-5 h-5 border-2 border-white/20 border-t-indigo-500 rounded-full animate-spin mr-2" />
                  불러오는 중...
                </div>
              ) : filtered.length === 0 ? (
                <div className="text-center py-16 text-white/30 text-sm">검색 결과가 없습니다.</div>
              ) : (
                <div className="divide-y divide-white/5">
                  {filtered.map(user => (
                    <div
                      key={user.id}
                      className={`flex items-center gap-4 px-5 py-3.5 hover:bg-white/3 transition-colors ${!user.is_active ? 'opacity-50' : ''}`}
                    >
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <Avatar name={user.name} imageUrl={user.image_url} size={9} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-white text-sm font-medium truncate">{user.name}</p>
                            {user.id === currentUser.id && (
                              <span className="px-1.5 py-0.5 rounded text-xs bg-indigo-500/20 text-indigo-300 border border-indigo-500/20 flex-shrink-0">나</span>
                            )}
                          </div>
                          <p className="text-white/35 text-xs">@{user.username}</p>
                        </div>
                      </div>

                      <p className="text-white/50 text-sm flex-1 min-w-0 truncate">{user.email}</p>
                      <div className="flex-shrink-0"><RoleBadge role={user.role} /></div>
                      <p className="text-white/30 text-xs flex-shrink-0 w-32 text-right">{formatDate(user.last_login_at)}</p>
                      <div className="flex-shrink-0">
                        <span className={`flex items-center gap-1 text-xs ${user.is_active ? 'text-green-400' : 'text-white/25'}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${user.is_active ? 'bg-green-400' : 'bg-white/20'}`} />
                          {user.is_active ? '활성' : '비활성'}
                        </span>
                      </div>

                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          onClick={() => { setEditUser(user); setShowForm(true) }}
                          className="p-1.5 rounded-lg text-white/30 hover:text-white/70 hover:bg-white/8 transition-colors"
                          title="편집"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        {user.id !== currentUser.id && (
                          <button
                            onClick={() => handleDelete(user)}
                            className="p-1.5 rounded-lg text-red-400/40 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                            title="삭제"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <p className="text-white/20 text-xs mt-3 text-right">
              총 {filtered.length}명 표시 (전체 {users.length}명)
            </p>
          </>
        ) : activeTab === 'db' ? (
          <div className="max-w-4xl mx-auto py-4">
            <h2 className="text-white font-bold text-lg mb-6 flex items-center gap-2">
              <svg className="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              데이터베이스 및 오브젝트 관리
            </h2>

            {dbLoading ? (
              <div className="flex flex-col items-center justify-center py-24 text-white/30">
                <div className="w-8 h-8 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin mb-4" />
                <p className="text-sm">서버에서 정보를 불러오는 중...</p>
              </div>
            ) : dbStats ? (
              <div className="space-y-6">
                {/* Postgres Stats */}
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6 shadow-xl">
                  <div className="flex items-start justify-between mb-6">
                    <div>
                      <h3 className="text-white font-bold text-base mb-1">PostgreSQL Database</h3>
                      <p className="text-white/40 text-xs">현재 작동 중인 데이터베이스 정보입니다.</p>
                    </div>
                    <div className="px-3 py-1 rounded-full bg-green-500/10 border border-green-500/20 text-green-400 text-[10px] font-bold uppercase tracking-wider">
                      Online
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-8">
                    <div className="space-y-4">
                      <div>
                        <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-1.5">DB 위치 (Data Directory)</p>
                        <div className="bg-black/30 rounded-xl px-4 py-3 border border-white/5 font-mono text-xs text-indigo-300 break-all leading-relaxed">
                          {dbStats.db.location}
                        </div>
                      </div>
                    </div>
                    <div className="space-y-10 flex flex-col justify-center">
                      <div className="text-center p-6 bg-white/3 rounded-3xl border border-white/5 relative overflow-hidden group">
                        <div className="absolute inset-0 bg-indigo-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                        <p className="text-white/40 text-xs font-semibold uppercase tracking-wider mb-2">현재 DB 할당 크기</p>
                        <p className="text-4xl font-black text-white tracking-tight">{dbStats.db.size}</p>
                        <div className="w-12 h-1 bg-indigo-500 mx-auto mt-4 rounded-full" />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Cassandra Stats */}
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6 shadow-xl">
                  <div className="flex items-start justify-between mb-6">
                    <div>
                      <h3 className="text-white font-bold text-base mb-1">Cassandra Database (Posts)</h3>
                      <p className="text-white/40 text-xs">게시글 및 메시지 저장을 위한 분산 데이터베이스 정보입니다.</p>
                    </div>
                    <div className="px-3 py-1 rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-400 text-[10px] font-bold uppercase tracking-wider">
                      Distributed Storage
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-8">
                    <div className="space-y-4">
                      <div>
                        <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-1.5">DB 위치 (Data Directory)</p>
                        <div className="bg-black/30 rounded-xl px-4 py-3 border border-white/5 font-mono text-xs text-indigo-300 break-all leading-relaxed">
                          {dbStats.cassandra?.location}
                        </div>
                      </div>
                    </div>
                    <div className="space-y-10 flex flex-col justify-center">
                      <div className="text-center p-6 bg-white/3 rounded-3xl border border-white/5 relative overflow-hidden group">
                        <div className="absolute inset-0 bg-purple-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                        <p className="text-white/40 text-xs font-semibold uppercase tracking-wider mb-2">현재 데이터 크기</p>
                        <p className="text-4xl font-black text-white tracking-tight">{dbStats.cassandra?.size}</p>
                        <div className="w-12 h-1 bg-purple-500 mx-auto mt-4 rounded-full" />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Object Files Stats */}
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6 shadow-xl">
                  <div className="flex items-start justify-between mb-6">
                    <div>
                      <h3 className="text-white font-bold text-base mb-1">Object File Storage</h3>
                      <p className="text-white/40 text-xs">첨부파일 및 미디어 오브젝트 저장소 정보입니다.</p>
                    </div>
                    <div className="px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-[10px] font-bold uppercase tracking-wider">
                      Stored Locally
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-8">
                    <div className="space-y-4">
                      <div>
                        <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-1.5">폴더 위치 (Upload Directory)</p>
                        <div className="bg-black/30 rounded-xl px-4 py-3 border border-white/5 font-mono text-xs text-indigo-300 break-all leading-relaxed">
                          {dbStats.objects.location}
                        </div>
                      </div>
                    </div>
                    <div className="space-y-10 flex flex-col justify-center">
                      <div className="text-center p-6 bg-white/3 rounded-3xl border border-white/5 relative overflow-hidden group">
                        <div className="absolute inset-0 bg-indigo-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                        <p className="text-white/40 text-xs font-semibold uppercase tracking-wider mb-2">전체 오브젝트 크기</p>
                        <p className="text-4xl font-black text-indigo-400 tracking-tight">{dbStats.objects.size}</p>
                        <div className="w-12 h-1 bg-indigo-500/40 mx-auto mt-4 rounded-full" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-24 text-white/20">
                정보를 가져올 수 없습니다.
              </div>
            )}
          </div>
        ) : (
          <div className="max-w-4xl mx-auto py-4">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-white font-bold text-lg flex items-center gap-2">
                <svg className="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                전역 디스플레이 설정
              </h2>
              <button
                onClick={handleSaveConfig}
                disabled={savingConfig}
                className="flex items-center gap-2 px-6 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold transition-all shadow-lg shadow-indigo-500/25 active:scale-95"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                </svg>
                {savingConfig ? '저장 중...' : '저장'}
              </button>
            </div>

            {dbLoading ? (
              <div className="flex flex-col items-center justify-center py-24 text-white/30">
                <div className="w-8 h-8 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin mb-4" />
                <p className="text-sm">설정을 불러오는 중...</p>
              </div>
            ) : dbStats?.display ? (
              <div className="bg-white/5 border border-white/10 rounded-2xl p-8 shadow-xl">
                <div className="flex items-start justify-between mb-8">
                  <div>
                    <h3 className="text-white font-bold text-base mb-1">Image Preview 설정</h3>
                    <p className="text-white/40 text-xs text-secondary leading-relaxed">
                      게시판 및 채팅 영역에서 이미지가 표시될 때 적용되는 기본 규격입니다.<br/>
                      현재 config.json 파일에 정의된 값을 수정하고 상단의 버튼으로 저장하세요.
                    </p>
                  </div>
                  <div className="px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[10px] font-bold uppercase tracking-wider">
                    Global Config
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-12">
                  <div className="flex flex-col justify-center">
                    <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-5">Preview Dimensions</p>
                    <div className="space-y-4">
                      <div className="bg-black/40 rounded-2xl p-5 border border-white/10 flex items-center justify-between focus-within:border-indigo-500/50 transition-colors">
                        <div>
                          <p className="text-white/40 text-[10px] uppercase font-bold mb-1">Width (가로)</p>
                          <div className="flex items-center gap-2">
                            <input
                              type="number"
                              value={displayForm.width}
                              onChange={e => setDisplayForm(p => ({ ...p, width: e.target.value }))}
                              className="bg-transparent text-3xl font-black text-white w-24 focus:outline-none"
                            />
                            <span className="text-sm font-normal text-white/20">px</span>
                          </div>
                        </div>
                        <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center">
                          <svg className="w-5 h-5 text-white/20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h8m0 0l-4-4m4 4l-4 4" />
                          </svg>
                        </div>
                      </div>
                      <div className="bg-black/40 rounded-2xl p-5 border border-white/10 flex items-center justify-between focus-within:border-indigo-500/50 transition-colors">
                        <div>
                          <p className="text-white/40 text-[10px] uppercase font-bold mb-1">Height (세로)</p>
                          <div className="flex items-center gap-2">
                            <input
                              type="number"
                              value={displayForm.height}
                              onChange={e => setDisplayForm(p => ({ ...p, height: e.target.value }))}
                              className="bg-transparent text-3xl font-black text-white w-24 focus:outline-none"
                            />
                            <span className="text-sm font-normal text-white/20">px</span>
                          </div>
                        </div>
                        <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center shadow-inner">
                          <svg className="w-5 h-5 text-white/20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8v8m0 0l-4-4m4 4l4-4" />
                          </svg>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col items-center justify-center">
                    <div className="relative w-48 h-48 rounded-3xl border-2 border-dashed border-white/10 flex items-center justify-center group overflow-hidden bg-white/[0.02]">
                      <div className="absolute inset-4 bg-indigo-500/10 rounded-2xl flex items-center justify-center text-[10px] text-indigo-400 font-bold uppercase tracking-widest text-center px-4">
                        Real-time Aspect Review
                      </div>
                      <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                    <p className="mt-4 text-white/20 text-xs italic">변경 후 상단의 저장 버튼을 눌러야 실제 시스템에 적용됩니다.</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-24 text-white/20">
                인터페이스 설정 정보를 불러올 수 없습니다.
              </div>
            )}
          </div>
        )}
        </div>

        {/* Right Side: GROQ Panel */}
        <div className="h-full border-l border-white/5">
          <GroqPanel />
        </div>
      </div>

      {/* User form modal */}
      {showForm && (
        <UserFormModal
          user={editUser}
          onClose={() => { setShowForm(false); setEditUser(null) }}
          onSave={handleSave}
        />
      )}
    </div>
  )
}
