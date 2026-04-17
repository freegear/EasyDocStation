import { createContext, useContext, useState, useEffect } from 'react'
import { apiFetch, setToken, clearToken, getToken } from '../lib/api'

const AuthContext = createContext(null)
const LANGUAGE_STORAGE_KEY = 'easydocstation.language'
const SUPPORTED_LANGUAGES = new Set(['ko', 'en', 'ja'])

export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null)
  const [language, setLanguageState] = useState(() => {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    return SUPPORTED_LANGUAGES.has(saved) ? saved : 'ko'
  })
  const [loading, setLoading] = useState(true)   // true while restoring session
  const [maxAttachmentFileSize, setMaxAttachmentFileSize] = useState(100)

  // Restore session on app load
  useEffect(() => {
    const token = getToken()
    if (!token) { setLoading(false); return }
    apiFetch('/auth/me')
      .then(user => setCurrentUser(user))
      .catch(() => clearToken())
      .finally(() => setLoading(false))
  }, [])

  // Load public config limits on startup
  useEffect(() => {
    fetch('/api/config/limits')
      .then(r => r.json())
      .then(data => { if (data.maxAttachmentFileSize) setMaxAttachmentFileSize(data.maxAttachmentFileSize) })
      .catch(() => {})
  }, [])

  async function login(email, password) {
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
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

  function logout() {
    clearToken()
    setCurrentUser(null)
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
