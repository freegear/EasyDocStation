import { useRef, useState } from 'react'
import { apiFetch } from '../../../../lib/api'

function dataTransferHasFiles(dataTransfer) {
  if (!dataTransfer) return false
  if (dataTransfer.files && dataTransfer.files.length > 0) return true
  return Array.from(dataTransfer.types || []).includes('Files')
}

export default function useMDPageComments({
  addComment,
  channelId,
  currentUser,
  deleteComment,
  maxAttachmentFileSize,
  postId,
}) {
  const [commentText, setCommentText] = useState('')
  const [commentFiles, setCommentFiles] = useState([])
  const [commentDragOver, setCommentDragOver] = useState(false)
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const [pendingDeleteCommentId, setPendingDeleteCommentId] = useState(null)
  const commentFileInputRef = useRef(null)

  function addCommentFiles(newFilesLike) {
    const incoming = Array.from(newFilesLike || [])
    if (incoming.length === 0) return
    const nextCount = commentFiles.length + incoming.length
    if (nextCount > 10) {
      alert('첨부파일은 최대 10개까지 추가할 수 있습니다.')
      return
    }

    const limitMB = Number(maxAttachmentFileSize ?? 100)
    const limitBytes = limitMB * 1024 * 1024
    for (const f of incoming) {
      if ((f.size || 0) > limitBytes) {
        alert(`파일 용량은 ${limitMB}MB 이하만 업로드할 수 있습니다.`)
        return
      }
    }

    const mapped = incoming.map((f) => ({
      id: `md-comment-file-${Date.now()}-${Math.random()}`,
      name: f.name,
      size: f.size,
      type: f.type,
      file: f,
    }))
    setCommentFiles((prev) => [...prev, ...mapped])
  }

  function removeCommentFile(id) {
    setCommentFiles((prev) => prev.filter((f) => f.id !== id))
  }

  function handleCommentInputDrop(e) {
    if (!dataTransferHasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    setCommentDragOver(false)
    if (e.dataTransfer?.files?.length) {
      addCommentFiles(e.dataTransfer.files)
    }
  }

  function handleCommentInputDragOver(e) {
    if (!dataTransferHasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    setCommentDragOver(true)
  }

  function handleCommentInputDragLeave(e) {
    if (!dataTransferHasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    setCommentDragOver(false)
  }

  async function handleCommentSubmit(e) {
    e.preventDefault()
    if (commentSubmitting) return
    const text = String(commentText || '').trim()
    if (!text && commentFiles.length === 0) return
    if (!currentUser) return

    setCommentSubmitting(true)
    try {
      const attachmentIds = []
      for (const fileObj of commentFiles) {
        const prep = await apiFetch('/files/get-upload-url', {
          method: 'POST',
          body: JSON.stringify({
            filename: fileObj.name,
            contentType: fileObj.type || 'application/octet-stream',
            channelId,
          }),
        })
        const uploadResp = await fetch(prep.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': fileObj.type || 'application/octet-stream' },
          body: fileObj.file,
        })
        if (!uploadResp.ok) {
          throw new Error(`파일 업로드 실패 (${uploadResp.status})`)
        }
        attachmentIds.push(prep.file_uuid)
      }

      await addComment(
        channelId,
        postId,
        text,
        currentUser,
        attachmentIds,
        Math.min(Number(currentUser?.security_level ?? 0), 1),
      )
      setCommentText('')
      setCommentFiles([])
    } catch (err) {
      console.error('MD 댓글 등록 실패:', err)
      alert(`댓글 등록에 실패했습니다: ${err.message || err}`)
    } finally {
      setCommentSubmitting(false)
      setCommentDragOver(false)
    }
  }

  async function handleDeleteComment() {
    const targetId = pendingDeleteCommentId
    if (!targetId) return
    try {
      await deleteComment(channelId, postId, targetId)
      setPendingDeleteCommentId(null)
    } catch (err) {
      console.error('MD 댓글 삭제 실패:', err)
      alert(`댓글 삭제에 실패했습니다: ${err.message || err}`)
    }
  }

  return {
    addCommentFiles,
    commentDragOver,
    commentFileInputRef,
    commentFiles,
    commentSubmitting,
    commentText,
    handleCommentInputDragLeave,
    handleCommentInputDragOver,
    handleCommentInputDrop,
    handleCommentSubmit,
    handleDeleteComment,
    pendingDeleteCommentId,
    removeCommentFile,
    setCommentText,
    setPendingDeleteCommentId,
  }
}
