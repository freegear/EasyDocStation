import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import { useAuth } from './AuthContext'
import { useToast } from './ToastContext'

const ChatContext = createContext(null)
const EMPTY_SELECTED_TEAM = { id: null, channels: [], directMessages: [], admin_ids: [] }
const INITIAL_POST_LIMIT = 10
const INITIAL_BUFFER_LIMIT = 90
const OLDER_POST_BATCH_LIMIT = 100

function asList(value) {
  return Array.isArray(value) ? value : []
}

function postsFromResponse(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.posts)) return value.posts
  return []
}

function postPageFromResponse(value) {
  return {
    hasMore: Boolean(value?.hasMore),
    nextCursor: value?.nextCursor || null,
  }
}

export function ChatProvider({ children }) {
  const { currentUser, loading: authLoading } = useAuth()
  const { showToast } = useToast()
  const [teams, setTeams] = useState([])
  const [selectedTeam, setSelectedTeam] = useState(EMPTY_SELECTED_TEAM)
  const [selectedChannel, setSelectedChannel] = useState(null)
  const [posts, setPosts] = useState({})
  const [postDetails, setPostDetails] = useState({})
  const [postPageMeta, setPostPageMeta] = useState({})
  const [pendingOpenPostId, setPendingOpenPostId] = useState(null)
  const [pendingOpenCommentId, setPendingOpenCommentId] = useState(null)
  const [pendingOpenAttachmentId, setPendingOpenAttachmentId] = useState(null)
  const [agenticTarget, setAgenticTarget] = useState(null)
  const [activePostSelection, setActivePostSelection] = useState({ channelId: null, postId: null })
  const [isSearchMode, setIsSearchMode] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [isSearching, setIsSearching] = useState(false)
  const selectedChannelRef = useRef(selectedChannel)
  const postPageMetaRef = useRef(postPageMeta)
  const loadingOlderChannelsRef = useRef(new Set())
  const prefetchingChannelsRef = useRef(new Set())
  const loadingCommentsRef = useRef(new Set())
  const lastUserIdRef = useRef(null)
  const accessRecoveryRef = useRef(false)
  // 낙관적 삭제 복구용 스냅샷 (postId/commentId -> 원본 객체)
  const deletedSnapshotsRef = useRef({ posts: new Map(), comments: new Map() })

  useEffect(() => {
    selectedChannelRef.current = selectedChannel
  }, [selectedChannel])

  useEffect(() => {
    postPageMetaRef.current = postPageMeta
  }, [postPageMeta])

  useEffect(() => {
    if (authLoading) return
    const userId = currentUser?.id || null
    if (userId) {
      const userChanged = lastUserIdRef.current !== userId
      lastUserIdRef.current = userId
      if (userChanged) {
        setTeams([])
        clearTransientNavigationState()
      }
      refreshTeams({ forceDefault: userChanged })
      return
    }
    lastUserIdRef.current = null
    setTeams([])
    clearTransientNavigationState()
  }, [authLoading, currentUser?.id])

  // 현재 채널 게시글 목록 주기 갱신 (학습 상태 변화 반영)
  useEffect(() => {
    if (!currentUser?.id || !selectedChannel?.id) return undefined
    let cancelled = false
    const channelId = selectedChannel.id

    async function refreshChannelPosts() {
      try {
        const data = await apiFetch(`/posts?channelId=${channelId}&limit=${INITIAL_POST_LIMIT}`)
        if (cancelled) return
        mergeChannelPosts(channelId, postsFromResponse(data), { preserveUnread: true, mode: 'append' })
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

  function clearTransientNavigationState({ clearPosts = true } = {}) {
    clearSelectedChannel()
    setSelectedTeam(EMPTY_SELECTED_TEAM)
    if (clearPosts) {
      setPosts({})
      setPostDetails({})
      setPostPageMeta({})
      postPageMetaRef.current = {}
      loadingOlderChannelsRef.current.clear()
      prefetchingChannelsRef.current.clear()
      loadingCommentsRef.current.clear()
    }
    setPendingOpenPostId(null)
    setPendingOpenCommentId(null)
    setPendingOpenAttachmentId(null)
    setAgenticTarget(null)
    setActivePostSelection({ channelId: null, postId: null })
    setIsSearchMode(false)
    setSearchTerm('')
    setSearchResults([])
    setIsSearching(false)
  }

  function findDefaultTeamChannel(teamsData = []) {
    for (const team of teamsData) {
      const channels = Array.isArray(team.channels) ? team.channels : []
      const channel = channels.find(item => !item.is_archived) || channels[0]
      if (channel) return { team, channel }
    }
    return null
  }

  function findTeamChannelById(channelId, teamsData = teams) {
    if (!channelId) return null
    for (const team of teamsData || []) {
      const channel = (team.channels || []).find(item => String(item.id) === String(channelId))
      if (channel) return { team, channel }
    }
    return null
  }

  async function selectDefaultChannel(teamsData = [], options = {}) {
    const fallback = findDefaultTeamChannel(teamsData)
    if (!fallback) {
      setSelectedTeam(teamsData[0] || EMPTY_SELECTED_TEAM)
      clearSelectedChannel()
      return false
    }
    setSelectedTeam(fallback.team)
    return selectChannel(fallback.channel, {
      markRead: options.markRead ?? false,
      suppressAccessDenied: options.suppressAccessDenied ?? true,
    })
  }

  function mergeChannelPosts(channelId, nextPosts = [], { preserveUnread = false, mode = 'replace' } = {}) {
    setPosts(prev => {
      const previousPosts = asList(prev[channelId])
      const previousById = new Map(previousPosts.map(post => [String(post.id), post]))
      const incomingPosts = asList(nextPosts)
      const mergedPosts = preserveUnread
        ? incomingPosts.map(post => {
            const previous = previousById.get(String(post.id))
            if (!previous?.isUnread || post.isUnread === true || post.isUnread === false) return post
            return {
              ...post,
              isUnread: true,
              unreadPost: previous.unreadPost || false,
              unreadCommentCount: previous.unreadCommentCount || 0,
              unreadActivityAt: previous.unreadActivityAt || post.unreadActivityAt || post.createdAt,
            }
          })
        : incomingPosts
      const combinedPosts = mode === 'replace'
        ? mergedPosts
        : mode === 'prepend'
          ? [...mergedPosts, ...previousPosts]
          : [...previousPosts, ...mergedPosts]
      const uniqueById = new Map()
      combinedPosts.forEach(post => {
        if (post?.id == null) return
        uniqueById.set(String(post.id), post)
      })
      return { ...prev, [channelId]: sortByCreatedAt([...uniqueById.values()]) }
    })
  }

  function setChannelPostPageMeta(channelId, patch) {
    if (!channelId) return
    setPostPageMeta(prev => {
      const nextMeta = {
        ...prev,
        [channelId]: {
          ...(prev[channelId] || {}),
          ...(typeof patch === 'function' ? patch(prev[channelId] || {}) : patch),
        },
      }
      postPageMetaRef.current = nextMeta
      return nextMeta
    })
  }

  async function prefetchInitialPostBuffer(channelId, cursor) {
    if (!channelId || !cursor || prefetchingChannelsRef.current.has(channelId)) return
    prefetchingChannelsRef.current.add(channelId)
    setChannelPostPageMeta(channelId, { prefetching: true })
    try {
      const data = await apiFetch(`/posts?channelId=${channelId}&limit=${INITIAL_BUFFER_LIMIT}&before=${encodeURIComponent(cursor)}`)
      mergeChannelPosts(channelId, postsFromResponse(data), { mode: 'prepend' })
      setChannelPostPageMeta(channelId, {
        ...postPageFromResponse(data),
        prefetching: false,
      })
    } catch (err) {
      console.error('Failed to prefetch posts:', err)
      setChannelPostPageMeta(channelId, { prefetching: false })
    } finally {
      prefetchingChannelsRef.current.delete(channelId)
    }
  }

  async function loadOlderPosts(channelId = selectedChannelRef.current?.id) {
    if (!channelId) return false
    const meta = postPageMetaRef.current[channelId] || {}
    if (!meta.hasMore || !meta.nextCursor) return false
    if (loadingOlderChannelsRef.current.has(channelId) || prefetchingChannelsRef.current.has(channelId)) return false

    loadingOlderChannelsRef.current.add(channelId)
    setChannelPostPageMeta(channelId, { loadingOlder: true })
    try {
      const data = await apiFetch(`/posts?channelId=${channelId}&limit=${OLDER_POST_BATCH_LIMIT}&before=${encodeURIComponent(meta.nextCursor)}`)
      mergeChannelPosts(channelId, postsFromResponse(data), { mode: 'prepend' })
      setChannelPostPageMeta(channelId, {
        ...postPageFromResponse(data),
        loadingOlder: false,
      })
      return true
    } catch (err) {
      console.error('Failed to load older posts:', err)
      setChannelPostPageMeta(channelId, { loadingOlder: false })
      return false
    } finally {
      loadingOlderChannelsRef.current.delete(channelId)
    }
  }

  // createdAt 오름차순 정렬 (글/댓글 공용)
  function sortByCreatedAt(list = []) {
    return [...list].sort((a, b) => (
      new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
    ))
  }

  // 특정 게시글 1건만 갱신 (전체 채널 재조회 회피)
  function updatePostInChannel(channelId, postId, updater) {
    setPosts(prev => ({
      ...prev,
      [channelId]: asList(prev[channelId]).map(p => (
        String(p.id) === String(postId) ? updater(p) : p
      )),
    }))
  }

  function upsertPostInChannel(channelId, post) {
    if (!channelId || !post?.id) return
    setPosts(prev => ({
      ...prev,
      [channelId]: sortByCreatedAt([
        ...asList(prev[channelId]).filter(p => String(p.id) !== String(post.id)),
        post,
      ]),
    }))
  }

  function detailKey(channelId, postId) {
    return `${channelId || ''}:${postId || ''}`
  }

  function updatePostDetail(channelId, postId, updater) {
    if (!channelId || !postId) return
    const key = detailKey(channelId, postId)
    setPostDetails(prev => {
      const current = prev[key] || {}
      const next = typeof updater === 'function' ? updater(current) : updater
      return { ...prev, [key]: next }
    })
  }

  function removePostDetail(channelId, postId) {
    if (!channelId || !postId) return
    const key = detailKey(channelId, postId)
    setPostDetails(prev => {
      if (!Object.prototype.hasOwnProperty.call(prev, key)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  async function loadPostComments(channelId, postId, { force = false } = {}) {
    if (!channelId || !postId) return []
    const key = `${channelId}:${postId}`
    if (loadingCommentsRef.current.has(key)) return []
    if (!force) {
      const existingDetail = postDetails[key]
      if (existingDetail?.commentsLoaded) return asList(existingDetail.comments)
    }

    loadingCommentsRef.current.add(key)
    try {
      const comments = asList(await apiFetch(`/posts/${postId}/comments`))
      const listPost = asList(posts[channelId]).find(p => String(p.id) === String(postId)) || {}
      updatePostDetail(channelId, postId, detail => ({
        ...listPost,
        ...detail,
        id: String(postId),
        channel_id: channelId,
        comments,
        commentsLoaded: true,
        comment_count: comments.length,
        last_comment_at: comments.length
          ? (comments[comments.length - 1].createdAt || comments[comments.length - 1].created_at || detail.last_comment_at || listPost.last_comment_at || null)
          : null,
      }))
      updatePostInChannel(channelId, postId, p => ({
        ...p,
        comment_count: comments.length,
        last_comment_at: comments.length
          ? (comments[comments.length - 1].createdAt || comments[comments.length - 1].created_at || p.last_comment_at || null)
          : null,
      }))
      return comments
    } finally {
      loadingCommentsRef.current.delete(key)
    }
  }

  // 작성 직후 즉시 표시할 낙관적 게시글 (첨부/학습상태는 5초 폴링이 보정)
  function buildOptimisticPost(channelId, created = {}, { content = '', security_level = 0 } = {}) {
    const author = currentUser || {}
    const avatar = String(author.name || '').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    return {
      id: String(created?.id ?? `tmp-${Date.now()}`),
      channel_id: channelId,
      content: created?.content ?? content ?? '',
      title: '',
      attachments: [],
      author: {
        id: author.id ?? null,
        name: author.name ?? '나',
        username: author.username ?? '',
        avatar,
        image_url: author.image_url ?? null,
      },
      createdAt: created?.authoredAt || new Date().toISOString(),
      comments: [],
      likeCount: 0,
      likedByMe: false,
      security_level: security_level ?? 0,
      can_edit: true,
      tags: [],
      pinned: false,
      pinned_at: null,
      pinned_by: null,
      views: 0,
      isUnread: false,
      unreadPost: false,
      unreadCommentCount: 0,
      unreadActivityAt: null,
      comment_count: 0,
      last_comment_at: null,
      commentsLoaded: false,
    }
  }

  async function refreshTeams(options = {}) {
    const { forceDefault = false } = options
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

        if (!forceDefault && selectedTeam?.id) {
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
            await selectDefaultChannel(enriched, { markRead: false })
          }
        } else {
          // 최초 로드 — 첫 번째 팀/채널 자동 선택
          await selectDefaultChannel(enriched, { markRead: false })
        }
        return enriched
      } else {
        setTeams([])
        clearTransientNavigationState()
        return []
      }
    } catch (err) {
      console.error('Failed to fetch teams:', err)
      return []
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
    const { markRead = true, suppressAccessDenied = false } = options
    if (!channel?.id) return false
    setSelectedChannel(channel)
    closeSearch()

    try {
      const data = await apiFetch(`/posts?channelId=${channel.id}&limit=${INITIAL_POST_LIMIT}`)
      mergeChannelPosts(channel.id, postsFromResponse(data))
      const pageMeta = postPageFromResponse(data)
      setChannelPostPageMeta(channel.id, {
        ...pageMeta,
        loadingOlder: false,
        prefetching: false,
      })
      prefetchInitialPostBuffer(channel.id, pageMeta.nextCursor)
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
      return true
    } catch (err) {
      if (err?.status === 403 && !suppressAccessDenied) {
        window.dispatchEvent(new CustomEvent('channel-access-denied'))
      }
      console.error('Failed to fetch posts:', err)
      setPosts(prev => ({ ...prev, [channel.id]: [] }))
      setChannelPostPageMeta(channel.id, {
        hasMore: false,
        nextCursor: null,
        loadingOlder: false,
        prefetching: false,
      })
      return false
    }
  }

  async function fetchPost(channelId, postId) {
    if (!channelId || !postId) return null
    const data = await apiFetch(`/posts/${encodeURIComponent(postId)}?channelId=${encodeURIComponent(channelId)}`)
    if (data?.id) {
      upsertPostInChannel(channelId, data)
      return data
    }
    return null
  }

  function markPostRead(channelId, postId) {
    if (!channelId || !postId) return
    setPosts(prev => ({
      ...prev,
      [channelId]: asList(prev[channelId]).map(post => (
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

  async function handleSaveAccessDenied() {
    const recovered = await recoverFromAccessDenied({ refreshTeamsFirst: true })
    showToast?.({
      message: recovered
        ? '권한이 없는 채널이라 접근 가능한 채널로 이동했습니다. 새 채널에서 다시 저장해주세요.'
        : '현재 계정이 접근할 수 있는 채널이 없습니다.',
      duration: 5000,
    })
    return recovered
  }

  async function addPost(channelId, { content, attachmentIds = [], security_level }, options = {}) {
    const { suppressAlert = false } = options
    try {
      const target = findTeamChannelById(channelId)
      if (!target) {
        const recovered = await handleSaveAccessDenied()
        const err = new Error(recovered
          ? '현재 계정이 접근할 수 있는 채널로 이동했습니다. 새 채널에서 다시 저장해주세요.'
          : '현재 계정이 접근할 수 없는 채널입니다.')
        err.status = 403
        err.accessHandled = true
        throw err
      }
      const created = await apiFetch('/posts', {
        method: 'POST',
        body: JSON.stringify({ channelId, content, attachmentIds, security_level }),
      })
      // 부분 갱신: 작성 결과를 즉시 목록에 삽입(첨부/학습상태는 5초 폴링이 보정)
      const optimisticPost = buildOptimisticPost(channelId, created, { content, security_level })
      setPosts(prev => ({
        ...prev,
        [channelId]: sortByCreatedAt([
          ...asList(prev[channelId]).filter(p => String(p.id) !== String(optimisticPost.id)),
          optimisticPost,
        ]),
      }))
      return optimisticPost
    } catch (err) {
      if (err?.status === 403) {
        if (!err.accessHandled) await handleSaveAccessDenied()
        throw err
      }
      if (!suppressAlert) {
        alert('게시글 저장에 실패했습니다: ' + err.message)
      }
      throw err
    }
  }

  // ─── 댓글 추가 — DB에 저장 후 최신 목록 재조회 ──────────────
  async function addComment(channelId, postId, text, user, attachmentIds = [], security_level) {
    try {
      if (!findTeamChannelById(channelId)) {
        await handleSaveAccessDenied()
        const err = new Error('현재 계정이 접근할 수 없는 채널입니다.')
        err.status = 403
        err.accessHandled = true
        throw err
      }
      const newComment = await apiFetch(`/posts/${postId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ channelId, content: text, attachmentIds, security_level }),
      })
      // 부분 갱신: 해당 게시글의 댓글 목록에만 새 댓글을 덧붙인다(전체 재조회 X)
      if (newComment?.id) {
        const hydratedComment = {
          ...newComment,
          training_status: newComment.training_status || 'training',
          training_error: newComment.training_error || null,
        }
        updatePostInChannel(channelId, postId, p => ({
          ...p,
          comment_count: Number(p.comment_count || 0) + 1,
          last_comment_at: hydratedComment.createdAt || hydratedComment.created_at || new Date().toISOString(),
        }))
        updatePostDetail(channelId, postId, detail => ({
          ...detail,
          comment_count: Number(detail.comment_count || 0) + 1,
          last_comment_at: hydratedComment.createdAt || hydratedComment.created_at || new Date().toISOString(),
          comments: sortByCreatedAt([
            ...(detail.comments || []).filter(c => String(c.id) !== String(hydratedComment.id)),
            hydratedComment,
          ]),
          commentsLoaded: true,
        }))
      }
    } catch (err) {
      if (err?.status === 403 && !err.accessHandled) {
        await handleSaveAccessDenied()
      }
      throw err
    }
  }

  function incrementViews(channelId, postId) {
    setPosts(prev => ({
      ...prev,
      [channelId]: asList(prev[channelId]).map(p =>
        p.id === postId ? { ...p, views: (p.views || 0) + 1 } : p
      ),
    }))
  }

  async function deletePost(channelId, postId) {
    // 낙관적 삭제: 화면에서 먼저 제거하고 원본은 복구용으로 보관
    const snapshot = asList(posts[channelId]).find(p => String(p.id) === String(postId))
    if (snapshot) deletedSnapshotsRef.current.posts.set(String(postId), snapshot)
    setPosts(prev => ({
      ...prev,
      [channelId]: asList(prev[channelId]).filter(p => String(p.id) !== String(postId)),
    }))
    removePostDetail(channelId, postId)
    try {
      await apiFetch(`/posts/${postId}`, { method: 'DELETE' })
      showToast({
        message: '게시글을 삭제했습니다.',
        actionLabel: '복구',
        duration: 10000,
        onAction: () => {
          restorePost(channelId, postId).catch((err) => {
            showToast({ message: `복구 실패: ${err.message}`, duration: 5000 })
          })
        },
      })
    } catch (err) {
      // 실패 시 롤백: 보관한 스냅샷을 되돌린다
      const rollback = deletedSnapshotsRef.current.posts.get(String(postId))
      if (rollback) {
        deletedSnapshotsRef.current.posts.delete(String(postId))
        setPosts(prev => ({
          ...prev,
          [channelId]: sortByCreatedAt([
            ...asList(prev[channelId]).filter(p => String(p.id) !== String(postId)),
            rollback,
          ]),
        }))
        updatePostDetail(channelId, postId, detail => ({ ...rollback, ...detail }))
      }
      console.error('delete post error:', err)
      throw err
    }
  }

  async function deletePosts(channelId, postIds) {
    const ids = [...new Set((postIds || []).map(String).filter(Boolean))]
    if (ids.length === 0) return
    const snapshots = asList(posts[channelId]).filter(post => ids.includes(String(post.id)))
    setPosts(prev => ({
      ...prev,
      [channelId]: asList(prev[channelId]).filter(post => !ids.includes(String(post.id))),
    }))
    ids.forEach(postId => removePostDetail(channelId, postId))
    try {
      await apiFetch('/posts/easy-pages/bulk-delete', {
        method: 'POST',
        body: JSON.stringify({ channelId, postIds: ids }),
      })
      showToast({
        message: `EasyPage ${ids.length}개를 삭제했습니다.`,
        actionLabel: '복구',
        duration: 10000,
        onAction: () => Promise.all(ids.map(postId => restorePost(channelId, postId))).catch((err) => {
          showToast({ message: `복구 실패: ${err.message}`, duration: 5000 })
        }),
      })
    } catch (err) {
      setPosts(prev => ({
        ...prev,
        [channelId]: sortByCreatedAt([
          ...asList(prev[channelId]).filter(post => !ids.includes(String(post.id))),
          ...snapshots,
        ]),
      }))
      throw err
    }
  }

  // ─── 삭제한 게시글 복구 (1분 이내) ──────────────────────────
  async function restorePost(channelId, postId) {
    await apiFetch(`/posts/${postId}/restore`, { method: 'POST' })
    // 부분 갱신: 보관 스냅샷을 다시 삽입(없으면 5초 폴링이 복원)
    const snapshot = deletedSnapshotsRef.current.posts.get(String(postId))
    if (snapshot) {
      deletedSnapshotsRef.current.posts.delete(String(postId))
      setPosts(prev => ({
        ...prev,
        [channelId]: sortByCreatedAt([
          ...asList(prev[channelId]).filter(p => String(p.id) !== String(postId)),
          snapshot,
        ]),
      }))
      updatePostDetail(channelId, postId, detail => ({ ...snapshot, ...detail }))
    }
  }

  // ─── 삭제한 댓글 복구 (1분 이내) ────────────────────────────
  async function restoreComment(channelId, postId, commentId) {
    await apiFetch(`/posts/${postId}/comments/${commentId}/restore`, { method: 'POST' })
    // 부분 갱신: 보관 스냅샷을 해당 게시글의 댓글 목록에 다시 삽입
    const snapshot = deletedSnapshotsRef.current.comments.get(String(commentId))
    if (snapshot) {
      deletedSnapshotsRef.current.comments.delete(String(commentId))
      updatePostInChannel(channelId, postId, p => ({
        ...p,
        comment_count: Number(p.comment_count || 0) + 1,
        last_comment_at: snapshot.createdAt || snapshot.created_at || p.last_comment_at || null,
      }))
      updatePostDetail(channelId, postId, detail => ({
        ...detail,
        comment_count: Number(detail.comment_count || 0) + 1,
        last_comment_at: snapshot.createdAt || snapshot.created_at || detail.last_comment_at || null,
        comments: sortByCreatedAt([
          ...(detail.comments || []).filter(c => String(c.id) !== String(commentId)),
          snapshot,
        ]),
        commentsLoaded: true,
      }))
    }
  }

  // ─── 최근 삭제됨(1분 내 복구 가능) 목록 조회 ────────────────
  async function fetchDeletedItems(channelId) {
    return apiFetch(`/posts/deleted?channelId=${channelId}`)
  }

  async function updatePost(channelId, postId, { content, ragContent, attachments, security_level, waitForTraining = false, requestSource = 'unknown' }) {
    try {
      if (!findTeamChannelById(channelId)) {
        await handleSaveAccessDenied()
        const err = new Error('현재 계정이 접근할 수 없는 채널입니다.')
        err.status = 403
        err.accessHandled = true
        throw err
      }
      await apiFetch(`/posts/${postId}`, {
        method: 'PUT',
        headers: { 'X-EasyDoc-Action': requestSource },
        body: JSON.stringify({ content, ragContent, security_level, attachments, waitForTraining }),
      })
      setPosts(prev => ({
        ...prev,
        [channelId]: asList(prev[channelId]).map(p =>
          p.id === postId ? { ...p, content, attachments, security_level, updatedAt: new Date().toISOString() } : p
        ),
      }))
      updatePostDetail(channelId, postId, detail => ({
        ...detail,
        content,
        attachments,
        security_level,
        updatedAt: new Date().toISOString(),
      }))
      return true
    } catch (err) {
      if (err?.status === 403 && !err.accessHandled) {
        await handleSaveAccessDenied()
      }
      console.error('update post error:', err)
      throw err
    }
  }

  async function togglePostPin(channelId, postId, pinned) {
    const nextPinned = Boolean(pinned)
    const prevChannelPosts = asList(posts[channelId])
    const key = detailKey(channelId, postId)
    const prevPostDetail = postDetails[key]
    setPosts(prev => ({
      ...prev,
      [channelId]: asList(prev[channelId]).map(p => (
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
    updatePostDetail(channelId, postId, detail => ({
      ...detail,
      pinned: nextPinned,
      pinned_at: nextPinned ? new Date().toISOString() : null,
      pinned_by: nextPinned ? 'me' : null,
    }))
    try {
      await apiFetch(`/posts/${postId}/pin`, {
        method: 'PUT',
        body: JSON.stringify({ pinned: nextPinned }),
      })
      // 낙관적 업데이트로 이미 반영됨 — 전체 재조회 불필요
      return true
    } catch (err) {
      setPosts(prev => ({ ...prev, [channelId]: prevChannelPosts }))
      setPostDetails(prev => ({ ...prev, [key]: prevPostDetail }))
      throw err
    }
  }

  async function togglePostLike(channelId, postId) {
    const prevChannelPosts = asList(posts[channelId])
    const key = detailKey(channelId, postId)
    const prevPostDetail = postDetails[key]
    const target = prevChannelPosts.find(p => String(p.id) === String(postId))
    const nextLiked = target?.likedByMe !== true
    const nextCount = Math.max(0, Number(target?.likeCount || 0) + (nextLiked ? 1 : -1))
    setPosts(prev => ({
      ...prev,
      [channelId]: asList(prev[channelId]).map(p => (
        String(p.id) === String(postId)
          ? { ...p, likedByMe: nextLiked, likeCount: nextCount }
          : p
      )),
    }))
    updatePostDetail(channelId, postId, detail => ({
      ...detail,
      likedByMe: nextLiked,
      likeCount: nextCount,
    }))
    try {
      const result = await apiFetch(`/posts/${postId}/like`, { method: 'POST' })
      setPosts(prev => ({
        ...prev,
        [channelId]: asList(prev[channelId]).map(p => (
          String(p.id) === String(postId)
            ? { ...p, likedByMe: Boolean(result.liked), likeCount: Number(result.likeCount || 0) }
          : p
      )),
    }))
      updatePostDetail(channelId, postId, detail => ({
        ...detail,
        likedByMe: Boolean(result.liked),
        likeCount: Number(result.likeCount || 0),
      }))
      return result
    } catch (err) {
      setPosts(prev => ({ ...prev, [channelId]: prevChannelPosts }))
      setPostDetails(prev => ({ ...prev, [key]: prevPostDetail }))
      throw err
    }
  }

  async function toggleCommentLike(channelId, postId, commentId) {
    const prevChannelPosts = asList(posts[channelId])
    const key = detailKey(channelId, postId)
    const prevPostDetail = postDetails[key]
    let targetComment = null
    targetComment = (prevPostDetail?.comments || []).find(c => String(c.id) === String(commentId))
    const nextLiked = targetComment?.likedByMe !== true
    const nextCount = Math.max(0, Number(targetComment?.likeCount || 0) + (nextLiked ? 1 : -1))
    updatePostDetail(channelId, postId, detail => ({
      ...detail,
      comments: (detail.comments || []).map(c => (
        String(c.id) === String(commentId)
          ? { ...c, likedByMe: nextLiked, likeCount: nextCount }
          : c
      )),
    }))
    try {
      const result = await apiFetch(`/posts/${postId}/comments/${commentId}/like`, { method: 'POST' })
      updatePostDetail(channelId, postId, detail => ({
        ...detail,
        comments: (detail.comments || []).map(c => (
          String(c.id) === String(commentId)
            ? { ...c, likedByMe: Boolean(result.liked), likeCount: Number(result.likeCount || 0) }
            : c
        )),
      }))
      return result
    } catch (err) {
      setPosts(prev => ({ ...prev, [channelId]: prevChannelPosts }))
      setPostDetails(prev => ({ ...prev, [key]: prevPostDetail }))
      throw err
    }
  }

  // ─── 댓글 삭제 — DB에서 삭제 후 state 반영 ──────────────────
  async function deleteComment(channelId, postId, commentId) {
    // 낙관적 삭제: 해당 댓글만 화면에서 제거하고 원본은 복구용으로 보관
    const snapshot = postDetails[detailKey(channelId, postId)]?.comments
      ?.find(c => String(c.id) === String(commentId))
    if (snapshot) deletedSnapshotsRef.current.comments.set(String(commentId), snapshot)
    updatePostInChannel(channelId, postId, p => ({
      ...p,
      comment_count: Math.max(0, Number(p.comment_count || 0) - 1),
    }))
    updatePostDetail(channelId, postId, detail => ({
      ...detail,
      comment_count: Math.max(0, Number(detail.comment_count || 0) - 1),
      comments: (detail.comments || []).filter(c => String(c.id) !== String(commentId)),
    }))
    try {
      await apiFetch(`/posts/${postId}/comments/${commentId}`, { method: 'DELETE' })
      showToast({
        message: '댓글을 삭제했습니다.',
        actionLabel: '복구',
        duration: 10000,
        onAction: () => {
          restoreComment(channelId, postId, commentId).catch((err) => {
            showToast({ message: `복구 실패: ${err.message}`, duration: 5000 })
          })
        },
      })
    } catch (err) {
      // 실패 시 롤백: 보관한 댓글을 되돌린다
      const rollback = deletedSnapshotsRef.current.comments.get(String(commentId))
      if (rollback) {
        deletedSnapshotsRef.current.comments.delete(String(commentId))
        updatePostInChannel(channelId, postId, p => ({
          ...p,
          comment_count: Number(p.comment_count || 0) + 1,
          last_comment_at: rollback.createdAt || rollback.created_at || p.last_comment_at || null,
        }))
        updatePostDetail(channelId, postId, detail => ({
          ...detail,
          comment_count: Number(detail.comment_count || 0) + 1,
          last_comment_at: rollback.createdAt || rollback.created_at || detail.last_comment_at || null,
          comments: sortByCreatedAt([
            ...(detail.comments || []).filter(c => String(c.id) !== String(commentId)),
            rollback,
          ]),
          commentsLoaded: true,
        }))
      }
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
      if (!findTeamChannelById(channelId)) {
        await handleSaveAccessDenied()
        const err = new Error('현재 계정이 접근할 수 없는 채널입니다.')
        err.status = 403
        err.accessHandled = true
        throw err
      }
      await apiFetch(`/posts/${postId}/comments/${commentId}`, {
        method: 'PUT',
        body: JSON.stringify({ content: text, attachments: attachmentIds, security_level }),
      })
      // 부분 갱신: 해당 댓글 내용만 즉시 반영(첨부 상세는 5초 폴링이 보정)
      updatePostDetail(channelId, postId, detail => ({
        ...detail,
        comments: (detail.comments || []).map(c => (
          String(c.id) === String(commentId)
            ? { ...c, content: text, text, security_level, updatedAt: new Date().toISOString() }
            : c
        )),
      }))
    } catch (err) {
      if (err?.status === 403 && !err.accessHandled) {
        await handleSaveAccessDenied()
      }
      console.error('update comment error:', err)
      throw err
    }
  }

  // ─── RAG 참고 문서 클릭 시 해당 채널+게시글로 이동 ──────────
  async function navigateToPost(channelId, postId, meta = {}) {
    // teams에서 channelId에 해당하는 채널 객체를 찾아 이동
    for (const team of teams) {
      const ch = (team.channels || []).find(c => String(c.id) === String(channelId))
      if (ch) {
        setSelectedTeam(team)
        const opened = await selectChannel(ch)
        if (!opened) return false
        if (postId) {
          setPendingOpenPostId(postId)
          fetchPost(ch.id, postId).catch((err) => {
            console.error('Failed to fetch navigated post:', err)
          })
        }
        if (meta.commentId) setPendingOpenCommentId(meta.commentId)
        if (meta.attachmentId) setPendingOpenAttachmentId(meta.attachmentId)
        return true
      }
    }
    return false
  }

  async function recoverFromAccessDenied(options = {}) {
    const { refreshTeamsFirst = false } = options
    if (accessRecoveryRef.current) return false
    accessRecoveryRef.current = true
    try {
      setPendingOpenPostId(null)
      setPendingOpenCommentId(null)
      setPendingOpenAttachmentId(null)
      setAgenticTarget(null)
      setActivePostSelection({ channelId: null, postId: null })
      setIsSearchMode(false)
      setSearchResults([])

      let sourceTeams = teams
      if (refreshTeamsFirst || !Array.isArray(sourceTeams) || sourceTeams.length === 0) {
        sourceTeams = await refreshTeams({ forceDefault: true })
        return Array.isArray(sourceTeams) && sourceTeams.length > 0
      }

      const fallback = findDefaultTeamChannel(sourceTeams)
      if (!fallback?.channel?.id) return false
      if (String(selectedChannelRef.current?.id || '') === String(fallback.channel.id)) {
        return false
      }
      setSelectedTeam(fallback.team)
      return await selectChannel(fallback.channel, { markRead: false, suppressAccessDenied: true })
    } finally {
      accessRecoveryRef.current = false
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
      postDetails,
      postPageMeta,
      selectTeam,
      selectChannel,
      loadOlderPosts,
      loadPostComments,
      markPostRead,
      fetchPost,
      addPost,
      addComment,
      incrementViews,
      deletePost,
      deletePosts,
      restorePost,
      restoreComment,
      fetchDeletedItems,
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
      recoverFromAccessDenied,
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
