import { useState } from 'react'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ChatProvider, useChat } from './contexts/ChatContext'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import ChatArea from './components/ChatArea'
import GroqPanel from './components/GroqPanel'
import LoginScreen from './components/LoginScreen'
import UserProfileModal from './components/UserProfileModal'
import SiteAdminPage from './components/SiteAdminPage'
import SearchResultsArea from './components/SearchResultsArea'

function MainLayout() {
  const [showProfile, setShowProfile] = useState(false)
  const [showSiteAdmin, setShowSiteAdmin] = useState(false)
  const [searchSelectedPost, setSearchSelectedPost] = useState(null)
  const { isSearchMode } = useChat()

  // 검색 결과 클릭 시 → 해당 채널이 selectChannel로 바뀌고,
  // ChatArea에 선택된 포스트 ID를 전달하여 자동 오픈
  function handleSearchSelect(post) {
    setSearchSelectedPost(post)
    // 짧은 딜레이 후 초기화 (ChatArea가 받은 후)
    setTimeout(() => setSearchSelectedPost(null), 500)
  }

  return (
    <div className="flex flex-col h-screen bg-[#1e1c30] overflow-hidden">
      <TitleBar
        onOpenProfile={() => setShowProfile(true)}
        onOpenSiteAdmin={() => setShowSiteAdmin(true)}
        onSelectSearchResult={handleSearchSelect}
      />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        
        {isSearchMode ? (
          <SearchResultsArea onSelectResult={handleSearchSelect} />
        ) : (
          <ChatArea autoOpenPostId={searchSelectedPost?.id} />
        )}
        
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

  if (!currentUser) return <LoginScreen />

  // 로그인 성공 후에만 ChatProvider를 마운트
  // → useEffect의 refreshTeams()가 인증 토큰이 있는 상태에서 실행됨
  return (
    <ChatProvider>
      <MainLayout />
    </ChatProvider>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  )
}
