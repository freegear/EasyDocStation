import { createContext, useContext, useState, useEffect } from 'react'
import { TEAMS, POSTS } from '../data/mockData'
import { apiFetch } from '../lib/api'

const ChatContext = createContext(null)

export function ChatProvider({ children }) {
  const [teams, setTeams] = useState(TEAMS)
  const [selectedTeam, setSelectedTeam] = useState(TEAMS[0])
  const [selectedChannel, setSelectedChannel] = useState(TEAMS[0].channels[0])
  const [posts, setPosts] = useState(POSTS)

  useEffect(() => {
    refreshTeams()
  }, [])

  async function refreshTeams() {
    try {
      const data = await apiFetch('/teams')
      if (data.length > 0) {
        const enriched = await Promise.all(data.map(async t => {
          const members = await apiFetch(`/teams/${t.id}/members`)
          return {
            ...t,
            channels: (t.channels || []).map(c => ({ ...c, unread: 0 })),
            directMessages: members.map(m => ({
              id: `dm-${m.id}`,
              name: m.name,
              avatar: m.name[0],
              image_url: m.image_url,
              online: Math.random() > 0.5,
              userId: m.id
            })),
            icon: t.icon || '🏢'
          }
        }))
        setTeams(enriched)

        if (selectedTeam) {
          const updated = enriched.find(t => t.id === selectedTeam.id)
          if (updated) setSelectedTeam(updated)
        } else {
          setSelectedTeam(enriched[0])
          setSelectedChannel(enriched[0].channels[0])
        }
      }
    } catch (err) {
      console.error('Failed to fetch teams:', err)
    }
  }

  function selectTeam(team) {
    setSelectedTeam(team)
    setSelectedChannel(team.channels[0])
    closeSearch()
  }

  async function selectChannel(channel) {
    setSelectedChannel(channel)
    closeSearch()
    try {
      const data = await apiFetch(`/posts?channelId=${channel.id}`)
      setPosts(prev => ({ ...prev, [channel.id]: data }))
    } catch (err) {
      console.error('Failed to fetch posts:', err)
      setPosts(prev => ({ ...prev, [channel.id]: [] }))
    }
  }

  async function addPost(channelId, { content, attachmentIds = [] }) {
    try {
      await apiFetch('/posts', {
        method: 'POST',
        body: JSON.stringify({ channelId, content, attachmentIds }),
      })
      const data = await apiFetch(`/posts?channelId=${channelId}`)
      setPosts(prev => ({ ...prev, [channelId]: data }))
    } catch (err) {
      alert('게시글 저장에 실패했습니다: ' + err.message)
      throw err
    }
  }

  // ─── 댓글 추가 — DB에 저장 후 최신 목록 재조회 ──────────────
  async function addComment(channelId, postId, text, user, attachments = []) {
    try {
      await apiFetch(`/posts/${postId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ channelId, content: text, attachments }),
      })
      const data = await apiFetch(`/posts?channelId=${channelId}`)
      setPosts(prev => ({ ...prev, [channelId]: data }))
    } catch (err) {
      alert('댓글 저장에 실패했습니다: ' + err.message)
      throw err
    }
  }

  function incrementViews(channelId, postId) {
    setPosts(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).map(p =>
        p.id === postId ? { ...p, views: (p.views || 0) + 1 } : p
      ),
    }))
  }

  async function deletePost(channelId, postId) {
    try {
      await apiFetch(`/posts/${postId}`, { method: 'DELETE' })
    } catch (err) {
      console.error('delete post error:', err)
    }
    setPosts(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).filter(p => p.id !== postId),
    }))
  }

  async function updatePost(channelId, postId, { content, attachments }) {
    try {
      await apiFetch(`/posts/${postId}`, {
        method: 'PUT',
        body: JSON.stringify({ content }),
      })
    } catch (err) {
      console.error('update post error:', err)
    }
    setPosts(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).map(p =>
        p.id === postId ? { ...p, content, attachments, updatedAt: new Date().toISOString() } : p
      ),
    }))
  }

  // ─── 댓글 삭제 — DB에서 삭제 후 state 반영 ──────────────────
  async function deleteComment(channelId, postId, commentId) {
    try {
      await apiFetch(`/posts/${postId}/comments/${commentId}`, { method: 'DELETE' })
    } catch (err) {
      console.error('delete comment error:', err)
    }
    setPosts(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).map(p =>
        p.id === postId ? { ...p, comments: (p.comments || []).filter(c => c.id !== commentId) } : p
      ),
    }))
  }

  // ─── 댓글 수정 — DB 업데이트 후 state 반영 ──────────────────
  async function updateComment(channelId, postId, commentId, { text, attachments }) {
    try {
      await apiFetch(`/posts/${postId}/comments/${commentId}`, {
        method: 'PUT',
        body: JSON.stringify({ content: text, attachments }),
      })
    } catch (err) {
      console.error('update comment error:', err)
    }
    setPosts(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).map(p =>
        p.id === postId ? {
          ...p,
          comments: (p.comments || []).map(c =>
            c.id === commentId
              ? { ...c, content: text, text, attachments, updatedAt: new Date().toISOString() }
              : c
          )
        } : p
      ),
    }))
  }

  // ─── RAG 참고 문서 클릭 시 해당 채널+게시글로 이동 ──────────
  const [pendingOpenPostId, setPendingOpenPostId] = useState(null)

  async function navigateToPost(channelId, postId) {
    // teams에서 channelId에 해당하는 채널 객체를 찾아 이동
    for (const team of teams) {
      const ch = (team.channels || []).find(c => c.id === channelId)
      if (ch) {
        setSelectedTeam(team)
        await selectChannel(ch)
        if (postId) setPendingOpenPostId(postId)
        return
      }
    }
  }

  function clearPendingPost() {
    setPendingOpenPostId(null)
  }

  const [isSearchMode, setIsSearchMode] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [isSearching, setIsSearching] = useState(false)

  async function performSearch(query) {
    if (!query.trim()) return
    setIsSearching(true)
    setSearchTerm(query)
    setIsSearchMode(true)
    try {
      const data = await apiFetch(`/posts/search?q=${encodeURIComponent(query)}`)
      setSearchResults(data)
    } catch (err) {
      console.error('Search failed:', err)
      setSearchResults([])
    } finally {
      setIsSearching(false)
    }
  }

  function closeSearch() {
    setIsSearchMode(false)
    setSearchTerm('')
    setSearchResults([])
  }

  return (
    <ChatContext.Provider value={{
      teams,
      setTeams,
      selectedTeam,
      selectedChannel,
      posts,
      selectTeam,
      selectChannel,
      addPost,
      addComment,
      incrementViews,
      deletePost,
      updatePost,
      deleteComment,
      updateComment,
      refreshTeams,
      isSearchMode,
      setIsSearchMode,
      searchTerm,
      searchResults,
      isSearching,
      performSearch,
      closeSearch,
      pendingOpenPostId,
      navigateToPost,
      clearPendingPost,
    }}>
      {children}
    </ChatContext.Provider>
  )
}

export function useChat() {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChat must be used within ChatProvider')
  return ctx
}
