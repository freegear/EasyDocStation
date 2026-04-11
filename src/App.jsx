import { useState } from 'react'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ChatProvider } from './contexts/ChatContext'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import ChatArea from './components/ChatArea'
import GroqPanel from './components/GroqPanel'
import LoginScreen from './components/LoginScreen'
import UserProfileModal from './components/UserProfileModal'
import SiteAdminPage from './components/SiteAdminPage'

function MainLayout() {
  const [showProfile, setShowProfile] = useState(false)
  const [showSiteAdmin, setShowSiteAdmin] = useState(false)

  return (
    <div className="flex flex-col h-screen bg-[#1e1c30] overflow-hidden">
      <TitleBar
        onOpenProfile={() => setShowProfile(true)}
        onOpenSiteAdmin={() => setShowSiteAdmin(true)}
      />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <ChatArea />
        <GroqPanel />
      </div>

      {showProfile && <UserProfileModal onClose={() => setShowProfile(false)} />}
      {showSiteAdmin && <SiteAdminPage onClose={() => setShowSiteAdmin(false)} />}
    </div>
  )
}

function AppContent() {
  const { currentUser, loading } = useAuth()

  if (loading) {
    return (
      <div className="h-screen bg-[#0f0e1a] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold animate-pulse">
            ED
          </div>
          <div className="w-5 h-5 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />
        </div>
      </div>
    )
  }

  return currentUser ? <MainLayout /> : <LoginScreen />
}

export default function App() {
  return (
    <AuthProvider>
      <ChatProvider>
        <AppContent />
      </ChatProvider>
    </AuthProvider>
  )
}
