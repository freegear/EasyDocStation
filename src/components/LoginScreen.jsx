import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useT } from '../i18n/useT'

const LANGUAGES = [
  { code: 'ko', label: '한국어' },
  { code: 'en', label: 'English' },
]

export default function LoginScreen() {
  const { login, language, setLanguage } = useAuth()
  const t = useT()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isLocked, setIsLocked] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setIsLocked(false)
    setLoading(true)
    try {
      await login(email, password)
    } catch (err) {
      const msg = err.message || t.login.loginFailed
      if (msg.includes(t.login.lockedKeyword) || msg.includes('locked')) {
        setIsLocked(true)
      }
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#0f0e1a] flex items-center justify-center px-4">
      {/* Background gradient */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-indigo-600/20 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 left-1/3 w-64 h-64 bg-purple-600/15 rounded-full blur-3xl" />
      </div>

      {/* Language toggle (top-right) */}
      <div className="absolute top-5 right-5 flex items-center bg-white/6 border border-white/10 rounded-lg overflow-hidden">
        {LANGUAGES.map(lang => (
          <button
            key={lang.code}
            onClick={() => setLanguage(lang.code)}
            className={`px-2.5 py-1 text-xs font-medium transition-all ${
              language === lang.code
                ? 'bg-indigo-600 text-white'
                : 'text-white/40 hover:text-white/70 hover:bg-white/5'
            }`}
          >
            {lang.label}
          </button>
        ))}
      </div>

      <div className="relative w-full max-w-md">
        {/* Card */}
        <div className="bg-[#1a1830]/90 backdrop-blur border border-white/10 rounded-3xl p-8 shadow-2xl">
          {/* Logo */}
          <div className="flex flex-col items-center mb-8">
            <div className="flex items-center gap-3 mb-4">
              <img src="/img/logo.png" alt="Logo" className="w-12 h-12 object-contain" />
              <h1 className="text-white font-bold text-3xl tracking-tight">EasyStation</h1>
            </div>
            <p className="text-white/40 text-sm mt-1">{t.login.welcome}</p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label className="block text-white/60 text-sm mb-1.5 font-medium">{t.login.email}</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder={t.login.emailPlaceholder}
                required
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/20 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
              />
            </div>
            <div>
              <label className="block text-white/60 text-sm mb-1.5 font-medium">{t.login.password}</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={t.login.passwordPlaceholder}
                required
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/20 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
              />
            </div>

            {error && (
              <div className={`border rounded-xl px-4 py-3 text-sm ${
                isLocked
                  ? 'bg-orange-500/10 border-orange-500/30 text-orange-400'
                  : 'bg-red-500/10 border-red-500/30 text-red-400'
              }`}>
                {isLocked && (
                  <div className="flex items-center gap-2 mb-1 font-semibold">
                    <span>🔒</span>
                    <span>{t.login.accountLocked}</span>
                  </div>
                )}
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full mt-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white font-semibold py-3 rounded-xl transition-all text-sm shadow-lg shadow-indigo-500/20 flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>{t.login.submitting}</span>
                </>
              ) : (
                t.login.submit
              )}
            </button>
          </form>

          {/* Demo accounts */}
          <div className="mt-6 pt-6 border-t border-white/10">
            <p className="text-white/30 text-xs text-center mb-3">{t.login.demoAccounts}</p>
            <div className="flex flex-col gap-2">
              {[
                { email: 'kevin@easydocstation.com', name: 'Kevin Im (Admin)' },
                { email: 'alice@easydocstation.com', name: 'Alice Kim (Member)' },
                { email: 'bob@easydocstation.com', name: 'Bob Lee (Member)' },
              ].map(u => (
                <button
                  key={u.email}
                  type="button"
                  onClick={() => { setEmail(u.email); setPassword('password123') }}
                  className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/5 text-white/50 hover:text-white/80 text-xs transition-all"
                >
                  <span>{u.name}</span>
                  <span className="text-white/20">{u.email}</span>
                </button>
              ))}
            </div>
            <p className="text-white/20 text-xs text-center mt-3">{t.login.demoPassword}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
