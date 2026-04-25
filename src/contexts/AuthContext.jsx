import { createContext, useContext, useState, useEffect, useRef } from 'react'
import { apiFetch, setToken, clearToken, getToken, setSessionInvalidatedHandler } from '../lib/api'

const AuthContext = createContext(null)
const LANGUAGE_STORAGE_KEY = 'easydocstation.language'
const SUPPORTED_LANGUAGES = new Set(['ko', 'en', 'ja'])
const IDLE_LOGOUT_MS = 30 * 60 * 1000

export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null)
  const [language, setLanguageState] = useState(() => {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    return SUPPORTED_LANGUAGES.has(saved) ? saved : 'ko'
  })
  const [loading, setLoading] = useState(true)   // true while restoring session
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
    })
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
  }

  // 유휴 시간 30분 초과 시 자동 로그아웃
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
          clearLocalSession()
          isAutoLoggingOutRef.current = false
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
