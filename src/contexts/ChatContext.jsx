import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react'
import { apiFetch } from '../lib/api'

const ChatContext = createContext(null)

export function ChatProvider({ children }) {
  const [teams, setTeams] = useState([])
  const [selectedTeam, setSelectedTeam] = useState({ id: null, channels: [], directMessages: [], admin_ids: [] })
  const [selectedChannel, setSelectedChannel] = useState(null)
  const [posts, setPosts] = useState({})
  const selectedChannelRef = useRef(selectedChannel)

  useEffect(() => {
    selectedChannelRef.current = selectedChannel
  }, [selectedChannel])

  useEffect(() => {
    refreshTeams()
  }, [])

  // 현재 채널 게시글 목록 주기 갱신 (학습 상태 변화 반영)
  useEffect(() => {
    if (!selectedChannel?.id) return undefined
    let cancelled = false
    const channelId = selectedChannel.id

    async function refreshChannelPosts() {
      try {
        const data = await apiFetch(`/posts?channelId=${channelId}`)
        if (cancelled) return
        setPosts(prev => ({ ...prev, [channelId]: data }))
      } catch (err) {
        console.error('Failed to refresh channel posts:', err)
      }
    }

    const interval = setInterval(refreshChannelPosts, 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [selectedChannel?.id])

  // 30초마다 안읽은 글 수 갱신 (다른 사용자가 올린 새 게시글 반영)
  useEffect(() => {
    const interval = setInterval(refreshUnread, 30000)
    return () => clearInterval(interval)
  }, [])

  // 채널별 unread count를 teams/selectedTeam state에 반영
  function applyUnreadCounts(teamsData, counts) {
    const currentChannelId = selectedChannelRef.current?.id
    return teamsData.map(t => ({
      ...t,
      channels: t.channels.map(c => ({
        ...c,
        unread: c.id === currentChannelId ? 0 : (counts[c.id] ?? c.unread ?? 0),
      })),
    }))
  }

  async function refreshUnread() {
    try {
      const counts = await apiFetch('/channels/unread')
      setTeams(prev => applyUnreadCounts(prev, counts))
      setSelectedTeam(prev => ({
        ...prev,
        channels: prev.channels.map(c => ({
          ...c,
          unread: c.id === selectedChannelRef.current?.id ? 0 : (counts[c.id] ?? c.unread ?? 0),
        })),
      }))
    } catch (_) {}
  }

  async function refreshTeams() {
    try {
      const [data, unreadCounts] = await Promise.all([
        apiFetch('/teams'),
        apiFetch('/channels/unread').catch(() => ({})),
      ])
      if (data.length > 0) {
        const enriched = await Promise.all(data.map(async t => {
          const members = await apiFetch(`/teams/${t.id}/members`)
          return {
            ...t,
            channels: (t.channels || []).map(c => ({
              ...c,
              unread: c.id === selectedChannelRef.current?.id ? 0 : (unreadCounts[c.id] ?? 0),
            })),
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

        if (selectedTeam?.id) {
          const updated = enriched.find(t => t.id === selectedTeam.id)
          if (updated) {
            setSelectedTeam(updated)
            // 채널도 다시 동기화
            const updatedCh = updated.channels.find(c => c.id === selectedChannel?.id) || updated.channels[0]
            if (updatedCh) selectChannel(updatedCh)
          } else {
            // 기존 선택 팀이 사라진 경우 첫 번째 팀으로 폴백
            setSelectedTeam(enriched[0])
            if (enriched[0].channels?.length > 0) selectChannel(enriched[0].channels[0])
          }
        } else {
          // 최초 로드 — 첫 번째 팀/채널 자동 선택
          setSelectedTeam(enriched[0])
          if (enriched[0].channels?.length > 0) selectChannel(enriched[0].channels[0])
        }
      }
    } catch (err) {
      console.error('Failed to fetch teams:', err)
    }
  }

  function selectTeam(team) {
    setSelectedTeam(team)
    if (team.channels && team.channels.length > 0) {
      selectChannel(team.channels[0])
    }
    closeSearch()
  }

  async function selectChannel(channel) {
    setSelectedChannel(channel)
    closeSearch()

    // 읽음 처리: last_read_at 갱신 + 클라이언트 unread 즉시 0으로 초기화
    apiFetch(`/channels/${channel.id}/read`, { method: 'POST' }).catch(() => {})
    setTeams(prev => prev.map(t => ({
      ...t,
      channels: t.channels.map(c => c.id === channel.id ? { ...c, unread: 0 } : c),
    })))
    setSelectedTeam(prev => ({
      ...prev,
      channels: prev.channels.map(c => c.id === channel.id ? { ...c, unread: 0 } : c),
    }))

    try {
      const data = await apiFetch(`/posts?channelId=${channel.id}`)
      setPosts(prev => ({ ...prev, [channel.id]: data }))
    } catch (err) {
      console.error('Failed to fetch posts:', err)
      setPosts(prev => ({ ...prev, [channel.id]: [] }))
    }
  }

  async function addPost(channelId, { content, attachmentIds = [], security_level }, options = {}) {
    const { suppressAlert = false } = options
    try {
      await apiFetch('/posts', {
        method: 'POST',
        body: JSON.stringify({ channelId, content, attachmentIds, security_level }),
      })
      const data = await apiFetch(`/posts?channelId=${channelId}`)
      setPosts(prev => ({ ...prev, [channelId]: data }))
    } catch (err) {
      if (!suppressAlert) {
        alert('게시글 저장에 실패했습니다: ' + err.message)
      }
      throw err
    }
  }

  // ─── 댓글 추가 — DB에 저장 후 최신 목록 재조회 ──────────────
  async function addComment(channelId, postId, text, user, attachmentIds = [], security_level) {
    try {
      await apiFetch(`/posts/${postId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ channelId, content: text, attachmentIds, security_level }),
      })
      const data = await apiFetch(`/posts?channelId=${channelId}`)
      setPosts(prev => ({ ...prev, [channelId]: data }))
    } catch (err) {
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
      const data = await apiFetch(`/posts?channelId=${channelId}`)
      setPosts(prev => ({ ...prev, [channelId]: data }))
    } catch (err) {
      console.error('delete post error:', err)
      throw err
    }
  }

  async function updatePost(channelId, postId, { content, attachments, security_level }) {
    try {
      await apiFetch(`/posts/${postId}`, {
        method: 'PUT',
        body: JSON.stringify({ content, security_level }),
      })
    } catch (err) {
      console.error('update post error:', err)
    }
    setPosts(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).map(p =>
        p.id === postId ? { ...p, content, attachments, security_level, updatedAt: new Date().toISOString() } : p
      ),
    }))
  }

  // ─── 댓글 삭제 — DB에서 삭제 후 state 반영 ──────────────────
  async function deleteComment(channelId, postId, commentId) {
    try {
      await apiFetch(`/posts/${postId}/comments/${commentId}`, { method: 'DELETE' })
      const data = await apiFetch(`/posts?channelId=${channelId}`)
      setPosts(prev => ({ ...prev, [channelId]: data }))
    } catch (err) {
      console.error('delete comment error:', err)
      throw err
    }
  }

  // ─── 댓글 수정 — DB 업데이트 후 state 반영 ──────────────────
  async function updateComment(channelId, postId, commentId, { text, attachments, security_level }) {
    const attachmentIds = (attachments || [])
      .map(item => (typeof item === 'object' ? item.id : item))
      .filter(Boolean)
    try {
      await apiFetch(`/posts/${postId}/comments/${commentId}`, {
        method: 'PUT',
        body: JSON.stringify({ content: text, attachments: attachmentIds, security_level }),
      })
      const data = await apiFetch(`/posts?channelId=${channelId}`)
      setPosts(prev => ({ ...prev, [channelId]: data }))
    } catch (err) {
      console.error('update comment error:', err)
      throw err
    }
  }

  // ─── RAG 참고 문서 클릭 시 해당 채널+게시글로 이동 ──────────
  const [pendingOpenPostId, setPendingOpenPostId] = useState(null)
  const [pendingOpenCommentId, setPendingOpenCommentId] = useState(null)
  const [pendingOpenAttachmentId, setPendingOpenAttachmentId] = useState(null)
  const [agenticTarget, setAgenticTarget] = useState(null)
  const [activePostSelection, setActivePostSelection] = useState({ channelId: null, postId: null })

  async function navigateToPost(channelId, postId, meta = {}) {
    // teams에서 channelId에 해당하는 채널 객체를 찾아 이동
    for (const team of teams) {
      const ch = (team.channels || []).find(c => c.id === channelId)
      if (ch) {
        setSelectedTeam(team)
        await selectChannel(ch)
        if (postId) setPendingOpenPostId(postId)
        if (meta.commentId) setPendingOpenCommentId(meta.commentId)
        if (meta.attachmentId) setPendingOpenAttachmentId(meta.attachmentId)
        return
      }
    }
  }

  function clearPendingPost() {
    setPendingOpenPostId(null)
    setPendingOpenCommentId(null)
    setPendingOpenAttachmentId(null)
  }

  function openInAgenticAI(target) {
    if (!target || !target.postId || !target.channelId) return
    setAgenticTarget({
      ...target,
      setAt: new Date().toISOString(),
    })
  }

  function clearAgenticTarget() {
    setAgenticTarget(null)
  }

  const setSelectedPostContext = useCallback((channelId, postId) => {
    if (!channelId || !postId) {
      setActivePostSelection(prev => (
        prev.channelId === null && prev.postId === null
          ? prev
          : { channelId: null, postId: null }
      ))
      return
    }
    setActivePostSelection(prev => (
      prev.channelId === channelId && prev.postId === postId
        ? prev
        : { channelId, postId }
    ))
  }, [])

  const clearSelectedPostContext = useCallback(() => {
    setActivePostSelection(prev => (
      prev.channelId === null && prev.postId === null
        ? prev
        : { channelId: null, postId: null }
    ))
  }, [])

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
      refreshUnread,
      isSearchMode,
      setIsSearchMode,
      searchTerm,
      searchResults,
      isSearching,
      performSearch,
      closeSearch,
      pendingOpenPostId,
      pendingOpenCommentId,
      pendingOpenAttachmentId,
      navigateToPost,
      clearPendingPost,
      agenticTarget,
      openInAgenticAI,
      clearAgenticTarget,
      activePostSelection,
      setSelectedPostContext,
      clearSelectedPostContext,
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
