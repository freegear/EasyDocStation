import { useState, useRef, useEffect } from 'react'
import { useChat } from '../../contexts/ChatContext'
import { useAuth } from '../../contexts/AuthContext'
import { apiFetch } from '../../lib/api'
import { useT } from '../../i18n/useT'
import { isTemplateContent, isMailCardContent, extractMailCardData, stripMailCardMarker } from '../../templates/formTemplates'
import MailSummaryCard from '../mail/MailSummaryCard'
import { useSelectionClickGuard } from '../../hooks/useSelectionClickGuard'
import { findDuplicateFileNames } from '../../lib/fileNameValidation'
import { getPastedImageFiles } from '../../lib/clipboardFiles'
import { recordRecentPostView } from '../../lib/recentPosts'
import { getContentFontStyle } from '../../lib/contentFont'
import useMentionAutocomplete from '../../hooks/useMentionAutocomplete'
import MentionDropdown from '../MentionDropdown'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { useOutsideMouseDown } from '../../hooks/useOutsideMouseDown'
import { printSelectedContent } from '../../lib/printSelectedContent'

const EMPTY_COMMENTS = []

function ActionMenu({ type, canEdit, canDelete, canPin, pinned, readOnly = false, labels, position, onAction }) {
  const itemClass = 'flex min-h-10 w-full items-center rounded-lg px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 focus:bg-gray-100 focus:outline-none'
  const item = (key, label, tone = '') => <button key={key} type="button" role="menuitem" onClick={() => onAction(key)} className={`${itemClass} ${tone}`}>{label}</button>
  return <div role="menu" aria-label={type === 'post' ? '게시글 작업 메뉴' : '댓글 작업 메뉴'} style={{ left: position.x, top: position.y }} className="fixed z-[90] w-60 rounded-xl border border-gray-200 bg-white p-2 shadow-2xl">
    {!readOnly && canEdit && item('edit', `✎ ${labels.edit || '수정'}`)}
    {!readOnly && canDelete && item('delete', `🗑 ${labels.delete || '삭제'}`, 'text-red-600 hover:bg-red-50 focus:bg-red-50')}
    {!readOnly && (canEdit || canDelete) && <div className="my-1 border-t border-gray-100" />}
    {item('copy', `⧉ ${labels.copy}`)}
    {item('copy-link', `🔗 ${labels.copyLink}`)}
    {item('print', `🖨 ${labels.print || '인쇄'}`)}
    {type === 'post' && item('print-with-comments', `🖨 ${labels.printWithComments || '인쇄 - 댓글 포함'}`)}
    {!readOnly && type === 'post' && canPin && <><div className="my-1 border-t border-gray-100" />{item('pin', `📌 ${pinned ? '핀 해제' : '핀 고정'}`)}</>}
    {!readOnly && <div className="my-1 border-t border-gray-100" />}
    {!readOnly && item('transfer-copy', '⇥ 다른 채널로 복사', 'text-indigo-600')}
    {!readOnly && canDelete && item('transfer-move', '➜ 다른 채널로 이동', 'text-amber-600')}
    <div className="my-1 border-t border-gray-100" />
    {item('agentic', `⚡ ${labels.agentic}`, 'text-sky-600')}
    {item('dm', `💬 ${labels.dm}`, 'text-indigo-600')}
  </div>
}

function toKstDateKey(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown-date'
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

function formatKstDividerLabel(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '날짜 미상'
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d)
  const pick = (type) => parts.find((p) => p.type === type)?.value || '00'
  return `${pick('year')}년 ${pick('month')}월 ${pick('day')}일`
}

function buildDateSeparatedRows(items = [], getCreatedAt, getId) {
  const rows = []
  let prevDateKey = ''
  for (const item of items) {
    const createdAt = getCreatedAt(item)
    const dateKey = toKstDateKey(createdAt)
    if (dateKey !== prevDateKey) {
      rows.push({
        type: 'divider',
        key: `divider-${dateKey}`,
        label: formatKstDividerLabel(createdAt),
      })
      prevDateKey = dateKey
    }
    rows.push({
      type: 'item',
      key: `item-${getId(item)}`,
      item,
    })
  }
  return rows
}

function LikeButton({ liked, count, onClick, fetchLikers, label = '좋아요' }) {
  const [likersOpen, setLikersOpen] = useState(false)
  const [likers, setLikers] = useState([])
  const [likersLoading, setLikersLoading] = useState(false)
  const likerCount = Number(count || 0)

  async function handleLikersClick(e) {
    e.preventDefault()
    e.stopPropagation()
    if (likerCount <= 0 || likersLoading) return
    if (likersOpen) {
      setLikersOpen(false)
      return
    }
    setLikersLoading(true)
    try {
      const data = await fetchLikers?.()
      setLikers(Array.isArray(data) ? data : [])
      setLikersOpen(true)
    } catch (err) {
      alert(`좋아요 목록을 불러오지 못했습니다: ${err.message || err}`)
    } finally {
      setLikersLoading(false)
    }
  }

  return (
    <div className="relative inline-flex items-center gap-1">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onClick?.()
        }}
        className={`inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs transition-colors ${
          liked
            ? 'text-red-600 hover:bg-red-50'
            : 'text-gray-400 hover:bg-gray-100 hover:text-red-500'
        }`}
        title={label}
        aria-label={label}
        aria-pressed={Boolean(liked)}
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill={liked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8">
          <path strokeLinecap="round" strokeLinejoin="round" d="M20.8 4.6c-1.8-1.8-4.7-1.8-6.5 0L12 6.9 9.7 4.6c-1.8-1.8-4.7-1.8-6.5 0s-1.8 4.7 0 6.5L12 19.9l8.8-8.8c1.8-1.8 1.8-4.7 0-6.5Z" />
        </svg>
        <span className="min-w-3 tabular-nums">{likerCount}</span>
      </button>
      <button
        type="button"
        onClick={handleLikersClick}
        disabled={likerCount <= 0 || likersLoading}
        className={`inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
          likerCount > 0
            ? 'text-gray-500 hover:bg-gray-100 hover:text-gray-800'
            : 'text-gray-300 opacity-40 cursor-default'
        }`}
        title="좋아요를 누른 사람"
        aria-label="좋아요를 누른 사람"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 7.5a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.5 20.25a7.5 7.5 0 0 1 15 0" />
        </svg>
      </button>
      {likersOpen && (
        <div
          className="absolute left-0 top-8 z-30 min-w-36 max-w-56 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-700 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="max-h-40 overflow-y-auto">
            {likers.map((user) => (
              <div key={user.id} className="truncate py-1">{user.name}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function PostDetailPane({
  post,
  channelId,
  onClose,
  pendingOpenCommentId = null,
  pendingOpenAttachmentId = null,
  pendingActionMenu = null,
  onConsumeActionMenu = null,
  onConsumePendingOpen = null,
  helpers = {},
  isMobile = false,
  contentFontScale = 100,
}) {
  const t = useT()
  const { addComment, incrementViews, deletePost, updatePost, togglePostPin, togglePostLike, toggleCommentLike, deleteComment, updateComment, loadPostComments, posts, postDetails, selectedChannel, selectedTeam, teams, selectTeam, selectChannel, navigateToPost, openInAgenticAI } = useChat()
  const { currentUser, maxAttachmentFileSize } = useAuth()
  const {
    Avatar,
    PinIcon,
    TrainingStatusBadge,
    FileChip,
    AttachmentList,
    ContentRenderer,
    TemplateRenderer,
    ConfirmDialog,
    formatDate,
    formatFull,
    formatSize,
    dataTransferHasFiles,
    uploadFileWithProgress,
  } = helpers
  const [comment, setComment] = useState('')
  const [showSendToDMModal, setShowSendToDMModal] = useState(false)
  const [transferDialog, setTransferDialog] = useState(null)
  const [transferWorking, setTransferWorking] = useState(false)
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const [actionMenuPosition, setActionMenuPosition] = useState({ x: 0, y: 0 })
  const actionMenuRef = useRef(null)
  const [dmConversations, setDmConversations] = useState([])
  const [loadingDMConversations, setLoadingDMConversations] = useState(false)
  const [sendingToDMId, setSendingToDMId] = useState(null)
  const [showPostDeleteConfirm, setShowPostDeleteConfirm] = useState(false)
  const [pendingDeleteCommentId, setPendingDeleteCommentId] = useState(null)
  
  // Post Edit State
  const [isEditingPost, setIsEditingPost] = useState(false)
  const [postContent, setPostContent] = useState('')
  const [postFiles, setPostFiles] = useState([])
  const [postSecurityLevel, setPostSecurityLevel] = useState(0)

  // Comment Edit State
  const [editingCommentId, setEditingCommentId] = useState(null)
  const [commentEditContent, setCommentEditContent] = useState('')
  const [commentEditFiles, setCommentEditFiles] = useState([])
  const [commentEditSecurityLevel, setCommentEditSecurityLevel] = useState(0)

  const [commentSecurityLevel, setCommentSecurityLevel] = useState(Math.min(1, currentUser?.security_level ?? 0))
  const [commentErrorDialog, setCommentErrorDialog] = useState(null)
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsLoadError, setCommentsLoadError] = useState('')
  const [dmNoticeDialog, setDmNoticeDialog] = useState(null)
  const [duplicateFileDialog, setDuplicateFileDialog] = useState(null)
  const [, setCopiedKey] = useState('')
  const [selectedTarget, setSelectedTarget] = useState({ type: 'post', postId: post.id, id: post.id })

  const [files, setFiles] = useState([])
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(null)
  const viewedPostRef = useRef('')
  const recordedRecentRef = useRef('')
  const commentSubmittingRef = useRef(false)
  const commentsEndRef = useRef(null)
  const commentItemRefs = useRef(new Map())
  const postPrintRef = useRef(null)
  const [highlightCommentId, setHighlightCommentId] = useState(null)
  const commentTextareaRef = useRef(null)
  const mention = useMentionAutocomplete(channelId)
  const fileInputRef = useRef(null)
  const dragCounter = useRef(0)


  function addFiles(newFiles) {
    if (files.length + newFiles.length > 10) {
      alert(t.chat.maxFilesExceeded)
      return
    }
    const limitBytes = (maxAttachmentFileSize ?? 100) * 1024 * 1024
    for (const f of Array.from(newFiles)) {
      if (f.size > limitBytes) {
        alert(t.chat.fileTooLarge(maxAttachmentFileSize ?? 100))
        return
      }
    }
    if (newFiles.length > 0 && !comment.trim()) {
      setComment(newFiles[0].name)
    }
    const mapped = Array.from(newFiles).map(f => ({
      id: `f-${Date.now()}-${Math.random()}`,
      name: f.name,
      size: f.size,
      type: f.type,
      url: URL.createObjectURL(f),
      file: f,
    }))
    setFiles(prev => [...prev, ...mapped])
  }

  function removeFile(id) {
    setFiles(prev => {
      const target = prev.find(f => f.id === id)
      if (target) URL.revokeObjectURL(target.url)
      return prev.filter(f => f.id !== id)
    })
  }

  function handleDragEnter(e) {
    e.preventDefault()
    if (!dataTransferHasFiles(e.dataTransfer)) return
    dragCounter.current++
    setDragOver(true)
  }
  function handleDragLeave(e) {
    e.preventDefault()
    dragCounter.current = Math.max(0, dragCounter.current - 1)
    if (dragCounter.current === 0) setDragOver(false)
  }
  function handleDragOver(e) {
    e.preventDefault()
    if (!dataTransferHasFiles(e.dataTransfer)) return
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }
  function handleDrop(e) {
    e.preventDefault()
    dragCounter.current = 0
    setDragOver(false)
    if (dataTransferHasFiles(e.dataTransfer) && e.dataTransfer.files?.length) {
      addFiles(e.dataTransfer.files)
    }
  }

  function handleTextareaDrop(e) {
    if (!dataTransferHasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current = 0
    setDragOver(false)
    if (e.dataTransfer.files?.length) {
      addFiles(e.dataTransfer.files)
    }
  }

  function handleTextareaPaste(e) {
    const pastedImages = getPastedImageFiles(e)
    if (pastedImages.length === 0) return
    e.preventDefault()
    addFiles(pastedImages)
  }

  function handleTextareaDragOver(e) {
    if (!dataTransferHasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }

  useEffect(() => {
    const key = `${channelId}:${post.id}`
    if (viewedPostRef.current === key) return
    viewedPostRef.current = key
    incrementViews(channelId, post.id)
  }, [channelId, incrementViews, post.id])

  // "최근에 본 문서"용 스냅샷 기록 — 게시글을 열 때 1회. (WelcomeBoard.md 15절)
  useEffect(() => {
    const key = `${channelId}:${post.id}`
    if (recordedRecentRef.current === key) return
    recordedRecentRef.current = key
    const snapshot = recordRecentPostView({ post, channel: selectedChannel, team: selectedTeam, userId: currentUser?.id })
    if (snapshot) {
      apiFetch('/recent-post-views', {
        method: 'POST',
        body: JSON.stringify({ ...snapshot, teamId: selectedTeam?.id || null }),
      }).catch(() => {})
    }
  }, [channelId, post, selectedChannel, selectedTeam, currentUser?.id])

  const channelPosts = Array.isArray(posts[channelId]) ? posts[channelId] : []
  const listPost = channelPosts.find(p => String(p.id) === String(post.id)) || null
  const detailPost = postDetails?.[`${channelId}:${post.id}`] || null
  const freshPost = {
    ...post,
    ...(detailPost || {}),
    ...(listPost || {}),
  }
  const visibleComments = Array.isArray(detailPost?.comments) ? detailPost.comments : EMPTY_COMMENTS
  const metadataCommentCount = Number(freshPost.comment_count)
  const commentsLoaded = Boolean(detailPost?.commentsLoaded)
  const detailCommentCount = commentsLoaded
    ? visibleComments.length
    : Number.isFinite(metadataCommentCount)
      ? metadataCommentCount
      : visibleComments.length
  const commentRows = buildDateSeparatedRows(
    visibleComments,
    (c) => c.createdAt,
    (c) => c.id,
  )
  const normalizedSelectedTarget = String(selectedTarget.postId || '') === String(post.id)
    ? selectedTarget
    : { type: 'post', postId: post.id, id: post.id }
  const selectedComment = normalizedSelectedTarget.type === 'comment'
    ? visibleComments.find(c => String(c.id) === String(normalizedSelectedTarget.id))
    : null
  const activeTargetType = selectedComment ? 'comment' : 'post'
  const isSiteAdmin = currentUser?.role === 'site_admin'
  const isPinManagerRole = ['site_admin', 'team_admin', 'channel_admin'].includes(String(currentUser?.role || ''))
  const isPostAuthor = String(freshPost.author?.id ?? '') === String(currentUser?.id ?? '')
  const canEditPost = freshPost.can_edit != null ? Boolean(freshPost.can_edit) : isPostAuthor
  const canDeletePost = isSiteAdmin || isPostAuthor
  const canPinPost = isPinManagerRole || isPostAuthor
  const canEditComment = selectedComment && (
    selectedComment.can_edit != null
      ? Boolean(selectedComment.can_edit)
      : String(selectedComment.author?.id ?? '') === String(currentUser?.id ?? '')
  )
  const isCommentAuthor = selectedComment && String(selectedComment.author?.id ?? '') === String(currentUser?.id ?? '')
  const canDeleteComment = selectedComment && (isSiteAdmin || isCommentAuthor)
  const canEditSelected = activeTargetType === 'post' ? canEditPost : Boolean(canEditComment)
  const canDeleteSelected = activeTargetType === 'post' ? canDeletePost : Boolean(canDeleteComment)
  const canPinSelected = activeTargetType === 'post' && canPinPost
  const selectedContent = activeTargetType === 'post'
    ? (isTemplateContent(freshPost.content) ? toPlainTextFromHtml(freshPost.content)
      : isMailCardContent(freshPost.content) ? stripMailCardMarker(freshPost.content)
      : freshPost.content)
    : selectedComment?.text
  const selectedCopyKey = activeTargetType === 'post' ? `post:${post.id}` : `comment:${selectedComment?.id}`
  const selectedLinkKey = activeTargetType === 'post' ? `post-link:${post.id}` : `comment-link:${selectedComment?.id}`
  const maxSelectableLevel = isSiteAdmin ? 4 : (currentUser?.security_level ?? 0)
  const postTrainingStatus = freshPost.training_status || null
  const postBodySelectionGuard = useSelectionClickGuard({
    scope: 'post-detail-body',
    dragThreshold: 4,
    blockOnAnySelection: false,
  })
  const commentBodySelectionGuard = useSelectionClickGuard({
    scope: 'post-detail-comment',
    dragThreshold: 4,
    blockOnAnySelection: false,
  })
  useOutsideMouseDown({
    enabled: actionMenuOpen,
    containerRef: actionMenuRef,
    onOutside: () => setActionMenuOpen(false),
    ignoreWhenTextSelected: true,
    scope: 'post-detail-action-menu',
  })

  useEffect(() => {
    if (!actionMenuOpen) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setActionMenuOpen(false)
        return
      }
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
      const items = [...(actionMenuRef.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') || [])]
      if (!items.length) return
      event.preventDefault()
      const current = items.indexOf(document.activeElement)
      const delta = event.key === 'ArrowDown' ? 1 : -1
      items[(current + delta + items.length) % items.length].focus()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [actionMenuOpen])

  function openContextActionMenu(event, target) {
    if (event.target?.closest?.('a, button, input, textarea, select, [data-attachment]')) return
    event.preventDefault()
    event.stopPropagation()
    if (target.type === 'comment') selectCommentTarget(target.comment)
    else setSelectedTarget({ type: 'post', postId: post.id, id: post.id })
    const menuWidth = 240
    const menuHeight = target.type === 'post' ? 430 : 390
    setActionMenuPosition({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
    })
    setActionMenuOpen(true)
  }

  useEffect(() => {
    if (!pendingActionMenu || String(pendingActionMenu.postId) !== String(post.id)) return
    setSelectedTarget({ type: 'post', postId: post.id, id: post.id })
    const menuWidth = 240
    const menuHeight = 440
    setActionMenuPosition({
      x: Math.max(8, Math.min(pendingActionMenu.x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(pendingActionMenu.y, window.innerHeight - menuHeight - 8)),
    })
    setActionMenuOpen(true)
    onConsumeActionMenu?.(pendingActionMenu.requestId)
  }, [onConsumeActionMenu, pendingActionMenu, post.id])
  const contentFontStyle = getContentFontStyle(contentFontScale)
  const postTextStyle = contentFontStyle
  const commentTextStyle = contentFontStyle

  useEffect(() => {
    if (!channelId || !post.id || commentsLoaded) return undefined
    let cancelled = false
    setCommentsLoading(true)
    setCommentsLoadError('')
    loadPostComments(channelId, post.id)
      .catch((err) => {
        if (!cancelled) setCommentsLoadError(err?.message || '댓글을 불러오지 못했습니다.')
      })
      .finally(() => {
        if (!cancelled) setCommentsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [channelId, commentsLoaded, loadPostComments, post.id])

  useEffect(() => {
    if (!channelId || !post.id || !commentsLoaded) return
    if (!Number.isFinite(metadataCommentCount)) return
    if (metadataCommentCount === visibleComments.length) return
    loadPostComments(channelId, post.id, { force: true }).catch(() => {})
  }, [channelId, commentsLoaded, loadPostComments, metadataCommentCount, post.id, visibleComments.length])

  useEffect(() => {
    if (!pendingOpenCommentId) return
    const exists = visibleComments.some(c => String(c.id) === String(pendingOpenCommentId))
    if (!exists) return

    const timer = setTimeout(() => {
      const el = commentItemRefs.current.get(String(pendingOpenCommentId))
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      setSelectedTarget({ type: 'comment', postId: post.id, id: String(pendingOpenCommentId) })
      setHighlightCommentId(String(pendingOpenCommentId))
      if (!pendingOpenAttachmentId) onConsumePendingOpen?.()
      setTimeout(() => setHighlightCommentId(null), 2200)
    }, 120)

    return () => clearTimeout(timer)
  }, [pendingOpenCommentId, pendingOpenAttachmentId, visibleComments, onConsumePendingOpen, post.id])

  function selectPostTarget(e) {
    if (postBodySelectionGuard.shouldBlockClick(e)) return
    setSelectedTarget({ type: 'post', postId: post.id, id: post.id })
  }

  function selectCommentTarget(commentObj) {
    setSelectedTarget({ type: 'comment', postId: post.id, id: String(commentObj.id) })
  }

  function guardSelectionMouseDownCapture(e, guard) {
    guard.handleMouseDown(e)
  }

  function guardSelectionMouseUpCapture(e, guard) {
    guard.handleMouseUp(e)
  }

  function guardSelectionClickCapture(e, guard) {
    guard.handleClickCapture(e)
  }

  function extractQuotationDocNo(content = '') {
    const m = content.match(/data-type=['"]no['"][^>]*>([^<]*)</i)
    return (m?.[1] || '').trim()
  }

  function isQuotationTemplate(content = '') {
    return isTemplateContent(content) && /<title>\s*견적서/i.test(content)
  }

  function extractExpenseDocNo(content = '') {
    const m = content.match(/data-field=['"]expense-doc-no['"][^>]*>([^<]*)</i)
    return (m?.[1] || '').trim()
  }

  function isExpenseTemplate(content = '') {
    return isTemplateContent(content) && /data-field=['"]expense-doc-no['"]/i.test(content)
  }

  function extractTripDocNo(content = '') {
    const m = content.match(/id=['"]trip-doc-no['"][^>]*>([^<]*)</i)
    return (m?.[1] || '').trim()
  }

  function isTripTemplate(content = '') {
    return isTemplateContent(content) && /id=['"]trip-doc-no['"]/i.test(content)
  }

  function toPlainTextFromHtml(html = '') {
    if (!html) return ''
    if (typeof window === 'undefined' || !window.document) return String(html || '')
    const el = window.document.createElement('div')
    el.innerHTML = html
    return (el.textContent || el.innerText || '').trim()
  }

  async function copyTextContent(text, key) {
    const normalized = String(text || '').trim()
    if (!normalized) return
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(normalized)
      } else {
        const ta = document.createElement('textarea')
        ta.value = normalized
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(prev => (prev === key ? '' : prev)), 1500)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = normalized
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(prev => (prev === key ? '' : prev)), 1500)
    }
  }

  async function copyPermalink({ postId, commentId = '' } = {}, key = '') {
    const link = `${window.location.origin}/?channelId=${encodeURIComponent(channelId)}&postId=${encodeURIComponent(postId || post.id)}${commentId ? `&commentId=${encodeURIComponent(commentId)}` : ''}`
    await copyTextContent(link, key || `link:${postId || post.id}:${commentId || 'post'}`)
  }

  async function handleComment(e) {
    e.preventDefault()
    if (commentSubmittingRef.current) return
    if ((!comment.trim() && files.length === 0) || !currentUser) return
    const duplicateNames = findDuplicateFileNames(files)
    if (duplicateNames.length > 0) {
      setDuplicateFileDialog(duplicateNames)
      return
    }
    
    commentSubmittingRef.current = true
    setUploading(true)
    try {
      const attachmentIds = []
      const totalUploadBytes = files.reduce((sum, f) => sum + (f.file?.size || 0), 0)
      let uploadedBytesDone = 0
      if (files.length > 0) {
        setUploadProgress({
          percent: 0,
          uploadedBytes: 0,
          totalBytes: totalUploadBytes,
          fileIndex: 1,
          fileCount: files.length,
        })
      }
      for (let i = 0; i < files.length; i++) {
        const fObj = files[i]
        const { uploadUrl, file_uuid } = await apiFetch('/files/get-upload-url', {
          method: 'POST',
          body: JSON.stringify({
            filename: fObj.name,
            contentType: fObj.type,
            channelId: selectedChannel?.id,
          }),
        })
        await uploadFileWithProgress(uploadUrl, fObj.file, ({ loaded, total }) => {
          const currentTotal = total || fObj.file?.size || 0
          const safeLoaded = Math.min(Math.max(loaded || 0, 0), currentTotal)
          const overallUploaded = uploadedBytesDone + safeLoaded
          const percent = totalUploadBytes > 0
            ? Math.min(100, Math.round((overallUploaded / totalUploadBytes) * 100))
            : 100
          setUploadProgress({
            percent,
            uploadedBytes: overallUploaded,
            totalBytes: totalUploadBytes,
            fileIndex: i + 1,
            fileCount: files.length,
          })
        })
        uploadedBytesDone += fObj.file?.size || 0
        attachmentIds.push(file_uuid)
      }

      await addComment(channelId, post.id, comment.trim(), currentUser, attachmentIds, commentSecurityLevel)

      files.forEach(f => URL.revokeObjectURL(f.url))
      setComment('')
      setFiles([])
      setTimeout(() => commentsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
    } catch (err) {
      setCommentErrorDialog(t.chat.commentError(err.message))
    } finally {
      setUploading(false)
      setUploadProgress(null)
      commentSubmittingRef.current = false
    }
  }

  // Handlers for Post Edit
  function startPostEdit() {
    setEditingCommentId(null)
    setSelectedTarget({ type: 'post', postId: post.id, id: post.id })
    setPostContent(freshPost.content)
    setPostFiles(freshPost.attachments || [])
    setPostSecurityLevel(freshPost.security_level ?? currentUser?.security_level ?? 0)
    setIsEditingPost(true)
  }

  function cancelPostEdit() {
    setIsEditingPost(false)
  }

  async function handlePostUpdate() {
    setUploading(true)
    try {
      const attachments = [...postFiles]
      await updatePost(channelId, post.id, { content: postContent, attachments, security_level: postSecurityLevel, requestSource: 'post-detail:edit-save' })
      setIsEditingPost(false)
    } catch (err) {
      alert(t.chat.saveError(err.message))
    } finally {
      setUploading(false)
    }
  }

  async function handleTogglePin() {
    try {
      await togglePostPin(channelId, post.id, !freshPost.pinned)
    } catch (err) {
      alert(`핀 상태 변경에 실패했습니다: ${err.message || err}`)
    }
  }

  function handleDelete() {
    setShowPostDeleteConfirm(true)
  }

  function handleSelectedEdit() {
    if (activeTargetType === 'comment' && selectedComment) {
      startCommentEdit(selectedComment)
      return
    }
    startPostEdit()
  }

  function handleSelectedDelete() {
    if (activeTargetType === 'comment' && selectedComment) {
      handleCommentDelete(selectedComment.id)
      return
    }
    handleDelete()
  }

  async function handleSelectedCopyLink() {
    await copyPermalink({
      postId: post.id,
      commentId: activeTargetType === 'comment' ? selectedComment?.id : '',
    }, selectedLinkKey)
  }

  async function handleSelectedCopyContent() {
    await copyTextContent(selectedContent, selectedCopyKey)
  }

  function getPrintTitle() {
    if (activeTargetType === 'comment') return '댓글'
    const firstLine = String(selectedContent || '').split('\n').map(line => line.trim()).find(Boolean)
    return (firstLine || '게시글').slice(0, 120)
  }

  async function handlePrintSelected({ includeComments = false } = {}) {
    const isComment = activeTargetType === 'comment' && selectedComment
    if (includeComments && !commentsLoaded) {
      try {
        await loadPostComments(channelId, post.id)
        await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))
      } catch (error) {
        setCommentErrorDialog(error?.message || '댓글을 불러오지 못했습니다.')
        return
      }
    }
    const targetNode = isComment
      ? commentItemRefs.current.get(String(selectedComment.id))
      : postPrintRef.current
    try {
      await printSelectedContent({
        type: isComment ? 'comment' : 'post',
        title: getPrintTitle(),
        channelName: selectedChannel?.name || '',
        author: isComment ? selectedComment.author?.name : freshPost.author?.name,
        username: isComment ? selectedComment.author?.username : freshPost.author?.username,
        createdAt: formatFull(isComment ? selectedComment.createdAt : freshPost.createdAt),
        contentNode: targetNode,
        includeComments,
        popupBlockedMessage: t.chat.printPopupBlocked,
        failedMessage: t.chat.printFailed,
      })
    } catch (error) {
      setCommentErrorDialog(error?.message || t.chat.printFailed || '인쇄 준비 중 오류가 발생했습니다.')
    }
  }

  function openTransferDialog(operation) {
    const isComment = activeTargetType === 'comment' && selectedComment
    const firstTarget = (teams || []).flatMap(team => (team.channels || []).map(channel => ({ team, channel })))
      .find(item => !item.channel.is_archived && String(item.channel.id) !== String(channelId))
    if (!firstTarget) {
      setCommentErrorDialog('이동하거나 복사할 수 있는 다른 채널이 없습니다.')
      return
    }
    setTransferDialog({ operation, contentType: isComment ? 'COMMENT' : 'POST', targetChannelId: firstTarget.channel.id,
      includeComments: true, includeAttachments: true, mode: 'AS_POST', targetPostId: '' })
  }

  async function submitTransfer() {
    if (!transferDialog || transferWorking) return
    setTransferWorking(true)
    try {
      const isComment = transferDialog.contentType === 'COMMENT'
      const endpoint = isComment
        ? `/posts/${post.id}/comments/${selectedComment.id}/transfer`
        : `/posts/${post.id}/transfer`
      const result = await apiFetch(endpoint, { method: 'POST', body: JSON.stringify({ ...transferDialog,
        idempotencyKey: `${currentUser.id}:${Date.now()}:${crypto.randomUUID?.() || Math.random()}` }) })
      const destination = (teams || []).flatMap(team => (team.channels || []).map(channel => ({ team, channel })))
        .find(item => String(item.channel.id) === String(result.targetChannelId))
      setTransferDialog(null)
      if (destination) {
        selectTeam(destination.team)
        await selectChannel(destination.channel)
        await navigateToPost(result.targetChannelId, result.targetPostId, { commentId: result.targetCommentId || '' })
      } else {
        onClose?.()
      }
    } catch (err) {
      setCommentErrorDialog(`콘텐츠 전송에 실패했습니다: ${err.message}`)
    } finally {
      setTransferWorking(false)
    }
  }

  async function openSendToDMModal() {
    setShowSendToDMModal(true)
    setLoadingDMConversations(true)
    try {
      const data = await apiFetch('/dm/conversations')
      setDmConversations(Array.isArray(data) ? data : [])
    } catch (err) {
      alert(err.message)
      setShowSendToDMModal(false)
    } finally {
      setLoadingDMConversations(false)
    }
  }

  function buildAgenticPostTarget() {
    const titleLine = (freshPost.content || '')
      .split('\n')
      .map(v => v.trim())
      .find(Boolean) || `${freshPost.author?.name || ''} 게시글`
    return {
      type: 'post',
      channelId,
      postId: post.id,
      commentId: '',
      label: titleLine.slice(0, 120),
      link: '',
      content: String(freshPost.content || ''),
      channelName: selectedChannel?.name || channelId,
    }
  }

  function buildAgenticCommentTarget(commentObj) {
    const postLink = `${window.location.origin}/?channelId=${encodeURIComponent(channelId)}&postId=${encodeURIComponent(post.id)}&commentId=${encodeURIComponent(commentObj?.id || '')}`
    const textLine = (commentObj?.text || commentObj?.content || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)
    return {
      type: 'comment',
      channelId,
      postId: post.id,
      commentId: commentObj?.id || '',
      label: textLine || `${commentObj?.author?.name || ''} 댓글`,
      link: postLink,
      channelName: selectedChannel?.name || channelId,
    }
  }

  function handleSendPostToAgenticAI() {
    openInAgenticAI(buildAgenticPostTarget())
    window.dispatchEvent(new CustomEvent('agentic-fill-input', {
      detail: { text: String(freshPost.content || '') },
    }))
    window.dispatchEvent(new Event('open-agentic-panel'))
  }

  function handleSendCommentToAgenticAI(commentObj) {
    openInAgenticAI(buildAgenticCommentTarget(commentObj))
    window.dispatchEvent(new Event('open-agentic-panel'))
  }

  function handleSendSelectedToAgenticAI() {
    if (activeTargetType === 'comment' && selectedComment) {
      handleSendCommentToAgenticAI(selectedComment)
      return
    }
    handleSendPostToAgenticAI()
  }

  async function handleSendSelectedLinkToDM(conv) {
    if (!conv?.id || sendingToDMId) return
    setSendingToDMId(conv.id)
    try {
      let message
      if (activeTargetType === 'comment' && selectedComment) {
        const titleLine = (selectedComment.text || '')
          .replace(/\s+/g, ' ')
          .trim() || `${selectedComment.author?.name || ''} 댓글`
        const commentLink = `${window.location.origin}/?channelId=${encodeURIComponent(channelId)}&postId=${encodeURIComponent(post.id)}&commentId=${encodeURIComponent(selectedComment.id)}`
        message = [
          '[댓글 링크]',
          `내용: ${titleLine.slice(0, 120)}`,
          `채널: ${selectedChannel?.name || channelId}`,
          commentLink,
        ].join('\n')
      } else {
        const defaultTitleLine = (freshPost.content || '')
          .split('\n')
          .map(v => v.trim())
          .find(Boolean) || `${freshPost.author?.name || ''} 게시글`
        const quoteDocNo = isQuotationTemplate(freshPost.content)
          ? extractQuotationDocNo(freshPost.content)
          : ''
        const expenseDocNo = isExpenseTemplate(freshPost.content)
          ? extractExpenseDocNo(freshPost.content)
          : ''
        const tripDocNo = isTripTemplate(freshPost.content)
          ? extractTripDocNo(freshPost.content)
          : ''
        const titleLine = quoteDocNo || expenseDocNo || tripDocNo || defaultTitleLine
        const postLink = `${window.location.origin}/?channelId=${encodeURIComponent(channelId)}&postId=${encodeURIComponent(post.id)}`
        message = [
          '[게시글 링크]',
          `제목: ${titleLine.slice(0, 120)}`,
          `채널: ${selectedChannel?.name || channelId}`,
          postLink,
        ].join('\n')
      }

      await apiFetch(`/dm/conversations/${conv.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: message, attachments: [] }),
      })
      setDmNoticeDialog(t.chat.sendToDMSuccess)
      setShowSendToDMModal(false)
    } catch (err) {
      alert(err.message)
    } finally {
      setSendingToDMId(null)
    }
  }

  // Handlers for Comment Edit/Delete
  function startCommentEdit(c) {
    setIsEditingPost(false)
    setSelectedTarget({ type: 'comment', postId: post.id, id: String(c.id) })
    setEditingCommentId(c.id)
    setCommentEditContent(c.text)
    setCommentEditFiles(c.attachments || [])
    setCommentEditSecurityLevel(c.security_level ?? currentUser?.security_level ?? 0)
  }

  function cancelCommentEdit() {
    setEditingCommentId(null)
  }

  function handleCommentDelete(cId) {
    setPendingDeleteCommentId(cId)
  }

  async function handleCommentUpdate(cId) {
    try {
      await updateComment(channelId, post.id, cId, {
        text: commentEditContent,
        attachments: commentEditFiles,
        security_level: commentEditSecurityLevel,
      })
      setEditingCommentId(null)
    } catch (err) {
      setCommentErrorDialog(`댓글 수정에 실패했습니다: ${err.message}`)
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0" style={{ WebkitAppRegion: 'no-drag' }}>
      <div className={`flex items-center gap-3 border-b border-gray-200 flex-shrink-0 ${isMobile ? 'px-3 py-2 overflow-x-auto' : 'px-6 py-3'}`}>
        <div className="flex-1" />
        {/* Close right panel (데스크톱 전용 — 모바일은 ChatArea 상단 뒤로가기 사용) */}
        {!isMobile && (
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg text-gray-400 hover:text-gray-900 hover:bg-gray-200 flex items-center justify-center transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {actionMenuOpen && !isEditingPost && <div ref={actionMenuRef}>
        <ActionMenu
          type={activeTargetType}
          canEdit={canEditSelected}
          canDelete={canDeleteSelected}
          canPin={canPinSelected}
          pinned={Boolean(freshPost.pinned)}
          readOnly={Boolean(selectedChannel?.is_archived)}
          position={actionMenuPosition}
          labels={{ edit: t.chat.edit, delete: t.chat.delete, copy: t.ai.copy || '복사', copyLink: t.chat.copyLink || '링크복사', print: t.chat.print || '인쇄', printWithComments: t.chat.printWithComments || '인쇄 - 댓글 포함', agentic: t.chat.sendToAgenticAI || 'AgenticAI로 보내기', dm: t.chat.sendToDM }}
          onAction={(action) => {
            setActionMenuOpen(false)
            if (action === 'edit') handleSelectedEdit()
            else if (action === 'delete') handleSelectedDelete()
            else if (action === 'copy') handleSelectedCopyContent()
            else if (action === 'copy-link') handleSelectedCopyLink()
            else if (action === 'print') handlePrintSelected()
            else if (action === 'print-with-comments') handlePrintSelected({ includeComments: true })
            else if (action === 'pin') handleTogglePin()
            else if (action === 'transfer-copy') openTransferDialog('COPY')
            else if (action === 'transfer-move') openTransferDialog('MOVE')
            else if (action === 'agentic') handleSendSelectedToAgenticAI()
            else if (action === 'dm') openSendToDMModal()
          }}
        />
      </div>}

      {showSendToDMModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl p-5 w-[420px] max-w-[92vw]">
            <h3 className="text-gray-900 font-bold text-base mb-2">{t.chat.sendToDMTitle}</h3>
            <p className="text-gray-400 text-xs mb-3">{t.chat.sendToDMHint}</p>
            <div className="max-h-64 overflow-y-auto border border-gray-200 rounded-xl p-2">
              {loadingDMConversations ? (
                <p className="text-gray-400 text-sm text-center py-6">{t.admin.loading}</p>
              ) : dmConversations.length === 0 ? (
                <p className="text-gray-400 text-sm text-center py-6">{t.search.noResults}</p>
              ) : (
                dmConversations.map(conv => (
                  <button
                    key={conv.id}
                    onClick={() => handleSendSelectedLinkToDM(conv)}
                    disabled={sendingToDMId === conv.id}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-indigo-50 disabled:opacity-50"
                  >
                    <p className="text-sm text-gray-800 font-semibold truncate">{conv.name || '대화'}</p>
                    <p className="text-[11px] text-gray-400 truncate">
                      {(conv.participant_details || []).map(p => p.display_name || p.username).filter(Boolean).join(', ')}
                    </p>
                  </button>
                ))
              )}
            </div>
            <div className="flex justify-end mt-3">
              <button
                onClick={() => setShowSendToDMModal(false)}
                className="px-4 py-2 rounded-xl text-sm text-gray-500 hover:bg-gray-100"
              >
                {t.chat.cancel}
              </button>
            </div>
          </div>
        </div>
      )}
      {transferDialog && (
        <div className="fixed inset-0 z-[96] flex items-center justify-center bg-black/45 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
            <h3 className="text-base font-bold text-gray-900">{transferDialog.contentType === 'POST' ? '게시글' : '댓글'} {transferDialog.operation === 'MOVE' ? '이동' : '복사'}</h3>
            <p className="mt-1 text-xs text-gray-500">대상 채널에 쓰기 권한이 있어야 하며 보안 등급은 유지됩니다.</p>
            <label className="mt-4 block text-xs font-semibold text-gray-600">대상 채널
              <select value={transferDialog.targetChannelId} onChange={e => setTransferDialog(prev => ({ ...prev, targetChannelId: e.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 p-2 text-sm">
                {(teams || []).map(team => (team.channels || []).filter(ch => !ch.is_archived && String(ch.id) !== String(channelId)).map(ch => <option key={ch.id} value={ch.id}>{team.name} / {ch.name}</option>))}
              </select>
            </label>
            {transferDialog.contentType === 'COMMENT' && <>
              <label className="mt-3 block text-xs font-semibold text-gray-600">전송 위치
                <select value={transferDialog.mode} onChange={e => setTransferDialog(prev => ({ ...prev, mode: e.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 p-2 text-sm">
                  <option value="AS_POST">대상 채널의 새 게시글</option><option value="AS_COMMENT">대상 게시글의 댓글</option>
                </select>
              </label>
              {transferDialog.mode === 'AS_COMMENT' && <label className="mt-3 block text-xs font-semibold text-gray-600">대상 게시글 ID
                <input value={transferDialog.targetPostId} onChange={e => setTransferDialog(prev => ({ ...prev, targetPostId: e.target.value.trim() }))} className="mt-1 w-full rounded-lg border border-gray-300 p-2 text-sm" placeholder="대상 게시글 링크의 postId" />
              </label>}
            </>}
            {transferDialog.contentType === 'POST' && transferDialog.operation === 'COPY' && <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={transferDialog.includeComments} onChange={e => setTransferDialog(prev => ({ ...prev, includeComments: e.target.checked }))} />댓글 포함</label>}
            <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={transferDialog.includeAttachments} onChange={e => setTransferDialog(prev => ({ ...prev, includeAttachments: e.target.checked }))} />첨부파일 포함</label>
            <div className="mt-5 flex justify-end gap-2"><button disabled={transferWorking} onClick={() => setTransferDialog(null)} className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100">취소</button><button disabled={transferWorking || (transferDialog.mode === 'AS_COMMENT' && !transferDialog.targetPostId)} onClick={submitTransfer} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{transferWorking ? '처리 중…' : transferDialog.operation === 'MOVE' ? '이동' : '복사'}</button></div>
          </div>
        </div>
      )}
      {showPostDeleteConfirm && (
        <ConfirmDialog
          title={t.chat.delete}
          message={t.chat.deletePostConfirm}
          confirmText={t.chat.delete}
          cancelText={t.chat.cancel}
          danger
          onConfirm={() => {
            deletePost(channelId, post.id).catch((err) => {
              setCommentErrorDialog(`게시글 삭제에 실패했습니다: ${err.message}`)
            })
            setShowPostDeleteConfirm(false)
            onClose()
          }}
          onCancel={() => setShowPostDeleteConfirm(false)}
        />
      )}
      {pendingDeleteCommentId && (
        <ConfirmDialog
          title={t.chat.delete}
          message={t.chat.deleteCommentConfirm}
          confirmText={t.chat.delete}
          cancelText={t.chat.cancel}
          danger
          onConfirm={() => {
            deleteComment(channelId, post.id, pendingDeleteCommentId).catch((err) => {
              setCommentErrorDialog(`댓글 삭제에 실패했습니다: ${err.message}`)
            })
            setPendingDeleteCommentId(null)
          }}
          onCancel={() => setPendingDeleteCommentId(null)}
        />
      )}
      {commentErrorDialog && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/45 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-white border border-gray-200 shadow-2xl p-5">
            <h3 className="text-gray-900 font-bold text-base">{t.chat.errorTitle}</h3>
            <p className="text-gray-600 text-sm mt-2 whitespace-pre-wrap leading-relaxed">{commentErrorDialog}</p>
            <div className="flex justify-end mt-5">
              <button
                onClick={() => setCommentErrorDialog(null)}
                className="px-4 py-2 rounded-xl text-sm text-white bg-indigo-600 hover:bg-indigo-700"
              >
                {t.chat.ok}
              </button>
            </div>
          </div>
        </div>
      )}
      {dmNoticeDialog && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/45 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-white border border-gray-200 shadow-2xl p-5">
            <h3 className="text-gray-900 font-bold text-base">알림</h3>
            <p className="text-gray-600 text-sm mt-2 whitespace-pre-wrap leading-relaxed">{dmNoticeDialog}</p>
            <div className="flex justify-end mt-5">
              <button
                onClick={() => setDmNoticeDialog(null)}
                className="px-4 py-2 rounded-xl text-sm text-white bg-indigo-600 hover:bg-indigo-700"
              >
                {t.chat.ok}
              </button>
            </div>
          </div>
        </div>
      )}
      {duplicateFileDialog && (
        <ConfirmDialog
          title={t.chat.fileAttachDuplicateTitle || '중복 파일명 경고'}
          titleTone="blue"
          message={t.chat.fileAttachDuplicateMessage || '첨부파일에 같은 이름이 있습니다. 파일명을 변경한 뒤 다시 게시해 주세요.'}
          highlightItems={duplicateFileDialog}
          confirmText={t.chat.ok || '확인'}
          hideCancel
          onConfirm={() => setDuplicateFileDialog(null)}
          onCancel={() => setDuplicateFileDialog(null)}
        />
      )}

      <PanelGroup
        direction="vertical"
        autoSaveId={`post-detail-compose:${currentUser?.id ?? 'anon'}:${post.id ?? 'none'}`}
        className="flex-1 min-h-0"
      >
        <Panel defaultSize={isMobile ? 82 : 72} minSize={25} className="overflow-hidden">
      <div
        ref={postPrintRef}
        onContextMenu={(event) => {
          if (event.target?.closest?.('[data-comment-card="true"]')) return
          openContextActionMenu(event, { type: 'post' })
        }}
        className={`h-full ${isMobile ? 'px-4 py-4' : 'px-6 py-6'} ${isEditingPost ? 'flex flex-col overflow-hidden' : 'overflow-y-auto overflow-x-hidden'}`}
      >
        {/* Meta */}
        <div className="mb-6">
          {freshPost.pinned && <div className="flex items-center gap-1.5 text-amber-600 text-xs font-medium mb-3"><PinIcon /><span>{t.chat.pinnedPost}</span></div>}
          <div
            onClick={() => { setSelectedTarget({ type: 'post', postId: post.id, id: post.id }); setActionMenuOpen(false) }}
            onContextMenu={(event) => openContextActionMenu(event, { type: 'post' })}
            className={`flex items-center gap-4 mb-6 p-4 rounded-2xl border transition-colors ${activeTargetType === 'post' ? 'bg-indigo-50/60 border-indigo-200' : 'bg-gray-50 border-gray-200'}`}
          >
            <Avatar letters={freshPost.author?.avatar || '?'} imageUrl={freshPost.author?.image_url} size="lg" />
            <div className="min-w-0 flex-1">
              <p className="text-gray-900 font-semibold text-base leading-tight">{freshPost.author?.name}</p>
              {freshPost.author?.username && (
                <p className="text-indigo-600/70 text-xs mt-0.5">@{freshPost.author.username}</p>
              )}
              <p className="text-gray-400 text-xs mt-1" title={formatFull(freshPost.createdAt)}>
                {t.chat.postedAt}: {formatFull(freshPost.createdAt)}
              </p>
              {postTrainingStatus && (
                <div className="mt-2">
                  <TrainingStatusBadge status={postTrainingStatus} error={freshPost.training_error} />
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="border-t border-gray-200 mb-6" />

        {/* Body & Attachments */}
        {isEditingPost ? (
          <div className="bg-gray-100 rounded-2xl border border-indigo-300 p-4 mb-6 flex flex-col gap-4 flex-1 min-h-0">
            <textarea
              value={postContent}
              onChange={e => setPostContent(e.target.value)}
              onKeyDown={e => {
                if (e.key !== 'Escape') return
                e.preventDefault()
                e.stopPropagation()
                cancelPostEdit()
              }}
              className="w-full flex-1 min-h-0 h-full bg-transparent text-gray-800 placeholder-gray-400 text-sm leading-relaxed resize-none focus:outline-none overflow-y-auto"
              style={postTextStyle}
            />
            {postFiles.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {postFiles.map(f => <FileChip key={f.id} file={f} onRemove={(id) => setPostFiles(prev => prev.filter(x => x.id !== id))} />)}
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <label className="text-gray-400 text-[10px] font-medium whitespace-nowrap">{t.chat.securityLevelLabel}</label>
                <select
                  value={postSecurityLevel}
                  onChange={e => setPostSecurityLevel(Number(e.target.value))}
                  className="bg-gray-200 border border-gray-300 rounded-lg px-2 py-1 text-gray-700 text-[11px] focus:outline-none focus:ring-1 focus:ring-indigo-400 cursor-pointer"
                >
                  {t.admin.securityLevels.map((label, i) => i <= maxSelectableLevel && (
                    <option key={i} value={i}>{label}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={cancelPostEdit} className="px-3 py-1.5 rounded-lg text-gray-400 hover:text-gray-900 text-xs transition-colors">{t.chat.cancel}</button>
                <button onClick={handlePostUpdate} className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-colors">{t.chat.savePost}</button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div
              className="mb-4 select-text allow-copy cursor-text"
              style={{ WebkitAppRegion: 'no-drag', userSelect: 'text', WebkitUserSelect: 'text', ...postTextStyle }}
              onMouseDownCapture={(e) => guardSelectionMouseDownCapture(e, postBodySelectionGuard)}
              onMouseUpCapture={(e) => guardSelectionMouseUpCapture(e, postBodySelectionGuard)}
              onClickCapture={(e) => guardSelectionClickCapture(e, postBodySelectionGuard)}
              onClick={selectPostTarget}
            >
              {isMailCardContent(freshPost.content) && extractMailCardData(freshPost.content) ? (
                <MailSummaryCard data={extractMailCardData(freshPost.content)} />
              ) : isTemplateContent(freshPost.content) ? (
                <TemplateRenderer
                  html={freshPost.content}
                  postId={post.id}
                  onSave={(data) => {
                    if (data?.kind === 'meeting-minutes') {
                      return updatePost(channelId, post.id, {
                        content: data.html,
                        ragContent: data.ragContent || '',
                        attachments: freshPost.attachments || [],
                        security_level: freshPost.security_level ?? 0,
                        waitForTraining: true,
                        requestSource: 'post-detail:meeting-minutes-template-save',
                      })
                    }
                    return apiFetch('/expense/save', {
                      method: 'POST',
                      body: JSON.stringify({
                        postId: post.id,
                        channelId,
                        securityLevel: freshPost.security_level ?? 1,
                        docNo: data.docNo || '',
                        formData: {
                          docNo:          data.docNo || '',
                          docDate:        data.docDate || '',
                          author:         data.author || '',
                          department:     data.department || '',
                          payDate:        data.payDate || '',
                          reviewOpinion:  data.reviewOpinion || '',
                          rows:           data.rows || [],
                          vat:            data.vat || '',
                          grandTotal:     data.grandTotal || '',
                        },
                        attachments: data.attachments || [],
                      }),
                    })
                  }}
                  onContentChange={(field, value) => {
                    let updatedContent = freshPost.content
                    if (field === 'quoteNo') {
                      updatedContent = updatedContent.replace(
                        /(<span[^>]*data-type="no"[^>]*>)[^<]*(<\/span>)/,
                        `$1${value}$2`
                      )
                    } else if (field === 'recv') {
                      updatedContent = updatedContent.replace(
                        /(<td[^>]*data-field="recv"[^>]*>)[^<]*(<\/td>)/,
                        `$1${value}$2`
                      )
                    } else if (field === 'estimateName') {
                      updatedContent = updatedContent.replace(
                        /(<span[^>]*data-field="estimate-name"[^>]*>)[^<]*(<\/span>)/,
                        `$1${value}$2`
                      )
                    } else if (field === 'expense-doc-no') {
                      updatedContent = updatedContent.replace(
                        /(<td[^>]*data-field="expense-doc-no"[^>]*>)[^<]*(<\/td>)/,
                        `$1${value}$2`
                      )
                    } else if (field === 'expense-doc-date') {
                      updatedContent = updatedContent.replace(
                        /(<td[^>]*data-field="expense-doc-date"[^>]*>)[^<]*(<\/td>)/,
                        `$1${value}$2`
                      )
                    } else if (field === 'expense-author') {
                      updatedContent = updatedContent.replace(
                        /(<td[^>]*data-field="expense-author"[^>]*>)[^<]*(<\/td>)/,
                        `$1${value}$2`
                      )
                    } else if (field === 'expense-department') {
                      updatedContent = updatedContent.replace(
                        /(<td[^>]*data-field="expense-department"[^>]*>)[^<]*(<\/td>)/,
                        `$1${value}$2`
                      )
                    } else if (field === 'trip-doc-no') {
                      updatedContent = updatedContent.replace(
                        /(<td[^>]*id="trip-doc-no"[^>]*>)[^<]*(<\/td>)/,
                        `$1${value}$2`
                      )
                    }
                    updatePost(channelId, post.id, {
                      content: updatedContent,
                      attachments: freshPost.attachments || [],
                      security_level: freshPost.security_level ?? 0,
                      requestSource: `post-detail:template-field-change:${field}`,
                    }).catch((err) => {
                      alert(t.chat.saveError(err.message))
                    })
                  }}
                />
              ) : (
                <ContentRenderer
                  key={freshPost.id}
                  text={freshPost.content}
                  sttPostId={freshPost.id}
                  sttChannelId={channelId}
                  contentFontStyle={postTextStyle}
                />
              )}
            </div>
            <AttachmentList
              attachments={freshPost.attachments}
              pendingOpenAttachmentId={pendingOpenAttachmentId}
              onConsumePendingOpen={onConsumePendingOpen}
            />
            <div className="mt-3 flex items-center">
              <LikeButton
                liked={freshPost.likedByMe}
                count={freshPost.likeCount}
                fetchLikers={() => apiFetch(`/posts/${post.id}/likes`)}
                onClick={() => {
                  togglePostLike(channelId, post.id).catch((err) => {
                    alert(`좋아요 처리에 실패했습니다: ${err.message || err}`)
                  })
                }}
              />
            </div>
          </>
        )}

        {/* Comments list — 스크롤 영역 안 */}
        {!isEditingPost && (
        <div data-print-exclude="true" data-print-comments="true" className="border-t border-gray-200 pt-6 mt-6 pb-4">
          <h3 className="text-gray-900 font-semibold text-sm mb-4">{t.chat.commentCount(detailCommentCount)}</h3>
          {commentsLoading ? (
            <p className="text-gray-400 text-sm">댓글을 불러오는 중...</p>
          ) : commentsLoadError ? (
            <p className="text-red-500 text-sm">{commentsLoadError}</p>
          ) : visibleComments.length === 0 ? (
            <p className="text-gray-400 text-sm">{t.chat.noComments}</p>
          ) : (
            <div className="flex flex-col gap-4 min-w-0">
              {commentRows.map((row) => (
                row.type === 'divider' ? (
                  <div key={row.key} className="flex items-center gap-3 my-1 min-w-0">
                    <div className="flex-1 min-w-4 h-px bg-gray-200" />
                    <span className="text-[13px] text-black font-medium whitespace-nowrap">
                      {row.label}
                    </span>
                    <div className="flex-1 min-w-4 h-px bg-gray-200" />
                  </div>
                ) : (() => {
                  const c = row.item
                  return (
                    <div
                      data-comment-card="true"
                      key={row.key}
                      ref={(el) => {
                        if (!el) {
                          commentItemRefs.current.delete(String(c.id))
                          return
                        }
                        commentItemRefs.current.set(String(c.id), el)
                      }}
                      onClick={() => { selectCommentTarget(c); setActionMenuOpen(false) }}
                      onContextMenu={(event) => openContextActionMenu(event, { type: 'comment', comment: c })}
                      className={`flex items-start gap-3 group rounded-xl transition-colors min-w-0 ${
                        String(highlightCommentId || '') === String(c.id)
                          ? 'bg-indigo-50/70 ring-1 ring-indigo-200'
                          : String(selectedComment?.id || '') === String(c.id)
                            ? 'bg-indigo-50/40 ring-1 ring-indigo-200/70'
                            : ''
                      }`}
                    >
                  <Avatar letters={c.author?.avatar || '?'} imageUrl={c.author?.image_url} size="sm" />
                  <div className="flex-1 min-w-0 max-w-full bg-gray-100 rounded-xl px-4 py-3 border border-gray-200" style={{ WebkitAppRegion: 'no-drag' }}>
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 mb-1.5 min-w-0">
                      <span className="text-gray-700 text-xs font-semibold truncate max-w-full">{c.author?.name}</span>
                      {c.author?.username && (
                        <span className="text-indigo-600/50 text-[10px] truncate max-w-full">@{c.author.username}</span>
                      )}
                      <span className="text-gray-400 text-xs whitespace-nowrap">{formatDate(c.createdAt, t)}</span>
                    </div>
                    {c.training_status && (
                      <div className="mb-2">
                        <TrainingStatusBadge status={c.training_status} error={c.training_error} />
                      </div>
                    )}

                    {editingCommentId === c.id ? (
                      <div className="mt-1">
                        <textarea
                          value={commentEditContent}
                          onChange={e => setCommentEditContent(e.target.value)}
                          onKeyDown={e => {
                            if (e.key !== 'Escape') return
                            e.preventDefault()
                            e.stopPropagation()
                            cancelCommentEdit()
                          }}
                          className="w-full h-[60vh] min-h-[220px] max-h-[60vh] bg-gray-100 border border-gray-200 rounded-lg p-3 text-gray-700 text-sm focus:outline-none focus:border-indigo-300 resize-y overflow-y-auto"
                          style={commentTextStyle}
                        />
                        {commentEditFiles.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {commentEditFiles.map(f => <FileChip key={f.id} file={f} onRemove={(id) => setCommentEditFiles(prev => prev.filter(x => x.id !== id))} />)}
                          </div>
                        )}
                        <div className="flex items-center justify-between mt-2">
                          <div className="flex items-center gap-1.5">
                            <label className="text-gray-400 text-[10px] font-medium whitespace-nowrap">{t.chat.securityLevelLabel}</label>
                            <select
                              value={commentEditSecurityLevel}
                              onChange={e => setCommentEditSecurityLevel(Number(e.target.value))}
                              className="bg-gray-200 border border-gray-300 rounded-lg px-2 py-1 text-gray-700 text-[11px] focus:outline-none focus:ring-1 focus:ring-indigo-400 cursor-pointer"
                            >
                              {t.admin.securityLevels.map((label, i) => i <= maxSelectableLevel && (
                                <option key={i} value={i}>{label}</option>
                              ))}
                            </select>
                          </div>
                          <div className="flex items-center gap-2">
                            <button onClick={cancelCommentEdit} className="text-gray-400 hover:text-gray-900 text-xs">{t.chat.cancel}</button>
                            <button onClick={() => handleCommentUpdate(c.id)} className="text-indigo-600 hover:text-indigo-600 text-xs font-semibold">{t.chat.save}</button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div
                          className="text-gray-600 select-text allow-copy cursor-text min-w-0 max-w-full overflow-hidden"
                          style={{ WebkitAppRegion: 'no-drag', userSelect: 'text', WebkitUserSelect: 'text', ...commentTextStyle }}
                          onMouseDownCapture={(e) => guardSelectionMouseDownCapture(e, commentBodySelectionGuard)}
                          onMouseUpCapture={(e) => guardSelectionMouseUpCapture(e, commentBodySelectionGuard)}
                          onClickCapture={(e) => guardSelectionClickCapture(e, commentBodySelectionGuard)}
                        >
                          <ContentRenderer text={c.text} contentFontStyle={commentTextStyle} />
                        </div>
                        {c.attachments && c.attachments.length > 0 && (
                          <div className="mt-3">
                            <AttachmentList
                              attachments={c.attachments}
                              compact
                              pendingOpenAttachmentId={pendingOpenAttachmentId}
                              onConsumePendingOpen={onConsumePendingOpen}
                            />
                          </div>
                        )}
                        <div className="mt-2 flex items-center">
                          <LikeButton
                            liked={c.likedByMe}
                            count={c.likeCount}
                            fetchLikers={() => apiFetch(`/posts/${post.id}/comments/${c.id}/likes`)}
                            onClick={() => {
                              toggleCommentLike(channelId, post.id, c.id).catch((err) => {
                                alert(`좋아요 처리에 실패했습니다: ${err.message || err}`)
                              })
                            }}
                          />
                        </div>
                      </>
                    )}
                  </div>
                    </div>
                  )
                })()
              ))}
              <div ref={commentsEndRef} />
            </div>
          )}
        </div>
        )}
      </div>
        </Panel>

        <PanelResizeHandle className="h-1.5 bg-gray-200 hover:bg-indigo-400 active:bg-indigo-500 transition-colors flex-shrink-0" />
        <Panel defaultSize={isMobile ? 18 : 28} minSize={12} className="overflow-hidden">
      {/* 댓글 입력 */}
      <div className={`h-full min-h-0 flex flex-col border-t border-gray-200 ${isMobile ? 'px-4 py-2' : 'px-6 py-3'} bg-white`}>
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={e => { if(e.target.files?.length) addFiles(e.target.files); e.target.value = '' }} />
        {!selectedChannel?.is_archived ? (
          <form
            onSubmit={handleComment}
            className="flex items-stretch gap-3 flex-1 min-h-0"
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {currentUser && (
              <div className="flex-shrink-0 self-start">
                <Avatar letters={currentUser.avatar} imageUrl={currentUser.image_url} size="sm" />
              </div>
            )}
            <div
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              className={`flex-1 min-h-0 flex flex-col rounded-xl border transition-all duration-150 relative overflow-hidden ${
                dragOver
                  ? 'border-indigo-400/70 bg-indigo-50 shadow-lg shadow-indigo-200'
                  : 'bg-gray-100 border-gray-200 focus-within:border-indigo-300'
              }`}
            >
              {dragOver && (
                <div className="absolute inset-0 flex flex-col items-center justify-center z-10 pointer-events-none">
                  <svg className="w-8 h-8 text-indigo-600 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                  <p className="text-indigo-600 text-sm font-semibold">{t.chat.dropFile}</p>
                </div>
              )}
              <div className="relative flex-1 min-h-0">
                <textarea
                  ref={commentTextareaRef}
                  value={comment}
                  onChange={e => {
                    setComment(e.target.value)
                    mention.handleChange(e.target.value, e.target.selectionStart, e.target)
                  }}
                  onClick={e => mention.handleChange(e.currentTarget.value, e.currentTarget.selectionStart, e.currentTarget)}
                  onKeyUp={e => mention.handleChange(e.currentTarget.value, e.currentTarget.selectionStart, e.currentTarget)}
                  placeholder={t.chat.commentPlaceholder}
                  className="w-full h-full bg-transparent text-gray-700 placeholder-gray-400 text-sm px-4 pt-3 pb-2 resize-none focus:outline-none leading-relaxed overflow-y-auto"
                  style={commentTextStyle}
                  onPaste={handleTextareaPaste}
                  onDragOver={handleTextareaDragOver}
                  onDrop={handleTextareaDrop}
                  onKeyDown={e => {
                    if (e.nativeEvent.isComposing) return
                    if (mention.open) {
                      const handled = mention.handleKeyDown(e)
                      if (handled) {
                        e.preventDefault()
                        if ((e.key === 'Enter' || e.key === 'Tab') && mention.users[mention.selectedIdx]) {
                          mention.selectUser(mention.users[mention.selectedIdx], comment, commentTextareaRef.current?.selectionStart ?? comment.length, (newText, newCursor) => {
                            setComment(newText)
                            requestAnimationFrame(() => {
                              if (commentTextareaRef.current) {
                                commentTextareaRef.current.selectionStart = newCursor
                                commentTextareaRef.current.selectionEnd = newCursor
                              }
                            })
                          })
                        }
                        return
                      }
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      e.currentTarget.form?.requestSubmit()
                    }
                  }}
                />
                {mention.open && (
                  <MentionDropdown
                    users={mention.users}
                    selectedIdx={mention.selectedIdx}
                    position={mention.cursorCoords}
                    onSelect={user => mention.selectUser(user, comment, commentTextareaRef.current?.selectionStart ?? comment.length, (newText, newCursor) => {
                      setComment(newText)
                      requestAnimationFrame(() => {
                        if (commentTextareaRef.current) {
                          commentTextareaRef.current.selectionStart = newCursor
                          commentTextareaRef.current.selectionEnd = newCursor
                          commentTextareaRef.current.focus()
                        }
                      })
                    })}
                  />
                )}
              </div>
              {files.length > 0 && (
                <div className="px-4 pb-2 flex-shrink-0 min-h-0">
                  <div className="max-h-32 overflow-y-auto overscroll-contain pr-1 flex flex-wrap gap-2">
                    {files.map(f => <FileChip key={f.id} file={f} onRemove={removeFile} />)}
                  </div>
                </div>
              )}
              <div className="flex items-center px-3 pb-2 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-200 transition-colors"
                  title={t.chat.attachFile}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                </button>
                <div className="flex-1" />
                <select
                  value={commentSecurityLevel}
                  onChange={e => setCommentSecurityLevel(Number(e.target.value))}
                  className="text-xs px-2 py-1 rounded-lg border border-gray-200 bg-white text-gray-600 focus:outline-none focus:border-indigo-300 mr-2"
                >
                  {(t.admin.securityLevels || []).map((label, i) => i <= maxSelectableLevel && (
                    <option key={i} value={i}>{label}</option>
                  ))}
                </select>
                <button type="submit" disabled={(!comment.trim() && files.length === 0) || uploading} className="px-3 py-1.5 rounded-lg bg-indigo-600 disabled:bg-gray-200 enabled:hover:bg-indigo-500 text-white text-xs font-semibold transition-colors flex items-center gap-2">
                  {uploading && <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                  {uploading ? t.chat.sending : t.chat.addComment}
                </button>
              </div>
              {uploading && uploadProgress && (
                <div className="px-4 pb-3 flex-shrink-0">
                  <div className="flex items-center justify-between text-[11px] text-gray-500 mb-1">
                    <span>{t.chat.sending} {uploadProgress.percent}%</span>
                    <span>{uploadProgress.fileIndex}/{uploadProgress.fileCount} · {formatSize(uploadProgress.uploadedBytes)} / {formatSize(uploadProgress.totalBytes)}</span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
                    <div
                      className="h-full bg-indigo-500 transition-all duration-150"
                      style={{ width: `${uploadProgress.percent}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          </form>
        ) : (
          <div className="flex-1 min-h-0 flex items-center justify-center py-2 gap-2 text-gray-400 text-xs italic">
            <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            {t.chat.archivedComment}
          </div>
        )}
      </div>
        </Panel>
      </PanelGroup>

    </div>
  )
}

export default PostDetailPane
