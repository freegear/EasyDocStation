import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'
import { ROLE_LABELS, ROLE_BADGE, ROLE_OPTIONS } from '../constants/roles'
import { useAuth } from '../contexts/AuthContext'

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

function Avatar({ name, size = 8 }) {
  const letters = name?.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) ?? '?'
  return (
    <div className={`w-${size} h-${size} rounded-full bg-indigo-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}>
      {letters}
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
        const body = { name: form.name, email: form.email, role: form.role, is_active: form.is_active }
        if (form.password) body.password = form.password
        result = await apiFetch(`/users/${user.id}`, { method: 'PUT', body: JSON.stringify(body) })
      } else {
        result = await apiFetch('/users', {
          method: 'POST',
          body: JSON.stringify({ username: form.username, name: form.name, email: form.email, password: form.password, role: form.role }),
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
                  className={`w-full bg-white/5 border rounded-xl px-4 py-2.5 text-white text-sm placeholder-white/20 focus:outline-none focus:ring-2 transition-all pr-10 ${
                    pwEntered
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
  const [editUser, setEditUser] = useState(null)    // user being edited or null for new
  const [showForm, setShowForm] = useState(false)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')

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

  useEffect(() => { loadUsers() }, [])

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
            <p className="text-white/30 text-xs">전체 사용자 관리</p>
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

      <div className="flex-1 overflow-auto px-6 py-5">
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
          {/* Table header */}
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
                  {/* Avatar + name */}
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="w-9 h-9 rounded-full bg-indigo-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                      {user.avatar}
                    </div>
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

                  {/* Email */}
                  <p className="text-white/50 text-sm flex-1 min-w-0 truncate">{user.email}</p>

                  {/* Role */}
                  <div className="flex-shrink-0"><RoleBadge role={user.role} /></div>

                  {/* Last login */}
                  <p className="text-white/30 text-xs flex-shrink-0 w-32 text-right">{formatDate(user.last_login_at)}</p>

                  {/* Status */}
                  <div className="flex-shrink-0">
                    <span className={`flex items-center gap-1 text-xs ${user.is_active ? 'text-green-400' : 'text-white/25'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${user.is_active ? 'bg-green-400' : 'bg-white/20'}`} />
                      {user.is_active ? '활성' : '비활성'}
                    </span>
                  </div>

                  {/* Actions */}
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
