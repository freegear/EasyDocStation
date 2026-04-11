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

  function selectChannel(channel) {
    setSelectedChannel(channel)
    if (!posts[channel.id]) {
      setPosts(prev => ({ ...prev, [channel.id]: [] }))
    }
  }

  function addPost(channelId, { title, content, tags, attachments = [] }, user) {
    const newPost = {
      id: `post-${Date.now()}`,
      title,
      content,
      tags: tags.filter(Boolean),
      attachments,
      author: { name: user.name, avatar: user.avatar },
      pinned: false,
      views: 0,
      createdAt: new Date().toISOString(),
      comments: [],
    }
    setPosts(prev => ({
      ...prev,
      [channelId]: [...(prev[channelId] || []), newPost],
    }))
    return newPost
  }

  function addComment(channelId, postId, text, user) {
    const comment = {
      id: `c-${Date.now()}`,
      author: { name: user.name, avatar: user.avatar },
      text,
      createdAt: new Date().toISOString(),
    }
    setPosts(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).map(p =>
        p.id === postId ? { ...p, comments: [...p.comments, comment] } : p
      ),
    }))
  }

  function incrementViews(channelId, postId) {
    setPosts(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).map(p =>
        p.id === postId ? { ...p, views: p.views + 1 } : p
      ),
    }))
  }

  function deletePost(channelId, postId) {
    setPosts(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).filter(p => p.id !== postId),
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
      decrementViews: incrementViews, // Placeholder if needed
      deletePost,
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
