import { useState, useEffect, useRef } from 'react'
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

const SECURITY_LEVEL_OPTIONS = [
  { value: 0, label: '0 — 누구나' },
  { value: 1, label: '1 — 팀원' },
  { value: 2, label: '2 — 팀장' },
  { value: 3, label: '3 — 임원' },
  { value: 4, label: '4 — 대표이사' },
]

function UserFormModal({ user, onClose, onSave, teams = [] }) {
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
    department_id: user?.department_id ?? '',
    security_level: user?.security_level ?? 0,
    display_name: user?.display_name ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef(null)

  function handleAvatarClick() {
    fileInputRef.current?.click()
  }

  function handleImageFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => set('image_url', ev.target.result)
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  function set(key, val) { setForm(p => ({ ...p, [key]: val })) }

  const pwEntered = form.password.length > 0 || form.confirmPassword.length > 0
  const pwMatch = form.password === form.confirmPassword

  // security_level이 3 이상이면 department_id 의미 없음
  const deptDisabled = form.security_level >= 3

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

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
        const body = {
          name: form.name, email: form.email, role: form.role,
          is_active: form.is_active, image_url: form.image_url,
          display_name: form.display_name,
          department_id: deptDisabled ? null : (form.department_id || null),
          security_level: form.security_level,
        }
        if (form.password) body.password = form.password
        result = await apiFetch(`/users/${user.id}`, { method: 'PUT', body: JSON.stringify(body) })
      } else {
        result = await apiFetch('/users', {
          method: 'POST',
          body: JSON.stringify({
            username: form.username, name: form.name, email: form.email,
            password: form.password, role: form.role, image_url: form.image_url,
            department_id: deptDisabled ? null : (form.department_id || null),
            security_level: form.security_level,
            display_name: form.display_name,
            is_active: form.is_active,
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
      <div className="relative w-full max-w-md bg-[#1e1c30] rounded-3xl border border-white/10 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 flex-shrink-0">
          <h3 className="text-white font-bold text-base">{isEdit ? '사용자 편집' : '새 사용자 추가'}</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-lg text-white/30 hover:text-white hover:bg-white/10 flex items-center justify-center transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 flex flex-col gap-4 overflow-y-auto">
          {error && <div className="px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">{error}</div>}

          {/* 프로필 이미지 */}
          <div className="flex items-center gap-4 py-2 border-b border-white/5 mb-2">
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageFile} />
            <button type="button" onClick={handleAvatarClick} className="relative group flex-shrink-0 rounded-full focus:outline-none">
              <Avatar name={form.name} imageUrl={form.image_url} size={16} />
              <div className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
            </button>
            <div className="flex-1 flex flex-col gap-2">
              {isEdit && (
                <>
                  <div>
                    <label className="text-white/40 text-xs font-medium block mb-0.5">User ID</label>
                    <div className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-white/50 text-xs font-mono">{user.id}</div>
                  </div>
                  <div>
                    <label className="text-white/40 text-xs font-medium block mb-0.5">User Name</label>
                    <div className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-white/50 text-xs font-mono">{user.username}</div>
                  </div>
                </>
              )}
              {!isEdit && (
                <p className="text-white/30 text-xs">클릭하여 프로필 이미지 선택</p>
              )}
            </div>
          </div>

          {/* 아이디 (신규만) */}
          {!isEdit && (
            <FormField label="아이디 (고유값, 자동 사용)" value={form.username} onChange={v => set('username', v)} placeholder="username" required />
          )}

          {/* 표시 이름 */}
          <FormField label="사용자 이름 (Full Name)" value={form.name} onChange={v => set('name', v)} placeholder="홍길동" required />

          {/* 디스플레이 이름 */}
          <FormField label="표시 이름 (Display Name)" value={form.display_name} onChange={v => set('display_name', v)} placeholder="길동님" required />

          {/* 이메일 */}
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

          {/* 비밀번호 재확인 */}
          {(!isEdit || form.password.length > 0) && (
            <div>
              <label className="block text-white/50 text-xs font-medium mb-1.5">비밀번호 재확인</label>
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
              {pwEntered && !pwMatch && <p className="text-red-400 text-xs mt-1.5 ml-1">비밀번호가 일치하지 않습니다.</p>}
              {pwEntered && pwMatch && form.password.length > 0 && <p className="text-green-400 text-xs mt-1.5 ml-1">비밀번호가 일치합니다.</p>}
            </div>
          )}

          {/* 보안 등급 */}
          <div>
            <label className="block text-white/50 text-xs font-medium mb-1.5">보안 등급 (Security Level)</label>
            <select
              value={form.security_level}
              onChange={e => set('security_level', parseInt(e.target.value))}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-all"
            >
              {SECURITY_LEVEL_OPTIONS.map(o => (
                <option key={o.value} value={o.value} className="bg-[#1e1c30]">{o.label}</option>
              ))}
            </select>
            {form.security_level >= 3 && (
              <p className="text-yellow-400/70 text-xs mt-1.5 ml-1">보안 등급 3 이상은 부서 배정이 적용되지 않습니다.</p>
            )}
          </div>

          {/* 부서 (Security Level < 3 일 때만 활성) */}
          <div>
            <label className={`block text-xs font-medium mb-1.5 ${deptDisabled ? 'text-white/20' : 'text-white/50'}`}>
              부서 (Department ID)
            </label>
            <select
              value={form.department_id}
              onChange={e => set('department_id', e.target.value)}
              disabled={deptDisabled}
              className={`w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-all ${deptDisabled ? 'text-white/20 cursor-not-allowed' : 'text-white'}`}
            >
              <option value="" className="bg-[#1e1c30]">— 부서 없음 —</option>
              {teams.map(t => (
                <option key={t.id} value={t.id} className="bg-[#1e1c30]">{t.name}</option>
              ))}
            </select>
          </div>


          {/* 계정 활성화 */}
          <div className="flex items-center justify-between py-2 px-4 rounded-xl bg-white/4 border border-white/8">
            <span className="text-white/70 text-sm">계정 활성화 (Is Active)</span>
            <button
              type="button"
              onClick={() => set('is_active', !form.is_active)}
              className={`w-10 h-5 rounded-full transition-colors relative ${form.is_active ? 'bg-indigo-500' : 'bg-white/20'}`}
            >
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${form.is_active ? 'left-5' : 'left-0.5'}`} />
            </button>
          </div>

          <div className="flex gap-2 pt-1 pb-1">
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
  const [displayForm, setDisplayForm] = useState({
    imagePreview: { width: 512, height: 512 },
    pptPreview: { width: 480, height: 270 },
    pptxPreview: { width: 480, height: 270 },
    excelPreview: { width: 480, height: 270 },
    wordPreview: { width: 270, height: 480 },
    moviePreview: { width: 480, height: 270 },
    htmlPreview: { width: 480, height: 270 }
  })
  const [lancedbPath, setLancedbPath] = useState('/Users/kevinim/Desktop/EasyDocStation/Database/LanceDB')
  const [ragForm, setRagForm] = useState({ type: 'manual', time: '02:00', vectorSize: 1024, chunkSize: 800, chunkOverlap: 100 })
  const [agenticaiForm, setAgenticaiForm] = useState({ num_predict: 4096, num_ctx: 8192 })
  const [savingConfig, setSavingConfig] = useState(false)
  const [trainingStatus, setTrainingStatus] = useState(null) // 'running', 'done', null
  const [resetConfirmation, setResetConfirmation] = useState('')
  const [executingReset, setExecutingReset] = useState(false)
  const [teams, setTeams] = useState([])

  async function loadTeams() {
    try {
      const data = await apiFetch('/teams')
      setTeams(data)
    } catch (e) {
      console.error('팀 목록 로드 실패:', e)
    }
  }

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
          imagePreview: data.display.imagePreview || { width: 512, height: 512 },
          pptPreview: data.display.pptPreview || { width: 480, height: 270 },
          pptxPreview: data.display.pptxPreview || { width: 480, height: 270 },
          excelPreview: data.display.excelPreview || { width: 480, height: 270 },
          wordPreview: data.display.wordPreview || { width: 270, height: 480 },
          moviePreview: data.display.moviePreview || { width: 480, height: 270 },
          htmlPreview: data.display.htmlPreview || { width: 480, height: 270 }
        })
      }
      if (data.lancedb?.location) {
        setLancedbPath(data.lancedb.location)
      }
      if (data.rag) {
        setRagForm(p => ({
          ...p,
          type: data.rag.trainingType || p.type,
          time: data.rag.dailyTime || p.time,
          vectorSize: data.rag.vectorSize || p.vectorSize,
          chunkSize: data.rag.chunk_size ?? p.chunkSize,
          chunkOverlap: data.rag.chunk_overlap ?? p.chunkOverlap
        }))
      }
      if (data.agenticai) {
        setAgenticaiForm({
          num_predict: data.agenticai.num_predict || 4096,
          num_ctx: data.agenticai.num_ctx || 8192
        })
      }
    } catch (err) {
      console.error('Failed to load DB stats:', err)
    } finally {
      setDbLoading(false)
    }
  }

  useEffect(() => { loadUsers(); loadTeams() }, [])
  useEffect(() => { 
    if (activeTab === 'db' || activeTab === 'display' || activeTab === 'rag' || activeTab === 'agenticai') loadDbStats() 
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
      const configData = {}

      if (activeTab === 'display') {
        configData.imagePreview = {
          width: parseInt(displayForm.imagePreview.width),
          height: parseInt(displayForm.imagePreview.height)
        }
        configData.pptPreview = {
          width: parseInt(displayForm.pptPreview.width),
          height: parseInt(displayForm.pptPreview.height)
        }
        configData.pptxPreview = {
          width: parseInt(displayForm.pptxPreview.width),
          height: parseInt(displayForm.pptxPreview.height)
        }
        configData.excelPreview = {
          width: parseInt(displayForm.excelPreview.width),
          height: parseInt(displayForm.excelPreview.height)
        }
        configData.wordPreview = {
          width: parseInt(displayForm.wordPreview.width),
          height: parseInt(displayForm.wordPreview.height)
        }
        configData.moviePreview = {
          width: parseInt(displayForm.moviePreview.width),
          height: parseInt(displayForm.moviePreview.height)
        }
        configData.htmlPreview = {
          width: parseInt(displayForm.htmlPreview.width),
          height: parseInt(displayForm.htmlPreview.height)
        }
      } else if (activeTab === 'db') {
        configData['lancedb Database Path'] = lancedbPath
      } else if (activeTab === 'rag') {
        configData.rag = {
          trainingType: ragForm.type,
          dailyTime: ragForm.time,
          vectorSize: parseInt(ragForm.vectorSize),
          chunk_size: parseInt(ragForm.chunkSize),
          chunk_overlap: parseInt(ragForm.chunkOverlap)
        }
      } else if (activeTab === 'agenticai') {
        configData.agenticai = {
          num_predict: parseInt(agenticaiForm.num_predict),
          num_ctx: parseInt(agenticaiForm.num_ctx)
        }
      }

      const result = await apiFetch('/admin/config', {
        method: 'PUT',
        body: JSON.stringify(configData)
      })
      if (result.success) {
        if (activeTab === 'rag') {
          // vector size 변경 시 LanceDB 테이블 재초기화
          try {
            const reinit = await apiFetch('/admin/rag/reinit-lancedb', { method: 'POST' })
            alert(`설정이 저장되었습니다.\n${reinit.message || 'LanceDB 재초기화 완료'}`)
          } catch (reinitErr) {
            alert(`설정은 저장되었으나 LanceDB 재초기화 실패:\n${reinitErr.message}`)
          }
        } else {
          alert('설정이 저장되었습니다.')
        }
        loadDbStats()
      }
    } catch (err) {
      alert('저장 실패: ' + err.message)
    } finally {
      setSavingConfig(false)
    }
  }

  async function handleStartTraining() {
    if (!window.confirm('지금 RAG 학습을 시작하시겠습니까? 데이터양에 따라 시간이 소요될 수 있습니다.')) return
    setTrainingStatus('running')
    try {
      // 실제 API 호출 시뮬레이션 또는 연동
      await apiFetch('/admin/rag/train', { method: 'POST' })
      alert('RAG 학습이 시작되었습니다.')
    } catch (err) {
      alert('학습 시작 실패: ' + err.message)
    } finally {
      setTrainingStatus(null)
    }
  }

  async function handleExecuteReset() {
    if (resetConfirmation !== '초기화를 해줘') return
    setExecutingReset(true)
    try {
      const res = await apiFetch('/admin/reset', {
        method: 'POST',
        body: JSON.stringify({ confirmation: resetConfirmation })
      })
      alert(res.message)
      // Force logout by clearing token and reloading
      localStorage.removeItem('token')
      window.location.reload()
    } catch (err) {
      alert('초기화 실패: ' + err.message)
    } finally {
      setExecutingReset(false)
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
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 hover:bg-red-500/20 text-white/70 hover:text-red-400 border border-white/10 hover:border-red-500/30 text-sm font-medium transition-all active:scale-95"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
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
          <button
            onClick={() => setActiveTab('rag')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${activeTab === 'rag' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'text-white/30 hover:text-white/60 hover:bg-white/5'}`}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
            </svg>
            RAG 학습 설정
          </button>
          <button
            onClick={() => setActiveTab('agenticai')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${activeTab === 'agenticai' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'text-white/30 hover:text-white/60 hover:bg-white/5'}`}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            AgenticAI 설정
          </button>
          <button
            onClick={() => setActiveTab('reset')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${activeTab === 'reset' ? 'bg-red-600 text-white shadow-lg shadow-red-500/20' : 'text-white/30 hover:text-white/60 hover:bg-white/5'}`}
          >
            <svg className="w-5 h-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            사이트 초기화
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
              {loading ? (
                <div className="flex items-center justify-center py-16 text-white/30 text-sm">
                  <div className="w-5 h-5 border-2 border-white/20 border-t-indigo-500 rounded-full animate-spin mr-2" />
                  불러오는 중...
                </div>
              ) : filtered.length === 0 ? (
                <div className="text-center py-16 text-white/30 text-sm">검색 결과가 없습니다.</div>
              ) : (
                <table className="w-full border-collapse">
                  <colgroup>
                    <col style={{ width: '220px' }} />
                    <col />
                    <col style={{ width: '180px' }} />
                    <col style={{ width: '128px' }} />
                    <col style={{ width: '72px' }} />
                    <col style={{ width: '72px' }} />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-white/8 text-white/30 text-xs font-semibold uppercase tracking-wider">
                      <th className="px-5 py-3 text-left font-semibold">사용자</th>
                      <th className="px-5 py-3 text-left font-semibold">이메일</th>
                      <th className="px-5 py-3 text-left font-semibold">팀</th>
                      <th className="px-5 py-3 text-left font-semibold">권한</th>
                      <th className="px-5 py-3 text-left font-semibold">마지막 로그인</th>
                      <th className="px-5 py-3 text-left font-semibold">상태</th>
                      <th className="px-5 py-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {filtered.map(user => (
                      <tr
                        key={user.id}
                        className={`hover:bg-white/3 transition-colors ${!user.is_active ? 'opacity-50' : ''}`}
                      >
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-3">
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
                        </td>
                        <td className="px-5 py-3.5 max-w-0">
                          <p className="text-white/50 text-sm truncate">{user.email}</p>
                        </td>
                        <td className="px-5 py-3.5">
                          <p className="text-white/50 text-sm truncate">
                            {user.department_id
                              ? (teams.find(t => t.id === user.department_id)?.name ?? user.department_id)
                              : <span className="text-white/20">—</span>}
                          </p>
                        </td>
                        <td className="px-5 py-3.5">
                          <RoleBadge role={user.role} />
                        </td>
                        <td className="px-5 py-3.5 text-white/30 text-xs whitespace-nowrap">
                          {formatDate(user.last_login_at)}
                        </td>
                        <td className="px-5 py-3.5">
                          <span className={`flex items-center gap-1 text-xs whitespace-nowrap ${user.is_active ? 'text-green-400' : 'text-white/25'}`}>
                            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${user.is_active ? 'bg-green-400' : 'bg-white/20'}`} />
                            {user.is_active ? '활성' : '비활성'}
                          </span>
                        </td>
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-1 justify-end">
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
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <p className="text-white/20 text-xs mt-3 text-right">
              총 {filtered.length}명 표시 (전체 {users.length}명)
            </p>
          </>
        ) : activeTab === 'db' ? (
          <div className="max-w-4xl mx-auto py-4">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-white font-bold text-lg flex items-center gap-2">
                <svg className="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
                데이터베이스 및 오브젝트 관리
              </h2>
              <button
                onClick={handleSaveConfig}
                disabled={savingConfig}
                className="flex items-center gap-2 px-6 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold transition-all shadow-lg shadow-indigo-500/25 active:scale-95"
              >
                {savingConfig ? '저장 중...' : '설정 저장'}
              </button>
            </div>

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

                {/* LanceDB Stats */}
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6 shadow-xl">
                  <div className="flex items-start justify-between mb-6">
                    <div>
                      <h3 className="text-white font-bold text-base mb-1">LanceDB (Vector Store)</h3>
                      <p className="text-white/40 text-xs">RAG 학습 데이터를 저장하는 벡터 데이터베이스 폴더입니다.</p>
                    </div>
                    <div className="px-3 py-1 rounded-full bg-teal-500/10 border border-teal-500/20 text-teal-400 text-[10px] font-bold uppercase tracking-wider">
                      Vector Store
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-8">
                    <div className="space-y-4">
                      <div>
                        <p className="text-white/30 text-xs font-semibold uppercase tracking-wider mb-1.5">폴더 위치 (LanceDB Directory)</p>
                        <input
                          type="text"
                          value={lancedbPath}
                          onChange={e => setLancedbPath(e.target.value)}
                          className="w-full bg-black/30 rounded-xl px-4 py-3 border border-white/5 font-mono text-xs text-teal-300 break-all leading-relaxed focus:outline-none focus:border-teal-500/50 transition-colors"
                        />
                        <p className="text-white/20 text-[10px] mt-1.5">경로를 수정한 후 상단의 설정 저장 버튼을 눌러 적용하세요.</p>
                      </div>
                    </div>
                    <div className="space-y-10 flex flex-col justify-center">
                      <div className="text-center p-6 bg-white/3 rounded-3xl border border-white/5 relative overflow-hidden group">
                        <div className="absolute inset-0 bg-teal-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                        <p className="text-white/40 text-xs font-semibold uppercase tracking-wider mb-2">전체 벡터 데이터 크기</p>
                        <p className="text-4xl font-black text-teal-400 tracking-tight">{dbStats.lancedb?.size ?? '—'}</p>
                        <div className="w-12 h-1 bg-teal-500/40 mx-auto mt-4 rounded-full" />
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
        ) : activeTab === 'rag' ? (
          <div className="max-w-4xl mx-auto py-4">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-white font-bold text-lg flex items-center gap-2">
                <svg className="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
                </svg>
                RAG 학습 옵션 설정
              </h2>
              <button
                onClick={handleSaveConfig}
                disabled={savingConfig}
                className="flex items-center gap-2 px-6 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold transition-all shadow-lg shadow-indigo-500/25 active:scale-95"
              >
                {savingConfig ? '저장 중...' : '설정 저장'}
              </button>
            </div>

            {/* Status Info */}
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-6 mb-6">
              <div className="flex gap-3 text-amber-400">
                <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div className="text-xs leading-relaxed">
                  <p className="font-bold mb-1">RAG(Retrieval-Augmented Generation) 안내</p>
                  학습된 데이터는 EasyDoc AgenticAI가 답변을 생성할 때 참고 자료로 사용됩니다.
                  데이터 양이 많을 경우 CPU 사용량이 일시적으로 증가할 수 있으니 서비스 사용량이 적은 시간에 학습을 예약하는 것을 권장합니다.
                </div>
              </div>
            </div>

            <div className="space-y-6">
              {/* 학습 시간 / 주기 설정 */}
              <div className="bg-white/5 border border-white/10 rounded-2xl p-8 shadow-xl">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
                    <svg className="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-white font-bold text-base">학습 시간 / 주기 설정</h3>
                    <p className="text-white/30 text-xs mt-0.5">문서 데이터를 AI가 학습하는 타이밍을 제어합니다.</p>
                  </div>
                </div>

                <div className="space-y-4">
                  {/* Option 1: Daily */}
                  <label className={`flex items-center gap-4 p-5 rounded-2xl border transition-all cursor-pointer ${ragForm.type === 'daily' ? 'bg-indigo-500/10 border-indigo-500/50' : 'bg-white/3 border-white/5 hover:border-white/10'}`}>
                    <input
                      type="radio"
                      name="ragType"
                      checked={ragForm.type === 'daily'}
                      onChange={() => setRagForm(p => ({ ...p, type: 'daily' }))}
                      className="w-4 h-4 text-indigo-600 bg-white/10 border-white/20 focus:ring-indigo-500"
                    />
                    <div className="flex-1">
                      <p className="text-white font-semibold text-sm">매일 설정한 시간에 학습</p>
                      <p className="text-white/30 text-xs mt-1">지정한 시간에 전날 올라온 모든 글을 한꺼번에 학습합니다.</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>
                      <input
                        type="time"
                        value={ragForm.time}
                        onChange={e => setRagForm(p => ({ ...p, time: e.target.value }))}
                        disabled={ragForm.type !== 'daily'}
                        className="bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed"
                      />
                      <span className="text-white/30 text-xs">에 학습 시작</span>
                    </div>
                  </label>

                  {/* Option 2: Immediate */}
                  <label className={`flex items-start gap-4 p-5 rounded-2xl border transition-all cursor-pointer ${ragForm.type === 'immediate' ? 'bg-indigo-500/10 border-indigo-500/50' : 'bg-white/3 border-white/5 hover:border-white/10'}`}>
                    <input
                      type="radio"
                      name="ragType"
                      checked={ragForm.type === 'immediate'}
                      onChange={() => setRagForm(p => ({ ...p, type: 'immediate' }))}
                      className="mt-1 w-4 h-4 text-indigo-600 bg-white/10 border-white/20 focus:ring-indigo-500"
                    />
                    <div className="flex-1">
                      <p className="text-white font-semibold text-sm">글이 올라오는 즉시 학습</p>
                      <p className="text-white/30 text-xs mt-1">새로운 게시글이 작성되면 실시간으로 벡터 디비에 반영합니다.</p>
                    </div>
                  </label>

                  {/* Option 3: Manual */}
                  <label className={`flex items-start gap-4 p-5 rounded-2xl border transition-all cursor-pointer ${ragForm.type === 'manual' ? 'bg-indigo-500/10 border-indigo-500/50' : 'bg-white/3 border-white/5 hover:border-white/10'}`}>
                    <input
                      type="radio"
                      name="ragType"
                      checked={ragForm.type === 'manual'}
                      onChange={() => setRagForm(p => ({ ...p, type: 'manual' }))}
                      className="mt-1 w-4 h-4 text-indigo-600 bg-white/10 border-white/20 focus:ring-indigo-500"
                    />
                    <div className="flex-1">
                      <p className="text-white font-semibold text-sm">수동 학습 (관리자 실행)</p>
                      <p className="text-white/30 text-xs mt-1">자동 학습을 수행하지 않으며, 관리자가 버튼을 누를 때에만 학습합니다.</p>
                      {ragForm.type === 'manual' && (
                        <div className="mt-4">
                          <button
                            onClick={handleStartTraining}
                            disabled={trainingStatus === 'running'}
                            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-green-600 hover:bg-green-500 disabled:bg-white/10 text-white text-sm font-bold transition-all shadow-lg shadow-green-600/20 active:scale-95"
                          >
                            {trainingStatus === 'running' ? (
                              <>
                                <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                학습 대기 중...
                              </>
                            ) : (
                              <>
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                지금 학습 시작
                              </>
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  </label>
                </div>
              </div>

              {/* Vector Size */}
              <div className="bg-white/5 border border-white/10 rounded-2xl p-8 shadow-xl">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-teal-500/10 border border-teal-500/20 flex items-center justify-center">
                    <svg className="w-5 h-5 text-teal-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-white font-bold text-base">Vector Size 설정</h3>
                    <p className="text-white/30 text-xs mt-0.5">임베딩 벡터의 차원 수를 설정합니다. 사용할 임베딩 모델의 출력 크기와 일치해야 합니다.</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-3">
                  {[256, 512, 1024, 1536, 2048, 4096, 8192].map(size => (
                    <button
                      key={size}
                      onClick={() => setRagForm(p => ({ ...p, vectorSize: size }))}
                      className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-all border ${
                        ragForm.vectorSize === size
                          ? 'bg-teal-500/20 border-teal-500/60 text-teal-300 shadow-lg shadow-teal-500/10'
                          : 'bg-white/3 border-white/5 text-white/30 hover:text-white/60 hover:border-white/10'
                      }`}
                    >
                      {size.toLocaleString()}
                    </button>
                  ))}
                </div>
                <p className="text-white/20 text-xs mt-4">
                  현재 선택: <span className="text-teal-400 font-bold">{ragForm.vectorSize?.toLocaleString()}</span> 차원
                </p>
              </div>

              {/* Chunk Size / Overlap */}
              <div className="bg-white/5 border border-white/10 rounded-2xl p-8 shadow-xl">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center">
                    <svg className="w-5 h-5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h8m-8 6h16" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-white font-bold text-base">청크 크기 설정</h3>
                    <p className="text-white/30 text-xs mt-0.5">문서를 분할할 때 각 청크의 크기와 인접 청크 간 중복 영역을 설정합니다.</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <p className="text-white/40 text-xs font-semibold uppercase tracking-wider mb-3">
                      한 청크당 글자 수 <span className="text-white/20 normal-case font-normal">(chunk_size)</span>
                    </p>
                    <div className="bg-black/30 rounded-xl px-4 py-3 border border-white/5 flex items-center gap-3 focus-within:border-violet-500/50 transition-colors">
                      <input
                        type="number"
                        min={100}
                        max={10000}
                        step={100}
                        value={ragForm.chunkSize}
                        onChange={e => setRagForm(p => ({ ...p, chunkSize: e.target.value }))}
                        className="bg-transparent text-2xl font-black text-white w-24 focus:outline-none"
                      />
                      <span className="text-white/20 text-sm">글자</span>
                    </div>
                  </div>
                  <div>
                    <p className="text-white/40 text-xs font-semibold uppercase tracking-wider mb-3">
                      청크 간 중복 영역 글자 수 <span className="text-white/20 normal-case font-normal">(chunk_overlap)</span>
                    </p>
                    <div className="bg-black/30 rounded-xl px-4 py-3 border border-white/5 flex items-center gap-3 focus-within:border-violet-500/50 transition-colors">
                      <input
                        type="number"
                        min={0}
                        max={ragForm.chunkSize}
                        step={10}
                        value={ragForm.chunkOverlap}
                        onChange={e => setRagForm(p => ({ ...p, chunkOverlap: e.target.value }))}
                        className="bg-transparent text-2xl font-black text-white w-24 focus:outline-none"
                      />
                      <span className="text-white/20 text-sm">글자</span>
                    </div>
                  </div>
                </div>
              </div>


            </div>
          </div>
        ) : activeTab === 'display' ? (
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
              <div className="space-y-6 pb-20">
                {/* Image Preview */}
                <PreviewSettingCard
                  title="Image Preview 설정"
                  description="게시판 및 채팅 영역에서 이미지가 표시될 때 적용되는 기본 규격입니다."
                  value={displayForm.imagePreview}
                  onChange={(val) => setDisplayForm(p => ({ ...p, imagePreview: val }))}
                />

                <div className="grid grid-cols-2 gap-6">
                  {/* PPT Preview */}
                  <PreviewSettingCard
                    title="PPT Preview 설정"
                    description="PPT 파일의 미리보기 규격입니다."
                    value={displayForm.pptPreview}
                    onChange={(val) => setDisplayForm(p => ({ ...p, pptPreview: val }))}
                  />

                  {/* PPTX Preview */}
                  <PreviewSettingCard
                    title="PPTX Preview 설정"
                    description="PPTX 파일의 미리보기 규격입니다."
                    value={displayForm.pptxPreview}
                    onChange={(val) => setDisplayForm(p => ({ ...p, pptxPreview: val }))}
                  />

                  {/* Excel Preview */}
                  <PreviewSettingCard
                    title="Excel Preview 설정"
                    description="Excel 파일의 미리보기 규격입니다."
                    value={displayForm.excelPreview}
                    onChange={(val) => setDisplayForm(p => ({ ...p, excelPreview: val }))}
                  />

                  {/* Word Preview */}
                  <PreviewSettingCard
                    title="Word Preview 설정"
                    description="Word 파일의 미리보기 규격입니다."
                    value={displayForm.wordPreview}
                    onChange={(val) => setDisplayForm(p => ({ ...p, wordPreview: val }))}
                  />

                  {/* Movie Preview */}
                  <PreviewSettingCard
                    title="Movie Preview 설정"
                    description="AVI, MOV 동영상 파일의 미리보기 규격입니다."
                    value={displayForm.moviePreview}
                    onChange={(val) => setDisplayForm(p => ({ ...p, moviePreview: val }))}
                  />

                  {/* HTML Preview */}
                  <PreviewSettingCard
                    title="HTML Preview 설정"
                    description="HTML 파일의 미리보기 규격입니다."
                    value={displayForm.htmlPreview}
                    onChange={(val) => setDisplayForm(p => ({ ...p, htmlPreview: val }))}
                  />
                </div>
              </div>
            ) : (
              <div className="text-center py-24 text-white/20">
                인터페이스 설정 정보를 불러올 수 없습니다.
              </div>
            )}
          </div>
        ) : activeTab === 'agenticai' ? (
          <div className="max-w-4xl mx-auto py-4">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-white font-bold text-lg flex items-center gap-2">
                <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                AgenticAI 지능형 비서 설정
              </h2>
              <button
                onClick={handleSaveConfig}
                disabled={savingConfig}
                className="flex items-center gap-2 px-6 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold transition-all shadow-lg shadow-indigo-500/25 active:scale-95"
              >
                {savingConfig ? '저장 중...' : '설정 저장'}
              </button>
            </div>

            <div className="space-y-8">
              {/* num_predict */}
              <div className="bg-white/5 border border-white/10 rounded-2xl p-8 shadow-xl">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-green-500/10 border border-green-500/20 flex items-center justify-center">
                    <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-white font-bold text-base">최대 답변 길이 (num_predict)</h3>
                    <p className="text-white/30 text-xs mt-0.5">매우 긴 장문의 답변도 끊기지 않고 끝까지 출력되도록 설정합니다.</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-3">
                  {[1024, 2048, 4096, 8192, 16384, 32768].map(size => (
                    <button
                      key={size}
                      onClick={() => setAgenticaiForm(p => ({ ...p, num_predict: size }))}
                      className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-all border ${
                        agenticaiForm.num_predict === size
                          ? 'bg-green-500/20 border-green-500/60 text-green-300 shadow-lg shadow-green-500/10'
                          : 'bg-white/3 border-white/5 text-white/30 hover:text-white/60 hover:border-white/10'
                      }`}
                    >
                      {size.toLocaleString()}
                    </button>
                  ))}
                </div>
              </div>

              {/* num_ctx */}
              <div className="bg-white/5 border border-white/10 rounded-2xl p-8 shadow-xl">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                    <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-white font-bold text-base">문맥 유지 범위 (num_ctx)</h3>
                    <p className="text-white/30 text-xs mt-0.5">이전 대화 내용이나 참조 문서(RAG)를 얼마나 많이 기억할지 설정합니다.</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-3">
                  {[4096, 8192, 16384, 32768, 65536].map(size => (
                    <button
                      key={size}
                      onClick={() => setAgenticaiForm(p => ({ ...p, num_ctx: size }))}
                      className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-all border ${
                        agenticaiForm.num_ctx === size
                          ? 'bg-blue-500/20 border-blue-500/60 text-blue-300 shadow-lg shadow-blue-500/10'
                          : 'bg-white/3 border-white/5 text-white/30 hover:text-white/60 hover:border-white/10'
                      }`}
                    >
                      {size.toLocaleString()}
                    </button>
                  ))}
                </div>
              </div>

              <div className="p-6 bg-white/3 border border-dashed border-white/10 rounded-2xl flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-indigo-500/10 flex items-center justify-center text-indigo-400">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div>
                  <p className="text-white text-xs font-semibold mb-0.5">설정값은 즉시 시스템에 반영됩니다.</p>
                  <p className="text-white/30 text-[10px]">너무 큰 값으로 설정하면 서버 부하가 커지거나 응답 속도가 느려질 수 있습니다.</p>
                </div>
              </div>
            </div>
          </div>
        ) : activeTab === 'reset' ? (
          <div className="max-w-2xl mx-auto py-12">
            <div className="bg-red-950/20 border border-red-500/30 rounded-3xl p-10 shadow-2xl overflow-hidden relative">
              <div className="absolute top-0 right-0 w-64 h-64 bg-red-500/5 blur-[100px] -mr-32 -mt-32" />
              
              <div className="flex flex-col items-center text-center relative z-10">
                <div className="w-20 h-20 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mb-8">
                  <svg className="w-10 h-10 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>

                <h2 className="text-3xl font-black text-white mb-4">사이트 완전 초기화</h2>
                <div className="space-y-4 px-6 mb-10 text-red-200/60 leading-relaxed font-medium">
                  <p>이 사이트 초기화를 실행하면 사이트에 등록된 모든 정보가 초기화가 됩니다.</p>
                  <p className="text-red-400 font-bold underline decoration-red-500/30 underline-offset-8 text-lg">이후에는 절대로 복구 할 수 없습니다.</p>
                </div>

                <div className="w-full bg-black/40 border border-white/5 rounded-2xl p-8 mb-8">
                  <p className="text-white/40 text-sm mb-4">계속하려면 아래 입력창에 <span className="text-white font-bold">"초기화를 해줘"</span> 라고 입력해 주세요.</p>
                  <input
                    type="text"
                    value={resetConfirmation}
                    onChange={e => setResetConfirmation(e.target.value)}
                    placeholder="초기화를 해줘"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-5 py-3.5 text-white text-lg font-bold placeholder-white/10 text-center focus:outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/50 transition-all"
                  />
                </div>

                <button
                  onClick={handleExecuteReset}
                  disabled={resetConfirmation !== '초기화를 해줘' || executingReset}
                  className={`w-full py-4 rounded-2xl font-black text-lg transition-all flex items-center justify-center gap-3 ${
                    resetConfirmation === '초기화를 해줘' && !executingReset
                      ? 'bg-red-600 hover:bg-red-500 text-white shadow-xl shadow-red-600/25 active:scale-[0.98]'
                      : 'bg-white/5 text-white/10 cursor-not-allowed border border-white/5'
                  }`}
                >
                  {executingReset ? (
                    <>
                      <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                      초기화 중...
                    </>
                  ) : (
                    <>
                      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      초기화 실행
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        ) : null}
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
          teams={teams}
        />
      )}
    </div>
  )
}

function PreviewSettingCard({ title, description, value, onChange }) {
  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-6 shadow-xl h-full flex flex-col">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h3 className="text-white font-bold text-sm mb-1">{title}</h3>
          <p className="text-white/40 text-[11px] leading-relaxed">
            {description}
          </p>
        </div>
        <div className="px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[9px] font-bold uppercase tracking-wider shrink-0">
          Preview
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mt-auto">
        <div className="bg-black/40 rounded-xl px-4 py-3 border border-white/5 flex flex-col focus-within:border-indigo-500/50 transition-colors">
          <p className="text-white/40 text-[9px] uppercase font-bold mb-1">Width (가로)</p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={value.width}
              onChange={e => onChange({ ...value, width: e.target.value })}
              className="bg-transparent text-xl font-black text-white w-full focus:outline-none"
            />
            <span className="text-sm font-normal text-white/20 shrink-0">px</span>
          </div>
        </div>
        <div className="bg-black/40 rounded-xl px-4 py-3 border border-white/5 flex flex-col focus-within:border-indigo-500/50 transition-colors">
          <p className="text-white/40 text-[9px] uppercase font-bold mb-1">Height (세로)</p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={value.height}
              onChange={e => onChange({ ...value, height: e.target.value })}
              className="bg-transparent text-xl font-black text-white w-full focus:outline-none"
            />
            <span className="text-sm font-normal text-white/20 shrink-0">px</span>
          </div>
        </div>
      </div>
    </div>
  )
}
