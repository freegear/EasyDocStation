import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { ROLE_LABELS, ROLE_BADGE } from '../constants/roles'
import { useT } from '../i18n/useT'

export default function UserProfileModal({ onClose }) {
  const { currentUser, updateProfile } = useAuth()
  const t = useT()
  const [tab, setTab] = useState('info')   // 'info' | 'password'

  const [name, setName] = useState(currentUser?.name ?? '')
  const [email, setEmail] = useState(currentUser?.email ?? '')
  const [imageUrl, setImageUrl] = useState(currentUser?.image_url ?? '')

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
      await updateProfile({ name, email, image_url: imageUrl })
      setSuccess(t.profile.successInfo)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
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

      <div className="relative w-full max-w-md bg-[#1e1c30] rounded-3xl border border-white/10 shadow-2xl shadow-black/50 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h2 className="text-white font-bold text-base">{t.profile.title}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg text-white/30 hover:text-white hover:bg-white/10 flex items-center justify-center transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Current user summary */}
        <div className="px-6 py-4 border-b border-white/8 flex items-center gap-4">
          <div className="relative group">
            <div className="w-16 h-16 rounded-full bg-indigo-500 overflow-hidden flex items-center justify-center text-white font-bold text-xl flex-shrink-0 border-2 border-white/10">
              {imageUrl ? (
                <img src={imageUrl} alt={currentUser?.name} className="w-full h-full object-cover" />
              ) : (
                currentUser?.avatar
              )}
            </div>
            <label className="absolute inset-0 flex items-center justify-center bg-black/60 text-white opacity-0 group-hover:opacity-100 cursor-pointer transition-opacity rounded-full">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 011.664.89l.812 1.22A2 2 0 0010.07 10H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <input type="file" className="hidden" accept="image/*" onChange={handleImageUpload} />
            </label>
          </div>
          <div>
            <p className="text-white font-semibold text-lg">{currentUser?.name}</p>
            <p className="text-white/40 text-sm">{currentUser?.email}</p>
            <span className={`inline-block mt-1 px-2 py-0.5 rounded-md text-xs font-medium border ${roleBadge}`}>
              {roleLabel}
            </span>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-white/8">
          {tabs.map(tb => (
            <button
              key={tb.key}
              onClick={() => { setTab(tb.key); clearMessages() }}
              className={`flex-1 py-3 text-sm font-medium transition-colors ${
                tab === tb.key
                  ? 'text-white border-b-2 border-indigo-500'
                  : 'text-white/40 hover:text-white/70'
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
              <Field label={t.profile.username} value={currentUser?.username ?? ''} disabled />
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
      <label className="block text-white/50 text-xs font-medium mb-1.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange?.(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
      />
    </div>
  )
}
