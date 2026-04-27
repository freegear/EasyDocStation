import { useState, useEffect, useRef } from 'react'
import { apiFetch, getToken } from '../lib/api'
import { ROLE_BADGE } from '../constants/roles'
import { useAuth } from '../contexts/AuthContext'
import { useT } from '../i18n/useT'
import GroqPanel from './GroqPanel'
import ConfirmDialog from './ConfirmDialog'

// ─── helpers ─────────────────────────────────────────────────
const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.]*$/
const LANGUAGES = [
  { code: 'ko', label: '한국어', flag: '🇰🇷' },
  { code: 'en', label: 'English', flag: '🇺🇸' },
  { code: 'ja', label: '日本語', flag: '🇯🇵' },
]

function formatDate(iso) {
  if (!iso) return '-'
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function RoleBadge({ role, label }) {
  const cls = ROLE_BADGE[role] ?? ROLE_BADGE.user
  return (
    <span className={`px-2 py-0.5 rounded-md text-xs font-medium border ${cls}`}>
      {label ?? role}
    </span>
  )
}

function Avatar({ name, imageUrl, size = 8 }) {
  const letters = name?.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) ?? '?'
  return (
    <div className={`w-${size} h-${size} rounded-full bg-indigo-500 overflow-hidden flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0 border border-gray-200`}>
      {imageUrl ? (
        <img src={imageUrl} alt={name} className="w-full h-full object-cover" />
      ) : (
        letters
      )}
    </div>
  )
}

// ─── User form modal ──────────────────────────────────────────

function UserFormModal({ user, onClose, onSave, teams = [] }) {
  const t = useT()
  const isEdit = !!user
  const [form, setForm] = useState({
    username: user?.username ?? '',
    name: user?.name ?? '',
    display_name: user?.display_name ?? '',
    email: user?.email ?? '',
    phone: user?.phone ?? '',
    telegram_id: user?.telegram_id ?? '',
    kakaotalk_api_key: user?.kakaotalk_api_key ?? '',
    line_channel_access_token: user?.line_channel_access_token ?? '',
    use_sns_channel: user?.use_sns_channel ?? '',
    role: user?.role ?? 'user',
    password: '',
    confirmPassword: '',
    is_active: user?.is_active ?? true,
    image_url: user?.image_url ?? '',
    stamp_picture: user?.stamp_picture ?? '',
    department_id: user?.department_id ?? '',
    security_level: user?.security_level ?? 0,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [requiredFieldDialogMessage, setRequiredFieldDialogMessage] = useState('')
  const [telegramTestStatus, setTelegramTestStatus] = useState(null) // null | 'sending' | 'ok' | 'error'
  const [telegramTestError, setTelegramTestError] = useState('')
  const fileInputRef = useRef(null)
  const stampInputRef = useRef(null)

  const SECURITY_LEVEL_OPTIONS = t.admin.securityLevels.map((label, i) => ({ value: i, label }))

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

  function handleStampFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => set('stamp_picture', ev.target.result)
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  function set(key, val) { setForm(p => ({ ...p, [key]: val })) }

  async function handleTestTelegram() {
    setTelegramTestStatus('sending')
    setTelegramTestError('')
    try {
      await apiFetch('/sns/test-telegram', { method: 'POST' })
      setTelegramTestStatus('ok')
    } catch (e) {
      const msg = e.message || '전송 실패'
      setTelegramTestError(e.guide ? `${msg}\n→ ${e.guide}` : msg)
      setTelegramTestStatus('error')
    }
  }

  const pwEntered = form.password.length > 0 || form.confirmPassword.length > 0
  const pwMatch = form.password === form.confirmPassword

  // security_level이 3 이상이면 department_id 의미 없음
  const deptDisabled = form.security_level >= 3
  const isAddMode = !isEdit
  const isUnifiedLayout = true

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    let usernameToSave = form.username

    if (isAddMode) {
      const requiredChecks = [
        { missing: !form.username.trim(), label: t.admin.labelUsername },
        { missing: !form.name.trim(), label: t.admin.labelName },
        { missing: !form.display_name.trim(), label: t.admin.labelDisplayName },
        { missing: !form.email.trim(), label: t.admin.labelEmail },
        { missing: !form.phone.trim(), label: t.admin.labelPhone },
        { missing: !form.password.trim(), label: t.admin.passwordGroupTitle || t.admin.labelPasswordNew },
        { missing: !form.role, label: t.admin.labelRole },
        { missing: form.security_level === null || form.security_level === undefined || Number.isNaN(form.security_level), label: t.admin.labelSecurityLevel },
      ]
      const firstMissing = requiredChecks.find(item => item.missing)
      if (firstMissing) {
        setRequiredFieldDialogMessage(
          t.admin.requiredFieldMissing
            ? t.admin.requiredFieldMissing(firstMissing.label)
            : `${firstMissing.label} 이 입력이 안되어 있습니다. 입력하여 주시기 바랍니다.`
        )
        return
      }
    }

    if (!isEdit) {
      const normalizedUsername = form.username.trim()
      if (!USERNAME_PATTERN.test(normalizedUsername)) {
        setError(t.admin.usernameRule)
        return
      }
      usernameToSave = normalizedUsername
    }

    if (form.password || !isEdit) {
      if (form.password.length < 6) {
        setError(t.admin.pwTooShort)
        return
      }
      if (form.password !== form.confirmPassword) {
        setError(t.admin.pwMismatch)
        return
      }
    }

    setSaving(true)
    try {
      let result
      if (isEdit) {
        const body = {
          name: form.name, display_name: form.display_name, email: form.email, phone: form.phone, role: form.role,
          is_active: form.is_active, image_url: form.image_url, stamp_picture: form.stamp_picture || null,
          department_id: deptDisabled ? null : (form.department_id || null),
          security_level: form.security_level,
          telegram_id: form.telegram_id || null,
          kakaotalk_api_key: form.kakaotalk_api_key || null,
          line_channel_access_token: form.line_channel_access_token || null,
          use_sns_channel: form.use_sns_channel || null,
        }
        if (form.password) body.password = form.password
        result = await apiFetch(`/users/${user.id}`, { method: 'PUT', body: JSON.stringify(body) })
      } else {
        result = await apiFetch('/users', {
          method: 'POST',
          body: JSON.stringify({
            username: usernameToSave, name: form.name, display_name: form.display_name, email: form.email, phone: form.phone,
            password: form.password, role: form.role, image_url: form.image_url,
            stamp_picture: form.stamp_picture || null,
            department_id: deptDisabled ? null : (form.department_id || null),
            security_level: form.security_level,
            is_active: form.is_active,
            telegram_id: form.telegram_id || null,
            kakaotalk_api_key: form.kakaotalk_api_key || null,
            line_channel_access_token: form.line_channel_access_token || null,
            use_sns_channel: form.use_sns_channel || null,
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
      <div className={`relative w-full ${isUnifiedLayout ? 'max-w-5xl' : 'max-w-md'} bg-gray-50 rounded-3xl border border-gray-200 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <h3 className="text-gray-900 font-bold text-base">{isEdit ? t.admin.formTitleEdit : (t.admin.newUserWindowTitle || t.admin.formTitleAdd)}</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-lg text-gray-400 hover:text-gray-900 hover:bg-gray-200 flex items-center justify-center transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form noValidate onSubmit={handleSubmit} className="px-6 py-5 flex flex-col gap-4 overflow-y-auto">
          {!isEdit && (
            <div className="px-4 py-3 rounded-xl bg-indigo-50 border border-indigo-200 text-indigo-700 text-sm font-medium">
              {t.admin.newUserInputSectionTitle || t.admin.newUserWindowTitle || t.admin.formTitleAdd}
            </div>
          )}
          {error && <div className="px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">{error}</div>}

          {isUnifiedLayout ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-2 border-b border-gray-100 mb-2">
              {/* 프로필 이미지 */}
              <div className="flex items-center gap-4 p-4 rounded-2xl bg-gray-50 border border-gray-200">
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageFile} />
                <button type="button" onClick={handleAvatarClick} className="relative group flex-shrink-0 rounded-full focus:outline-none">
                  <Avatar name={form.name} imageUrl={form.image_url} size={32} />
                  <div className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </div>
                </button>
                <div className="flex-1">
                  <p className="text-gray-700 text-sm font-medium">{t.admin.profileImageTitle || '프로필 이미지'}</p>
                  <p className="text-gray-400 text-xs mt-0.5">{t.admin.clickToSelectImage}</p>
                </div>
              </div>

              {/* 개인 도장 이미지 */}
              <div className="flex items-center gap-4 p-4 rounded-2xl bg-gray-50 border border-gray-200">
                <input ref={stampInputRef} type="file" accept="image/*" className="hidden" onChange={handleStampFile} />
                <button
                  type="button"
                  onClick={() => stampInputRef.current?.click()}
                  className="relative group flex-shrink-0 w-32 h-32 rounded-xl border-2 border-dashed border-gray-300 hover:border-indigo-400 bg-gray-50 hover:bg-indigo-50/40 transition-colors focus:outline-none flex items-center justify-center overflow-hidden"
                >
                  {form.stamp_picture ? (
                    <>
                      <img src={form.stamp_picture} alt="도장" className="w-full h-full object-contain" />
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                        </svg>
                      </div>
                    </>
                  ) : (
                    <svg className="w-9 h-9 text-gray-300 group-hover:text-indigo-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                    </svg>
                  )}
                </button>
                <div className="flex-1">
                  <p className="text-gray-700 text-sm font-medium">{t.admin.stampImageTitle || '개인 도장 이미지'}</p>
                  <p className="text-gray-400 text-xs mt-0.5">{t.admin.stampImageHint || '클릭하여 도장 이미지를 등록합니다'}</p>
                  {form.stamp_picture && (
                    <button
                      type="button"
                      onClick={() => set('stamp_picture', '')}
                      className="mt-1 text-xs text-red-400 hover:text-red-600 transition-colors"
                    >
                      {t.admin.deleteText || '삭제'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* 프로필 이미지 */}
              <div className="flex items-center gap-4 py-2 border-b border-gray-100">
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageFile} />
                <button type="button" onClick={handleAvatarClick} className="relative group flex-shrink-0 rounded-full focus:outline-none">
                  <Avatar name={form.name} imageUrl={form.image_url} size={16} />
                  <div className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <svg className="w-5 h-5 text-gray-900" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </div>
                </button>
                <div className="flex-1 flex flex-col gap-2">
                  <div>
                    <label className="text-gray-400 text-xs font-medium block mb-0.5">User ID</label>
                    <div className="w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-2 text-gray-500 text-xs font-mono">{user.id}</div>
                  </div>
                  <div>
                    <label className="text-gray-400 text-xs font-medium block mb-0.5">User Name</label>
                    <div className="w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-2 text-gray-500 text-xs font-mono">{user.username}</div>
                  </div>
                </div>
              </div>

              {/* 개인 도장 이미지 */}
              <div className="flex items-center gap-4 py-2 border-b border-gray-100 mb-2">
                <input ref={stampInputRef} type="file" accept="image/*" className="hidden" onChange={handleStampFile} />
                <button
                  type="button"
                  onClick={() => stampInputRef.current?.click()}
                  className="relative group flex-shrink-0 w-16 h-16 rounded-xl border-2 border-dashed border-gray-300 hover:border-indigo-400 bg-gray-50 hover:bg-indigo-50/40 transition-colors focus:outline-none flex items-center justify-center overflow-hidden"
                >
                  {form.stamp_picture ? (
                    <>
                      <img src={form.stamp_picture} alt="도장" className="w-full h-full object-contain" />
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                        </svg>
                      </div>
                    </>
                  ) : (
                    <svg className="w-7 h-7 text-gray-300 group-hover:text-indigo-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                    </svg>
                  )}
                </button>
                <div className="flex-1">
                  <p className="text-gray-700 text-sm font-medium">개인 도장 이미지</p>
                  <p className="text-gray-400 text-xs mt-0.5">클릭하여 도장 이미지를 등록합니다</p>
                  {form.stamp_picture && (
                    <button
                      type="button"
                      onClick={() => set('stamp_picture', '')}
                      className="mt-1 text-xs text-red-400 hover:text-red-600 transition-colors"
                    >
                      삭제
                    </button>
                  )}
                </div>
              </div>
            </>
          )}

          <div className={isUnifiedLayout ? 'grid grid-cols-1 md:grid-cols-2 gap-4' : 'space-y-4'}>
            {/* 아이디 (신규만) */}
            {!isEdit ? (
              <FormField
                label={t.admin.labelUsername}
                value={form.username}
                onChange={v => set('username', v)}
                placeholder={t.admin.placeholderUsername || 'e.g. hong.gildong'}
                required
                requiredMark
              />
            ) : (
              <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-gray-500 text-xs font-medium mb-1.5">User ID</label>
                  <div className="w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-500 text-sm font-mono">{user.id}</div>
                </div>
                <div>
                  <label className="block text-gray-500 text-xs font-medium mb-1.5">{t.admin.labelUsername}</label>
                  <div className="w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-500 text-sm font-mono">{user.username}</div>
                </div>
              </div>
            )}

            {/* 표시 이름 */}
            <FormField
              label={t.admin.labelName}
              value={form.name}
              onChange={v => set('name', v)}
              placeholder={t.admin.placeholderName}
              required={isAddMode}
              requiredMark={isAddMode}
            />

            {/* 디스플레이 이름 */}
            <FormField
              label={t.admin.labelDisplayName}
              value={form.display_name}
              onChange={v => set('display_name', v)}
              placeholder={t.admin.placeholderDisplayName}
              required={isAddMode}
              requiredMark={isAddMode}
            />

            {/* 이메일 */}
            <FormField
              label={t.admin.labelEmail}
              type="email"
              value={form.email}
              onChange={v => set('email', v)}
              placeholder={t.admin.placeholderEmail || 'e.g. user@example.com'}
              required={isAddMode}
              requiredMark={isAddMode}
            />

            {/* 전화번호 */}
            <FormField
              label={t.admin.labelPhone}
              value={form.phone}
              onChange={v => set('phone', v)}
              placeholder={t.admin.placeholderPhone}
              required={isAddMode}
              requiredMark={isAddMode}
            />

            {/* 비밀번호 설정 (신규 추가 시 그룹 박스) */}
            {isAddMode ? (
              <div className="md:col-span-2 p-4 rounded-2xl bg-gray-50 border border-gray-200">
                <p className="text-gray-900 text-sm font-semibold mb-3">
                  {t.admin.passwordGroupTitle || t.admin.labelPasswordNew}
                  <span className="text-red-500 ml-1">(*)</span>
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FormField
                    label={t.admin.labelPasswordNew}
                    type="password"
                    value={form.password}
                    onChange={v => set('password', v)}
                    placeholder={t.admin.placeholderPasswordNew}
                    required
                  />
                  <div>
                    <label className="block text-gray-500 text-xs font-medium mb-1.5">{t.admin.labelPasswordConfirm}</label>
                    <div className="relative">
                      <input
                        type="password"
                        value={form.confirmPassword}
                        onChange={e => set('confirmPassword', e.target.value)}
                        placeholder={t.admin.placeholderPasswordConfirm}
                        required
                        className={`w-full bg-gray-100 border rounded-xl px-4 py-2.5 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 transition-all pr-10 ${pwEntered
                          ? pwMatch
                            ? 'border-green-500/50 focus:ring-green-500/30 focus:border-green-500/50'
                            : 'border-red-500/50 focus:ring-red-500/30 focus:border-red-500/50'
                          : 'border-gray-200 focus:ring-indigo-500/40 focus:border-indigo-300'
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
                    {pwEntered && !pwMatch && <p className="text-red-400 text-xs mt-1.5 ml-1">{t.admin.pwMismatch}</p>}
                    {pwEntered && pwMatch && form.password.length > 0 && <p className="text-green-400 text-xs mt-1.5 ml-1">{t.admin.pwMatch}</p>}
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <FormField
                  label={t.admin.labelPasswordEdit}
                  type="password"
                  value={form.password}
                  onChange={v => set('password', v)}
                  placeholder={t.admin.placeholderPasswordEdit}
                />
                {form.password.length > 0 && (
                  <div className="mt-4">
                    <label className="block text-gray-500 text-xs font-medium mb-1.5">{t.admin.labelPasswordConfirm}</label>
                    <div className="relative">
                      <input
                        type="password"
                        value={form.confirmPassword}
                        onChange={e => set('confirmPassword', e.target.value)}
                        placeholder={t.admin.placeholderPasswordConfirm}
                        className={`w-full bg-gray-100 border rounded-xl px-4 py-2.5 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 transition-all pr-10 ${pwEntered
                          ? pwMatch
                            ? 'border-green-500/50 focus:ring-green-500/30 focus:border-green-500/50'
                            : 'border-red-500/50 focus:ring-red-500/30 focus:border-red-500/50'
                          : 'border-gray-200 focus:ring-indigo-500/40 focus:border-indigo-300'
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
                    {pwEntered && !pwMatch && <p className="text-red-400 text-xs mt-1.5 ml-1">{t.admin.pwMismatch}</p>}
                    {pwEntered && pwMatch && form.password.length > 0 && <p className="text-green-400 text-xs mt-1.5 ml-1">{t.admin.pwMatch}</p>}
                  </div>
                )}
              </div>
            )}

            {/* 권한 */}
            <div>
              <label className="block text-gray-500 text-xs font-medium mb-1.5">
                {t.admin.labelRole}
                {isAddMode && <span className="text-red-500 ml-1">(*)</span>}
              </label>
              <select
                value={form.role}
                onChange={e => set('role', e.target.value)}
                required={isAddMode}
                className="w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-300 transition-all"
              >
                {[
                  { value: 'user',          label: t.roles.user },
                  { value: 'channel_admin', label: t.roles.channel_admin },
                  { value: 'team_admin',    label: t.roles.team_admin },
                  { value: 'site_admin',    label: t.roles.site_admin },
                ].map(o => (
                  <option key={o.value} value={o.value} className="bg-gray-50">{o.label}</option>
                ))}
              </select>
            </div>

            {/* 보안 등급 */}
            <div>
              <label className="block text-gray-500 text-xs font-medium mb-1.5">
                {t.admin.labelSecurityLevel}
                {isAddMode && <span className="text-red-500 ml-1">(*)</span>}
              </label>
              <select
                value={form.security_level}
                onChange={e => set('security_level', parseInt(e.target.value))}
                required={isAddMode}
                className="w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-300 transition-all"
              >
                {SECURITY_LEVEL_OPTIONS.map(o => (
                  <option key={o.value} value={o.value} className="bg-gray-50">{o.label}</option>
                ))}
              </select>
              {form.security_level >= 3 && (
                <p className="text-yellow-400/70 text-xs mt-1.5 ml-1">{t.admin.securityLevelWarning}</p>
              )}
            </div>

            {/* 부서 (Security Level < 3 일 때만 활성) */}
            <div className={isUnifiedLayout ? 'md:col-span-2' : ''}>
              <label className={`block text-xs font-medium mb-1.5 ${deptDisabled ? 'text-gray-300' : 'text-gray-500'}`}>
                {t.admin.labelDepartment}
                {isAddMode && <span className="text-red-500 ml-1">(*)</span>}
              </label>
              <select
                value={form.department_id}
                onChange={e => set('department_id', e.target.value)}
                disabled={deptDisabled}
                required={isAddMode && !deptDisabled}
                className={`w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-300 transition-all ${deptDisabled ? 'text-gray-300 cursor-not-allowed' : 'text-gray-900'}`}
              >
                <option value="" className="bg-gray-50">{t.admin.noDepartment}</option>
                {teams.map(team => (
                  <option key={team.id} value={team.id} className="bg-gray-50">{team.name}</option>
                ))}
              </select>
            </div>

            {/* SNS 설정 (묶음 박스) */}
            <div className={`${isUnifiedLayout ? 'md:col-span-2' : ''} p-4 rounded-2xl bg-gray-50 border border-gray-200`}>
              <p className="text-gray-900 text-sm font-semibold mb-3">{t.admin.navSns}</p>
              <div className={isUnifiedLayout ? 'grid grid-cols-1 md:grid-cols-2 gap-4' : 'space-y-4'}>
                <div>
                  <label className="block text-gray-500 text-xs font-medium mb-1.5">{t.admin.labelTelegramId}</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={form.telegram_id}
                      onChange={e => set('telegram_id', e.target.value)}
                      placeholder={t.admin.placeholderTelegramId}
                      className="flex-1 min-w-0 bg-gray-100 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-300 transition-all"
                    />
                    <button
                      type="button"
                      onClick={handleTestTelegram}
                      disabled={!form.telegram_id?.trim() || telegramTestStatus === 'sending'}
                      className="flex-shrink-0 px-3 py-2.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-700 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                    >
                      {telegramTestStatus === 'sending' ? '...' : (t.admin.btnTestTelegram || '테스트 메시지 보내기')}
                    </button>
                    {telegramTestStatus === 'ok' && <span className="flex-shrink-0 text-xs text-green-600 whitespace-nowrap">✓ 전송 성공</span>}
                    {telegramTestStatus === 'error' && <span className="flex-shrink-0 text-xs text-red-500 whitespace-pre-line">{telegramTestError}</span>}
                  </div>
                </div>
                <FormField label={t.admin.labelKakaoTalkApiKey} value={form.kakaotalk_api_key} onChange={v => set('kakaotalk_api_key', v)} placeholder={t.admin.placeholderKakaoTalkApiKey} />
                <FormField label={t.admin.labelLineChannelAccessToken} value={form.line_channel_access_token} onChange={v => set('line_channel_access_token', v)} placeholder={t.admin.placeholderLineChannelAccessToken} />
                <div>
                  <label className="block text-gray-500 text-xs font-medium mb-1.5">{t.admin.labelUseSnsChannel}</label>
                  <select
                    value={form.use_sns_channel}
                    onChange={e => set('use_sns_channel', e.target.value)}
                    className="w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-300 transition-all"
                  >
                    <option value="" className="bg-gray-50">{t.admin.optionNone}</option>
                    <option value="telegram" className="bg-gray-50">{t.admin.optionTelegram}</option>
                    <option value="kakaotalk" className="bg-gray-50">{t.admin.optionKakaoTalk}</option>
                    <option value="line" className="bg-gray-50">{t.admin.optionLineMessenger}</option>
                  </select>
                </div>
              </div>
            </div>

            {/* 계정 활성화 */}
            <div className={`${isUnifiedLayout ? 'md:col-span-2' : ''} flex items-center justify-between py-2 px-4 rounded-xl bg-gray-50 border border-gray-200`}>
              <span className="text-gray-600 text-sm">{t.admin.labelIsActive}</span>
              <button
                type="button"
                onClick={() => set('is_active', !form.is_active)}
                className={`w-10 h-5 rounded-full transition-colors relative ${form.is_active ? 'bg-indigo-500' : 'bg-gray-300'}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${form.is_active ? 'left-5' : 'left-0.5'}`} />
              </button>
            </div>
          </div>

          <div className={`flex gap-2 pt-1 pb-1 ${isUnifiedLayout ? 'md:col-span-2' : ''}`}>
            <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-xl text-gray-500 hover:text-gray-700 text-sm border border-gray-200 hover:bg-gray-100 transition-colors">
              {t.admin.cancel}
            </button>
            <button type="submit" disabled={saving} className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-semibold transition-colors">
              {saving ? t.admin.saving : (isEdit ? t.admin.save : t.admin.add)}
            </button>
          </div>
        </form>
      </div>
      {requiredFieldDialogMessage && (
        <ConfirmDialog
          title={t.admin.requiredFieldTitle || t.chat.errorTitle || '오류'}
          message={requiredFieldDialogMessage}
          confirmText={t.chat.ok || t.admin.close || '확인'}
          cancelText={t.admin.close || t.chat.ok || '닫기'}
          onConfirm={() => setRequiredFieldDialogMessage('')}
          onCancel={() => setRequiredFieldDialogMessage('')}
        />
      )}
    </div>
  )
}

function FormField({ label, type = 'text', value, onChange, placeholder, required, requiredMark = false }) {
  return (
    <div>
      <label className="block text-gray-500 text-xs font-medium mb-1.5">
        {label}
        {requiredMark && <span className="text-red-500 ml-1">(*)</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        className="w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-300 transition-all"
      />
    </div>
  )
}

// ─── Main SiteAdminPage ───────────────────────────────────────

export default function SiteAdminPage({ onClose }) {
  const t = useT()
  const { currentUser, setMaxAttachmentFileSize, language, setLanguage } = useAuth()
  const [showLocalAgenticPanel, setShowLocalAgenticPanel] = useState(true)
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
    pdfPreview: { width: 480, height: 270 },
    txtPreview: { width: 270, height: 480 },
    pptPreview: { width: 480, height: 270 },
    pptxPreview: { width: 480, height: 270 },
    excelPreview: { width: 480, height: 270 },
    wordPreview: { width: 270, height: 480 },
    moviePreview: { width: 480, height: 270 },
    htmlPreview: { width: 480, height: 270 }
  })
  const [easyDocStationFolder, setEasyDocStationFolder] = useState('')
  const [postgresPath, setPostgresPath] = useState('Database/PoseSQLDB')
  const [cassandraPathConfig, setCassandraPathConfig] = useState('Database/CassandraDB')
  const [objectFilePathConfig, setObjectFilePathConfig] = useState('Database/ObjectFile')
  const [lancedbPath, setLancedbPath] = useState('Database/LanceDB')
  const [maxAttachmentFileSize, setMaxAttachmentFileSizeLocal] = useState(100)
  const [dmRetentionDays, setDmRetentionDays] = useState(30)
  const [dmUnlimited, setDmUnlimited] = useState(false)
  const [ragForm, setRagForm] = useState({ type: 'manual', time: '02:00', vectorSize: 1024, chunkSize: 800, chunkOverlap: 100, pdfParseStrategy: 'auto' })
  const [ragDatasets, setRagDatasets] = useState([])
  const [ragDatasetSelectedIds, setRagDatasetSelectedIds] = useState([])
  const [ragDatasetUploading, setRagDatasetUploading] = useState(false)
  const [ragDatasetTraining, setRagDatasetTraining] = useState(false)
  const [showRagResetConfirm, setShowRagResetConfirm] = useState(false)
  const [ragResetting, setRagResetting] = useState(false)
  const [agenticaiForm, setAgenticaiForm] = useState({ num_predict: 4096, num_ctx: 8192, history: 6, language: 'ko' })
  const [companyForm, setCompanyForm] = useState({ name: '', address: '', phone: '', homepage: '', fax: '', seal: '', logo: '' })
  const [snsForm, setSnsForm] = useState({
    kakao: { enabled: false, apiKey: '' },
    line: { enabled: false, channelAccessToken: '' },
    telegram: { enabled: false, botName: '', botUserName: '', httpApiToken: '' },
  })
  const [telegramWebhookUrl, setTelegramWebhookUrl] = useState('')
  const [telegramWebhookRegistered, setTelegramWebhookRegistered] = useState('')
  const [telegramWebhookStatus, setTelegramWebhookStatus] = useState(null) // null | 'loading' | 'ok' | 'error'
  const [telegramWebhookError, setTelegramWebhookError] = useState('')
  const [ragTableDragOver, setRagTableDragOver] = useState(false)
  const ragTableDragCounter = useRef(0)
  const companyFileInputRef = useRef(null)
  const companyLogoInputRef = useRef(null)
  const ragDatasetFileInputRef = useRef(null)
  const [savingConfig, setSavingConfig] = useState(false)
  const [saveConfigDialogMessage, setSaveConfigDialogMessage] = useState('')
  const [trainingStatus, setTrainingStatus] = useState(null) // 'running', 'done', null
  const [showRagTrainingConfirm, setShowRagTrainingConfirm] = useState(false)
  const [ragTrainingDoneMessage, setRagTrainingDoneMessage] = useState(null)
  const [pendingDeleteUser, setPendingDeleteUser] = useState(null)
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
          pdfPreview: data.display.pdfPreview || { width: 480, height: 270 },
          txtPreview: data.display.txtPreview || { width: 270, height: 480 },
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
      if (data.pathConfig) {
        setEasyDocStationFolder(data.pathConfig.easyDocStationFolder || '')
        setPostgresPath(data.pathConfig.postgresqlPath || 'Database/PoseSQLDB')
        setCassandraPathConfig(data.pathConfig.cassandraPath || 'Database/CassandraDB')
        setObjectFilePathConfig(data.pathConfig.objectFilePath || 'Database/ObjectFile')
        setLancedbPath(data.pathConfig.lancedbPath || 'Database/LanceDB')
      }
      if (data.rag) {
        const pdfParseStrategy = ['auto', 'fast', 'hi-res'].includes(data.rag.pdf_parse_strategy)
          ? data.rag.pdf_parse_strategy
          : 'auto'
        setRagForm(p => ({
          ...p,
          type: data.rag.trainingType || p.type,
          time: data.rag.dailyTime || p.time,
          vectorSize: data.rag.vectorSize || p.vectorSize,
          chunkSize: data.rag.chunk_size ?? p.chunkSize,
          chunkOverlap: data.rag.chunk_overlap ?? p.chunkOverlap,
          pdfParseStrategy
        }))
      }
      if (data.agenticai) {
        setAgenticaiForm({
          num_predict: data.agenticai.num_predict || 4096,
          num_ctx: data.agenticai.num_ctx || 8192,
          history: data.agenticai.history ?? 6,
          language: ['ko', 'ja', 'en', 'zh'].includes(data.agenticai.language) ? data.agenticai.language : 'ko'
        })
      }
      if (data.maxAttachmentFileSize != null) {
        setMaxAttachmentFileSizeLocal(data.maxAttachmentFileSize)
      }
      if (data.DirectMessage) {
        setDmRetentionDays(data.DirectMessage['보존 기한'] ?? 30)
        setDmUnlimited(data.DirectMessage['무제한보관'] ?? false)
      }
      if (data.company) {
        setCompanyForm({
          name:      data.company.name      || '',
          address:   data.company.address   || '',
          phone:     data.company.phone     || '',
          homepage:  data.company.homepage  || '',
          fax:       data.company.fax       || '',
          seal:      data.company.seal      || '',
          logo:      data.company.logo      || '',
        })
      }
      if (data.sns) {
        setSnsForm({
          kakao: {
            enabled: Boolean(data.sns.kakao?.enabled),
            apiKey: data.sns.kakao?.apiKey || '',
          },
          line: {
            enabled: Boolean(data.sns.line?.enabled),
            channelAccessToken: data.sns.line?.channelAccessToken || '',
          },
          telegram: {
            enabled: Boolean(data.sns.telegram?.enabled),
            botName: data.sns.telegram?.botName || '',
            botUserName: data.sns.telegram?.botUserName || data.sns.telegram?.botId || '',
            httpApiToken: data.sns.telegram?.httpApiToken || '',
          },
        })
      }
    } catch (err) {
      console.error('Failed to load DB stats:', err)
    } finally {
      setDbLoading(false)
    }
  }

  async function loadTelegramWebhookInfo() {
    try {
      const data = await apiFetch('/sns/telegram/webhook-info')
      setTelegramWebhookRegistered(data.webhookUrl || '')
      if (!telegramWebhookUrl) setTelegramWebhookUrl(data.savedWebhookUrl || data.webhookUrl || '')
    } catch {
      setTelegramWebhookRegistered('')
    }
  }

  async function handleSetTelegramWebhook() {
    if (!telegramWebhookUrl.trim()) return
    setTelegramWebhookStatus('loading')
    setTelegramWebhookError('')
    try {
      await apiFetch('/sns/telegram/set-webhook', {
        method: 'POST',
        body: JSON.stringify({ webhookUrl: telegramWebhookUrl.trim() }),
      })
      setTelegramWebhookRegistered(telegramWebhookUrl.trim())
      setTelegramWebhookStatus('ok')
    } catch (e) {
      setTelegramWebhookStatus('error')
      setTelegramWebhookError(e.message || '등록 실패')
    }
  }

  async function loadRagDatasets() {
    try {
      const data = await apiFetch('/rag/datasets')
      const items = Array.isArray(data?.items) ? data.items : []
      setRagDatasets(items)
      setRagDatasetSelectedIds(prev => prev.filter(id => items.some(it => it.id === id)))
    } catch (err) {
      alert(err.message)
    }
  }

  async function handleAddRagDatasets(files) {
    if (!files || files.length === 0) return
    setRagDatasetUploading(true)
    try {
      const formData = new FormData()
      for (const file of files) formData.append('files', file)
      formData.append('originalNames', JSON.stringify(files.map(file => file.name)))
      const res = await fetch('/api/rag/datasets/upload', {
        method: 'POST',
        headers: {
          ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
        },
        body: formData,
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.error || `HTTP ${res.status}`)
      }
      await loadRagDatasets()
    } catch (err) {
      alert(err.message)
    } finally {
      setRagDatasetUploading(false)
    }
  }

  async function handleDeleteSelectedRagDatasets() {
    if (ragDatasetSelectedIds.length === 0) return
    try {
      await apiFetch('/rag/datasets/delete', {
        method: 'POST',
        body: JSON.stringify({ ids: ragDatasetSelectedIds }),
      })
      await loadRagDatasets()
      setRagDatasetSelectedIds([])
    } catch (err) {
      alert(err.message)
    }
  }

  async function handleRagResetVectors() {
    setRagResetting(true)
    try {
      await apiFetch('/rag/datasets/reset-vectors', { method: 'POST' })
      await loadRagDatasets()
      setRagTrainingDoneMessage(t.admin.ragResetDone || '학습 벡터 데이터가 모두 초기화되었습니다.')
    } catch (err) {
      alert(err.message)
    } finally {
      setRagResetting(false)
      setShowRagResetConfirm(false)
    }
  }

  async function handleStartRagDatasetTraining() {
    const untrainedItems = ragDatasets.filter(item => item.status !== 'trained')
    if (untrainedItems.length === 0) {
      setRagTrainingDoneMessage(t.admin.ragAllTrained || '모든 파일이 이미 학습되었습니다.')
      return
    }
    setRagDatasetTraining(true)
    try {
      const ids = untrainedItems.map(item => item.id)
      const result = await apiFetch('/rag/datasets/train', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      })
      await loadRagDatasets()
      setRagTrainingDoneMessage((t.admin.ragTrainingDonePrefix || '학습 완료: ') + `${result?.total ?? ids.length}건`)
    } catch (err) {
      alert(err.message)
    } finally {
      setRagDatasetTraining(false)
    }
  }

  useEffect(() => { loadUsers(); loadTeams() }, [])
  useEffect(() => {
    if (activeTab === 'db' || activeTab === 'display' || activeTab === 'rag' || activeTab === 'agenticai' || activeTab === 'company' || activeTab === 'sns') loadDbStats()
    if (activeTab === 'sns') loadTelegramWebhookInfo()
    if (activeTab === 'rag-learning') loadRagDatasets()
  }, [activeTab])
  useEffect(() => {
    function handleEscClose(e) {
      if (e.key !== 'Escape') return
      if (showForm) {
        e.preventDefault()
        setShowForm(false)
        setEditUser(null)
        return
      }
      onClose?.()
    }
    window.addEventListener('keydown', handleEscClose)
    return () => window.removeEventListener('keydown', handleEscClose)
  }, [onClose, showForm])

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
    setPendingDeleteUser(user)
  }

  async function confirmDeleteUser() {
    if (!pendingDeleteUser) return
    try {
      await apiFetch(`/users/${pendingDeleteUser.id}`, { method: 'DELETE' })
      setUsers(prev => prev.filter(u => u.id !== pendingDeleteUser.id))
    } catch (err) {
      alert(err.message)
    } finally {
      setPendingDeleteUser(null)
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
        configData.pdfPreview = {
          width: parseInt(displayForm.pdfPreview.width),
          height: parseInt(displayForm.pdfPreview.height)
        }
        configData.txtPreview = {
          width: parseInt(displayForm.txtPreview.width),
          height: parseInt(displayForm.txtPreview.height)
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
        configData['EasyDocStationFolder'] = easyDocStationFolder.trim()
        configData['PostgreSQL Database Path'] = postgresPath.trim()
        configData['Cassandra Database Path'] = cassandraPathConfig.trim()
        configData['ObjectFile Path'] = objectFilePathConfig.trim()
        configData['lancedb Database Path'] = lancedbPath.trim()
        configData['MaxAttachmentFileSize'] = parseInt(maxAttachmentFileSize) || 100
        configData['DirectMessage'] = {
          '보존 기한': Math.min(90, Math.max(1, parseInt(dmRetentionDays) || 30)),
          '무제한보관': dmUnlimited
        }
      } else if (activeTab === 'rag') {
        configData.rag = {
          trainingType: ragForm.type,
          dailyTime: ragForm.time,
          vectorSize: parseInt(ragForm.vectorSize),
          chunk_size: parseInt(ragForm.chunkSize),
          chunk_overlap: parseInt(ragForm.chunkOverlap),
          pdf_parse_strategy: ['auto', 'fast', 'hi-res'].includes(ragForm.pdfParseStrategy)
            ? ragForm.pdfParseStrategy
            : 'auto'
        }
      } else if (activeTab === 'agenticai') {
        configData.agenticai = {
          num_predict: parseInt(agenticaiForm.num_predict),
          num_ctx: parseInt(agenticaiForm.num_ctx),
          history: parseInt(agenticaiForm.history),
          language: agenticaiForm.language || 'ko'
        }
      } else if (activeTab === 'company') {
        configData.company = {
          name:     companyForm.name.trim(),
          address:  companyForm.address.trim(),
          phone:    companyForm.phone.trim(),
          homepage: companyForm.homepage.trim(),
          fax:      companyForm.fax.trim(),
          seal:     companyForm.seal || null,
          logo:     companyForm.logo || null,
        }
      } else if (activeTab === 'sns') {
        configData.sns = {
          kakao: {
            enabled: Boolean(snsForm.kakao.enabled),
            apiKey: (snsForm.kakao.apiKey || '').trim(),
          },
          line: {
            enabled: Boolean(snsForm.line.enabled),
            channelAccessToken: (snsForm.line.channelAccessToken || '').trim(),
          },
          telegram: {
            enabled: Boolean(snsForm.telegram.enabled),
            botName: (snsForm.telegram.botName || '').trim(),
            botUserName: (snsForm.telegram.botUserName || '').trim(),
            httpApiToken: (snsForm.telegram.httpApiToken || '').trim(),
          },
        }
      }

      const result = await apiFetch('/admin/config', {
        method: 'PUT',
        body: JSON.stringify(configData)
      })
      if (result.success) {
        if (activeTab === 'db') {
          // Sync maxAttachmentFileSize to AuthContext so ChatArea picks it up immediately
          setMaxAttachmentFileSize(parseInt(maxAttachmentFileSize) || 100)
        }
        if (activeTab === 'rag') {
          // vector size 변경 시 LanceDB 테이블 재초기화
          try {
            const reinit = await apiFetch('/admin/rag/reinit-lancedb', { method: 'POST' })
            setSaveConfigDialogMessage(t.admin.settingsSavedWithReinit(reinit.message || t.admin.lancedbReinitComplete))
          } catch (reinitErr) {
            setSaveConfigDialogMessage(t.admin.settingsReinitFailed(reinitErr.message))
          }
        } else {
          setSaveConfigDialogMessage(t.admin.settingsSaved)
        }
        loadDbStats()
      }
    } catch (err) {
      setSaveConfigDialogMessage(t.admin.settingsSaveFailed(err.message))
    } finally {
      setSavingConfig(false)
    }
  }

  async function handleStartTraining() {
    setShowRagTrainingConfirm(true)
  }

  async function confirmStartTraining() {
    setTrainingStatus('running')
    try {
      // 실제 API 호출 시뮬레이션 또는 연동
      await apiFetch('/admin/rag/train', { method: 'POST' })
      alert(t.admin.ragTrainingStarted)
    } catch (err) {
      alert(t.admin.ragTrainingFailed(err.message))
    } finally {
      setTrainingStatus(null)
      setShowRagTrainingConfirm(false)
    }
  }

  async function handleExecuteReset() {
    if (resetConfirmation !== t.admin.resetConfirmWord) return
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
      alert(t.admin.resetFailed(err.message))
    } finally {
      setExecutingReset(false)
    }
  }

  const filtered = users.filter(u => {
    const matchSearch = !search || u.name.includes(search) || u.email.includes(search) || u.username.includes(search)
    const matchRole = roleFilter === 'all' || u.role === roleFilter
    return matchSearch && matchRole
  })
  const roleOptions = [
    { value: 'site_admin', label: t.roles.site_admin },
    { value: 'team_admin', label: t.roles.team_admin },
    { value: 'channel_admin', label: t.roles.channel_admin },
    { value: 'user', label: t.roles.user },
  ]

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-gray-100/95 backdrop-blur-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 bg-gray-100 border-b border-gray-200 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold">
            ED
          </div>
          <div>
            <h1 className="text-gray-900 font-bold text-base">{t.admin.headerTitle}</h1>
            <p className="text-gray-400 text-xs">
              {activeTab === 'users' ? t.admin.headerSubUsers : t.admin.headerSubSystem}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden md:block">
            <div className="relative">
              <svg className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t.admin.searchPlaceholder}
                className="w-56 bg-gray-100 border border-gray-200 rounded-lg pl-8 pr-3 py-1.5 text-gray-900 text-xs placeholder-gray-400 focus:outline-none focus:border-indigo-300 focus:ring-1 focus:ring-indigo-500/40"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowLocalAgenticPanel(v => !v)}
            title={showLocalAgenticPanel ? t.titlebar.agenticPanelHide : t.titlebar.agenticPanelShow}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-colors ${
              showLocalAgenticPanel
                ? 'bg-blue-600 border-blue-600 text-white hover:bg-blue-700'
                : 'bg-gray-200 border-gray-300 text-gray-600 hover:bg-gray-300'
            }`}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <rect x="2.5" y="3" width="15" height="14" rx="2" />
              <line x1="11" y1="3" x2="11" y2="17" />
            </svg>
            <span>{t.titlebar.agenticPanelLabel}</span>
          </button>

          <div className="flex items-center bg-gray-100 border border-gray-200 rounded-lg overflow-hidden">
            {LANGUAGES.map(lang => (
              <button
                key={lang.code}
                type="button"
                onClick={() => setLanguage(lang.code)}
                title={lang.label}
                aria-label={lang.label}
                className={`px-2.5 py-1 text-sm leading-none transition-all ${
                  language === lang.code
                    ? 'bg-indigo-600 text-white'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-200'
                }`}
              >
                {lang.flag}
              </button>
            ))}
          </div>

          <button
            onClick={onClose}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gray-100 hover:bg-red-500/20 text-gray-600 hover:text-red-400 border border-gray-200 hover:border-red-200 text-sm font-medium transition-all active:scale-95"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
            {t.admin.close}
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0 bg-gray-100 relative">
        {/* Left Side: Button Plane (Sidebar) */}
        <div className="w-64 border-r border-gray-100 bg-gray-100 px-4 py-6 flex flex-col gap-2 flex-shrink-0 min-h-0 overflow-y-auto">
          <button
            onClick={() => setActiveTab('users')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${activeTab === 'users' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200'}`}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 01-12 0v-1z" />
            </svg>
            {t.admin.navUsers}
          </button>
          <button
            onClick={() => setActiveTab('db')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${activeTab === 'db' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200'}`}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
            </svg>
            {t.admin.navDb}
          </button>
          <button
            onClick={() => setActiveTab('display')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${activeTab === 'display' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200'}`}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            {t.admin.navDisplay}
          </button>
          <button
            onClick={() => setActiveTab('rag')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${activeTab === 'rag' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200'}`}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
            </svg>
            {t.admin.navRag}
          </button>
          <button
            onClick={() => setActiveTab('agenticai')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${activeTab === 'agenticai' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200'}`}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {t.admin.navAgenticAI}
          </button>
          <button
            onClick={() => setActiveTab('company')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${activeTab === 'company' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200'}`}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
            {t.admin.navCompany}
          </button>
          <button
            onClick={() => setActiveTab('sns')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${activeTab === 'sns' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200'}`}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 3H3a2 2 0 00-2 2v14l4-4h16a2 2 0 002-2V5a2 2 0 00-2-2z" />
            </svg>
            {t.admin.navSns}
          </button>
          <button
            onClick={() => setActiveTab('reset')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${activeTab === 'reset' ? 'bg-red-600 text-white shadow-lg shadow-red-500/20' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200'}`}
          >
            <svg className="w-5 h-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            {t.admin.navReset}
          </button>
        </div>

        {/* Center: Main Content area */}
        <div className="flex-1 overflow-auto px-8 py-6">
        {activeTab === 'users' ? (
          <>
            {/* Stats bar */}
            <div className="grid grid-cols-4 gap-3 mb-5">
              {[
                { label: t.admin.statTotalUsers, value: users.length, color: 'text-gray-900' },
                { label: t.admin.statSiteAdmins, value: users.filter(u => u.role === 'site_admin').length, color: 'text-red-400' },
                { label: t.admin.statTeamAdmins, value: users.filter(u => u.role === 'team_admin').length, color: 'text-orange-600' },
                { label: t.admin.statActiveAccounts, value: users.filter(u => u.is_active).length, color: 'text-green-400' },
              ].map(s => (
                <div key={s.label} className="bg-gray-50 border border-gray-200 rounded-2xl px-4 py-3">
                  <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
                  <p className="text-gray-400 text-xs mt-0.5">{s.label}</p>
                </div>
              ))}
            </div>

            {/* Toolbar */}
            <div className="flex items-center gap-3 mb-4">
              <div className="flex-1 relative">
                <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={t.admin.searchPlaceholder}
                  className="w-full bg-gray-100 border border-gray-200 rounded-xl pl-9 pr-4 py-2.5 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:border-indigo-300 focus:ring-1 focus:ring-indigo-500/40"
                />
              </div>

              <select
                value={roleFilter}
                onChange={e => setRoleFilter(e.target.value)}
                className="bg-gray-100 border border-gray-200 rounded-xl px-3 py-2.5 text-gray-900 text-sm focus:outline-none focus:border-indigo-300"
              >
                <option value="all" className="bg-gray-50">{t.admin.roleAll}</option>
                {roleOptions.map(r => (
                  <option key={r.value} value={r.value} className="bg-gray-50">{r.label}</option>
                ))}
              </select>

              <button
                onClick={() => { setEditUser(null); setShowForm(true) }}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-colors shadow-lg shadow-indigo-200 flex-shrink-0"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                {t.admin.addUser}
              </button>
            </div>

            {/* Error */}
            {error && (
              <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">{error}</div>
            )}

            {/* User table */}
            <div className="bg-gray-50 border border-gray-200 rounded-2xl overflow-hidden">
              {loading ? (
                <div className="flex items-center justify-center py-16 text-gray-400 text-sm">
                  <div className="w-5 h-5 border-2 border-gray-300 border-t-indigo-500 rounded-full animate-spin mr-2" />
                  {t.admin.loading}
                </div>
              ) : filtered.length === 0 ? (
                <div className="text-center py-16 text-gray-400 text-sm">{t.admin.noResults}</div>
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
                    <tr className="border-b border-gray-200 text-gray-400 text-xs font-semibold uppercase tracking-wider">
                      <th className="px-5 py-3 text-left font-semibold">{t.admin.tableUser}</th>
                      <th className="px-5 py-3 text-left font-semibold">{t.admin.tableEmail}</th>
                      <th className="px-5 py-3 text-left font-semibold">{t.admin.tableTeam}</th>
                      <th className="px-5 py-3 text-left font-semibold">{t.admin.tableRole}</th>
                      <th className="px-5 py-3 text-left font-semibold">{t.admin.tableLastLogin}</th>
                      <th className="px-5 py-3 text-left font-semibold">{t.admin.tableStatus}</th>
                      <th className="px-5 py-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {filtered.map(user => (
                      <tr
                        key={user.id}
                        className={`hover:bg-gray-50 transition-colors ${!user.is_active ? 'opacity-50' : ''}`}
                      >
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-3">
                            <Avatar name={user.name} imageUrl={user.image_url} size={9} />
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="text-gray-900 text-sm font-medium truncate">{user.name}</p>
                                {user.id === currentUser.id && (
                                  <span className="px-1.5 py-0.5 rounded text-xs bg-indigo-100 text-indigo-600 border border-indigo-200 flex-shrink-0">{t.admin.me}</span>
                                )}
                              </div>
                              <p className="text-gray-400 text-xs">@{user.username}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-3.5 max-w-0">
                          <p className="text-gray-500 text-sm truncate">{user.email}</p>
                        </td>
                        <td className="px-5 py-3.5">
                          <p className="text-gray-500 text-sm truncate">
                            {user.department_id
                              ? (teams.find(team => team.id === user.department_id)?.name ?? user.department_id)
                              : <span className="text-gray-300">—</span>}
                          </p>
                        </td>
                        <td className="px-5 py-3.5">
                          <RoleBadge role={user.role} label={t.roles?.[user.role] ?? user.role} />
                        </td>
                        <td className="px-5 py-3.5 text-gray-400 text-xs whitespace-nowrap">
                          {formatDate(user.last_login_at)}
                        </td>
                        <td className="px-5 py-3.5">
                          <span className={`flex items-center gap-1 text-xs whitespace-nowrap ${user.is_active ? 'text-green-400' : 'text-gray-400'}`}>
                            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${user.is_active ? 'bg-green-400' : 'bg-gray-300'}`} />
                            {user.is_active ? t.admin.active : t.admin.inactive}
                          </span>
                        </td>
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-1 justify-end">
                            <button
                              onClick={() => { setEditUser(user); setShowForm(true) }}
                              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-200 transition-colors"
                              title={t.admin.tooltipEdit}
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </button>
                            {user.id !== currentUser.id && (
                              <button
                                onClick={() => handleDelete(user)}
                                className="p-1.5 rounded-lg text-red-400 hover:text-red-400 hover:bg-red-50 transition-colors"
                                title={t.admin.tooltipDelete}
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
            <p className="text-gray-300 text-xs mt-3 text-right">
              {t.admin.userCount(filtered.length, users.length)}
            </p>
          </>
        ) : activeTab === 'db' ? (
          <div className="max-w-4xl mx-auto py-4">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-gray-900 font-bold text-lg flex items-center gap-2">
                <svg className="w-5 h-5 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
                {t.admin.dbTabTitle}
              </h2>
              <button
                onClick={handleSaveConfig}
                disabled={savingConfig}
                className="flex items-center gap-2 px-6 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold transition-all shadow-lg shadow-indigo-200 active:scale-95"
              >
                {savingConfig ? t.admin.savingConfig : t.admin.saveSettings}
              </button>
            </div>

            {dbLoading ? (
              <div className="flex flex-col items-center justify-center py-24 text-gray-400">
                <div className="w-8 h-8 border-2 border-indigo-200 border-t-indigo-500 rounded-full animate-spin mb-4" />
                <p className="text-sm">{t.admin.dbLoadingInfo}</p>
              </div>
            ) : dbStats ? (
              <div className="space-y-6">
                {/* EasyDocStation Folder + Relative DB Path Config */}
                <div className="bg-gray-100 border border-gray-200 rounded-2xl p-6 shadow-xl">
                  <div className="flex items-start justify-between mb-6">
                    <div>
                      <h3 className="text-gray-900 font-bold text-base mb-1">EasyDocStation Folder</h3>
                      <p className="text-gray-400 text-xs">기준 경로와 DB 상대 경로를 설정합니다. 실제 경로는 기준 경로 + 상대 경로 방식으로 계산됩니다.</p>
                    </div>
                    <div className="px-3 py-1 rounded-full bg-sky-50 border border-sky-200 text-sky-700 text-[10px] font-bold uppercase tracking-wider">
                      Path Rule
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-1.5">EasyDocStationFolder</p>
                      <input
                        type="text"
                        value={easyDocStationFolder}
                        onChange={e => setEasyDocStationFolder(e.target.value)}
                        className="w-full bg-gray-200 rounded-xl px-4 py-3 border border-gray-100 font-mono text-xs text-gray-700 break-all leading-relaxed focus:outline-none focus:border-sky-500/50 transition-colors"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-1.5">PostgreSQL Database Path</p>
                        <input
                          type="text"
                          value={postgresPath}
                          onChange={e => setPostgresPath(e.target.value)}
                          className="w-full bg-gray-200 rounded-xl px-4 py-3 border border-gray-100 font-mono text-xs text-gray-700 break-all leading-relaxed focus:outline-none focus:border-sky-500/50 transition-colors"
                        />
                      </div>
                      <div>
                        <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-1.5">Cassandra Database Path</p>
                        <input
                          type="text"
                          value={cassandraPathConfig}
                          onChange={e => setCassandraPathConfig(e.target.value)}
                          className="w-full bg-gray-200 rounded-xl px-4 py-3 border border-gray-100 font-mono text-xs text-gray-700 break-all leading-relaxed focus:outline-none focus:border-sky-500/50 transition-colors"
                        />
                      </div>
                      <div>
                        <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-1.5">ObjectFile Path</p>
                        <input
                          type="text"
                          value={objectFilePathConfig}
                          onChange={e => setObjectFilePathConfig(e.target.value)}
                          className="w-full bg-gray-200 rounded-xl px-4 py-3 border border-gray-100 font-mono text-xs text-gray-700 break-all leading-relaxed focus:outline-none focus:border-sky-500/50 transition-colors"
                        />
                      </div>
                      <div>
                        <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-1.5">lancedb Database Path</p>
                        <input
                          type="text"
                          value={lancedbPath}
                          onChange={e => setLancedbPath(e.target.value)}
                          className="w-full bg-gray-200 rounded-xl px-4 py-3 border border-gray-100 font-mono text-xs text-gray-700 break-all leading-relaxed focus:outline-none focus:border-sky-500/50 transition-colors"
                        />
                      </div>
                    </div>

                    <p className="text-gray-400 text-xs">
                      예시: {`EasyDocStationFolder="/home/freegear/EasyDocStation/"`} + {`"Database/ObjectFile"`} = {`/home/freegear/EasyDocStation/Database/ObjectFile`}
                    </p>
                  </div>
                </div>

                {/* Postgres Stats */}
                <div className="bg-gray-100 border border-gray-200 rounded-2xl p-6 shadow-xl">
                  <div className="flex items-start justify-between mb-6">
                    <div>
                      <h3 className="text-gray-900 font-bold text-base mb-1">PostgreSQL Database</h3>
                      <p className="text-gray-400 text-xs">{t.admin.dbPostgresDesc}</p>
                    </div>
                    <div className="px-3 py-1 rounded-full bg-green-500/10 border border-green-500/20 text-green-400 text-[10px] font-bold uppercase tracking-wider">
                      Online
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-8">
                    <div className="space-y-4">
                      <div>
                        <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-1.5">{t.admin.dbLocation}</p>
                        <div className="bg-gray-200 rounded-xl px-4 py-3 border border-gray-100 font-mono text-xs text-indigo-600 break-all leading-relaxed">
                          {dbStats.db.location}
                        </div>
                      </div>
                    </div>
                    <div className="space-y-10 flex flex-col justify-center">
                      <div className="text-center p-6 bg-gray-50 rounded-3xl border border-gray-100 relative overflow-hidden group">
                        <div className="absolute inset-0 bg-indigo-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                        <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">{t.admin.dbCurrentSize}</p>
                        <p className="text-4xl font-black text-gray-900 tracking-tight">{dbStats.db.size}</p>
                        <div className="w-12 h-1 bg-indigo-500 mx-auto mt-4 rounded-full" />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Cassandra Stats */}
                <div className="bg-gray-100 border border-gray-200 rounded-2xl p-6 shadow-xl">
                  <div className="flex items-start justify-between mb-6">
                    <div>
                      <h3 className="text-gray-900 font-bold text-base mb-1">Cassandra Database (Posts)</h3>
                      <p className="text-gray-400 text-xs">{t.admin.dbCassandraDesc}</p>
                    </div>
                    <div className="px-3 py-1 rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-400 text-[10px] font-bold uppercase tracking-wider">
                      Distributed Storage
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-8">
                    <div className="space-y-4">
                      <div>
                        <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-1.5">{t.admin.dbLocation}</p>
                        <div className="bg-gray-200 rounded-xl px-4 py-3 border border-gray-100 font-mono text-xs text-indigo-600 break-all leading-relaxed">
                          {dbStats.cassandra?.location}
                        </div>
                      </div>
                    </div>
                    <div className="space-y-10 flex flex-col justify-center">
                      <div className="text-center p-6 bg-gray-50 rounded-3xl border border-gray-100 relative overflow-hidden group">
                        <div className="absolute inset-0 bg-purple-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                        <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">{t.admin.dbCurrentDataSize}</p>
                        <p className="text-4xl font-black text-gray-900 tracking-tight">{dbStats.cassandra?.size}</p>
                        <div className="w-12 h-1 bg-purple-500 mx-auto mt-4 rounded-full" />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Object Files Stats */}
                <div className="bg-gray-100 border border-gray-200 rounded-2xl p-6 shadow-xl">
                  <div className="flex items-start justify-between mb-6">
                    <div>
                      <h3 className="text-gray-900 font-bold text-base mb-1">Object File Storage</h3>
                      <p className="text-gray-400 text-xs">{t.admin.dbObjectDesc}</p>
                    </div>
                    <div className="px-3 py-1 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-600 text-[10px] font-bold uppercase tracking-wider">
                      Stored Locally
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-8">
                    <div className="space-y-4">
                      <div>
                        <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-1.5">{t.admin.dbFolderLocation}</p>
                        <div className="bg-gray-200 rounded-xl px-4 py-3 border border-gray-100 font-mono text-xs text-indigo-600 break-all leading-relaxed">
                          {dbStats.objects.location}
                        </div>
                      </div>
                    </div>
                    <div className="space-y-10 flex flex-col justify-center">
                      <div className="text-center p-6 bg-gray-50 rounded-3xl border border-gray-100 relative overflow-hidden group">
                        <div className="absolute inset-0 bg-indigo-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                        <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">{t.admin.dbTotalObjectSize}</p>
                        <p className="text-4xl font-black text-indigo-600 tracking-tight">{dbStats.objects.size}</p>
                        <div className="w-12 h-1 bg-indigo-500/40 mx-auto mt-4 rounded-full" />
                      </div>
                    </div>
                  </div>
                </div>

                {/* LanceDB Stats */}
                <div className="bg-gray-100 border border-gray-200 rounded-2xl p-6 shadow-xl">
                  <div className="flex items-start justify-between mb-6">
                    <div>
                      <h3 className="text-gray-900 font-bold text-base mb-1">LanceDB (Vector Store)</h3>
                      <p className="text-gray-400 text-xs">{t.admin.dbLancedbDesc}</p>
                    </div>
                    <div className="px-3 py-1 rounded-full bg-teal-50 border border-teal-200 text-teal-700 text-[10px] font-bold uppercase tracking-wider">
                      Vector Store
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-8">
                    <div className="space-y-4">
                      <div>
                        <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-1.5">{t.admin.dbLancedbFolderLocation}</p>
                        <div className="w-full bg-gray-200 rounded-xl px-4 py-3 border border-gray-100 font-mono text-xs text-teal-700 break-all leading-relaxed">
                          {dbStats.lancedb?.location}
                        </div>
                      </div>
                    </div>
                    <div className="space-y-10 flex flex-col justify-center">
                      <div className="text-center p-6 bg-gray-50 rounded-3xl border border-gray-100 relative overflow-hidden group">
                        <div className="absolute inset-0 bg-teal-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                        <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">{t.admin.dbTotalVectorSize}</p>
                        <p className="text-4xl font-black text-teal-700 tracking-tight">{dbStats.lancedb?.size ?? '—'}</p>
                        <div className="w-12 h-1 bg-teal-500/40 mx-auto mt-4 rounded-full" />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Max Attachment File Size */}
                <div className="bg-gray-100 border border-gray-200 rounded-2xl p-6 shadow-xl">
                  <div className="flex items-start justify-between mb-6">
                    <div>
                      <h3 className="text-gray-900 font-bold text-base mb-1">{t.admin.maxAttachmentTitle}</h3>
                      <p className="text-gray-400 text-xs">{t.admin.maxAttachmentDesc}</p>
                    </div>
                    <div className="px-3 py-1 rounded-full bg-orange-50 border border-orange-500/20 text-orange-600 text-[10px] font-bold uppercase tracking-wider">
                      Upload
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-8">
                    <div className="space-y-4">
                      <div>
                        <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-1.5">{t.admin.maxAttachmentLabel}</p>
                        <div className="flex items-center gap-3">
                          <input
                            type="number"
                            min="1"
                            max="10240"
                            value={maxAttachmentFileSize}
                            onChange={e => setMaxAttachmentFileSizeLocal(e.target.value)}
                            className="w-32 bg-gray-200 rounded-xl px-4 py-3 border border-gray-100 font-mono text-sm text-orange-300 focus:outline-none focus:border-orange-500/50 transition-colors text-right"
                          />
                          <span className="text-gray-400 text-sm font-semibold">MB</span>
                        </div>
                        <p className="text-gray-300 text-[10px] mt-1.5">{t.admin.maxAttachmentHint}</p>
                      </div>
                    </div>
                    <div className="flex flex-col justify-center">
                      <div className="text-center p-6 bg-gray-50 rounded-3xl border border-gray-100 relative overflow-hidden group">
                        <div className="absolute inset-0 bg-orange-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                        <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">{t.admin.maxAttachmentCurrent}</p>
                        <p className="text-4xl font-black text-orange-600 tracking-tight">{maxAttachmentFileSize}</p>
                        <p className="text-gray-400 text-xs mt-2">MB</p>
                        <div className="w-12 h-1 bg-orange-500/40 mx-auto mt-4 rounded-full" />
                      </div>
                    </div>
                  </div>
                </div>

                {/* DM Message Retention */}
                <div className="bg-gray-100 border border-gray-200 rounded-2xl p-6 shadow-xl">
                  <div className="flex items-start justify-between mb-6">
                    <div>
                      <h3 className="text-gray-900 font-bold text-base mb-1">메시지 유지 조건 설정</h3>
                      <p className="text-gray-400 text-xs">다이렉트 메시지 첨부 파일 보존 기간을 설정합니다.</p>
                    </div>
                    <div className="px-3 py-1 rounded-full bg-indigo-50 border border-indigo-500/20 text-indigo-600 text-[10px] font-bold uppercase tracking-wider">
                      DM
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-8">
                    <div className="space-y-4">
                      <div>
                        <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-1.5">보존 기한 (일)</p>
                        <div className="flex items-center gap-3">
                          <input
                            type="number"
                            min="1"
                            max="90"
                            disabled={dmUnlimited}
                            value={dmRetentionDays}
                            onChange={e => setDmRetentionDays(e.target.value)}
                            className="w-32 bg-gray-200 rounded-xl px-4 py-3 border border-gray-100 font-mono text-sm text-indigo-400 focus:outline-none focus:border-indigo-500/50 transition-colors text-right disabled:opacity-40"
                          />
                          <span className="text-gray-400 text-sm font-semibold">일</span>
                        </div>
                        <p className="text-gray-300 text-[10px] mt-1.5">최소 1일 ~ 최대 90일</p>
                      </div>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={dmUnlimited}
                          onChange={e => setDmUnlimited(e.target.checked)}
                          className="w-4 h-4 rounded accent-indigo-600"
                        />
                        <span className="text-gray-600 text-sm">무제한 (영구 보관)</span>
                      </label>
                    </div>
                    <div className="flex flex-col justify-center">
                      <div className="text-center p-6 bg-gray-50 rounded-3xl border border-gray-100 relative overflow-hidden group">
                        <div className="absolute inset-0 bg-indigo-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                        <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">현재 설정</p>
                        {dmUnlimited ? (
                          <p className="text-2xl font-black text-indigo-600 tracking-tight">무제한</p>
                        ) : (
                          <>
                            <p className="text-4xl font-black text-indigo-600 tracking-tight">{dmRetentionDays}</p>
                            <p className="text-gray-400 text-xs mt-2">일</p>
                          </>
                        )}
                        <div className="w-12 h-1 bg-indigo-500/40 mx-auto mt-4 rounded-full" />
                      </div>
                    </div>
                  </div>
                </div>

              </div>
            ) : (
              <div className="text-center py-24 text-gray-300">
                {t.admin.noResults}
              </div>
            )}
          </div>
        ) : activeTab === 'rag' ? (
          <div className="max-w-4xl mx-auto py-4">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-gray-900 font-bold text-lg flex items-center gap-2">
                <svg className="w-5 h-5 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
                </svg>
                {t.admin.ragTabTitle}
              </h2>
              <button
                onClick={handleSaveConfig}
                disabled={savingConfig}
                className="flex items-center gap-2 px-6 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold transition-all shadow-lg shadow-indigo-200 active:scale-95"
              >
                {savingConfig ? t.admin.savingConfig : t.admin.saveSettings}
              </button>
            </div>

            {/* Status Info */}
            <div className="bg-amber-50 border border-amber-500/20 rounded-2xl p-6 mb-6">
              <div className="flex gap-3 text-amber-600">
                <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div className="text-xs leading-relaxed">
                  <p className="font-bold mb-1">{t.admin.ragNotice}</p>
                  {t.admin.ragNoticeDesc}
                </div>
              </div>
            </div>

            <div className="space-y-6">
              {/* 학습 시간 / 주기 설정 */}
              <div className="bg-gray-100 border border-gray-200 rounded-2xl p-8 shadow-xl">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-indigo-50 border border-indigo-200 flex items-center justify-center">
                    <svg className="w-5 h-5 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-gray-900 font-bold text-base">{t.admin.ragScheduleTitle}</h3>
                    <p className="text-gray-400 text-xs mt-0.5">{t.admin.ragScheduleDesc}</p>
                  </div>
                </div>

                <div className="space-y-4">
                  {/* Option 1: Daily */}
                  <label className={`flex items-center gap-4 p-5 rounded-2xl border transition-all cursor-pointer ${ragForm.type === 'daily' ? 'bg-indigo-50 border-indigo-500/50' : 'bg-gray-50 border-gray-100 hover:border-gray-200'}`}>
                    <input
                      type="radio"
                      name="ragType"
                      checked={ragForm.type === 'daily'}
                      onChange={() => setRagForm(p => ({ ...p, type: 'daily' }))}
                      className="w-4 h-4 text-indigo-600 bg-gray-200 border-gray-300 focus:ring-indigo-500"
                    />
                    <div className="flex-1">
                      <p className="text-gray-900 font-semibold text-sm">{t.admin.ragDailyLabel}</p>
                      <p className="text-gray-400 text-xs mt-1">{t.admin.ragDailyDesc}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>
                      <input
                        type="time"
                        value={ragForm.time}
                        onChange={e => setRagForm(p => ({ ...p, time: e.target.value }))}
                        disabled={ragForm.type !== 'daily'}
                        className="bg-gray-200 border border-gray-200 rounded-lg px-3 py-2 text-gray-900 text-sm focus:outline-none focus:border-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed"
                      />
                      <span className="text-gray-400 text-xs">{t.admin.ragDailyStartLabel}</span>
                    </div>
                  </label>

                  {/* Option 2: Immediate */}
                  <label className={`flex items-start gap-4 p-5 rounded-2xl border transition-all cursor-pointer ${ragForm.type === 'immediate' ? 'bg-indigo-50 border-indigo-500/50' : 'bg-gray-50 border-gray-100 hover:border-gray-200'}`}>
                    <input
                      type="radio"
                      name="ragType"
                      checked={ragForm.type === 'immediate'}
                      onChange={() => setRagForm(p => ({ ...p, type: 'immediate' }))}
                      className="mt-1 w-4 h-4 text-indigo-600 bg-gray-200 border-gray-300 focus:ring-indigo-500"
                    />
                    <div className="flex-1">
                      <p className="text-gray-900 font-semibold text-sm">{t.admin.ragImmediateLabel}</p>
                      <p className="text-gray-400 text-xs mt-1">{t.admin.ragImmediateDesc}</p>
                    </div>
                  </label>

                  {/* Option 3: Manual */}
                  <label className={`flex items-start gap-4 p-5 rounded-2xl border transition-all cursor-pointer ${ragForm.type === 'manual' ? 'bg-indigo-50 border-indigo-500/50' : 'bg-gray-50 border-gray-100 hover:border-gray-200'}`}>
                    <input
                      type="radio"
                      name="ragType"
                      checked={ragForm.type === 'manual'}
                      onChange={() => setRagForm(p => ({ ...p, type: 'manual' }))}
                      className="mt-1 w-4 h-4 text-indigo-600 bg-gray-200 border-gray-300 focus:ring-indigo-500"
                    />
                    <div className="flex-1">
                      <p className="text-gray-900 font-semibold text-sm">{t.admin.ragManualLabel}</p>
                      <p className="text-gray-400 text-xs mt-1">{t.admin.ragManualDesc}</p>
                      {ragForm.type === 'manual' && (
                        <div className="mt-4">
                          <button
                            onClick={handleStartTraining}
                            disabled={trainingStatus === 'running'}
                            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-gray-200 text-white text-sm font-bold transition-all shadow-lg shadow-blue-600/20 active:scale-95"
                          >
                            {trainingStatus === 'running' ? (
                              <>
                                <div className="w-3 h-3 border-2 border-blue-300 border-t-white rounded-full animate-spin" />
                                {t.admin.ragTrainingWaiting}
                              </>
                            ) : (
                              <>
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                {t.admin.ragStartNow}
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
              <div className="bg-gray-100 border border-gray-200 rounded-2xl p-8 shadow-xl">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-teal-50 border border-teal-200 flex items-center justify-center">
                    <svg className="w-5 h-5 text-teal-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-gray-900 font-bold text-base">{t.admin.ragVectorSizeTitle}</h3>
                    <p className="text-gray-400 text-xs mt-0.5">{t.admin.ragVectorSizeDesc}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-3">
                  {[256, 512, 1024, 1536, 2048, 4096, 8192].map(size => (
                    <button
                      key={size}
                      onClick={() => setRagForm(p => ({ ...p, vectorSize: size }))}
                      className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-all border ${
                        ragForm.vectorSize === size
                          ? 'bg-teal-500/20 border-teal-500/60 text-teal-700 shadow-lg shadow-teal-500/10'
                          : 'bg-gray-50 border-gray-100 text-gray-400 hover:text-gray-500 hover:border-gray-200'
                      }`}
                    >
                      {size.toLocaleString()}
                    </button>
                  ))}
                </div>
                <p className="text-gray-300 text-xs mt-4">
                  {t.admin.ragCurrentSelection(ragForm.vectorSize?.toLocaleString())}
                </p>
              </div>

              {/* Chunk Size / Overlap */}
              <div className="bg-gray-100 border border-gray-200 rounded-2xl p-8 shadow-xl">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center">
                    <svg className="w-5 h-5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h8m-8 6h16" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-gray-900 font-bold text-base">{t.admin.ragChunkTitle}</h3>
                    <p className="text-gray-400 text-xs mt-0.5">{t.admin.ragChunkDesc}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-3">
                      {t.admin.ragChunkSizeLabel} <span className="text-gray-300 normal-case font-normal">(chunk_size)</span>
                    </p>
                    <div className="bg-gray-200 rounded-xl px-4 py-3 border border-gray-100 flex items-center gap-3 focus-within:border-violet-500/50 transition-colors">
                      <input
                        type="number"
                        min={100}
                        max={10000}
                        step={100}
                        value={ragForm.chunkSize}
                        onChange={e => setRagForm(p => ({ ...p, chunkSize: e.target.value }))}
                        className="bg-transparent text-2xl font-black text-gray-900 w-24 focus:outline-none"
                      />
                      <span className="text-gray-300 text-sm">{t.admin.ragChunkUnit}</span>
                    </div>
                  </div>
                  <div>
                    <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-3">
                      {t.admin.ragChunkOverlapLabel} <span className="text-gray-300 normal-case font-normal">(chunk_overlap)</span>
                    </p>
                    <div className="bg-gray-200 rounded-xl px-4 py-3 border border-gray-100 flex items-center gap-3 focus-within:border-violet-500/50 transition-colors">
                      <input
                        type="number"
                        min={0}
                        max={ragForm.chunkSize}
                        step={10}
                        value={ragForm.chunkOverlap}
                        onChange={e => setRagForm(p => ({ ...p, chunkOverlap: e.target.value }))}
                        className="bg-transparent text-2xl font-black text-gray-900 w-24 focus:outline-none"
                      />
                      <span className="text-gray-300 text-sm">{t.admin.ragChunkUnit}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* RAG 학습 옵션 */}
              <div className="bg-gray-100 border border-gray-200 rounded-2xl p-8 shadow-xl">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-cyan-50 border border-cyan-200 flex items-center justify-center">
                    <svg className="w-5 h-5 text-cyan-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999A7 7 0 103 15z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-gray-900 font-bold text-base">{t.admin.ragLearningOptionsTitle || 'RAG 학습 옵션'}</h3>
                    <p className="text-gray-400 text-xs mt-0.5">{t.admin.ragLearningOptionsDesc || 'PDF 학습 전략 옵션을 선택합니다.'}</p>
                  </div>
                </div>
                <div>
                  <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-3">
                    {t.admin.ragPdfStrategyLabel || 'PDF 학습 전략 옵션'}
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <label className={`flex items-start gap-3 rounded-xl border p-4 cursor-pointer transition-all ${ragForm.pdfParseStrategy === 'auto' ? 'bg-cyan-50 border-cyan-300' : 'bg-gray-50 border-gray-100 hover:border-gray-200'}`}>
                      <input
                        type="radio"
                        name="pdfParseStrategy"
                        checked={ragForm.pdfParseStrategy === 'auto'}
                        onChange={() => setRagForm(p => ({ ...p, pdfParseStrategy: 'auto' }))}
                        className="mt-0.5 w-4 h-4 text-cyan-700 bg-gray-100 border-gray-300 focus:ring-cyan-500"
                      />
                      <div>
                        <p className="text-gray-900 font-semibold text-sm">auto</p>
                        <p className="text-gray-400 text-xs mt-1">{t.admin.ragPdfStrategyAutoDesc || '컨텐츠에 따라서 학습 채널을 가변하는 옵션입니다.'}</p>
                      </div>
                    </label>
                    <label className={`flex items-start gap-3 rounded-xl border p-4 cursor-pointer transition-all ${ragForm.pdfParseStrategy === 'fast' ? 'bg-cyan-50 border-cyan-300' : 'bg-gray-50 border-gray-100 hover:border-gray-200'}`}>
                      <input
                        type="radio"
                        name="pdfParseStrategy"
                        checked={ragForm.pdfParseStrategy === 'fast'}
                        onChange={() => setRagForm(p => ({ ...p, pdfParseStrategy: 'fast' }))}
                        className="mt-0.5 w-4 h-4 text-cyan-700 bg-gray-100 border-gray-300 focus:ring-cyan-500"
                      />
                      <div>
                        <p className="text-gray-900 font-semibold text-sm">fast</p>
                        <p className="text-gray-400 text-xs mt-1">{t.admin.ragPdfStrategyFastDesc || '빠르게 학습하는 옵션입니다.'}</p>
                      </div>
                    </label>
                    <label className={`flex items-start gap-3 rounded-xl border p-4 cursor-pointer transition-all ${ragForm.pdfParseStrategy === 'hi-res' ? 'bg-cyan-50 border-cyan-300' : 'bg-gray-50 border-gray-100 hover:border-gray-200'}`}>
                      <input
                        type="radio"
                        name="pdfParseStrategy"
                        checked={ragForm.pdfParseStrategy === 'hi-res'}
                        onChange={() => setRagForm(p => ({ ...p, pdfParseStrategy: 'hi-res' }))}
                        className="mt-0.5 accent-cyan-600"
                      />
                      <div>
                        <p className="text-gray-900 font-semibold text-sm">hi-res</p>
                        <p className="text-gray-400 text-xs mt-1">{t.admin.ragPdfStrategyHiResDesc || '정확도를 우선하여 고해상도 파싱으로 학습합니다.'}</p>
                      </div>
                    </label>
                  </div>
                </div>
              </div>

              {/* RAG 학습 페이지 이동 */}
              <div className="bg-gray-100 border border-gray-200 rounded-2xl p-6 shadow-xl">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h3 className="text-gray-900 font-bold text-base">{t.admin.ragLearningPageTitle || 'RAG 학습 페이지'}</h3>
                    <p className="text-gray-400 text-xs mt-0.5">{t.admin.ragLearningPageDesc || '학습 데이터 추가/삭제 후 학습을 시작합니다.'}</p>
                  </div>
                  <button
                    onClick={() => setActiveTab('rag-learning')}
                    className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-all"
                  >
                    {t.admin.ragLearningPageButton || 'RAG 학습 페이지'}
                  </button>
                </div>
              </div>


            </div>
          </div>
        ) : activeTab === 'rag-learning' ? (
          <div className="max-w-5xl mx-auto py-4">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-gray-900 font-bold text-lg flex items-center gap-2">
                <svg className="w-5 h-5 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6M7 4h10a2 2 0 012 2v12a2 2 0 01-2 2H7a2 2 0 01-2-2V6a2 2 0 012-2z" />
                </svg>
                {t.admin.ragLearningPageTitle || 'RAG 학습 페이지'}
              </h2>
              <button
                onClick={() => setActiveTab('rag')}
                className="px-4 py-2 rounded-xl border border-gray-200 text-gray-600 hover:text-gray-900 hover:bg-gray-100 text-sm"
              >
                {t.admin.backToRagSettings || 'RAG 설정으로 돌아가기'}
              </button>
            </div>

            <div className="bg-gray-100 border border-gray-200 rounded-2xl p-6 shadow-xl">
              <div className="flex items-center gap-3 mb-6">
                <input
                  ref={ragDatasetFileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  accept=".pdf,.txt,.md,.csv,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx"
                  onChange={async (e) => {
                    const files = Array.from(e.target.files || [])
                    e.target.value = ''
                    await handleAddRagDatasets(files)
                  }}
                />
                <button
                  onClick={() => ragDatasetFileInputRef.current?.click()}
                  disabled={ragDatasetUploading}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold"
                >
                  {ragDatasetUploading ? (t.admin.ragAddingData || '추가 중...') : (t.admin.ragAddData || '학습 데이터 추가')}
                </button>
                <button
                  onClick={handleStartRagDatasetTraining}
                  disabled={ragDatasetTraining || ragDatasets.filter(item => item.status !== 'trained').length === 0}
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-semibold"
                >
                  {ragDatasetTraining ? (t.admin.ragTrainingNow || '학습 중...') : (t.admin.ragStartTraining || '학습 시작')}
                </button>
                <button
                  onClick={handleDeleteSelectedRagDatasets}
                  disabled={ragDatasetSelectedIds.length === 0}
                  className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-sm font-semibold"
                >
                  {t.admin.ragDeleteFromData || '학습 데이터에서 삭제'}
                </button>
                <button
                  onClick={() => setShowRagResetConfirm(true)}
                  disabled={ragResetting || ragDatasets.length === 0}
                  className="ml-auto px-4 py-2 rounded-xl bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white text-sm font-semibold"
                >
                  {ragResetting ? '초기화 중...' : (t.admin.ragResetVectors || '학습 벡터 초기화')}
                </button>
              </div>

              <div
                className={`rounded-2xl border-2 overflow-hidden bg-gray-50 relative transition-colors ${ragTableDragOver ? 'border-dashed border-indigo-400 bg-indigo-50/40' : 'border-gray-200'}`}
                onDragEnter={e => {
                  e.preventDefault(); e.stopPropagation()
                  ragTableDragCounter.current += 1
                  if (e.dataTransfer.types.includes('Files')) setRagTableDragOver(true)
                }}
                onDragLeave={e => {
                  e.preventDefault(); e.stopPropagation()
                  ragTableDragCounter.current -= 1
                  if (ragTableDragCounter.current === 0) setRagTableDragOver(false)
                }}
                onDragOver={e => { e.preventDefault(); e.stopPropagation() }}
                onDrop={async e => {
                  e.preventDefault(); e.stopPropagation()
                  ragTableDragCounter.current = 0
                  setRagTableDragOver(false)
                  const files = Array.from(e.dataTransfer.files || [])
                  if (files.length > 0) await handleAddRagDatasets(files)
                }}
              >
                {ragTableDragOver && (
                  <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
                    <p className="text-indigo-500 font-semibold text-sm bg-white/80 px-4 py-2 rounded-xl shadow">파일을 놓으면 학습 데이터에 추가됩니다</p>
                  </div>
                )}
                <table className="w-full text-sm">
                  <thead className="bg-gray-100 border-b border-gray-200">
                    <tr>
                      <th className="px-4 py-3 text-left w-12">
                        <input
                          type="checkbox"
                          checked={ragDatasets.length > 0 && ragDatasetSelectedIds.length === ragDatasets.length}
                          ref={el => { if (el) el.indeterminate = ragDatasetSelectedIds.length > 0 && ragDatasetSelectedIds.length < ragDatasets.length }}
                          onChange={e => {
                            setRagDatasetSelectedIds(e.target.checked ? ragDatasets.map(item => item.id) : [])
                          }}
                          onClick={e => e.stopPropagation()}
                        />
                      </th>
                      <th className="px-4 py-3 text-left">{t.admin.ragDataName || '학습 데이터'}</th>
                      <th className="px-4 py-3 text-left w-28">{t.admin.ragDataType || '형식'}</th>
                      <th className="px-4 py-3 text-left w-24">{t.admin.ragDataSize || '크기'}</th>
                      <th className="px-4 py-3 text-left w-32">{t.admin.ragDataStatus || '상태'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ragDatasets.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-10 text-center text-gray-400">
                          {t.admin.ragNoDataset || '학습 데이터가 없습니다.'}
                        </td>
                      </tr>
                    ) : ragDatasets.map(item => {
                      const selected = ragDatasetSelectedIds.includes(item.id)
                      return (
                        <tr
                          key={item.id}
                          className={`border-b border-gray-200 last:border-b-0 ${selected ? 'bg-indigo-50/60' : ''}`}
                          onClick={() => {
                            setRagDatasetSelectedIds(prev => (
                              prev.includes(item.id)
                                ? prev.filter(id => id !== item.id)
                                : [...prev, item.id]
                            ))
                          }}
                        >
                          <td className="px-4 py-3">
                            <input type="checkbox" readOnly checked={selected} />
                          </td>
                          <td className="px-4 py-3 text-gray-800">{item.filename}</td>
                          <td className="px-4 py-3 text-gray-500 uppercase">{item.ext || '-'}</td>
                          <td className="px-4 py-3 text-gray-500">{((item.size || 0) / 1024).toFixed(1)} KB</td>
                          <td className="px-4 py-3">
                            {item.status === 'trained' ? (
                              <span className="text-emerald-600 font-medium">trained</span>
                            ) : item.status === 'failed' ? (
                              <span className="text-red-600 font-medium">failed</span>
                            ) : (
                              <span className="text-gray-500 font-medium">ready</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : activeTab === 'display' ? (
          <div className="max-w-4xl mx-auto py-4">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-gray-900 font-bold text-lg flex items-center gap-2">
                <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                {t.admin.displayTabTitle}
              </h2>
              <button
                onClick={handleSaveConfig}
                disabled={savingConfig}
                className="flex items-center gap-2 px-6 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold transition-all shadow-lg shadow-indigo-200 active:scale-95"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                </svg>
                {savingConfig ? t.admin.savingConfig : t.admin.displaySaveBtn}
              </button>
            </div>

            {dbLoading ? (
              <div className="flex flex-col items-center justify-center py-24 text-gray-400">
                <div className="w-8 h-8 border-2 border-indigo-200 border-t-indigo-500 rounded-full animate-spin mb-4" />
                <p className="text-sm">{t.admin.displayLoading}</p>
              </div>
            ) : dbStats?.display ? (
              <div className="space-y-6 pb-20">
                {/* Image Preview */}
                <PreviewSettingCard
                  title={t.admin.previewImageTitle}
                  description={t.admin.previewImageDesc}
                  value={displayForm.imagePreview}
                  onChange={(val) => setDisplayForm(p => ({ ...p, imagePreview: val }))}
                />

                <PreviewSettingCard
                  title={t.admin.previewPdfTitle}
                  description={t.admin.previewPdfDesc}
                  value={displayForm.pdfPreview}
                  onChange={(val) => setDisplayForm(p => ({ ...p, pdfPreview: val }))}
                />

                <PreviewSettingCard
                  title={t.admin.previewTxtTitle}
                  description={t.admin.previewTxtDesc}
                  value={displayForm.txtPreview}
                  onChange={(val) => setDisplayForm(p => ({ ...p, txtPreview: val }))}
                />

                <div className="grid grid-cols-2 gap-6">
                  {/* PPT Preview */}
                  <PreviewSettingCard
                    title={t.admin.previewPptTitle}
                    description={t.admin.previewPptDesc}
                    value={displayForm.pptPreview}
                    onChange={(val) => setDisplayForm(p => ({ ...p, pptPreview: val }))}
                  />

                  {/* PPTX Preview */}
                  <PreviewSettingCard
                    title={t.admin.previewPptxTitle}
                    description={t.admin.previewPptxDesc}
                    value={displayForm.pptxPreview}
                    onChange={(val) => setDisplayForm(p => ({ ...p, pptxPreview: val }))}
                  />

                  {/* Excel Preview */}
                  <PreviewSettingCard
                    title={t.admin.previewExcelTitle}
                    description={t.admin.previewExcelDesc}
                    value={displayForm.excelPreview}
                    onChange={(val) => setDisplayForm(p => ({ ...p, excelPreview: val }))}
                  />

                  {/* Word Preview */}
                  <PreviewSettingCard
                    title={t.admin.previewWordTitle}
                    description={t.admin.previewWordDesc}
                    value={displayForm.wordPreview}
                    onChange={(val) => setDisplayForm(p => ({ ...p, wordPreview: val }))}
                  />

                  {/* Movie Preview */}
                  <PreviewSettingCard
                    title={t.admin.previewMovieTitle}
                    description={t.admin.previewMovieDesc}
                    value={displayForm.moviePreview}
                    onChange={(val) => setDisplayForm(p => ({ ...p, moviePreview: val }))}
                  />

                  {/* HTML Preview */}
                  <PreviewSettingCard
                    title={t.admin.previewHtmlTitle}
                    description={t.admin.previewHtmlDesc}
                    value={displayForm.htmlPreview}
                    onChange={(val) => setDisplayForm(p => ({ ...p, htmlPreview: val }))}
                  />
                </div>
              </div>
            ) : (
              <div className="text-center py-24 text-gray-300">
                {t.admin.displayNoInfo}
              </div>
            )}
          </div>
        ) : activeTab === 'agenticai' ? (
          <div className="max-w-4xl mx-auto py-4">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-gray-900 font-bold text-lg flex items-center gap-2">
                <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                {t.admin.agenticaiTabTitle}
              </h2>
              <button
                onClick={handleSaveConfig}
                disabled={savingConfig}
                className="flex items-center gap-2 px-6 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold transition-all shadow-lg shadow-indigo-200 active:scale-95"
              >
                {savingConfig ? t.admin.savingConfig : t.admin.saveSettings}
              </button>
            </div>

            <div className="space-y-8">
              {/* num_predict */}
              <div className="bg-gray-100 border border-gray-200 rounded-2xl p-8 shadow-xl">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-green-500/10 border border-green-500/20 flex items-center justify-center">
                    <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-gray-900 font-bold text-base">{t.admin.agenticaiNumPredictTitle}</h3>
                    <p className="text-gray-400 text-xs mt-0.5">{t.admin.agenticaiNumPredictDesc}</p>
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
                          : 'bg-gray-50 border-gray-100 text-gray-400 hover:text-gray-500 hover:border-gray-200'
                      }`}
                    >
                      {size.toLocaleString()}
                    </button>
                  ))}
                </div>
              </div>

              {/* num_ctx */}
              <div className="bg-gray-100 border border-gray-200 rounded-2xl p-8 shadow-xl">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                    <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-gray-900 font-bold text-base">{t.admin.agenticaiNumCtxTitle}</h3>
                    <p className="text-gray-400 text-xs mt-0.5">{t.admin.agenticaiNumCtxDesc}</p>
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
                          : 'bg-gray-50 border-gray-100 text-gray-400 hover:text-gray-500 hover:border-gray-200'
                      }`}
                    >
                      {size.toLocaleString()}
                    </button>
                  ))}
                </div>
              </div>

              {/* history */}
              <div className="bg-gray-100 border border-gray-200 rounded-2xl p-8 shadow-xl">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
                    <svg className="w-5 h-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-gray-900 font-bold text-base">{t.admin.agenticaiHistoryTitle}</h3>
                    <p className="text-gray-400 text-xs mt-0.5">{t.admin.agenticaiHistoryDesc}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-3">
                  {[2, 4, 6, 8, 16, 32, 64].map(n => (
                    <button
                      key={n}
                      onClick={() => setAgenticaiForm(p => ({ ...p, history: n }))}
                      className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-all border ${
                        agenticaiForm.history === n
                          ? 'bg-purple-500/20 border-purple-500/60 text-purple-700 shadow-lg shadow-purple-500/10'
                          : 'bg-gray-50 border-gray-100 text-gray-400 hover:text-gray-500 hover:border-gray-200'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              {/* default language */}
              <div className="bg-gray-100 border border-gray-200 rounded-2xl p-8 shadow-xl">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                    <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9A18.022 18.022 0 016.412 9m6.088 9h7m-7 0a3 3 0 100-6 3 3 0 000 6zm0 0v3m0-3a3 3 0 01-3-3m3 3a3 3 0 003-3" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-gray-900 font-bold text-base">{t.admin.agenticaiLanguageTitle}</h3>
                    <p className="text-gray-400 text-xs mt-0.5">{t.admin.agenticaiLanguageDesc}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-3">
                  {[
                    { value: 'ko', label: t.admin.agenticaiLangKo },
                    { value: 'ja', label: t.admin.agenticaiLangJa },
                    { value: 'en', label: t.admin.agenticaiLangEn },
                    { value: 'zh', label: t.admin.agenticaiLangZh },
                  ].map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setAgenticaiForm(p => ({ ...p, language: opt.value }))}
                      className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-all border ${
                        agenticaiForm.language === opt.value
                          ? 'bg-amber-500/20 border-amber-500/60 text-amber-700 shadow-lg shadow-amber-500/10'
                          : 'bg-gray-50 border-gray-100 text-gray-400 hover:text-gray-500 hover:border-gray-200'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="p-6 bg-gray-50 border border-dashed border-gray-200 rounded-2xl flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-indigo-50 flex items-center justify-center text-indigo-600">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div>
                  <p className="text-gray-900 text-xs font-semibold mb-0.5">{t.admin.agenticaiSettingNote}</p>
                  <p className="text-gray-400 text-[10px]">{t.admin.agenticaiSettingNoteDesc}</p>
                </div>
              </div>
            </div>
          </div>
        ) : activeTab === 'company' ? (
          <div className="max-w-2xl mx-auto py-4">
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-gray-900 font-bold text-lg flex items-center gap-2">
                  <svg className="w-5 h-5 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                  </svg>
                  {t.admin.companyTabTitle}
                </h2>
                <p className="text-gray-400 text-xs mt-1">{t.admin.companyTabDesc}</p>
              </div>
              <button
                onClick={handleSaveConfig}
                disabled={savingConfig}
                className="flex items-center gap-2 px-6 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold transition-all shadow-lg shadow-indigo-200 active:scale-95"
              >
                {savingConfig ? t.admin.savingConfig : t.admin.saveSettings}
              </button>
            </div>

            <div className="space-y-5">
              {/* 회사 도장 */}
              <div className="bg-gray-100 border border-gray-200 rounded-2xl p-6">
                <label className="block text-gray-700 text-sm font-semibold mb-3">{t.admin.companySeal}</label>
                <input
                  ref={companyFileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={e => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    const reader = new FileReader()
                    reader.onload = ev => setCompanyForm(p => ({ ...p, seal: ev.target.result }))
                    reader.readAsDataURL(file)
                    e.target.value = ''
                  }}
                />
                <div className="flex items-center gap-5">
                  <button
                    type="button"
                    onClick={() => companyFileInputRef.current?.click()}
                    className="relative group w-24 h-24 rounded-xl border-2 border-dashed border-gray-300 hover:border-indigo-400 bg-gray-50 hover:bg-indigo-50/40 transition-colors flex items-center justify-center overflow-hidden flex-shrink-0"
                  >
                    {companyForm.seal ? (
                      <>
                        <img src={companyForm.seal} alt="회사 도장" className="w-full h-full object-contain" />
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center rounded-xl">
                          <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                          </svg>
                        </div>
                      </>
                    ) : (
                      <svg className="w-8 h-8 text-gray-300 group-hover:text-indigo-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                      </svg>
                    )}
                  </button>
                  <div>
                    <p className="text-gray-500 text-sm">{t.admin.companySealHint}</p>
                    {companyForm.seal && (
                      <button
                        type="button"
                        onClick={() => setCompanyForm(p => ({ ...p, seal: '' }))}
                        className="mt-2 text-xs text-red-400 hover:text-red-600 transition-colors"
                      >
                        {t.admin.companySealDelete}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* 회사 로고 */}
              <div className="bg-gray-100 border border-gray-200 rounded-2xl p-6">
                <label className="block text-gray-700 text-sm font-semibold mb-3">{t.admin.companyLogo}</label>
                <input
                  ref={companyLogoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={e => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    const reader = new FileReader()
                    reader.onload = ev => setCompanyForm(p => ({ ...p, logo: ev.target.result }))
                    reader.readAsDataURL(file)
                    e.target.value = ''
                  }}
                />
                <div className="flex items-center gap-5">
                  <button
                    type="button"
                    onClick={() => companyLogoInputRef.current?.click()}
                    className="relative group w-24 h-24 rounded-xl border-2 border-dashed border-gray-300 hover:border-indigo-400 bg-gray-50 hover:bg-indigo-50/40 transition-colors flex items-center justify-center overflow-hidden flex-shrink-0"
                  >
                    {companyForm.logo ? (
                      <>
                        <img src={companyForm.logo} alt="회사 로고" className="w-full h-full object-contain" />
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center rounded-xl">
                          <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                          </svg>
                        </div>
                      </>
                    ) : (
                      <svg className="w-8 h-8 text-gray-300 group-hover:text-indigo-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                      </svg>
                    )}
                  </button>
                  <div>
                    <p className="text-gray-500 text-sm">{t.admin.companyLogoHint}</p>
                    {companyForm.logo && (
                      <button
                        type="button"
                        onClick={() => setCompanyForm(p => ({ ...p, logo: '' }))}
                        className="mt-2 text-xs text-red-400 hover:text-red-600 transition-colors"
                      >
                        {t.admin.companyLogoDelete}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* 텍스트 필드들 */}
              {[
                { key: 'name',     label: t.admin.companyName,     placeholder: 'SiliconCube' },
                { key: 'address',  label: t.admin.companyAddress,  placeholder: '경기도 성남시 수정구 창업로 54...' },
                { key: 'phone',    label: t.admin.companyPhone,    placeholder: '032-837-6270' },
                { key: 'homepage', label: t.admin.companyHomepage, placeholder: 'www.example.co.kr' },
                { key: 'fax',      label: t.admin.companyFax,      placeholder: '032-837-6271' },
              ].map(({ key, label, placeholder }) => (
                <div key={key} className="bg-gray-100 border border-gray-200 rounded-2xl p-5">
                  <label className="block text-gray-700 text-sm font-semibold mb-2">{label}</label>
                  {key === 'address' ? (
                    <textarea
                      value={companyForm[key]}
                      onChange={e => setCompanyForm(p => ({ ...p, [key]: e.target.value }))}
                      placeholder={placeholder}
                      rows={2}
                      className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-300 transition-all resize-none"
                    />
                  ) : (
                    <input
                      type="text"
                      value={companyForm[key]}
                      onChange={e => setCompanyForm(p => ({ ...p, [key]: e.target.value }))}
                      placeholder={placeholder}
                      className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-300 transition-all"
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : activeTab === 'sns' ? (
          <div className="max-w-4xl mx-auto py-4">
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-3">
                <svg className="w-6 h-6 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 3H3a2 2 0 00-2 2v14l4-4h16a2 2 0 002-2V5a2 2 0 00-2-2z" />
                </svg>
                <h2 className="text-gray-900 font-bold text-lg">{t.admin.snsTitle}</h2>
              </div>
              <button
                onClick={handleSaveConfig}
                disabled={savingConfig}
                className="flex items-center gap-2 px-6 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold transition-all shadow-lg shadow-indigo-200 active:scale-95"
              >
                {savingConfig ? t.admin.savingConfig : t.admin.saveSettings}
              </button>
            </div>

            <div className="space-y-6">
              <div className="bg-indigo-50 border border-indigo-200 rounded-2xl px-6 py-5">
                <p className="text-indigo-700 text-sm font-medium">{t.admin.snsDescription}</p>
              </div>

              <div className="bg-gray-100 border border-gray-200 rounded-2xl p-6 shadow-xl">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-gray-900 font-bold text-base">{t.admin.snsKakaoTitle}</h3>
                    <p className="text-gray-400 text-xs mt-1">{t.admin.snsKakaoDesc}</p>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-gray-600">
                    <input
                      type="checkbox"
                      checked={snsForm.kakao.enabled}
                      onChange={e => setSnsForm(p => ({ ...p, kakao: { ...p.kakao, enabled: e.target.checked } }))}
                      className="w-4 h-4 rounded accent-indigo-600"
                    />
                    {t.admin.snsEnabled}
                  </label>
                </div>
                <label className="block text-gray-500 text-xs font-medium mb-1.5">{t.admin.snsApiKey}</label>
                <input
                  type="text"
                  value={snsForm.kakao.apiKey}
                  onChange={e => setSnsForm(p => ({ ...p, kakao: { ...p.kakao, apiKey: e.target.value } }))}
                  placeholder={t.admin.snsApiKeyPlaceholder}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-300 transition-all"
                />
              </div>

              <div className="bg-gray-100 border border-gray-200 rounded-2xl p-6 shadow-xl">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-gray-900 font-bold text-base">{t.admin.snsLineTitle}</h3>
                    <p className="text-gray-400 text-xs mt-1">{t.admin.snsLineDesc}</p>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-gray-600">
                    <input
                      type="checkbox"
                      checked={snsForm.line.enabled}
                      onChange={e => setSnsForm(p => ({ ...p, line: { ...p.line, enabled: e.target.checked } }))}
                      className="w-4 h-4 rounded accent-indigo-600"
                    />
                    {t.admin.snsEnabled}
                  </label>
                </div>
                <label className="block text-gray-500 text-xs font-medium mb-1.5">{t.admin.snsChannelAccessToken}</label>
                <input
                  type="text"
                  value={snsForm.line.channelAccessToken}
                  onChange={e => setSnsForm(p => ({ ...p, line: { ...p.line, channelAccessToken: e.target.value } }))}
                  placeholder={t.admin.snsChannelAccessTokenPlaceholder}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-300 transition-all"
                />
              </div>

              <div className="bg-gray-100 border border-gray-200 rounded-2xl p-6 shadow-xl">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-gray-900 font-bold text-base">{t.admin.snsTelegramTitle}</h3>
                    <p className="text-gray-400 text-xs mt-1">{t.admin.snsTelegramDesc}</p>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-gray-600">
                    <input
                      type="checkbox"
                      checked={snsForm.telegram.enabled}
                      onChange={e => setSnsForm(p => ({ ...p, telegram: { ...p.telegram, enabled: e.target.checked } }))}
                      className="w-4 h-4 rounded accent-indigo-600"
                    />
                    {t.admin.snsEnabled}
                  </label>
                </div>
                <label className="block text-gray-500 text-xs font-medium mb-1.5">{t.admin.snsTelegramBotName}</label>
                <input
                  type="text"
                  value={snsForm.telegram.botName}
                  onChange={e => setSnsForm(p => ({ ...p, telegram: { ...p.telegram, botName: e.target.value } }))}
                  placeholder={t.admin.snsTelegramBotNamePlaceholder}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-300 transition-all"
                />
                <label className="block text-gray-500 text-xs font-medium mb-1.5 mt-3">{t.admin.snsTelegramBotUserName}</label>
                <input
                  type="text"
                  value={snsForm.telegram.botUserName}
                  onChange={e => setSnsForm(p => ({ ...p, telegram: { ...p.telegram, botUserName: e.target.value } }))}
                  placeholder={t.admin.snsTelegramBotUserNamePlaceholder}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-300 transition-all"
                />
                <label className="block text-gray-500 text-xs font-medium mb-1.5 mt-3">{t.admin.snsTelegramHttpApiToken}</label>
                <input
                  type="text"
                  value={snsForm.telegram.httpApiToken}
                  onChange={e => setSnsForm(p => ({ ...p, telegram: { ...p.telegram, httpApiToken: e.target.value } }))}
                  placeholder={t.admin.snsTelegramHttpApiTokenPlaceholder}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-300 transition-all"
                />

                {/* Webhook 등록 */}
                <div className="mt-5 p-4 bg-indigo-50 border border-indigo-200 rounded-xl">
                  <p className="text-indigo-800 text-xs font-semibold mb-1">텔레그램 Webhook 등록</p>
                  <p className="text-indigo-600 text-xs mb-3">
                    사용자가 봇에게 메시지를 보내면 chat_id가 자동 저장됩니다. 서버의 공개 URL을 입력하세요.
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={telegramWebhookUrl}
                      onChange={e => { setTelegramWebhookUrl(e.target.value); setTelegramWebhookStatus(null) }}
                      placeholder="https://yourserver.com/api/sns/telegram/webhook"
                      className="flex-1 bg-white border border-indigo-200 rounded-lg px-3 py-2 text-gray-900 text-xs placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/40 focus:border-indigo-400 transition-all"
                    />
                    <button
                      type="button"
                      onClick={handleSetTelegramWebhook}
                      disabled={!telegramWebhookUrl.trim() || telegramWebhookStatus === 'loading'}
                      className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                    >
                      {telegramWebhookStatus === 'loading' ? '...' : '등록'}
                    </button>
                  </div>
                  {telegramWebhookRegistered && (
                    <p className="mt-2 text-xs text-green-700">
                      ✓ 현재 등록된 URL: <span className="font-mono">{telegramWebhookRegistered}</span>
                    </p>
                  )}
                  {telegramWebhookStatus === 'ok' && !telegramWebhookRegistered && (
                    <p className="mt-2 text-xs text-green-700">✓ 웹훅이 등록되었습니다.</p>
                  )}
                  {telegramWebhookStatus === 'error' && (
                    <p className="mt-2 text-xs text-red-600">{telegramWebhookError}</p>
                  )}
                  <p className="mt-3 text-indigo-500 text-xs">
                    ① 설정 저장 후 위 URL 등록 → ② 각 사용자가 봇({snsForm.telegram.botUserName || '@봇이름'})에게 아무 메시지나 전송 → ③ chat_id 자동 연동
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : activeTab === 'reset' ? (
          <div className="max-w-2xl mx-auto py-12">
            <div className="bg-red-50 border border-red-200 rounded-3xl p-10 shadow-2xl overflow-hidden relative">
              <div className="absolute top-0 right-0 w-64 h-64 bg-red-500/5 blur-[100px] -mr-32 -mt-32" />
              
              <div className="flex flex-col items-center text-center relative z-10">
                <div className="w-20 h-20 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mb-8">
                  <svg className="w-10 h-10 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>

                <h2 className="text-3xl font-black text-gray-900 mb-4">{t.admin.resetSectionTitle}</h2>
                <div className="space-y-4 px-6 mb-10 text-red-800 leading-relaxed font-medium">
                  <p>{t.admin.resetSectionDesc1}</p>
                  <p className="text-red-600 font-bold text-lg">{t.admin.resetSectionDesc2}</p>
                </div>

                <div className="w-full bg-white border border-red-200 rounded-2xl p-8 mb-8">
                  <p className="text-gray-600 text-sm mb-4">{t.admin.resetHint(t.admin.resetConfirmWord)}</p>
                  <input
                    type="text"
                    value={resetConfirmation}
                    onChange={e => setResetConfirmation(e.target.value)}
                    placeholder={t.admin.resetConfirmPlaceholder}
                    className="w-full bg-red-50 border border-red-300 rounded-xl px-5 py-3.5 text-gray-900 text-lg font-bold placeholder-red-300 text-center focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500 transition-all"
                  />
                </div>

                <button
                  onClick={handleExecuteReset}
                  disabled={resetConfirmation !== t.admin.resetConfirmWord || executingReset}
                  className={`w-full py-4 rounded-2xl font-black text-lg transition-all flex items-center justify-center gap-3 ${
                    resetConfirmation === t.admin.resetConfirmWord && !executingReset
                      ? 'bg-red-600 hover:bg-red-500 text-white shadow-xl shadow-red-600/25 active:scale-[0.98]'
                      : 'bg-gray-100 text-gray-200 cursor-not-allowed border border-gray-100'
                  }`}
                >
                  {executingReset ? (
                    <>
                      <div className="w-5 h-5 border-2 border-gray-300 border-t-white rounded-full animate-spin" />
                      {t.admin.resetRunning}
                    </>
                  ) : (
                    <>
                      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      {t.admin.resetExecute}
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        ) : null}
        </div>

        {/* Right Side: GROQ Panel */}
        {showLocalAgenticPanel && (
          <div className="h-full border-l border-gray-100">
            <GroqPanel />
          </div>
        )}
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
      {pendingDeleteUser && (
        <ConfirmDialog
          title={t.admin.delete}
          message={t.admin.deleteConfirm(pendingDeleteUser.name)}
          confirmText={t.admin.delete}
          cancelText={t.admin.cancel}
          danger
          onConfirm={confirmDeleteUser}
          onCancel={() => setPendingDeleteUser(null)}
        />
      )}
      {showRagTrainingConfirm && (
        <ConfirmDialog
          title={t.admin.ragStartNow}
          message={t.admin.ragTrainingConfirm}
          confirmText={t.admin.ragStartNow}
          cancelText={t.admin.cancel}
          loading={trainingStatus === 'running'}
          onConfirm={confirmStartTraining}
          onCancel={() => setShowRagTrainingConfirm(false)}
        />
      )}
      {ragTrainingDoneMessage && (
        <ConfirmDialog
          title={t.admin.ragStartTraining || 'RAG 학습'}
          message={ragTrainingDoneMessage}
          confirmText={t.admin.confirm || '확인'}
          hideCancel
          onConfirm={() => setRagTrainingDoneMessage(null)}
          onCancel={() => setRagTrainingDoneMessage(null)}
        />
      )}
      {showRagResetConfirm && (
        <ConfirmDialog
          title={t.admin.ragResetVectors || '학습 벡터 초기화'}
          message={t.admin.ragResetConfirm || '학습된 모든 벡터 데이터를 삭제합니다.\n파일 목록은 유지되며 상태가 "ready"로 초기화됩니다.\n계속하시겠습니까?'}
          confirmText={t.admin.ragResetVectors || '초기화'}
          cancelText={t.admin.cancel || '취소'}
          danger
          loading={ragResetting}
          onConfirm={handleRagResetVectors}
          onCancel={() => setShowRagResetConfirm(false)}
        />
      )}
      {saveConfigDialogMessage && (
        <ConfirmDialog
          title={t.admin.saveSettings || '설정 저장'}
          message={saveConfigDialogMessage}
          confirmText={t.admin.confirm || '확인'}
          hideCancel
          onConfirm={() => setSaveConfigDialogMessage('')}
          onCancel={() => setSaveConfigDialogMessage('')}
        />
      )}
    </div>
  )
}

function PreviewSettingCard({ title, description, value, onChange }) {
  const t = useT()
  return (
    <div className="bg-gray-100 border border-gray-200 rounded-2xl p-6 shadow-xl h-full flex flex-col">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h3 className="text-gray-900 font-bold text-sm mb-1">{title}</h3>
          <p className="text-gray-400 text-[11px] leading-relaxed">
            {description}
          </p>
        </div>
        <div className="px-2 py-0.5 rounded-full bg-amber-50 border border-amber-500/20 text-amber-600 text-[9px] font-bold uppercase tracking-wider shrink-0">
          Preview
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mt-auto">
        <div className="bg-black/40 rounded-xl px-4 py-3 border border-gray-100 flex flex-col focus-within:border-indigo-500/50 transition-colors">
          <p className="text-gray-400 text-[9px] uppercase font-bold mb-1">{t.admin.previewWidthLabel}</p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={value.width}
              onChange={e => onChange({ ...value, width: e.target.value })}
              className="bg-transparent text-xl font-black text-gray-900 w-full focus:outline-none"
            />
            <span className="text-sm font-normal text-gray-300 shrink-0">px</span>
          </div>
        </div>
        <div className="bg-black/40 rounded-xl px-4 py-3 border border-gray-100 flex flex-col focus-within:border-indigo-500/50 transition-colors">
          <p className="text-gray-400 text-[9px] uppercase font-bold mb-1">{t.admin.previewHeightLabel}</p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={value.height}
              onChange={e => onChange({ ...value, height: e.target.value })}
              className="bg-transparent text-xl font-black text-gray-900 w-full focus:outline-none"
            />
            <span className="text-sm font-normal text-gray-300 shrink-0">px</span>
          </div>
        </div>
      </div>
    </div>
  )
}
