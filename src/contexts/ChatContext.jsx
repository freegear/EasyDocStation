import { createContext, useContext, useState } from 'react'
import { TEAMS, POSTS } from '../data/mockData'

const ChatContext = createContext(null)

export function ChatProvider({ children }) {
  const [selectedTeam, setSelectedTeam] = useState(TEAMS[0])
  const [selectedChannel, setSelectedChannel] = useState(TEAMS[0].channels[0])
  const [posts, setPosts] = useState(POSTS)

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
      teams: TEAMS,
      selectedTeam,
      selectedChannel,
      posts,
      selectTeam,
      selectChannel,
      addPost,
      addComment,
      incrementViews,
      deletePost,
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
