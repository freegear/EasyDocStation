import { useState, useRef, useEffect } from 'react'
import { useChat } from '../../contexts/ChatContext'
import { useAuth } from '../../contexts/AuthContext'
import { apiFetch } from '../../lib/api'
import { useT } from '../../i18n/useT'
import { isTemplateContent } from '../../templates/formTemplates'
import { useSelectionClickGuard } from '../../hooks/useSelectionClickGuard'
import { findDuplicateFileNames } from '../../lib/fileNameValidation'

function PostDetailPane({ post, channelId, onClose, helpers = {} }) {
  const t = useT()
  const { addComment, incrementViews, deletePost, updatePost, deleteComment, updateComment, posts, selectedChannel, openInAgenticAI } = useChat()
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
  const [viewed, setViewed] = useState(false)
  const [showSendToDMModal, setShowSendToDMModal] = useState(false)
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
  const [dmNoticeDialog, setDmNoticeDialog] = useState(null)
  const [duplicateFileDialog, setDuplicateFileDialog] = useState(null)

  const [files, setFiles] = useState([])
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(null)
  const commentSubmittingRef = useRef(false)
  const commentsEndRef = useRef(null)
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

  function handleTextareaDragOver(e) {
    if (!dataTransferHasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }

  useEffect(() => {
    if (!viewed) { incrementViews(channelId, post.id); setViewed(true) }
  }, [])

  const freshPost = posts[channelId]?.find(p => p.id === post.id) || post
  const isSiteAdmin = currentUser?.role === 'site_admin'
  const canEditPost = String(freshPost.author?.id ?? '') === String(currentUser?.id ?? '')
  const canDeletePost = isSiteAdmin || canEditPost
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
      await updatePost(channelId, post.id, { content: postContent, attachments, security_level: postSecurityLevel })
      setIsEditingPost(false)
    } catch (err) {
      alert(t.chat.saveError(err.message))
    } finally {
      setUploading(false)
    }
  }

  function handleDelete() {
    setShowPostDeleteConfirm(true)
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
    const postLink = `${window.location.origin}/?channelId=${encodeURIComponent(channelId)}&postId=${encodeURIComponent(post.id)}`
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
      link: postLink,
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
    window.dispatchEvent(new Event('open-agentic-panel'))
  }

  function handleSendCommentToAgenticAI(commentObj) {
    openInAgenticAI(buildAgenticCommentTarget(commentObj))
    window.dispatchEvent(new Event('open-agentic-panel'))
  }

  async function handleSendPostLinkToDM(conv) {
    if (!conv?.id || sendingToDMId) return
    setSendingToDMId(conv.id)
    try {
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
      const message = [
        '[게시글 링크]',
        `제목: ${titleLine.slice(0, 120)}`,
        `채널: ${selectedChannel?.name || channelId}`,
        postLink,
      ].join('\n')

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
      <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-200 flex-shrink-0">
        <div className="flex-1" />
        {(canEditPost || canDeletePost) && !isEditingPost && !selectedChannel?.is_archived && (
          <div className="flex items-center gap-2">
            {canEditPost && (
              <button onClick={startPostEdit} className="flex items-center gap-1 text-gray-400 hover:text-gray-900 text-xs transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                {t.chat.edit}
              </button>
            )}
            {canDeletePost && (
              <button onClick={handleDelete} className="flex items-center gap-1 text-red-500 hover:text-red-400 text-xs transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                {t.chat.delete}
              </button>
            )}
          </div>
        )}
        {!isEditingPost && !selectedChannel?.is_archived && (
          <div className="flex items-center gap-2">
            <button onClick={handleSendPostToAgenticAI} className="flex items-center gap-1 text-sky-600 hover:text-sky-700 text-xs transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              {t.chat.sendToAgenticAI || 'AgenticAI로 보내기'}
            </button>
            <button onClick={openSendToDMModal} className="flex items-center gap-1 text-indigo-600 hover:text-indigo-700 text-xs transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
              </svg>
              {t.chat.sendToDM}
            </button>
          </div>
        )}
        {/* Close right panel */}
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-lg text-gray-400 hover:text-gray-900 hover:bg-gray-200 flex items-center justify-center transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

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
                    onClick={() => handleSendPostLinkToDM(conv)}
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

      <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-6">
        {/* Meta */}
        <div className="mb-6">
          {freshPost.pinned && <div className="flex items-center gap-1.5 text-amber-600 text-xs font-medium mb-3"><PinIcon /><span>{t.chat.pinnedPost}</span></div>}
          <div className="flex items-center gap-4 mb-6 p-4 rounded-2xl bg-gray-50 border border-gray-200">
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
                  <TrainingStatusBadge status={postTrainingStatus} />
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="border-t border-gray-200 mb-6" />

        {/* Body & Attachments */}
        {isEditingPost ? (
          <div className="bg-gray-100 rounded-2xl border border-indigo-300 p-4 mb-6 flex flex-col gap-4">
            <textarea
              value={postContent}
              onChange={e => setPostContent(e.target.value)}
              onKeyDown={e => {
                if (e.key !== 'Escape') return
                e.preventDefault()
                e.stopPropagation()
                cancelPostEdit()
              }}
              className="w-full h-[min(58vh,520px)] bg-transparent text-gray-800 placeholder-gray-400 text-sm leading-relaxed resize-none focus:outline-none overflow-y-auto"
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
              style={{ WebkitAppRegion: 'no-drag', userSelect: 'text', WebkitUserSelect: 'text' }}
              onMouseDownCapture={(e) => guardSelectionMouseDownCapture(e, postBodySelectionGuard)}
              onMouseUpCapture={(e) => guardSelectionMouseUpCapture(e, postBodySelectionGuard)}
              onClickCapture={(e) => guardSelectionClickCapture(e, postBodySelectionGuard)}
            >
              {isTemplateContent(freshPost.content) ? (
                <TemplateRenderer
                  html={freshPost.content}
                  postId={post.id}
                  onSave={(data) => apiFetch('/expense/save', {
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
                  })}
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
                    }).catch((err) => {
                      alert(t.chat.saveError(err.message))
                    })
                  }}
                />
              ) : (
                <ContentRenderer text={freshPost.content} />
              )}
            </div>
            <AttachmentList attachments={freshPost.attachments} />
          </>
        )}

        {/* Comments list — 스크롤 영역 안 */}
        <div className="border-t border-gray-200 pt-6 mt-6 pb-4">
          <h3 className="text-gray-900 font-semibold text-sm mb-4">{t.chat.commentCount((freshPost.comments || []).length)}</h3>
          {(freshPost.comments || []).length === 0 ? (
            <p className="text-gray-400 text-sm">{t.chat.noComments}</p>
          ) : (
            <div className="flex flex-col gap-4">
              {(freshPost.comments || []).map(c => (
                <div key={c.id} className="flex items-start gap-3 group">
                  <Avatar letters={c.author?.avatar || '?'} imageUrl={c.author?.image_url} size="sm" />
                  <div className="flex-1 bg-gray-100 rounded-xl px-4 py-3 border border-gray-200" style={{ WebkitAppRegion: 'no-drag' }}>
                    <div className="flex items-baseline gap-2 mb-1.5">
                      <span className="text-gray-700 text-xs font-semibold">{c.author?.name}</span>
                      {c.author?.username && (
                        <span className="text-indigo-600/50 text-[10px]">@{c.author.username}</span>
                      )}
                      <span className="text-gray-400 text-xs">{formatDate(c.createdAt, t)}</span>
                      {editingCommentId !== c.id && !selectedChannel?.is_archived && (
                        <div className="ml-auto flex items-center gap-2 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity">
                          <button onClick={() => handleSendCommentToAgenticAI(c)} className="text-sky-600 hover:text-sky-700 text-[10px] font-medium uppercase tracking-tight">{t.chat.sendToAgenticAI || 'AgenticAI'}</button>
                          {String(c.author?.id ?? '') === String(currentUser?.id ?? '') && (
                            <button onClick={() => startCommentEdit(c)} className="text-gray-400 hover:text-gray-900 text-[10px] font-medium uppercase tracking-tight">{t.chat.edit}</button>
                          )}
                          {(isSiteAdmin || String(c.author?.id ?? '') === String(currentUser?.id ?? '')) && (
                            <button onClick={() => handleCommentDelete(c.id)} className="text-red-400 hover:text-red-400 text-[10px] font-medium uppercase tracking-tight">{t.chat.delete}</button>
                          )}
                        </div>
                      )}
                    </div>
                    {c.training_status && (
                      <div className="mb-2">
                        <TrainingStatusBadge status={c.training_status} />
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
                          className="w-full h-[min(32vh,300px)] bg-gray-100 border border-gray-200 rounded-lg p-2 text-gray-700 text-sm focus:outline-none focus:border-indigo-300 resize-none overflow-y-auto"
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
                          className="text-gray-600 select-text allow-copy cursor-text"
                          style={{ WebkitAppRegion: 'no-drag', userSelect: 'text', WebkitUserSelect: 'text' }}
                          onMouseDownCapture={(e) => guardSelectionMouseDownCapture(e, commentBodySelectionGuard)}
                          onMouseUpCapture={(e) => guardSelectionMouseUpCapture(e, commentBodySelectionGuard)}
                          onClickCapture={(e) => guardSelectionClickCapture(e, commentBodySelectionGuard)}
                        >
                          <ContentRenderer text={c.text} />
                        </div>
                        {c.attachments && c.attachments.length > 0 && (
                          <div className="mt-3">
                            <AttachmentList attachments={c.attachments} compact />
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}
              <div ref={commentsEndRef} />
            </div>
          )}
        </div>
      </div>

      {/* 댓글 입력 — 스크롤 영역 밖, 항상 하단 고정 */}
      <div className="flex-shrink-0 border-t border-gray-200 px-6 py-3 bg-white">
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={e => { if(e.target.files?.length) addFiles(e.target.files); e.target.value = '' }} />
        {!selectedChannel?.is_archived ? (
          <form
            onSubmit={handleComment}
            className="flex items-start gap-3"
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {currentUser && <Avatar letters={currentUser.avatar} imageUrl={currentUser.image_url} size="sm" />}
            <div
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              className={`flex-1 rounded-xl border transition-all duration-150 relative overflow-hidden ${
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
              <textarea
                value={comment}
                onChange={e => setComment(e.target.value)}
                placeholder={t.chat.commentPlaceholder}
                rows={2}
                className="w-full bg-transparent text-gray-700 placeholder-gray-400 text-sm px-4 pt-3 pb-2 resize-none focus:outline-none leading-relaxed"
                onDragOver={handleTextareaDragOver}
                onDrop={handleTextareaDrop}
                onKeyDown={e => {
                  if (e.nativeEvent.isComposing) return
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    e.currentTarget.form?.requestSubmit()
                  }
                }}
              />
              {files.length > 0 && (
                <div className="px-4 pb-2">
                  <div className="flex flex-wrap gap-2">
                    {files.map(f => <FileChip key={f.id} file={f} onRemove={removeFile} />)}
                  </div>
                </div>
              )}
              <div className="flex items-center px-3 pb-2">
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
                <div className="px-4 pb-3">
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
          <div className="flex items-center justify-center py-2 gap-2 text-gray-400 text-xs italic">
            <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            {t.chat.archivedComment}
          </div>
        )}
      </div>

    </div>
  )
}

export default PostDetailPane
