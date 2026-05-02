import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useT } from '../i18n/useT'

const LANGUAGES = [
  { code: 'ko', label: '한국어' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
]

export default function LoginScreen() {
  const { login, loginWithProvider, language, setLanguage, logoutNotice, clearLogoutNotice } = useAuth()
  const t = useT()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isLocked, setIsLocked] = useState(false)
  const [loading, setLoading] = useState(false)
  const [oauthLoading, setOauthLoading] = useState('')
  const [isDuplicateLogin, setIsDuplicateLogin] = useState(false)
  const [pendingDuplicateCredentials, setPendingDuplicateCredentials] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setIsLocked(false)
    setIsDuplicateLogin(false)
    setPendingDuplicateCredentials(null)
    setLoading(true)
    try {
      await login(identifier, password)
    } catch (err) {
      const msg = err.message || t.login.loginFailed
      if (err.code === 'DUPLICATE_LOGIN' || msg.includes('이미 동일한 정보로')) {
        setPendingDuplicateCredentials({ identifier, password })
        setIsDuplicateLogin(true)
        setLoading(false)
        return
      }
      if (msg.includes(t.login.lockedKeyword) || msg.includes('locked')) {
        setIsLocked(true)
      }
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  async function handleOAuthLogin(provider) {
    setError('')
    setOauthLoading(provider)
    try {
      await loginWithProvider(provider)
    } catch (err) {
      setError(err.message || '소셜 로그인 중 오류가 발생했습니다.')
    } finally {
      setOauthLoading('')
    }
  }

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center px-4">
      {/* 중복 로그인 Dialog */}
      {logoutNotice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl p-6 mx-4 w-full max-w-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M3 12a9 9 0 1118 0 9 9 0 01-18 0z" />
                </svg>
              </div>
              <h2 className="text-gray-900 font-semibold text-base">자동 로그아웃</h2>
            </div>
            <p className="text-gray-600 text-sm mb-6 whitespace-pre-wrap">{logoutNotice}</p>
            <button
              onClick={clearLogoutNotice}
              className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-2.5 rounded-xl text-sm transition-all"
            >
              확인
            </button>
          </div>
        </div>
      )}
      {/* 중복 로그인 Dialog */}
      {isDuplicateLogin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl p-6 mx-4 w-full max-w-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-yellow-100 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-yellow-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                </svg>
              </div>
              <h2 className="text-gray-900 font-semibold text-base">{t.login.duplicateLoginTitle}</h2>
            </div>
            <p className="text-gray-600 text-sm mb-6">{t.login.duplicateLoginMessage}</p>
            <button
              onClick={async () => {
                if (!pendingDuplicateCredentials) {
                  setIsDuplicateLogin(false)
                  return
                }
                setLoading(true)
                setError('')
                try {
                  await login(
                    pendingDuplicateCredentials.identifier,
                    pendingDuplicateCredentials.password,
                    { forceRelogin: true }
                  )
                  setIsDuplicateLogin(false)
                  setPendingDuplicateCredentials(null)
                } catch (err) {
                  setError(err.message || t.login.loginFailed)
                  setIsDuplicateLogin(false)
                } finally {
                  setLoading(false)
                }
              }}
              className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-2.5 rounded-xl text-sm transition-all"
            >
              {t.login.duplicateLoginConfirm}
            </button>
          </div>
        </div>
      )}
      {/* Background gradient */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-indigo-100 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 left-1/3 w-64 h-64 bg-purple-50 rounded-full blur-3xl" />
      </div>

      {/* Language toggle (top-right) */}
      <div className="absolute top-5 right-5 flex items-center bg-gray-100 border border-gray-200 rounded-lg overflow-hidden">
        {LANGUAGES.map(lang => (
          <button
            key={lang.code}
            onClick={() => setLanguage(lang.code)}
            className={`px-2.5 py-1 text-xs font-medium transition-all ${
              language === lang.code
                ? 'bg-indigo-600 text-white'
                : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
            }`}
          >
            {lang.label}
          </button>
        ))}
      </div>

      <div className="relative w-full max-w-md">
        {/* Card */}
        <div className="bg-white/90 backdrop-blur border border-gray-200 rounded-3xl p-8 shadow-2xl">
          {/* Logo */}
          <div className="flex flex-col items-center mb-8">
            <div className="flex items-center gap-3 mb-4">
              <img src="/img/logo.png" alt="Logo" className="w-12 h-12 object-contain" />
              <h1 className="text-gray-900 font-bold text-3xl tracking-tight">EasyStation</h1>
            </div>
            <p className="text-gray-400 text-sm mt-1">{t.login.welcome}</p>
          </div>

          {/* Form */}
          <div className="flex flex-col gap-2 mb-5">
            <button
              type="button"
              onClick={() => handleOAuthLogin('kakao')}
              disabled={Boolean(oauthLoading)}
              className="w-full bg-yellow-300 hover:bg-yellow-200 disabled:opacity-60 text-gray-900 font-semibold py-2.5 rounded-xl text-sm transition-all"
            >
              {oauthLoading === 'kakao' ? 'Kakao 연결 중...' : 'Kakao로 로그인'}
            </button>
            <button
              type="button"
              onClick={() => handleOAuthLogin('google')}
              disabled={Boolean(oauthLoading)}
              className="w-full bg-white hover:bg-gray-50 disabled:opacity-60 text-gray-800 border border-gray-300 font-semibold py-2.5 rounded-xl text-sm transition-all"
            >
              {oauthLoading === 'google' ? 'Google 연결 중...' : 'Google로 로그인'}
            </button>
            <button
              type="button"
              onClick={() => handleOAuthLogin('apple')}
              disabled={Boolean(oauthLoading)}
              className="w-full bg-black hover:bg-gray-900 disabled:opacity-60 text-white font-semibold py-2.5 rounded-xl text-sm transition-all"
            >
              {oauthLoading === 'apple' ? 'Apple 연결 중...' : 'Apple로 로그인'}
            </button>
            <button
              type="button"
              onClick={() => handleOAuthLogin('custom:naver')}
              disabled={Boolean(oauthLoading)}
              className="w-full bg-green-600 hover:bg-green-500 disabled:opacity-60 text-white font-semibold py-2.5 rounded-xl text-sm transition-all"
            >
              {oauthLoading === 'custom:naver' ? 'Naver 연결 중...' : 'Naver로 로그인'}
            </button>
          </div>

          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-gray-200" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-white px-2 text-gray-400">Legacy Login</span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label className="block text-gray-500 text-sm mb-1.5 font-medium">{t.login.email}</label>
              <input
                type="text"
                value={identifier}
                onChange={e => setIdentifier(e.target.value)}
                placeholder={t.login.emailPlaceholder}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
                className="w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-3 text-gray-900 placeholder-gray-400 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 transition-all"
              />
            </div>
            <div>
              <label className="block text-gray-500 text-sm mb-1.5 font-medium">{t.login.password}</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={t.login.passwordPlaceholder}
                required
                className="w-full bg-gray-100 border border-gray-200 rounded-xl px-4 py-3 text-gray-900 placeholder-gray-400 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 transition-all"
              />
            </div>

            {error && (
              <div className={`border rounded-xl px-4 py-3 text-sm ${
                isLocked
                  ? 'bg-orange-50 border-orange-200 text-orange-600'
                  : 'bg-red-50 border-red-200 text-red-400'
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
              className="w-full mt-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white font-semibold py-3 rounded-xl transition-all text-sm shadow-lg shadow-indigo-200 flex items-center justify-center gap-2"
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
          <div className="mt-6 pt-6 border-t border-gray-200">
            <p className="text-gray-400 text-xs text-center mb-3">{t.login.demoAccounts}</p>
            <div className="flex flex-col gap-2">
              {[
                { id: 'kevin', name: 'Kevin Im (Admin)' },
                { id: 'alice', name: 'Alice Kim (Member)' },
                { id: 'bob', name: 'Bob Lee (Member)' },
              ].map(u => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => { setIdentifier(u.id); setPassword('password123') }}
                  className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 border border-gray-100 text-gray-500 hover:text-gray-700 text-xs transition-all"
                >
                  <span>{u.name}</span>
                  <span className="text-gray-300">{u.id}</span>
                </button>
              ))}
            </div>
            <p className="text-gray-300 text-xs text-center mt-3">{t.login.demoPassword}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
