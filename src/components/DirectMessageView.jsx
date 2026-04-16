import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch, getToken } from '../lib/api'

function uuidv4() {
  return crypto.randomUUID ? crypto.randomUUID() : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16))
}

// ── icons ──────────────────────────────────────────────────────
function ClipIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
    </svg>
  )
}
function SendIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
    </svg>
  )
}
function PlusUserIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
    </svg>
  )
}

// ── helpers ────────────────────────────────────────────────────
function formatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function Avatar({ name, imageUrl, size = 8 }) {
  const letters = (name || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
  return (
    <div className={`w-${size} h-${size} rounded-full bg-indigo-500 overflow-hidden flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}>
      {imageUrl ? <img src={imageUrl} alt={name} className="w-full h-full object-cover" /> : letters}
    </div>
  )
}

// ── RenamePopup ────────────────────────────────────────────────
function RenamePopup({ current, onConfirm, onCancel }) {
  const [val, setVal] = useState(current)
  const [err, setErr] = useState('')
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  async function handleConfirm() {
    setErr('')
    if (!val.trim()) { setErr('이름을 입력해주세요.'); return }
    const result = await onConfirm(val.trim())
    if (result?.error) setErr(result.error)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl p-6 w-80">
        <h3 className="text-gray-800 font-bold text-base mb-4">대화 이름 변경</h3>
        <input
          ref={inputRef}
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleConfirm(); if (e.key === 'Escape') onCancel() }}
          className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-400 mb-2"
        />
        {err && <p className="text-red-500 text-xs mb-3">{err}</p>}
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="px-4 py-2 rounded-xl text-sm text-gray-500 hover:bg-gray-100">취소</button>
          <button onClick={handleConfirm} className="px-4 py-2 rounded-xl text-sm bg-indigo-600 text-white hover:bg-indigo-700">확인</button>
        </div>
      </div>
    </div>
  )
}

// ── RemoveParticipantPopup ────────────────────────────────────
function RemoveParticipantPopup({ participant, onConfirm, onCancel }) {
  const btnRef = useRef(null)

  useEffect(() => {
    btnRef.current?.focus()
    function onKey(e) { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const name = participant?.display_name || participant?.username || '?'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl p-6 w-72">
        <p className="text-gray-800 text-sm mb-5 text-center">
          <span className="font-semibold text-gray-900">{name}</span> 님을<br />삭제 하시겠습니까?
        </p>
        <div className="flex gap-2 justify-center">
          <button onClick={onCancel} className="px-5 py-2 rounded-xl text-sm text-gray-500 hover:bg-gray-100 border border-gray-200">취소</button>
          <button ref={btnRef} onClick={onConfirm} className="px-5 py-2 rounded-xl text-sm bg-red-500 text-white hover:bg-red-600">삭제</button>
        </div>
      </div>
    </div>
  )
}

// ── AddParticipantPopup ───────────────────────────────────────
function AddParticipantPopup({ currentParticipants, onAdd, onCancel }) {
  const [users, setUsers] = useState([])
  const [search, setSearch] = useState('')

  useEffect(() => {
    apiFetch('/users').then(setUsers).catch(() => {})
  }, [])

  const filtered = users.filter(u =>
    !currentParticipants.includes(u.id) &&
    ((u.display_name || u.username || '').toLowerCase().includes(search.toLowerCase()))
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl p-6 w-80">
        <h3 className="text-gray-800 font-bold text-base mb-3">참여자 추가</h3>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="이름 검색..."
          className="w-full border border-gray-200 rounded-xl px-4 py-2 text-sm mb-3 focus:outline-none focus:border-indigo-400"
          autoFocus
        />
        <div className="max-h-48 overflow-y-auto flex flex-col gap-1">
          {filtered.map(u => (
            <button
              key={u.id}
              onClick={() => onAdd(u.id)}
              className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-indigo-50 text-left"
            >
              <Avatar name={u.display_name || u.username} imageUrl={u.image_url} size={8} />
              <span className="text-sm text-gray-700">{u.display_name || u.username}</span>
            </button>
          ))}
          {filtered.length === 0 && <p className="text-gray-300 text-xs text-center py-4">추가할 사용자가 없습니다.</p>}
        </div>
        <button onClick={onCancel} className="mt-3 w-full py-2 rounded-xl text-sm text-gray-500 hover:bg-gray-100">닫기</button>
      </div>
    </div>
  )
}

// ── NameInputPopup (여러명 선택 시 이름 입력) ─────────────────
function NameInputPopup({ selected, users, onConfirm, onBack }) {
  const [name, setName] = useState('')
  const [err, setErr] = useState('')
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const selectedUsers = users.filter(u => selected.includes(u.id))

  async function handleConfirm() {
    if (!name.trim()) { setErr('대화 이름을 입력해주세요.'); return }
    setErr('')
    await onConfirm(name.trim())
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl p-6 w-80">
        <h3 className="text-gray-800 font-bold text-base mb-3">대화 이름 설정</h3>
        <div className="flex flex-wrap gap-1.5 mb-4">
          {selectedUsers.map(u => (
            <span key={u.id} className="text-xs bg-indigo-100 text-indigo-700 px-2 py-1 rounded-full">
              {u.display_name || u.username}
            </span>
          ))}
        </div>
        <input
          ref={inputRef}
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleConfirm(); if (e.key === 'Escape') onBack() }}
          placeholder="대화방 이름 입력..."
          className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm mb-2 focus:outline-none focus:border-indigo-400"
        />
        {err && <p className="text-red-500 text-xs mb-2">{err}</p>}
        <div className="flex gap-2 justify-end mt-1">
          <button onClick={onBack} className="px-4 py-2 rounded-xl text-sm text-gray-500 hover:bg-gray-100">뒤로</button>
          <button onClick={handleConfirm} className="px-4 py-2 rounded-xl text-sm bg-indigo-600 text-white hover:bg-indigo-700">확인</button>
        </div>
      </div>
    </div>
  )
}

// ── NewConversationModal ───────────────────────────────────────
function NewConversationModal({ onCreated, onCancel }) {
  const [users, setUsers] = useState([])
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState([])
  const [showNameStep, setShowNameStep] = useState(false)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    apiFetch('/users').then(setUsers).catch(() => {})
  }, [])

  const filtered = users.filter(u =>
    (u.display_name || u.username || '').toLowerCase().includes(search.toLowerCase())
  )

  async function createConversation(nameOverride) {
    setCreating(true)
    setErr('')
    try {
      const data = await apiFetch('/dm/conversations', {
        method: 'POST',
        body: JSON.stringify({ name: nameOverride || undefined, participants: selected })
      })
      // _existing: true means server found & returned duplicate — open it directly
      onCreated(data)
    } catch (e) {
      setErr(e.message)
      setShowNameStep(false)
    } finally {
      setCreating(false)
    }
  }

  async function handleNext() {
    if (selected.length === 0) { setErr('참여자를 선택해주세요.'); return }
    setErr('')
    if (selected.length > 1) {
      // 여러명 선택 → 이름 입력 팝업
      setShowNameStep(true)
    } else {
      // 1명 선택 → 기본 이름으로 즉시 생성 (중복이면 서버가 기존 것 반환)
      await createConversation()
    }
  }

  function toggle(uid) {
    setSelected(prev => prev.includes(uid) ? prev.filter(x => x !== uid) : [...prev, uid])
  }

  if (showNameStep) {
    return (
      <NameInputPopup
        selected={selected}
        users={users}
        onConfirm={(name) => createConversation(name)}
        onBack={() => setShowNameStep(false)}
      />
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl p-6 w-96">
        <h3 className="text-gray-800 font-bold text-base mb-4">새 대화 시작</h3>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="사용자 검색..."
          className="w-full border border-gray-200 rounded-xl px-4 py-2 text-sm mb-3 focus:outline-none focus:border-indigo-400"
          autoFocus
        />
        <div className="max-h-48 overflow-y-auto flex flex-col gap-1 mb-3">
          {filtered.map(u => (
            <button
              key={u.id}
              onClick={() => toggle(u.id)}
              className={`flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors ${selected.includes(u.id) ? 'bg-indigo-100 border border-indigo-300' : 'hover:bg-gray-50'}`}
            >
              <Avatar name={u.display_name || u.username} imageUrl={u.image_url} size={8} />
              <span className="text-sm text-gray-700">{u.display_name || u.username}</span>
              {selected.includes(u.id) && <span className="ml-auto text-indigo-500 text-xs font-bold">✓</span>}
            </button>
          ))}
        </div>
        {selected.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3 p-2 bg-indigo-50 rounded-xl">
            {users.filter(u => selected.includes(u.id)).map(u => (
              <span key={u.id} className="text-xs bg-indigo-600 text-white px-2 py-0.5 rounded-full flex items-center gap-1">
                {u.display_name || u.username}
                <button onClick={() => toggle(u.id)} className="hover:opacity-70">×</button>
              </span>
            ))}
          </div>
        )}
        {err && <p className="text-red-500 text-xs mb-2">{err}</p>}
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="px-4 py-2 rounded-xl text-sm text-gray-500 hover:bg-gray-100">취소</button>
          <button
            onClick={handleNext}
            disabled={creating || selected.length === 0}
            className="px-4 py-2 rounded-xl text-sm bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            {creating ? '생성 중...' : selected.length > 1 ? '다음 ▸' : '대화 시작'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── MessageBubble ─────────────────────────────────────────────
function MessageBubble({ msg, isMine, onEdit, onDelete }) {
  const [editMode, setEditMode] = useState(false)
  const [editContent, setEditContent] = useState(msg.content)

  async function submitEdit() {
    if (!editContent.trim() && msg.attachments?.length === 0) return
    await onEdit(msg.id, editContent.trim())
    setEditMode(false)
  }

  function downloadFile(att) {
    const token = getToken()
    const url = `/api/dm/files?storagePath=${encodeURIComponent(att.storagePath)}&filename=${encodeURIComponent(att.filename)}${token ? `&auth_token=${encodeURIComponent(token)}` : ''}`
    const a = document.createElement('a')
    a.href = url
    a.download = att.filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  function handleAttachmentDoubleClick(att, allAtts) {
    if (allAtts.length > 1) {
      const yes = window.confirm('한꺼번에 다운 받으시겠습니까?')
      if (yes) { allAtts.forEach(a => downloadFile(a)); return }
    }
    downloadFile(att)
  }

  const senderName = msg.sender?.display_name || msg.sender?.username || '?'

  return (
    <div className={`flex gap-2 mb-3 ${isMine ? 'flex-row-reverse' : 'flex-row'}`}>
      {!isMine && <Avatar name={senderName} imageUrl={msg.sender?.image_url} size={8} />}
      <div className={`flex flex-col max-w-[70%] ${isMine ? 'items-end' : 'items-start'}`}>
        <div className={`flex items-center gap-2 mb-1 ${isMine ? 'flex-row-reverse' : ''}`}>
          <span className="text-xs font-semibold text-gray-600">{senderName}</span>
          <span className="text-[10px] text-gray-300">{formatTime(msg.created_at)}</span>
          {msg.is_edited && <span className="text-[10px] text-gray-300">(수정됨)</span>}
        </div>

        <div className={`rounded-2xl px-4 py-2.5 text-sm shadow-sm ${
          isMine
            ? 'bg-indigo-600 text-white rounded-tr-sm'
            : 'bg-white text-gray-800 border border-gray-100 rounded-tl-sm'
        }`}>
          {editMode ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={editContent}
                onChange={e => setEditContent(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitEdit() } if (e.key === 'Escape') setEditMode(false) }}
                className="bg-white/20 rounded-xl px-2 py-1 text-sm resize-none w-full focus:outline-none min-w-[200px]"
                rows={2}
                autoFocus
              />
              <div className="flex gap-1 justify-end">
                <button onClick={() => setEditMode(false)} className="text-xs px-2 py-1 rounded-lg bg-white/20 hover:bg-white/30">취소</button>
                <button onClick={submitEdit} className="text-xs px-2 py-1 rounded-lg bg-white/30 hover:bg-white/40 font-semibold">저장</button>
              </div>
            </div>
          ) : (
            <>
              {msg.content && <p className="whitespace-pre-wrap">{msg.content}</p>}
              {msg.attachments?.length > 0 && (
                <div className={`flex flex-col gap-1 ${msg.content ? 'mt-2' : ''}`}>
                  {msg.attachments.map((att, i) => (
                    <button
                      key={i}
                      onDoubleClick={() => handleAttachmentDoubleClick(att, msg.attachments)}
                      title="더블클릭하여 다운로드"
                      className={`flex items-center gap-1.5 text-xs rounded-lg px-2 py-1 transition-colors ${
                        isMine ? 'bg-white/20 hover:bg-white/30 text-white' : 'bg-gray-50 hover:bg-gray-100 text-gray-600 border border-gray-100'
                      }`}
                    >
                      <ClipIcon />
                      <span className="truncate max-w-[180px]">{att.filename}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {isMine && !editMode && (
          <div className="flex gap-1 mt-1">
            <button
              onClick={() => { setEditContent(msg.content); setEditMode(true) }}
              className="text-[10px] text-gray-300 hover:text-indigo-500 px-1 transition-colors"
            >수정</button>
            <button
              onClick={() => onDelete(msg.id)}
              className="text-[10px] text-gray-300 hover:text-red-500 px-1 transition-colors"
            >삭제</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── DirectMessageView (main) ──────────────────────────────────
export default function DirectMessageView({ conversation, onClose, onConversationUpdated }) {
  const { currentUser } = useAuth()
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [pendingFiles, setPendingFiles] = useState([]) // [{file, name}]
  const [sending, setSending] = useState(false)
  const [showRename, setShowRename] = useState(false)
  const [showAddParticipant, setShowAddParticipant] = useState(false)
  const [removingParticipant, setRemovingParticipant] = useState(null) // participant object
  const messagesEndRef = useRef(null)
  const fileInputRef = useRef(null)

  useEffect(() => {
    if (conversation?.id) loadMessages()
  }, [conversation?.id])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ESC to close
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape' && !showRename && !showAddParticipant && !removingParticipant) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, showRename, showAddParticipant, removingParticipant])

  async function loadMessages() {
    try {
      const data = await apiFetch(`/dm/conversations/${conversation.id}/messages`)
      setMessages(Array.isArray(data) ? data : [])
    } catch (e) {
      console.error('메시지 로드 실패:', e)
    }
  }

  // msgId: 메시지 전송 전 미리 생성 — 모든 첨부파일이 같은 폴더에 저장됨
  // 경로: ObjectFiles/DirectMessage/{conv_id}/{msgId}/{filename}
  async function uploadFile(convId, file, msgId) {
    const urlRes = await apiFetch(`/dm/conversations/${convId}/upload-url`, {
      method: 'POST',
      body: JSON.stringify({ filename: file.name, contentType: file.type || 'application/octet-stream', msgId })
    })
    const buf = await file.arrayBuffer()
    const token = getToken()
    const resp = await fetch(
      `/api/dm/conversations/${convId}/upload/${urlRes.uploadId}?storagePath=${encodeURIComponent(urlRes.storagePath)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          ...(token && { Authorization: `Bearer ${token}` }),
        },
        body: buf,
      }
    )
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}))
      throw new Error(err.error || `업로드 실패 (${resp.status})`)
    }
    return { filename: file.name, size: file.size, storagePath: urlRes.storagePath }
  }

  async function handleSend() {
    if (sending) return
    if (!input.trim() && pendingFiles.length === 0) return
    setSending(true)
    try {
      // 메시지 ID를 미리 생성 — 첨부파일 폴더명과 메시지 ID가 일치하도록
      const msgId = uuidv4()

      // 모든 첨부파일을 같은 msgId 폴더에 업로드
      const attachments = []
      for (const { file } of pendingFiles) {
        const att = await uploadFile(conversation.id, file, msgId)
        attachments.push(att)
      }

      // 메시지 생성 시 동일한 msgId 전달
      const data = await apiFetch(`/dm/conversations/${conversation.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: input.trim(), attachments, msgId })
      })
      setMessages(prev => [...prev, data])
      setInput('')
      setPendingFiles([])
    } catch (e) {
      alert('전송 실패: ' + e.message)
    } finally {
      setSending(false)
    }
  }

  async function handleEdit(msgId, content) {
    try {
      const data = await apiFetch(`/dm/conversations/${conversation.id}/messages/${msgId}`, {
        method: 'PUT',
        body: JSON.stringify({ content })
      })
      setMessages(prev => prev.map(m => m.id === msgId ? { ...m, ...data } : m))
    } catch (e) {
      alert('수정 실패: ' + e.message)
    }
  }

  async function handleDelete(msgId) {
    if (!window.confirm('메시지를 삭제하시겠습니까?')) return
    try {
      await apiFetch(`/dm/conversations/${conversation.id}/messages/${msgId}`, { method: 'DELETE' })
      setMessages(prev => prev.filter(m => m.id !== msgId))
    } catch (e) {
      alert('삭제 실패: ' + e.message)
    }
  }

  async function handleRename(newName) {
    try {
      const data = await apiFetch(`/dm/conversations/${conversation.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: newName })
      })
      if (data.error) return { error: data.error }
      onConversationUpdated?.({ ...conversation, name: newName })
      setShowRename(false)
    } catch (e) {
      return { error: e.message }
    }
  }

  async function handleAddParticipant(uid) {
    try {
      const data = await apiFetch(`/dm/conversations/${conversation.id}/participants`, {
        method: 'POST',
        body: JSON.stringify({ participantId: uid })
      })
      if (data.error) { alert(data.error); return }
      onConversationUpdated?.(data)
      setShowAddParticipant(false)
    } catch (e) {
      alert(e.message)
    }
  }

  async function handleRemoveParticipant() {
    if (!removingParticipant) return
    try {
      const data = await apiFetch(`/dm/conversations/${conversation.id}/participants/${removingParticipant.id}`, {
        method: 'DELETE'
      })
      if (data.error) { alert(data.error); return }
      onConversationUpdated?.(data)
    } catch (e) {
      alert(e.message)
    } finally {
      setRemovingParticipant(null)
    }
  }

  function handleFileSelect(e) {
    const files = Array.from(e.target.files || [])
    setPendingFiles(prev => {
      const combined = [...prev, ...files.map(f => ({ file: f, name: f.name }))]
      return combined.slice(0, 10)
    })
    e.target.value = ''
  }

  function removePendingFile(i) {
    setPendingFiles(prev => prev.filter((_, idx) => idx !== i))
  }

  const participants = conversation?.participant_details || []
  const participantIds = conversation?.participants || []
  // 나 자신 제외한 상대방 목록
  const otherParticipants = participants.filter(p => p.id !== currentUser?.id)

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-gray-50">
      {/* ── Header: 창 이름 / 전송수신 상대방 / 닫기 ── */}
      <div className="flex items-center gap-3 px-5 py-3 bg-white border-b border-gray-100 shadow-sm flex-shrink-0">

        {/* 왼쪽: 창 이름 + 상대방 이름 */}
        <div className="flex-1 min-w-0">
          {/* 창 이름 영역 — 더블클릭으로 이름 변경 */}
          <h2
            className="font-bold text-gray-900 text-base cursor-pointer hover:text-indigo-600 transition-colors truncate select-none leading-tight"
            onDoubleClick={() => setShowRename(true)}
            title="더블클릭하여 이름 변경"
          >
            {conversation?.name || '대화'}
          </h2>

          {/* 전송/수신 상대방 이름 영역 — 클릭 시 삭제 확인 팝업 */}
          {otherParticipants.length > 0 && (
            <div className="flex items-center gap-1 mt-0.5 flex-wrap">
              <span className="text-[10px] text-gray-300 uppercase tracking-wide mr-0.5">상대방</span>
              {otherParticipants.map((p, i) => (
                <span key={p.id} className="flex items-center gap-1">
                  <button
                    onClick={() => setRemovingParticipant(p)}
                    title="클릭하여 삭제"
                    className="text-xs text-gray-500 font-medium hover:text-red-500 hover:line-through transition-colors cursor-pointer"
                  >
                    {p.display_name || p.username}
                  </button>
                  {i < otherParticipants.length - 1 && <span className="text-gray-200 text-xs">·</span>}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* 오른쪽: 참여자 추가 + 닫기 버튼 */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {participantIds.length < 10 && (
            <button
              onClick={() => setShowAddParticipant(true)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
              title="참여자 추가"
            >
              <PlusUserIcon />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            title="닫기 (ESC)"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-300 gap-2">
            <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
            <p className="text-sm">첫 메시지를 보내보세요</p>
          </div>
        ) : (
          messages.map(msg => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              isMine={msg.sender_id === currentUser?.id}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="flex-shrink-0 bg-white border-t border-gray-100 px-4 py-3">
        {pendingFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {pendingFiles.map((f, i) => (
              <div key={i} className="flex items-center gap-1 bg-indigo-50 border border-indigo-200 rounded-lg px-2 py-1 text-xs text-indigo-700">
                <ClipIcon />
                <span className="max-w-[120px] truncate">{f.name}</span>
                <button onClick={() => removePendingFile(i)} className="ml-1 text-indigo-400 hover:text-red-500">×</button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-2 rounded-xl text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors flex-shrink-0"
            title="파일 첨부"
          >
            <ClipIcon />
          </button>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
            }}
            placeholder="메시지 입력... (Enter 전송, Shift+Enter 줄바꿈)"
            rows={1}
            className="flex-1 bg-gray-100 rounded-xl px-4 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-400/40 max-h-32"
            style={{ minHeight: '40px' }}
          />
          <button
            onClick={handleSend}
            disabled={sending || (!input.trim() && pendingFiles.length === 0)}
            className="p-2.5 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 transition-colors flex-shrink-0"
          >
            <SendIcon />
          </button>
        </div>
      </div>

      {showRename && (
        <RenamePopup
          current={conversation?.name || ''}
          onConfirm={handleRename}
          onCancel={() => setShowRename(false)}
        />
      )}
      {showAddParticipant && (
        <AddParticipantPopup
          currentParticipants={participantIds}
          onAdd={handleAddParticipant}
          onCancel={() => setShowAddParticipant(false)}
        />
      )}
      {removingParticipant && (
        <RemoveParticipantPopup
          participant={removingParticipant}
          onConfirm={handleRemoveParticipant}
          onCancel={() => setRemovingParticipant(null)}
        />
      )}
    </div>
  )
}

// ── DMConversationList ────────────────────────────────────────
// Exported separately for Sidebar to show recent conversations
export { NewConversationModal }
