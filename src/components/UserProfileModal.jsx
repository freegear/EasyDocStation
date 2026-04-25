import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useChat } from '../contexts/ChatContext'
import { ROLE_BADGE } from '../constants/roles'
import { useT } from '../i18n/useT'

export default function UserProfileModal({ onClose, onSaved }) {
  const { currentUser, updateProfile } = useAuth()
  const { teams = [] } = useChat()
  const t = useT()

  const [name, setName] = useState(currentUser?.name ?? '')
  const [displayName, setDisplayName] = useState(currentUser?.display_name ?? '')
  const [email, setEmail] = useState(currentUser?.email ?? '')
  const [phone, setPhone] = useState(currentUser?.phone ?? '')
  const [telegramId, setTelegramId] = useState(currentUser?.telegram_id ?? '')
  const [kakaoTalkApiKey, setKakaoTalkApiKey] = useState(currentUser?.kakaotalk_api_key ?? '')
  const [lineChannelAccessToken, setLineChannelAccessToken] = useState(currentUser?.line_channel_access_token ?? '')
  const [useSnsChannel, setUseSnsChannel] = useState(currentUser?.use_sns_channel ?? '')
  const [imageUrl, setImageUrl] = useState(currentUser?.image_url ?? '')
  const [stampPicture, setStampPicture] = useState(currentUser?.stamp_picture ?? '')

  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')

  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')

  const imageInputRef = useRef(null)
  const stampInputRef = useRef(null)

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  function clearMessages() {
    setError('')
    setSuccess('')
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

  async function handleImageUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError(t.profile.imageOnly)
      return
    }
    clearMessages()
    try {
      const base64 = await resizeImageToBase64(file, 256, 256)
      setImageUrl(base64)
    } catch (err) {
      setError(t.profile.imageUploadFail(err.message))
    }
    e.target.value = ''
  }

  async function handleStampUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError(t.profile.imageOnly)
      return
    }
    clearMessages()
    try {
      const base64 = await resizeImageToBase64(file, 256, 256)
      setStampPicture(base64)
    } catch (err) {
      setError(t.profile.imageUploadFail(err.message))
    }
    e.target.value = ''
  }

  async function handleSaveInfo(e) {
    e.preventDefault()
    clearMessages()

    const tryingPasswordChange = Boolean(newPw || confirmPw)
    if (tryingPasswordChange) {
      if (!currentPw) {
        setError(t.profile.currentPasswordPlaceholder || t.profile.currentPassword)
        return
      }
      if (newPw.length < 6) {
        setError(t.profile.passwordTooShort)
        return
      }
      if (newPw !== confirmPw) {
        setError(t.profile.passwordMismatch)
        return
      }
    }

    setSaving(true)
    try {
      const payload = {
        name,
        display_name: displayName || null,
        email,
        phone,
        telegram_id: telegramId || null,
        kakaotalk_api_key: kakaoTalkApiKey || null,
        line_channel_access_token: lineChannelAccessToken || null,
        use_sns_channel: useSnsChannel || null,
        image_url: imageUrl,
        stamp_picture: stampPicture || null,
      }
      if (tryingPasswordChange) {
        payload.currentPassword = currentPw
        payload.newPassword = newPw
      }

      await updateProfile(payload)
      setCurrentPw('')
      setNewPw('')
      setConfirmPw('')
      onSaved?.()
      onClose?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const roleBadge = ROLE_BADGE[currentUser?.role] ?? ROLE_BADGE.user
  const roleLabel = t.roles?.[currentUser?.role] ?? currentUser?.role ?? ''
  const teamName = currentUser?.department_id
    ? (teams.find(tm => tm.id === currentUser.department_id)?.name || currentUser.department_id)
    : (t.profile.noDepartment || t.admin.noDepartment || '-')
  const securityLabel = t.admin.securityLevels?.[currentUser?.security_level ?? 0] ?? String(currentUser?.security_level ?? 0)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-5xl bg-gray-50 rounded-3xl border border-gray-200 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <h2 className="text-gray-900 font-bold text-base">{t.profile.title}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg text-gray-400 hover:text-gray-900 hover:bg-gray-200 flex items-center justify-center transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form noValidate onSubmit={handleSaveInfo} className="px-6 py-5 flex flex-col gap-4 overflow-y-auto">
          {error && (
            <div className="px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">{error}</div>
          )}
          {success && (
            <div className="px-4 py-2.5 rounded-xl bg-green-500/10 border border-green-500/25 text-green-400 text-sm">{success}</div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-2 border-b border-gray-100 mb-2">
            <div className="flex items-center gap-4 p-4 rounded-2xl bg-gray-50 border border-gray-200">
              <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
              <button type="button" onClick={() => imageInputRef.current?.click()} className="relative group flex-shrink-0 rounded-full focus:outline-none">
                <div className="w-32 h-32 rounded-full bg-indigo-500 overflow-hidden flex items-center justify-center text-white font-bold text-3xl border border-gray-200">
                  {imageUrl ? (
                    <img src={imageUrl} alt={currentUser?.name} className="w-full h-full object-cover" />
                  ) : (
                    currentUser?.avatar
                  )}
                </div>
                <div className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
              </button>
              <div className="flex-1">
                <p className="text-gray-700 text-sm font-medium">{t.admin.profileImageTitle || t.profile.imageFile}</p>
                <p className="text-gray-400 text-xs mt-0.5">{t.admin.clickToSelectImage || t.profile.imageHint}</p>
              </div>
            </div>

            <div className="flex items-center gap-4 p-4 rounded-2xl bg-gray-50 border border-gray-200">
              <input ref={stampInputRef} type="file" className="hidden" accept="image/*" onChange={handleStampUpload} />
              <button
                type="button"
                onClick={() => stampInputRef.current?.click()}
                className="relative group flex-shrink-0 w-32 h-32 rounded-xl border-2 border-dashed border-gray-300 hover:border-indigo-400 bg-gray-50 hover:bg-indigo-50/40 transition-colors focus:outline-none flex items-center justify-center overflow-hidden"
              >
                {stampPicture ? (
                  <>
                    <img src={stampPicture} alt="stamp" className="w-full h-full object-contain" />
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
                <p className="text-gray-700 text-sm font-medium">{t.admin.stampImageTitle || t.profile.stampPicture}</p>
                <p className="text-gray-400 text-xs mt-0.5">{t.admin.stampImageHint || t.profile.stampHint}</p>
                {stampPicture && (
                  <button type="button" onClick={() => setStampPicture('')} className="mt-1 text-xs text-red-400 hover:text-red-600 transition-colors">
                    {t.admin.deleteText || t.profile.stampDelete}
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ReadOnlyField label="User ID" value={currentUser?.id || '-'} mono />
            <ReadOnlyField label={t.profile.username || t.admin.labelUsername} value={currentUser?.username || '-'} mono />

            <Field label={t.admin.labelName || t.profile.name} value={name} onChange={setName} placeholder={t.admin.placeholderName || t.profile.name} />
            <Field label={t.admin.labelDisplayName || 'Display Name'} value={displayName} onChange={setDisplayName} placeholder={t.admin.placeholderDisplayName || 'Display Name'} />
            <Field label={t.admin.labelEmail || t.profile.email} type="email" value={email} onChange={setEmail} placeholder={t.admin.placeholderEmail || 'user@example.com'} />
            <Field label={t.admin.labelPhone || t.profile.phone} value={phone} onChange={setPhone} placeholder={t.admin.placeholderPhone || t.profile.phonePlaceholder} />

            <ReadOnlyField
              label={t.profile.role || t.admin.labelRole}
              value={
                <span className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium border ${roleBadge}`}>
                  {roleLabel}
                </span>
              }
            />
            <ReadOnlyField label={t.admin.labelSecurityLevel || 'Security Level'} value={securityLabel} />

            <div className="md:col-span-2">
              <ReadOnlyField label={t.profile.department || t.admin.labelDepartment} value={teamName} />
            </div>

            <div className="md:col-span-2 p-4 rounded-2xl bg-gray-50 border border-gray-200">
              <p className="text-gray-900 text-sm font-semibold mb-3">{t.admin.navSns || 'SNS'}</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label={t.admin.labelTelegramId || t.profile.telegramId} value={telegramId} onChange={setTelegramId} placeholder={t.admin.placeholderTelegramId || t.profile.telegramIdPlaceholder} />
                <Field label={t.admin.labelKakaoTalkApiKey || t.profile.kakaoTalkApiKey} value={kakaoTalkApiKey} onChange={setKakaoTalkApiKey} placeholder={t.admin.placeholderKakaoTalkApiKey || t.profile.kakaoTalkApiKeyPlaceholder} />
                <Field label={t.admin.labelLineChannelAccessToken || t.profile.lineChannelAccessToken} value={lineChannelAccessToken} onChange={setLineChannelAccessToken} placeholder={t.admin.placeholderLineChannelAccessToken || t.profile.lineChannelAccessTokenPlaceholder} />
                <div>
                  <label className="block text-gray-500 text-xs font-medium mb-1.5">{t.admin.labelUseSnsChannel || t.profile.useSnsChannel}</label>
                  <select
                    value={useSnsChannel}
                    onChange={e => setUseSnsChannel(e.target.value)}
                    className="w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-300 transition-all"
                  >
                    <option value="">{t.profile.optionNone}</option>
                    <option value="telegram">{t.profile.optionTelegram}</option>
                    <option value="kakaotalk">{t.profile.optionKakaoTalk}</option>
                    <option value="line">{t.profile.optionLineMessenger}</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="md:col-span-2 p-4 rounded-2xl bg-gray-50 border border-gray-200">
              <p className="text-gray-900 text-sm font-semibold mb-3">{t.admin.passwordGroupTitle || t.profile.changePassword}</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Field label={t.profile.currentPassword} type="password" value={currentPw} onChange={setCurrentPw} placeholder={t.profile.currentPasswordPlaceholder} />
                <Field label={t.profile.newPassword} type="password" value={newPw} onChange={setNewPw} placeholder={t.admin.placeholderPasswordNew || t.profile.passwordMinLength} />
                <Field label={t.profile.confirmPassword} type="password" value={confirmPw} onChange={setConfirmPw} placeholder={t.admin.placeholderPasswordConfirm || t.profile.passwordReenter} />
              </div>
            </div>
          </div>

          <div className="flex gap-2 pt-1 pb-1">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-xl text-gray-500 hover:text-gray-700 text-sm border border-gray-200 hover:bg-gray-100 transition-colors">
              {t.admin.cancel || '취소'}
            </button>
            <button type="submit" disabled={saving} className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-semibold transition-colors">
              {saving ? (t.profile.saving || t.admin.saving) : (t.profile.save || t.admin.save)}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function Field({ label, type = 'text', value, onChange, placeholder }) {
  return (
    <div>
      <label className="block text-gray-500 text-xs font-medium mb-1.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange?.(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-300 transition-all"
      />
    </div>
  )
}

function ReadOnlyField({ label, value, mono = false }) {
  return (
    <div>
      <label className="block text-gray-500 text-xs font-medium mb-1.5">{label}</label>
      <div className={`w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-2.5 text-sm text-gray-500 ${mono ? 'font-mono' : ''}`}>
        {value}
      </div>
    </div>
  )
}
