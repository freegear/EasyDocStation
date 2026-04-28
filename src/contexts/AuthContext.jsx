import { createContext, useContext, useState, useEffect, useRef } from 'react'
import { apiFetch, setToken, clearToken, getToken, setSessionInvalidatedHandler } from '../lib/api'

const AuthContext = createContext(null)
const LANGUAGE_STORAGE_KEY = 'easydocstation.language'
const SUPPORTED_LANGUAGES = new Set(['ko', 'en', 'ja'])
const IDLE_LOGOUT_MS = 60 * 60 * 1000
const AUTH_EVENT_KEY = 'eds.auth.event'
const AUTH_NOTICE_KEY = 'eds.auth.notice'
const AUTO_LOGOUT_NOTICE = '1시간 이상 아무런 반응이 없어서 자동으로 로그아웃 되었습니다.'

export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null)
  const [language, setLanguageState] = useState(() => {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    return SUPPORTED_LANGUAGES.has(saved) ? saved : 'ko'
  })
  const [loading, setLoading] = useState(true)   // true while restoring session
  const [logoutNotice, setLogoutNotice] = useState('')
  const [maxAttachmentFileSize, setMaxAttachmentFileSize] = useState(100)
  const currentUserRef = useRef(null)
  const idleTimerRef = useRef(null)
  const isAutoLoggingOutRef = useRef(false)

  function clearIdleTimer() {
    if (idleTimerRef.current) {
      window.clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
  }

  function clearLocalSession() {
    clearToken()
    setCurrentUser(null)
    currentUserRef.current = null
  }

  function pushLogoutNotice(message) {
    if (!message) return
    setLogoutNotice(message)
    localStorage.setItem(AUTH_NOTICE_KEY, message)
  }

  function consumeStoredLogoutNotice() {
    const saved = localStorage.getItem(AUTH_NOTICE_KEY) || ''
    if (!saved) return
    setLogoutNotice(saved)
    localStorage.removeItem(AUTH_NOTICE_KEY)
  }

  function broadcastAuthEvent(event) {
    try {
      localStorage.setItem(AUTH_EVENT_KEY, JSON.stringify({ ...event, at: Date.now() }))
    } catch (_) {}
  }

  function redirectToLoginPage(forceReload = false) {
    const cleanPath = `${window.location.origin}/`
    if (forceReload) {
      window.location.replace(cleanPath)
      return
    }
    window.history.replaceState({}, '', '/')
  }

  async function logoutToServer() {
    try {
      await apiFetch('/auth/logout', { method: 'POST' })
    } catch (_) {
      // 서버 오류 시에도 로컬 세션은 정리
    }
  }

  // 세션 강제 만료 핸들러 (다른 기기 로그인 감지)
  useEffect(() => {
    setSessionInvalidatedHandler(() => {
      clearToken()
      setCurrentUser(null)
      currentUserRef.current = null
      redirectToLoginPage(true)
    })
  }, [])

  // 앱 진입 시 자동 로그아웃 안내 문구 복원
  useEffect(() => {
    consumeStoredLogoutNotice()
  }, [])

  // currentUser 변경 시 ref 동기화
  useEffect(() => {
    currentUserRef.current = currentUser
  }, [currentUser])

  // Restore session on app load
  useEffect(() => {
    const token = getToken()
    if (!token) { setLoading(false); return }
    apiFetch('/auth/me')
      .then(user => setCurrentUser(user))
      .catch(() => clearToken())
      .finally(() => setLoading(false))
  }, [])

  // 윈도우 포커스 시 세션 재검증 (다른 탭/브라우저에서 로그인 감지)
  useEffect(() => {
    function handleFocus() {
      if (!getToken() || !currentUserRef.current) return
      apiFetch('/auth/me')
        .then(user => setCurrentUser(user))
        .catch(() => {
          clearToken()
          setCurrentUser(null)
        })
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [])

  // 다른 탭에서 강제 로그아웃된 경우 동기화
  useEffect(() => {
    function handleStorage(e) {
      if (e.key !== AUTH_EVENT_KEY || !e.newValue) return
      try {
        const payload = JSON.parse(e.newValue)
        if (payload?.type !== 'FORCE_LOGOUT') return
        clearLocalSession()
        if (payload?.reason === 'IDLE') {
          pushLogoutNotice(AUTO_LOGOUT_NOTICE)
        }
        redirectToLoginPage(true)
      } catch (_) {}
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  // Load public config limits on startup
  useEffect(() => {
    fetch('/api/config/limits')
      .then(r => r.json())
      .then(data => { if (data.maxAttachmentFileSize) setMaxAttachmentFileSize(data.maxAttachmentFileSize) })
      .catch(() => {})
  }, [])

  async function login(identifier, password, options = {}) {
    const { forceRelogin = false } = options
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password, forceRelogin }),
    })
    setToken(data.token)
    setCurrentUser(data.user)
  }

  async function updateProfile(updates) {
    const updated = await apiFetch('/auth/me', {
      method: 'PUT',
      body: JSON.stringify(updates),
    })
    setCurrentUser(updated)
    return updated
  }

  async function logout() {
    clearIdleTimer()
    await logoutToServer()
    clearLocalSession()
    broadcastAuthEvent({ type: 'FORCE_LOGOUT', reason: 'MANUAL' })
    redirectToLoginPage(false)
  }

  // 유휴 시간 1시간 초과 시 자동 로그아웃
  useEffect(() => {
    if (!currentUser) {
      clearIdleTimer()
      return undefined
    }

    const scheduleAutoLogout = () => {
      clearIdleTimer()
      idleTimerRef.current = window.setTimeout(async () => {
        if (isAutoLoggingOutRef.current || !currentUserRef.current) return
        isAutoLoggingOutRef.current = true
        try {
          await logoutToServer()
        } finally {
          broadcastAuthEvent({ type: 'FORCE_LOGOUT', reason: 'IDLE' })
          pushLogoutNotice(AUTO_LOGOUT_NOTICE)
          clearLocalSession()
          isAutoLoggingOutRef.current = false
          redirectToLoginPage(true)
        }
      }, IDLE_LOGOUT_MS)
    }

    const handleUserActivity = () => {
      if (!currentUserRef.current) return
      scheduleAutoLogout()
    }

    scheduleAutoLogout()
    const activityEvents = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'pointerdown']
    activityEvents.forEach((eventName) => {
      window.addEventListener(eventName, handleUserActivity, { passive: true })
    })

    return () => {
      clearIdleTimer()
      activityEvents.forEach((eventName) => {
        window.removeEventListener(eventName, handleUserActivity)
      })
    }
  }, [currentUser])

  // 세션 동기화: 주기적으로 /auth/me 호출해 서버 세션 만료를 감지
  useEffect(() => {
    if (!currentUser) return undefined
    const timer = window.setInterval(() => {
      if (!getToken() || !currentUserRef.current) return
      apiFetch('/auth/me')
        .then(user => setCurrentUser(user))
        .catch((err) => {
          clearLocalSession()
          if (err?.code === 'SESSION_INVALIDATED') {
            redirectToLoginPage(true)
          } else {
            redirectToLoginPage(false)
          }
        })
    }, 30000)
    return () => window.clearInterval(timer)
  }, [currentUser])

  function clearLogoutNotice() {
    setLogoutNotice('')
    localStorage.removeItem(AUTH_NOTICE_KEY)
  }

  function setLanguage(nextLanguage) {
    const safeLanguage = SUPPORTED_LANGUAGES.has(nextLanguage) ? nextLanguage : 'ko'
    setLanguageState(safeLanguage)
    localStorage.setItem(LANGUAGE_STORAGE_KEY, safeLanguage)
  }

  return (
    <AuthContext.Provider value={{
      currentUser,
      loading,
      language,
      setLanguage,
      login,
      logout,
      updateProfile,
      logoutNotice,
      clearLogoutNotice,
      maxAttachmentFileSize,
      setMaxAttachmentFileSize,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
