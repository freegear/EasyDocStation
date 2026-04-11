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
        // Enrich teams with channels and members from DB
        const enriched = await Promise.all(data.map(async t => {
          const members = await apiFetch(`/teams/${t.id}/members`)
          return {
            ...t,
            channels: (t.channels || []).map(c => ({ ...c, unread: 0 })),
            directMessages: members.map(m => ({
              id: `dm-${m.id}`,
              name: m.name,
              avatar: m.name[0],
              online: Math.random() > 0.5, // Simulate for UI
              userId: m.id
            })),
            icon: t.icon || '🏢'
          }
        }))
        setTeams(enriched)
        
        // Update selected team if it exists in the new list
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
  }

  // Select channel and fetch its posts from Cassandra
  async function selectChannel(channel) {
    setSelectedChannel(channel)
    try {
      const data = await apiFetch(`/posts?channelId=${channel.id}`)
      setPosts(prev => ({ ...prev, [channel.id]: data }))
    } catch (err) {
      console.error('Failed to fetch posts:', err)
      setPosts(prev => ({ ...prev, [channel.id]: [] }))
    }
  }

  // Create post via API, then refetch so attachments are fully enriched
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

  function addComment(channelId, postId, text, user, attachments = []) {
    const comment = {
      id: `c-${Date.now()}`,
      author: { name: user.name, avatar: user.avatar },
      text,
      attachments,
      createdAt: new Date().toISOString(),
    }
    setPosts(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).map(p =>
        p.id === postId ? { ...p, comments: [...(p.comments || []), comment] } : p
      ),
    }))
  }

  function incrementViews(channelId, postId) {
    setPosts(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).map(p =>
        p.id === postId ? { ...p, views: (p.views || 0) + 1 } : p
      ),
    }))
  }

  function deletePost(channelId, postId) {
    // In a real app, you'd also call apiFetch('/files/delete', ...) for each attachment
    setPosts(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).filter(p => p.id !== postId),
    }))
  }

  function updatePost(channelId, postId, { content, attachments }) {
    setPosts(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).map(p =>
        p.id === postId ? { ...p, content, attachments, updatedAt: new Date().toISOString() } : p
      ),
    }))
  }

  function deleteComment(channelId, postId, commentId) {
    setPosts(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).map(p =>
        p.id === postId ? { ...p, comments: (p.comments || []).filter(c => c.id !== commentId) } : p
      ),
    }))
  }

  function updateComment(channelId, postId, commentId, { text, attachments }) {
    setPosts(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).map(p =>
        p.id === postId ? {
          ...p,
          comments: (p.comments || []).map(c =>
            c.id === commentId ? { ...c, text, attachments, updatedAt: new Date().toISOString() } : c
          )
        } : p
      ),
    }))
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
      refreshTeams
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
