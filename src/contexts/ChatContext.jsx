import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import { useAuth } from './AuthContext'

const ChatContext = createContext(null)

export function ChatProvider({ children }) {
  const { currentUser, loading: authLoading } = useAuth()
  const [teams, setTeams] = useState([])
  const [selectedTeam, setSelectedTeam] = useState({ id: null, channels: [], directMessages: [], admin_ids: [] })
  const [selectedChannel, setSelectedChannel] = useState(null)
  const [posts, setPosts] = useState({})
  const selectedChannelRef = useRef(selectedChannel)

  useEffect(() => {
    selectedChannelRef.current = selectedChannel
  }, [selectedChannel])

  useEffect(() => {
    if (authLoading) return
    if (currentUser?.id) {
      refreshTeams()
      return
    }
    setTeams([])
    setSelectedTeam({ id: null, channels: [], directMessages: [], admin_ids: [] })
    setPosts({})
    clearSelectedChannel()
  }, [authLoading, currentUser?.id])

  // 현재 채널 게시글 목록 주기 갱신 (학습 상태 변화 반영)
  useEffect(() => {
    if (!currentUser?.id || !selectedChannel?.id) return undefined
    let cancelled = false
    const channelId = selectedChannel.id

    async function refreshChannelPosts() {
      try {
        const data = await apiFetch(`/posts?channelId=${channelId}`)
        if (cancelled) return
        mergeChannelPosts(channelId, data, { preserveUnread: true })
      } catch (err) {
        if (err?.status === 403) {
          window.dispatchEvent(new CustomEvent('channel-access-denied'))
        }
        console.error('Failed to refresh channel posts:', err)
      }
    }

    const interval = setInterval(refreshChannelPosts, 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [currentUser?.id, selectedChannel?.id])

  // 30초마다 안읽은 글 수 갱신 (다른 사용자가 올린 새 게시글 반영)
  useEffect(() => {
    if (!currentUser?.id) return undefined
    const interval = setInterval(refreshUnread, 30000)
    return () => clearInterval(interval)
  }, [currentUser?.id])

  // 채널별 unread count를 teams/selectedTeam state에 반영
  function applyUnreadCounts(teamsData, counts) {
    return teamsData.map(t => ({
      ...t,
      channels: t.channels.map(c => ({
        ...c,
        unread: counts[c.id] ?? c.unread ?? 0,
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
          unread: counts[c.id] ?? c.unread ?? 0,
        })),
      }))
    } catch (_) {}
  }

  function clearSelectedChannel() {
    selectedChannelRef.current = null
    setSelectedChannel(null)
  }

  function mergeChannelPosts(channelId, nextPosts = [], { preserveUnread = false } = {}) {
    setPosts(prev => {
      const previousById = new Map((prev[channelId] || []).map(post => [String(post.id), post]))
      const mergedPosts = preserveUnread
        ? nextPosts.map(post => {
            const previous = previousById.get(String(post.id))
            if (!previous?.isUnread || post.isUnread) return post
            return {
              ...post,
              isUnread: true,
              unreadPost: previous.unreadPost || false,
              unreadCommentCount: previous.unreadCommentCount || 0,
              unreadActivityAt: previous.unreadActivityAt || post.unreadActivityAt || post.createdAt,
            }
          })
        : nextPosts
      return { ...prev, [channelId]: mergedPosts }
    })
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
              unread: unreadCounts[c.id] ?? 0,
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
            const updatedCh = updated.channels.find(c => c.id === selectedChannelRef.current?.id) || updated.channels[0]
            if (updatedCh) {
              selectChannel(updatedCh, { markRead: false })
            } else {
              clearSelectedChannel()
            }
          } else {
            // 기존 선택 팀이 사라진 경우 첫 번째 팀으로 폴백
            setSelectedTeam(enriched[0])
            if (enriched[0].channels?.length > 0) {
              selectChannel(enriched[0].channels[0], { markRead: false })
            } else {
              clearSelectedChannel()
            }
          }
        } else {
          // 최초 로드 — 첫 번째 팀/채널 자동 선택
          setSelectedTeam(enriched[0])
          if (enriched[0].channels?.length > 0) {
            selectChannel(enriched[0].channels[0], { markRead: false })
          } else {
            clearSelectedChannel()
          }
        }
      } else {
        setTeams([])
        setSelectedTeam({ id: null, channels: [], directMessages: [], admin_ids: [] })
        clearSelectedChannel()
      }
    } catch (err) {
      console.error('Failed to fetch teams:', err)
    }
  }

  function selectTeam(team) {
    setSelectedTeam(team)
    if (team.channels && team.channels.length > 0) {
      selectChannel(team.channels[0])
    } else {
      clearSelectedChannel()
    }
    closeSearch()
  }

  async function selectChannel(channel, options = {}) {
    const { markRead = true } = options
    setSelectedChannel(channel)
    closeSearch()

    try {
      const data = await apiFetch(`/posts?channelId=${channel.id}`)
      mergeChannelPosts(channel.id, data)
      if (markRead) {
        // 목록 표시용 unread 스냅샷을 받은 뒤 채널 배지는 읽음 처리한다.
        apiFetch(`/channels/${channel.id}/read`, { method: 'POST' }).catch(() => {})
        setTeams(prev => prev.map(t => ({
          ...t,
          channels: t.channels.map(c => c.id === channel.id ? { ...c, unread: 0 } : c),
        })))
        setSelectedTeam(prev => ({
          ...prev,
          channels: prev.channels.map(c => c.id === channel.id ? { ...c, unread: 0 } : c),
        }))
      }
    } catch (err) {
      if (err?.status === 403) {
        window.dispatchEvent(new CustomEvent('channel-access-denied'))
      }
      console.error('Failed to fetch posts:', err)
      setPosts(prev => ({ ...prev, [channel.id]: [] }))
    }
  }

  function markPostRead(channelId, postId) {
    if (!channelId || !postId) return
    setPosts(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).map(post => (
        String(post.id) === String(postId)
          ? {
              ...post,
              isUnread: false,
              unreadPost: false,
              unreadCommentCount: 0,
              unreadActivityAt: null,
            }
          : post
      )),
    }))
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

  async function updatePost(channelId, postId, { content, ragContent, attachments, security_level, waitForTraining = false }) {
    try {
      await apiFetch(`/posts/${postId}`, {
        method: 'PUT',
        body: JSON.stringify({ content, ragContent, security_level, attachments, waitForTraining }),
      })
      setPosts(prev => ({
        ...prev,
        [channelId]: (prev[channelId] || []).map(p =>
          p.id === postId ? { ...p, content, attachments, security_level, updatedAt: new Date().toISOString() } : p
        ),
      }))
      return true
    } catch (err) {
      console.error('update post error:', err)
      throw err
    }
  }

  async function togglePostPin(channelId, postId, pinned) {
    const nextPinned = Boolean(pinned)
    const prevChannelPosts = posts[channelId] || []
    setPosts(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).map(p => (
        p.id === postId
          ? {
            ...p,
            pinned: nextPinned,
            pinned_at: nextPinned ? new Date().toISOString() : null,
            pinned_by: nextPinned ? 'me' : null,
          }
          : p
      )),
    }))
    try {
      await apiFetch(`/posts/${postId}/pin`, {
        method: 'PUT',
        body: JSON.stringify({ pinned: nextPinned }),
      })
      const data = await apiFetch(`/posts?channelId=${channelId}`)
      setPosts(prev => ({ ...prev, [channelId]: data }))
      return true
    } catch (err) {
      setPosts(prev => ({ ...prev, [channelId]: prevChannelPosts }))
      throw err
    }
  }

  async function togglePostLike(channelId, postId) {
    const prevChannelPosts = posts[channelId] || []
    const target = prevChannelPosts.find(p => String(p.id) === String(postId))
    const nextLiked = target?.likedByMe !== true
    const nextCount = Math.max(0, Number(target?.likeCount || 0) + (nextLiked ? 1 : -1))
    setPosts(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).map(p => (
        String(p.id) === String(postId)
          ? { ...p, likedByMe: nextLiked, likeCount: nextCount }
          : p
      )),
    }))
    try {
      const result = await apiFetch(`/posts/${postId}/like`, { method: 'POST' })
      setPosts(prev => ({
        ...prev,
        [channelId]: (prev[channelId] || []).map(p => (
          String(p.id) === String(postId)
            ? { ...p, likedByMe: Boolean(result.liked), likeCount: Number(result.likeCount || 0) }
            : p
        )),
      }))
      return result
    } catch (err) {
      setPosts(prev => ({ ...prev, [channelId]: prevChannelPosts }))
      throw err
    }
  }

  async function toggleCommentLike(channelId, postId, commentId) {
    const prevChannelPosts = posts[channelId] || []
    let targetComment = null
    for (const p of prevChannelPosts) {
      if (String(p.id) !== String(postId)) continue
      targetComment = (p.comments || []).find(c => String(c.id) === String(commentId))
      break
    }
    const nextLiked = targetComment?.likedByMe !== true
    const nextCount = Math.max(0, Number(targetComment?.likeCount || 0) + (nextLiked ? 1 : -1))
    setPosts(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).map(p => (
        String(p.id) === String(postId)
          ? {
              ...p,
              comments: (p.comments || []).map(c => (
                String(c.id) === String(commentId)
                  ? { ...c, likedByMe: nextLiked, likeCount: nextCount }
                  : c
              )),
            }
          : p
      )),
    }))
    try {
      const result = await apiFetch(`/posts/${postId}/comments/${commentId}/like`, { method: 'POST' })
      setPosts(prev => ({
        ...prev,
        [channelId]: (prev[channelId] || []).map(p => (
          String(p.id) === String(postId)
            ? {
                ...p,
                comments: (p.comments || []).map(c => (
                  String(c.id) === String(commentId)
                    ? { ...c, likedByMe: Boolean(result.liked), likeCount: Number(result.likeCount || 0) }
                    : c
                )),
              }
            : p
        )),
      }))
      return result
    } catch (err) {
      setPosts(prev => ({ ...prev, [channelId]: prevChannelPosts }))
      throw err
    }
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
      const ch = (team.channels || []).find(c => String(c.id) === String(channelId))
      if (ch) {
        setSelectedTeam(team)
        await selectChannel(ch)
        if (postId) setPendingOpenPostId(postId)
        if (meta.commentId) setPendingOpenCommentId(meta.commentId)
        if (meta.attachmentId) setPendingOpenAttachmentId(meta.attachmentId)
        return true
      }
    }
    return false
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
      const params = new URLSearchParams({ q: query })
      if (selectedChannel?.id) params.set('current_channel_id', selectedChannel.id)
      if (selectedTeam?.id) params.set('current_team_id', selectedTeam.id)
      const data = await apiFetch(`/posts/search?${params.toString()}`)
      setSearchResults(data)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('open-agentic-panel'))
        window.dispatchEvent(new CustomEvent('agentic-search-results', {
          detail: { query, results: Array.isArray(data) ? data : [] },
        }))
      }
    } catch (err) {
      console.error('Search failed:', err)
      setSearchResults([])
    } finally {
      setIsSearching(false)
    }
  }

  function closeSearch() {
    setIsSearchMode(false)
  }

  function showSearchResults() {
    if (!searchTerm && searchResults.length === 0) return
    setIsSearchMode(true)
  }

  function toggleSearchResults() {
    if (!searchTerm && searchResults.length === 0) return
    setIsSearchMode(prev => !prev)
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
      markPostRead,
      addPost,
      addComment,
      incrementViews,
      deletePost,
      updatePost,
      togglePostPin,
      togglePostLike,
      toggleCommentLike,
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
      showSearchResults,
      toggleSearchResults,
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
