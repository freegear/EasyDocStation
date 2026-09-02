import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../lib/api'

function formatExpiry(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date)
}

export default function EmergencySpaceAccessModal({ teams = [], onClose, onChanged }) {
  const [spaceId, setSpaceId] = useState('')
  const [reason, setReason] = useState('')
  const [durationMinutes, setDurationMinutes] = useState(15)
  const [revokeReasons, setRevokeReasons] = useState({})
  const [loadingKey, setLoadingKey] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const activeAccesses = useMemo(
    () => (teams || []).filter(team => team.visibility === 'personal' && team.emergency_access?.id),
    [teams],
  )

  useEffect(() => {
    const onKeyDown = event => {
      if (event.key === 'Escape' && !loadingKey) onClose?.()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [loadingKey, onClose])

  const grantAccess = async () => {
    const id = spaceId.trim()
    const safeReason = reason.trim()
    setError('')
    setNotice('')
    if (!id) return setError('복구용 스페이스 ID를 입력해주세요.')
    if (safeReason.length < 10) return setError('긴급 접근 사유를 10자 이상 입력해주세요.')

    setLoadingKey('grant')
    try {
      const access = await apiFetch(`/teams/${encodeURIComponent(id)}/emergency-access`, {
        method: 'POST',
        body: JSON.stringify({ reason: safeReason, durationMinutes }),
      })
      setNotice(`긴급 접근이 발급되었습니다. 만료: ${formatExpiry(access.expires_at)}`)
      setSpaceId('')
      setReason('')
      await onChanged?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoadingKey('')
    }
  }

  const revokeAccess = async team => {
    const accessId = team.emergency_access?.id
    const safeReason = String(revokeReasons[accessId] || '').trim()
    setError('')
    setNotice('')
    if (safeReason.length < 10) return setError('긴급 접근 해제 사유를 10자 이상 입력해주세요.')

    setLoadingKey(`revoke:${accessId}`)
    try {
      await apiFetch(`/teams/emergency-access/${encodeURIComponent(accessId)}`, {
        method: 'DELETE',
        body: JSON.stringify({ reason: safeReason }),
      })
      setNotice(`${team.name} 긴급 접근을 해제했습니다.`)
      setRevokeReasons(previous => ({ ...previous, [accessId]: '' }))
      await onChanged?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoadingKey('')
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => !loadingKey && onClose?.()} />
      <div className="relative flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-3xl border border-red-100 bg-gray-50 shadow-2xl">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-gray-200 bg-white px-6 py-4">
          <div>
            <h2 className="font-bold text-gray-900">🚨 개인 스페이스 긴급 접근</h2>
            <p className="mt-1 text-xs text-gray-500">모든 발급·검색·조회·해제 작업은 감사 기록에 남습니다.</p>
          </div>
          <button type="button" onClick={onClose} disabled={!!loadingKey} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700">✕</button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-6">
          {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}
          {notice && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}

          <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-4">
            <div>
              <label className="mb-1.5 block text-xs font-bold text-gray-600">복구용 스페이스 ID</label>
              <input value={spaceId} onChange={event => setSpaceId(event.target.value)} placeholder="예: private-project-1234" autoComplete="off" className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 outline-none focus:border-red-300 focus:ring-1 focus:ring-red-200" />
              <p className="mt-1.5 text-xs text-gray-400">개인 스페이스 관리자에게 전달받은 정확한 ID가 필요합니다.</p>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-bold text-gray-600">긴급 접근 사유</label>
              <textarea value={reason} onChange={event => setReason(event.target.value)} rows={3} maxLength={500} placeholder="장애 복구 목적과 작업 범위를 10자 이상 기록하세요." className="w-full resize-none rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 outline-none focus:border-red-300 focus:ring-1 focus:ring-red-200" />
              <p className="mt-1 text-right text-xs text-gray-400">{reason.trim().length}/500</p>
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between text-xs font-bold text-gray-600">
                <span>접근 유지 시간</span><span>{durationMinutes}분</span>
              </div>
              <input type="range" min="1" max="60" step="1" value={durationMinutes} onChange={event => setDurationMinutes(Number(event.target.value))} className="w-full accent-red-600" />
              <div className="mt-1 flex justify-between text-[10px] text-gray-400"><span>1분</span><span>60분</span></div>
            </div>
            <button type="button" onClick={grantAccess} disabled={!!loadingKey || !spaceId.trim() || reason.trim().length < 10} className="w-full rounded-xl bg-red-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-red-100 transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40">
              {loadingKey === 'grant' ? '발급 중...' : '감사 기록 후 긴급 접근 발급'}
            </button>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-gray-500">현재 활성 긴급 접근</h3>
            {activeAccesses.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-300 px-4 py-5 text-center text-xs text-gray-400">활성 긴급 접근이 없습니다.</div>
            ) : activeAccesses.map(team => {
              const access = team.emergency_access
              const key = `revoke:${access.id}`
              return (
                <div key={access.id} className="mb-3 rounded-2xl border border-red-100 bg-red-50/60 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-gray-800">🔒 {team.name}</p>
                      <p className="mt-1 break-all text-[11px] text-gray-500">ID: {team.id}</p>
                      <p className="mt-1 text-[11px] text-red-600">만료: {formatExpiry(access.expires_at)}</p>
                    </div>
                    <span className="rounded-full bg-red-100 px-2 py-1 text-[10px] font-bold text-red-600">긴급 접근 중</span>
                  </div>
                  <input value={revokeReasons[access.id] || ''} onChange={event => setRevokeReasons(previous => ({ ...previous, [access.id]: event.target.value }))} placeholder="해제 사유를 10자 이상 입력" maxLength={500} className="mt-3 w-full rounded-xl border border-red-100 bg-white px-3 py-2 text-xs text-gray-800 outline-none focus:border-red-300" />
                  <button type="button" onClick={() => revokeAccess(team)} disabled={!!loadingKey || String(revokeReasons[access.id] || '').trim().length < 10} className="mt-2 w-full rounded-xl border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40">
                    {loadingKey === key ? '해제 중...' : '긴급 접근 즉시 해제'}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
