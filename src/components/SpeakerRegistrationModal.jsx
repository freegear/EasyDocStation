import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../lib/api'

const SPEAKER_LABELS = ['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_02', 'SPEAKER_03', 'SPEAKER_04', 'SPEAKER_05']

export default function SpeakerRegistrationModal({ channelId, jobId = null, onClose }) {
  const [mappings, setMappings] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [editLabel, setEditLabel] = useState('')
  const [editName, setEditName] = useState('')
  const [addingNew, setAddingNew] = useState(false)
  const [newLabel, setNewLabel] = useState(SPEAKER_LABELS[0])
  const [newName, setNewName] = useState('')

  const fetchMappings = useCallback(async () => {
    if (!channelId) return
    setLoading(true)
    setError('')
    try {
      const qs = new URLSearchParams({ channelId })
      if (jobId) qs.set('jobId', jobId)
      const data = await apiFetch(`/ai/stt/speaker-mappings?${qs.toString()}`)
      setMappings(Array.isArray(data) ? data : [])
    } catch (e) {
      setError('화자 목록을 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }, [channelId])

  useEffect(() => { fetchMappings() }, [fetchMappings])

  async function handleSave(speakerLabel, displayName) {
    if (!displayName.trim()) return
    setSaving(true)
    setError('')
    try {
      await apiFetch('/ai/stt/speaker-mappings', {
        method: 'POST',
        body: JSON.stringify({ channelId, speakerLabel, displayName: displayName.trim(), jobId }),
      })
      setEditLabel('')
      setEditName('')
      setAddingNew(false)
      setNewLabel(SPEAKER_LABELS[0])
      setNewName('')
      await fetchMappings()
    } catch (e) {
      setError('저장에 실패했습니다.')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(speakerLabel) {
    if (!window.confirm(`'${speakerLabel}' 매핑을 삭제하시겠습니까?`)) return
    setSaving(true)
    setError('')
    try {
      await apiFetch('/ai/stt/speaker-mappings', {
        method: 'DELETE',
        body: JSON.stringify({ channelId, speakerLabel, jobId: jobId || undefined }),
      })
      await fetchMappings()
    } catch (e) {
      setError('삭제에 실패했습니다.')
    } finally {
      setSaving(false)
    }
  }

  const usedLabels = new Set(mappings.map((m) => m.speaker_label))
  const availableLabels = SPEAKER_LABELS.filter((l) => !usedLabels.has(l))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-gray-900 font-bold text-base">화자 등록 관리</h2>
            <p className="text-gray-400 text-xs mt-0.5">화자 레이블에 이름을 지정합니다</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2">
          {loading && (
            <p className="text-center text-gray-400 text-sm py-8">불러오는 중...</p>
          )}
          {!loading && mappings.length === 0 && !addingNew && (
            <p className="text-center text-gray-400 text-sm py-8">등록된 화자가 없습니다.</p>
          )}

          {/* Existing mappings */}
          {mappings.map((m) => {
            const isUnnamed = !m.display_name
            return (
            <div key={m.speaker_label} className={`flex items-center gap-2 p-3 rounded-xl border ${isUnnamed ? 'border-amber-200 bg-amber-50' : 'border-gray-100 bg-gray-50'}`}>
              <span className="text-xs font-mono text-indigo-600 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-md w-28 text-center flex-shrink-0">
                {m.speaker_label}
              </span>

              {editLabel === m.speaker_label ? (
                <>
                  <input
                    className="flex-1 border border-gray-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:border-sky-400"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSave(m.speaker_label, editName)
                      if (e.key === 'Escape') { setEditLabel(''); setEditName('') }
                    }}
                    autoFocus
                    placeholder="이름 입력"
                  />
                  <button
                    onClick={() => handleSave(m.speaker_label, editName)}
                    disabled={saving || !editName.trim()}
                    className="px-3 py-1 rounded-lg text-xs font-semibold bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50"
                  >
                    저장
                  </button>
                  <button
                    onClick={() => { setEditLabel(''); setEditName('') }}
                    className="px-2 py-1 rounded-lg text-xs text-gray-500 hover:bg-gray-200"
                  >
                    취소
                  </button>
                </>
              ) : (
                <>
                  {isUnnamed ? (
                    <span className="flex-1 text-xs text-amber-500 font-medium">미등록 — 이름을 지정하세요</span>
                  ) : (
                    <span className="flex-1 text-sm text-gray-800 font-medium">{m.display_name}</span>
                  )}
                  {m.voice_embedding_json && (
                    <span className="text-[10px] text-emerald-600 border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 rounded-full">
                      임베딩 저장됨
                    </span>
                  )}
                  <button
                    onClick={() => { setEditLabel(m.speaker_label); setEditName(m.display_name || '') }}
                    className={`text-xs hover:underline ${isUnnamed ? 'text-amber-600 font-semibold' : 'text-sky-600'}`}
                  >
                    {isUnnamed ? '이름 등록' : '수정'}
                  </button>
                  {!isUnnamed && (
                    <button
                      onClick={() => handleDelete(m.speaker_label)}
                      className="text-xs text-red-400 hover:text-red-600 hover:underline"
                    >
                      삭제
                    </button>
                  )}
                </>
              )}
            </div>
            )
          })}

          {/* New mapping form */}
          {addingNew && (
            <div className="flex items-center gap-2 p-3 rounded-xl border border-sky-200 bg-sky-50">
              <select
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                className="text-xs font-mono border border-gray-200 rounded-lg px-2 py-1 bg-white focus:outline-none w-32 flex-shrink-0"
              >
                {availableLabels.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
                {availableLabels.length === 0 && <option value="">-</option>}
              </select>
              <input
                className="flex-1 border border-gray-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:border-sky-400"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSave(newLabel, newName)
                  if (e.key === 'Escape') { setAddingNew(false); setNewName('') }
                }}
                autoFocus
                placeholder="이름 입력"
              />
              <button
                onClick={() => handleSave(newLabel, newName)}
                disabled={saving || !newName.trim() || availableLabels.length === 0}
                className="px-3 py-1 rounded-lg text-xs font-semibold bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50"
              >
                추가
              </button>
              <button
                onClick={() => { setAddingNew(false); setNewName('') }}
                className="px-2 py-1 rounded-lg text-xs text-gray-500 hover:bg-gray-200"
              >
                취소
              </button>
            </div>
          )}

          {error && <p className="text-red-500 text-xs">{error}</p>}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between">
          <button
            onClick={() => { setAddingNew(true); setNewName(''); setNewLabel(availableLabels[0] || SPEAKER_LABELS[0]) }}
            disabled={addingNew || availableLabels.length === 0}
            className="px-3 py-1.5 rounded-xl text-xs font-semibold border border-sky-200 text-sky-700 bg-sky-50 hover:bg-sky-100 disabled:opacity-50"
          >
            + 화자 추가
          </button>
          {jobId && (
            <p className="text-[11px] text-gray-400">이 STT 작업의 음성 임베딩이 함께 저장됩니다</p>
          )}
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl text-xs font-semibold border border-gray-200 text-gray-600 hover:bg-gray-100"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  )
}
