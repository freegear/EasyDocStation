import { createContext, useContext, useState, useEffect } from 'react'
import { apiFetch, setToken, clearToken, getToken } from '../lib/api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null)
  const [language, setLanguage] = useState('ko')
  const [loading, setLoading] = useState(true)   // true while restoring session

  // Restore session on app load
  useEffect(() => {
    const token = getToken()
    if (!token) { setLoading(false); return }
    apiFetch('/auth/me')
      .then(user => setCurrentUser(user))
      .catch(() => clearToken())
      .finally(() => setLoading(false))
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

  return (
    <AuthContext.Provider value={{
      currentUser,
      loading,
      language,
      setLanguage,
      login,
      logout,
      updateProfile,
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
