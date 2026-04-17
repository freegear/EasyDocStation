import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useChat } from '../contexts/ChatContext'
import { ROLE_LABELS, ROLE_BADGE } from '../constants/roles'
import { useT } from '../i18n/useT'

export default function UserProfileModal({ onClose }) {
  const { currentUser, updateProfile } = useAuth()
  const { teams = [] } = useChat()
  const t = useT()
  const [tab, setTab] = useState('info')   // 'info' | 'password'

  const [name, setName] = useState(currentUser?.name ?? '')
  const [email, setEmail] = useState(currentUser?.email ?? '')
  const [phone, setPhone] = useState(currentUser?.phone ?? '')
  const [imageUrl, setImageUrl] = useState(currentUser?.image_url ?? '')
  const [stampPicture, setStampPicture] = useState(currentUser?.stamp_picture ?? '')
  const stampInputRef = useRef(null)

  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')

  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  function clearMessages() { setError(''); setSuccess('') }

  async function handleSaveInfo(e) {
    e.preventDefault()
    clearMessages()
    setSaving(true)
    try {
      await updateProfile({ name, email, phone, image_url: imageUrl, stamp_picture: stampPicture || null })
      setSuccess(t.profile.successInfo)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleStampUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) { setError(t.profile.imageOnly); return }
    setSaving(true)
    clearMessages()
    try {
      const base64 = await resizeImageToBase64(file, 120, 120)
      setStampPicture(base64)
      await updateProfile({ stamp_picture: base64 })
      setSuccess(t.profile.stampUploadSuccess)
    } catch (err) {
      setError(t.profile.imageUploadFail(err.message))
    } finally {
      setSaving(false)
    }
    e.target.value = ''
  }

  async function handleImageUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError(t.profile.imageOnly)
      return
    }

    setSaving(true)
    clearMessages()
    try {
      const base64 = await resizeImageToBase64(file, 100, 100)
      setImageUrl(base64)
      await updateProfile({ image_url: base64 })
      setSuccess(t.profile.imageUploadSuccess)
    } catch (err) {
      setError(t.profile.imageUploadFail(err.message))
    } finally {
      setSaving(false)
    }
  }

  function resizeImageToBase64(file, maxW, maxH) {
    return new Promise((resolve, reject) => {
      const img = new Image()
      const url = URL.createObjectURL(file)
      img.onload = () => {
        URL.revokeObjectURL(url)
        const canvas = document.createElement('canvas')
        canvas.width = maxW
        canvas.height = maxH
        const ctx = canvas.getContext('2d')
        const scale = Math.max(maxW / img.width, maxH / img.height)
        const sw = maxW / scale
        const sh = maxH / scale
        const sx = (img.width - sw) / 2
        const sy = (img.height - sh) / 2
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, maxW, maxH)
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      }
      img.onerror = reject
      img.src = url
    })
  }

  async function handleChangePassword(e) {
    e.preventDefault()
    clearMessages()
    if (newPw !== confirmPw) { setError(t.profile.passwordMismatch); return }
    if (newPw.length < 6) { setError(t.profile.passwordTooShort); return }
    setSaving(true)
    try {
      await updateProfile({ currentPassword: currentPw, newPassword: newPw })
      setSuccess(t.profile.successPassword)
      setCurrentPw(''); setNewPw(''); setConfirmPw('')
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const roleBadge = ROLE_BADGE[currentUser?.role] ?? ROLE_BADGE.user
  const roleLabel = ROLE_LABELS[currentUser?.role] ?? ''

  const tabs = [
    { key: 'info', label: t.profile.tabInfoFull },
    { key: 'password', label: t.profile.tabPassword },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-md bg-gray-50 rounded-3xl border border-gray-200 shadow-2xl shadow-gray-400/30 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-gray-900 font-bold text-base">{t.profile.title}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg text-gray-400 hover:text-gray-900 hover:bg-gray-200 flex items-center justify-center transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Current user summary */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center gap-4">
          {/* 프로필 사진 */}
          <div className="relative group flex-shrink-0">
            <div className="w-16 h-16 rounded-full bg-indigo-500 overflow-hidden flex items-center justify-center text-white font-bold text-xl border-2 border-gray-200">
              {imageUrl ? (
                <img src={imageUrl} alt={currentUser?.name} className="w-full h-full object-cover" />
              ) : (
                currentUser?.avatar
              )}
            </div>
            <label className="absolute inset-0 flex items-center justify-center bg-black/60 text-gray-900 opacity-0 group-hover:opacity-100 cursor-pointer transition-opacity rounded-full">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 011.664.89l.812 1.22A2 2 0 0010.07 10H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <input type="file" className="hidden" accept="image/*" onChange={handleImageUpload} />
            </label>
          </div>
          {/* 도장 이미지 */}
          <div className="relative group flex-shrink-0">
            <input ref={stampInputRef} type="file" className="hidden" accept="image/*" onChange={handleStampUpload} />
            <button
              type="button"
              onClick={() => stampInputRef.current?.click()}
              title={t.profile.stampHint}
              className="w-14 h-14 rounded-xl border-2 border-dashed border-gray-300 hover:border-indigo-400 bg-gray-50 hover:bg-indigo-50/40 transition-colors flex items-center justify-center overflow-hidden relative group"
            >
              {stampPicture ? (
                <>
                  <img src={stampPicture} alt="도장" className="w-full h-full object-contain" />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center rounded-xl">
                    <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 011.664.89l.812 1.22A2 2 0 0010.07 10H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    </svg>
                  </div>
                </>
              ) : (
                <svg className="w-6 h-6 text-gray-300 group-hover:text-indigo-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                </svg>
              )}
            </button>
            <p className="text-center text-gray-400 text-[10px] mt-0.5 leading-tight">{t.profile.stampPicture}</p>
          </div>
          {/* 사용자 정보 */}
          <div className="flex-1 min-w-0">
            <p className="text-gray-900 font-semibold text-lg truncate">{currentUser?.name}</p>
            <p className="text-gray-400 text-sm truncate">{currentUser?.email}</p>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium border ${roleBadge}`}>
                {roleLabel}
              </span>
              {currentUser?.department_id && (
                <span className="inline-block px-2 py-0.5 rounded-md text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200">
                  {teams.find(t => t.id === currentUser.department_id)?.name || currentUser.department_id}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200">
          {tabs.map(tb => (
            <button
              key={tb.key}
              onClick={() => { setTab(tb.key); clearMessages() }}
              className={`flex-1 py-3 text-sm font-medium transition-colors ${
                tab === tb.key
                  ? 'text-gray-900 border-b-2 border-indigo-500'
                  : 'text-gray-400 hover:text-gray-600'
              }`}
            >
              {tb.label}
            </button>
          ))}
        </div>

        <div className="px-6 py-5">
          {/* Alert */}
          {error && (
            <div className="mb-4 px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">{error}</div>
          )}
          {success && (
            <div className="mb-4 px-4 py-2.5 rounded-xl bg-green-500/10 border border-green-500/25 text-green-400 text-sm">{success}</div>
          )}

          {/* Basic info tab */}
          {tab === 'info' && (
            <form onSubmit={handleSaveInfo} className="flex flex-col gap-4">
              <Field label={t.profile.name} value={name} onChange={setName} placeholder={t.profile.name} />
              <Field label={t.profile.email} type="email" value={email} onChange={setEmail} placeholder="email@example.com" />
              <Field label={t.profile.phone} value={phone} onChange={setPhone} placeholder={t.profile.phonePlaceholder} />
              <Field label={t.profile.username} value={currentUser?.username ?? ''} disabled />

              {/* 권한 (읽기 전용) */}
              <div>
                <label className="block text-gray-500 text-xs font-medium mb-1.5">{t.profile.role}</label>
                <div className="w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-500 text-sm flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded-md text-xs font-medium border ${roleBadge}`}>{roleLabel}</span>
                </div>
              </div>

              {/* 부서 (읽기 전용) */}
              <div>
                <label className="block text-gray-500 text-xs font-medium mb-1.5">{t.profile.department}</label>
                <div className="w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-500 text-sm">
                  {currentUser?.department_id
                    ? (teams.find(tm => tm.id === currentUser.department_id)?.name || currentUser.department_id)
                    : t.profile.noDepartment}
                </div>
              </div>

              {/* 도장 이미지 삭제 버튼 */}
              {stampPicture && (
                <div className="flex items-center justify-between px-4 py-2.5 rounded-xl bg-gray-50 border border-gray-200">
                  <span className="text-gray-600 text-sm">{t.profile.stampPicture}</span>
                  <button
                    type="button"
                    onClick={async () => {
                      setStampPicture('')
                      await updateProfile({ stamp_picture: null }).catch(() => {})
                    }}
                    className="text-xs text-red-400 hover:text-red-600 transition-colors"
                  >
                    {t.profile.stampDelete}
                  </button>
                </div>
              )}

              <button
                type="submit"
                disabled={saving}
                className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-semibold transition-colors"
              >
                {saving ? t.profile.saving : t.profile.save}
              </button>
            </form>
          )}

          {/* Password tab */}
          {tab === 'password' && (
            <form onSubmit={handleChangePassword} className="flex flex-col gap-4">
              <Field label={t.profile.currentPassword} type="password" value={currentPw} onChange={setCurrentPw} placeholder={t.profile.currentPasswordPlaceholder} />
              <Field label={t.profile.newPassword} type="password" value={newPw} onChange={setNewPw} placeholder={t.profile.passwordMinLength} />
              <Field label={t.profile.confirmPassword} type="password" value={confirmPw} onChange={setConfirmPw} placeholder={t.profile.passwordReenter} />
              <button
                type="submit"
                disabled={saving || !currentPw || !newPw || !confirmPw}
                className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-semibold transition-colors"
              >
                {saving ? t.profile.changingPassword : t.profile.changePassword}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({ label, type = 'text', value, onChange, placeholder, disabled }) {
  return (
    <div>
      <label className="block text-gray-500 text-xs font-medium mb-1.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange?.(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-300 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
      />
    </div>
  )
}
