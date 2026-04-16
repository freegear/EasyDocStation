import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useT } from '../i18n/useT'
import { apiFetch } from '../lib/api'

const EVENT_COLORS = [
  { value: '#4f46e5', label: '인디고' },
  { value: '#ef4444', label: '빨강' },
  { value: '#f97316', label: '주황' },
  { value: '#eab308', label: '노랑' },
  { value: '#22c55e', label: '초록' },
  { value: '#06b6d4', label: '청록' },
  { value: '#a855f7', label: '보라' },
  { value: '#ec4899', label: '핑크' },
  { value: '#6b7280', label: '회색' },
]

const REPEAT_OPTIONS = [
  { value: 'none', label: '없음' },
  { value: 'daily', label: '매일' },
  { value: 'weekly', label: '매주' },
  { value: 'monthly', label: '매월' },
  { value: 'yearly', label: '매년' },
]

function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate()
}

function makeDefaultDt(addHours = 0) {
  const d = new Date()
  // 분은 5단위로 올림 처리 (예: 3:47 → 3:50)
  const roundedMin = Math.ceil(d.getMinutes() / 5) * 5
  d.setHours(d.getHours() + addHours, roundedMin >= 60 ? 0 : roundedMin, 0, 0)
  if (roundedMin >= 60) d.setHours(d.getHours() + 1)
  const h = d.getHours()
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    ampm: h < 12 ? '오전' : '오후',
    hour: h === 0 ? 12 : h > 12 ? h - 12 : h,
    minute: roundedMin >= 60 ? 0 : roundedMin,
  }
}

const selectCls = 'border border-gray-200 rounded-md px-1.5 py-1 text-xs text-gray-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400 cursor-pointer'

function DateTimeRow({ label, dt, setDt, disabled }) {
  const years = Array.from({ length: 11 }, (_, i) => new Date().getFullYear() - 2 + i)
  const months = Array.from({ length: 12 }, (_, i) => i + 1)
  const days = Array.from({ length: getDaysInMonth(dt.year, dt.month) }, (_, i) => i + 1)
  const hours = Array.from({ length: 12 }, (_, i) => i + 1)
  const minutes = Array.from({ length: 12 }, (_, i) => i * 5)

  return (
    <div className={`flex items-center gap-1.5 flex-wrap transition-opacity ${disabled ? 'opacity-30 pointer-events-none' : ''}`}>
      {label && <span className="text-xs text-gray-500 w-8 flex-shrink-0">{label}</span>}
      <select value={dt.year} onChange={e => setDt({ ...dt, year: +e.target.value })} className={selectCls}>
        {years.map(y => <option key={y} value={y}>{y}년</option>)}
      </select>
      <select value={dt.month} onChange={e => setDt({ ...dt, month: +e.target.value, day: 1 })} className={selectCls}>
        {months.map(m => <option key={m} value={m}>{m}월</option>)}
      </select>
      <select value={dt.day} onChange={e => setDt({ ...dt, day: +e.target.value })} className={selectCls}>
        {days.map(d => <option key={d} value={d}>{d}일</option>)}
      </select>
      <select value={dt.ampm} onChange={e => setDt({ ...dt, ampm: e.target.value })} className={selectCls}>
        <option value="오전">오전</option>
        <option value="오후">오후</option>
      </select>
      <select value={dt.hour} onChange={e => setDt({ ...dt, hour: +e.target.value })} className={selectCls}>
        {hours.map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}</option>)}
      </select>
      <span className="text-gray-400 text-sm">:</span>
      <select value={dt.minute} onChange={e => setDt({ ...dt, minute: +e.target.value })} className={selectCls}>
        {minutes.map(m => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
      </select>
    </div>
  )
}

export default function EventAddModal({ onClose, onAdd, onSave, onDelete, event: editEvent, initialStartDt, initialEndDt }) {
  const { currentUser } = useAuth()
  const t = useT()
  const isSiteAdmin = currentUser?.role === 'site_admin'
  const maxLevel = isSiteAdmin ? 4 : (currentUser?.security_level ?? 0)
  const isEditMode = !!editEvent

  const [tab, setTab] = useState('event') // 'event' | 'reminder'
  const [showRepeatDeleteConfirm, setShowRepeatDeleteConfirm] = useState(false)
  const [showRepeatSaveConfirm, setShowRepeatSaveConfirm] = useState(false)

  // 이벤트 탭 상태
  const [title, setTitle] = useState(editEvent?.title ?? '')
  const [color, setColor] = useState(editEvent?.color ?? '#4f46e5')
  const [allDay, setAllDay] = useState(editEvent?.allDay ?? false)
  const [startDt, setStartDt] = useState(editEvent?.startDt ?? initialStartDt ?? makeDefaultDt(0))
  const [endDt, setEndDt] = useState(editEvent?.endDt ?? initialEndDt ?? makeDefaultDt(1))
  const [repeat, setRepeat] = useState(editEvent?.repeat ?? 'none')
  const [inviteeQuery, setInviteeQuery] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [invitees, setInvitees] = useState(editEvent?.invitees ?? [])
  const inviteeInputRef = useRef(null)
  const suggestBoxRef = useRef(null)
  const [memo, setMemo] = useState(editEvent?.memo ?? '')
  const [securityLevel, setSecurityLevel] = useState(editEvent?.securityLevel ?? Math.min(1, maxLevel))

  // 미리 알림 탭 상태
  const [remindDt, setRemindDt] = useState(editEvent?.remindDt ?? makeDefaultDt(0))
  const [remindRepeat, setRemindRepeat] = useState(editEvent?.remindRepeat ?? 'none')

  const titleRef = useRef(null)

  useEffect(() => {
    titleRef.current?.focus()
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Search users as query changes
  useEffect(() => {
    const q = inviteeQuery.trim()
    if (!q) { setSuggestions([]); setShowSuggestions(false); return }
    apiFetch(`/users/search?q=${encodeURIComponent(q)}`)
      .then(data => {
        // Filter out already-added invitees
        const addedIds = new Set(invitees.map(u => u.id))
        setSuggestions(data.filter(u => !addedIds.has(u.id)))
        setShowSuggestions(true)
      })
      .catch(() => setSuggestions([]))
  }, [inviteeQuery])

  // Close dropdown when clicking outside
  useEffect(() => {
    function onClickOutside(e) {
      if (
        inviteeInputRef.current && !inviteeInputRef.current.contains(e.target) &&
        suggestBoxRef.current && !suggestBoxRef.current.contains(e.target)
      ) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  function addInvitee(user) {
    setInvitees(prev => [...prev, { id: user.id, username: user.username, name: user.name, image_url: user.image_url }])
    setInviteeQuery('')
    setSuggestions([])
    setShowSuggestions(false)
    inviteeInputRef.current?.focus()
  }

  function buildData() {
    return {
      title: title.trim(),
      color,
      allDay,
      startDt,
      endDt,
      repeat,
      invitees,
      memo,
      securityLevel,
      remindDt,
      remindRepeat,
    }
  }

  function handleSubmit() {
    if (!title.trim()) { titleRef.current?.focus(); return }
    if (isEditMode) {
      if (editEvent.repeat && editEvent.repeat !== 'none') {
        setShowRepeatSaveConfirm(true)
      } else {
        onSave?.({ ...editEvent, ...buildData() }, 'single')
        onClose()
      }
    } else {
      onAdd?.(buildData())
      onClose()
    }
  }

  function handleDelete() {
    if (editEvent.repeat && editEvent.repeat !== 'none') {
      setShowRepeatDeleteConfirm(true)
    } else {
      onDelete?.(editEvent.id, 'single')
      onClose()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      {/* 반복 이벤트 수정 확인 팝업 */}
      {showRepeatSaveConfirm && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
          onKeyDown={e => { if (e.key === 'Escape') { setShowRepeatSaveConfirm(false); onClose() } }}
          tabIndex={-1}
          ref={el => el?.focus()}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-[380px] overflow-hidden">
            <div className="px-6 pt-6 pb-4">
              <h3 className="text-base font-semibold text-gray-900 mb-2">반복 이벤트 수정</h3>
              <p className="text-sm text-gray-600 leading-relaxed">
                반복 등록된 이벤트입니다.<br />
                해당 날짜만 수정하시겠습니까? 전체를 수정하시겠습니까?
              </p>
            </div>
            <div className="flex items-center gap-2 px-6 pb-5">
              <button
                onClick={() => { setShowRepeatSaveConfirm(false); onSave?.({ ...editEvent, ...buildData() }, 'single'); onClose() }}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors"
              >
                해당 날짜만
              </button>
              <button
                onClick={() => { setShowRepeatSaveConfirm(false); onSave?.({ ...editEvent, ...buildData() }, 'all'); onClose() }}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
              >
                전체
              </button>
              <button
                onClick={() => { setShowRepeatSaveConfirm(false); onClose() }}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-500 hover:bg-gray-50 transition-colors"
              >
                취소
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 반복 이벤트 삭제 확인 팝업 */}
      {showRepeatDeleteConfirm && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
          onKeyDown={e => { if (e.key === 'Escape') setShowRepeatDeleteConfirm(false) }}
          tabIndex={-1}
          ref={el => el?.focus()}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-[380px] overflow-hidden">
            <div className="px-6 pt-6 pb-4">
              <h3 className="text-base font-semibold text-gray-900 mb-2">반복 이벤트 삭제</h3>
              <p className="text-sm text-gray-600 leading-relaxed">
                반복 등록된 이벤트입니다.<br />
                해당 날짜만 삭제하시겠습니까? 전체를 삭제하시겠습니까?
              </p>
            </div>
            <div className="flex items-center gap-2 px-6 pb-5">
              <button
                onClick={() => { setShowRepeatDeleteConfirm(false); onDelete?.(editEvent.id, 'single'); onClose() }}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors"
              >
                해당 날짜만
              </button>
              <button
                onClick={() => { setShowRepeatDeleteConfirm(false); onDelete?.(editEvent.id, 'all', editEvent.seriesId); onClose() }}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 transition-colors"
              >
                전체
              </button>
              <button
                onClick={() => setShowRepeatDeleteConfirm(false)}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-500 hover:bg-gray-50 transition-colors"
              >
                취소
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="bg-white rounded-2xl shadow-2xl w-[520px] max-h-[90vh] flex flex-col overflow-hidden">

        {/* Header tabs */}
        <div className="flex border-b border-gray-200 px-5 pt-4 gap-0 items-center">
          {isEditMode && (
            <span className="text-xs font-semibold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full mr-3 mb-1">편집</span>
          )}
          {[['event', '이벤트'], ['reminder', '미리 알림']].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-4 py-2 text-sm font-semibold border-b-2 transition-colors -mb-px ${
                tab === k ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
          <button onClick={onClose} className="ml-auto w-8 h-8 flex items-center justify-center text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors mb-1">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

          {tab === 'event' && (
            <>
              {/* 1. 제목 */}
              <div>
                <input
                  ref={titleRef}
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSubmit() }}
                  placeholder="이벤트 제목"
                  className="w-full border-0 border-b-2 border-gray-200 focus:border-indigo-500 outline-none text-base font-semibold text-gray-900 placeholder-gray-300 pb-1.5 transition-colors bg-transparent"
                />
              </div>

              {/* 2. 색상 */}
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 block">이벤트 색상</label>
                <div className="flex gap-2 flex-wrap">
                  {EVENT_COLORS.map(c => (
                    <button
                      key={c.value}
                      onClick={() => setColor(c.value)}
                      title={c.label}
                      className={`w-7 h-7 rounded-full transition-all ${color === c.value ? 'ring-2 ring-offset-2 ring-gray-400 scale-110' : 'hover:scale-105'}`}
                      style={{ backgroundColor: c.value }}
                    />
                  ))}
                </div>
              </div>

              {/* 3. 하루종일 */}
              <div>
                <label className="flex items-center gap-2.5 cursor-pointer w-fit">
                  <div
                    onClick={() => setAllDay(v => !v)}
                    className={`w-9 h-5 rounded-full transition-colors relative ${allDay ? 'bg-indigo-600' : 'bg-gray-200'}`}
                  >
                    <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${allDay ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </div>
                  <span className="text-sm text-gray-700 font-medium">하루 종일</span>
                </label>
              </div>

              {/* 4. 시간 */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide block">시간</label>
                <DateTimeRow label="시작" dt={startDt} setDt={setStartDt} disabled={allDay} />
                <DateTimeRow label="종료" dt={endDt} setDt={setEndDt} disabled={allDay} />
              </div>

              {/* 5. 반복 */}
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 block">반복</label>
                <div className="flex gap-2 flex-wrap">
                  {REPEAT_OPTIONS.map(r => (
                    <button
                      key={r.value}
                      onClick={() => setRepeat(r.value)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                        repeat === r.value
                          ? 'bg-indigo-600 text-white border-indigo-600'
                          : 'text-gray-600 border-gray-200 hover:border-indigo-300 hover:text-indigo-600'
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 6. 등록자 */}
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 block">등록자</label>
                <div className="flex items-center gap-2">
                  {currentUser?.image_url ? (
                    <img src={currentUser.image_url} className="w-6 h-6 rounded-full object-cover flex-shrink-0" alt="" />
                  ) : (
                    <div className="w-6 h-6 rounded-full bg-indigo-500 text-white flex items-center justify-center text-[10px] font-bold flex-shrink-0">
                      {(currentUser?.name || currentUser?.username || '?')[0].toUpperCase()}
                    </div>
                  )}
                  <span className="text-sm text-gray-700">{currentUser?.name}</span>
                  <span className="text-xs text-gray-400">@{currentUser?.username}</span>
                </div>
              </div>

              {/* 7. 초대할 사람 */}
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 block">초대할 사람</label>
                {/* 추가된 초대자 태그 */}
                {invitees.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {invitees.map((inv, i) => (
                      <span key={inv.id ?? i} className="flex items-center gap-1.5 bg-indigo-50 border border-indigo-200 text-indigo-800 text-xs px-2 py-1 rounded-full font-medium">
                        {inv.image_url ? (
                          <img src={inv.image_url} className="w-4 h-4 rounded-full object-cover" alt="" />
                        ) : (
                          <span className="w-4 h-4 rounded-full bg-indigo-400 text-white flex items-center justify-center text-[9px] font-bold flex-shrink-0">
                            {(inv.name || inv.username || '?')[0].toUpperCase()}
                          </span>
                        )}
                        <span>{inv.name}</span>
                        <span className="text-indigo-400">@{inv.username}</span>
                        <button
                          onClick={() => setInvitees(prev => prev.filter((_, j) => j !== i))}
                          className="hover:text-red-500 leading-none ml-0.5"
                        >×</button>
                      </span>
                    ))}
                  </div>
                )}
                {/* 자동완성 입력창 */}
                <div className="relative">
                  <input
                    ref={inviteeInputRef}
                    value={inviteeQuery}
                    onChange={e => setInviteeQuery(e.target.value)}
                    onFocus={() => inviteeQuery.trim() && setShowSuggestions(true)}
                    onKeyDown={e => { if (e.key === 'Escape') { setShowSuggestions(false); setInviteeQuery('') } }}
                    placeholder="아이디 또는 이름으로 검색..."
                    className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400 placeholder-gray-300"
                  />
                  {showSuggestions && suggestions.length > 0 && (
                    <div
                      ref={suggestBoxRef}
                      className="absolute left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 overflow-hidden max-h-48 overflow-y-auto"
                    >
                      {suggestions.map(user => (
                        <button
                          key={user.id}
                          onMouseDown={e => { e.preventDefault(); addInvitee(user) }}
                          className="flex items-center gap-2.5 w-full px-3 py-2 hover:bg-indigo-50 text-left transition-colors"
                        >
                          {user.image_url ? (
                            <img src={user.image_url} className="w-7 h-7 rounded-full object-cover flex-shrink-0" alt="" />
                          ) : (
                            <div className="w-7 h-7 rounded-full bg-indigo-500 text-white flex items-center justify-center text-xs font-bold flex-shrink-0">
                              {(user.name || user.username)[0].toUpperCase()}
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-gray-900 truncate">{user.name}</div>
                            <div className="text-xs text-gray-400 truncate">@{user.username}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  {showSuggestions && inviteeQuery.trim() && suggestions.length === 0 && (
                    <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 px-3 py-2 text-sm text-gray-400">
                      검색 결과가 없습니다.
                    </div>
                  )}
                </div>
              </div>

              {/* 7. 메모 */}
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 block">메모</label>
                <textarea
                  value={memo}
                  onChange={e => setMemo(e.target.value)}
                  rows={3}
                  placeholder="이벤트 메모를 입력하세요..."
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400 resize-none placeholder-gray-300"
                />
              </div>

              {/* 8. 보안 등급 */}
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 block">보안 등급</label>
                <select
                  value={securityLevel}
                  onChange={e => setSecurityLevel(+e.target.value)}
                  className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-indigo-400 cursor-pointer"
                >
                  {t.admin.securityLevels.map((label, i) => i <= maxLevel && (
                    <option key={i} value={i}>{label}</option>
                  ))}
                </select>
              </div>
            </>
          )}

          {tab === 'reminder' && (
            <div className="space-y-4 py-1">
              {/* 지정한 날짜에 */}
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 block">지정한 날짜에</label>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {[
                    { label: '년', key: 'year', options: Array.from({ length: 11 }, (_, i) => new Date().getFullYear() - 2 + i) },
                    { label: '월', key: 'month', options: Array.from({ length: 12 }, (_, i) => i + 1) },
                    { label: '일', key: 'day', options: Array.from({ length: getDaysInMonth(remindDt.year, remindDt.month) }, (_, i) => i + 1) },
                  ].map(({ label, key, options }) => (
                    <select key={key} value={remindDt[key]} onChange={e => setRemindDt({ ...remindDt, [key]: +e.target.value })} className={selectCls}>
                      {options.map(v => <option key={v} value={v}>{v}{label}</option>)}
                    </select>
                  ))}
                </div>
              </div>

              {/* 특정한 시간에 */}
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 block">특정한 시간에</label>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <select value={remindDt.ampm} onChange={e => setRemindDt({ ...remindDt, ampm: e.target.value })} className={selectCls}>
                    <option value="오전">오전</option>
                    <option value="오후">오후</option>
                  </select>
                  <select value={remindDt.hour} onChange={e => setRemindDt({ ...remindDt, hour: +e.target.value })} className={selectCls}>
                    {Array.from({ length: 12 }, (_, i) => i + 1).map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}</option>)}
                  </select>
                  <span className="text-gray-400 text-sm">:</span>
                  <select value={remindDt.minute} onChange={e => setRemindDt({ ...remindDt, minute: +e.target.value })} className={selectCls}>
                    {Array.from({ length: 12 }, (_, i) => i * 5).map(m => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
                  </select>
                </div>
              </div>

              {/* 반복 */}
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 block">반복</label>
                <div className="flex gap-2 flex-wrap">
                  {[{ value: 'none', label: '반복 안함' }, ...REPEAT_OPTIONS.slice(1)].map(r => (
                    <button
                      key={r.value}
                      onClick={() => setRemindRepeat(r.value)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                        remindRepeat === r.value
                          ? 'bg-indigo-600 text-white border-indigo-600'
                          : 'text-gray-600 border-gray-200 hover:border-indigo-300 hover:text-indigo-600'
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer buttons */}
        <div className="flex items-center px-5 py-3 border-t border-gray-100 bg-gray-50/60">
          {isEditMode && (
            <button
              onClick={handleDelete}
              className="px-4 py-2 rounded-lg text-sm text-red-600 hover:bg-red-50 font-medium transition-colors border border-red-200"
            >
              삭제
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-100 font-medium transition-colors"
          >
            취소
          </button>
          <button
            onClick={handleSubmit}
            style={{ backgroundColor: color }}
            className="ml-2 px-5 py-2 rounded-lg text-sm text-white font-semibold shadow-sm hover:opacity-90 transition-opacity"
          >
            {isEditMode ? '수정' : '추가'}
          </button>
        </div>
      </div>
    </div>
  )
}
