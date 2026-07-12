import { useEffect, useId, useRef, useState } from 'react'
import { MAIL_TEXT } from './mailText'
import { MenuIcon } from './mailIcons'
import {
  MAIL_SUMMARY_NO_INFO,
  formatDraftSummaryActionTimeLabel,
  isSummaryTimeMissing,
  parseSummaryActionDateTime,
  parseSummaryScheduleDate,
} from './mailSummaryUtils'

function MailSummaryValue({ label, value, noInfo = MAIL_SUMMARY_NO_INFO }) {
  const empty = !value || value === MAIL_SUMMARY_NO_INFO || value === noInfo
  return (
    <div className="rounded-md border border-indigo-100 bg-white px-3 py-2">
      <div className="text-[11px] font-extrabold text-indigo-500">{label}</div>
      <div className={`mt-1 text-sm font-bold ${empty ? 'text-gray-400' : 'text-gray-800'}`}>{value || noInfo}</div>
    </div>
  )
}

export default function MailSummaryPanel({
  summary,
  mt = MAIL_TEXT.ko,
  actionTimeDrafts = {},
  actionTimeSavingKey = '',
  actionTimeError = '',
  actionTaskSavingKey = '',
  actionTaskError = '',
  onActionTimeChange,
  onActionTaskChange,
  onCalendarRegister,
  referenceDate,
}) {
  const [openActionMenu, setOpenActionMenu] = useState(null)
  const [editingActionIndex, setEditingActionIndex] = useState(null)
  const [editingActionValue, setEditingActionValue] = useState('')
  const cancelledEditRef = useRef(null)
  const actionMenuIdPrefix = useId()
  const actionMenuContainersRef = useRef(new Map())
  const actionMenuTriggersRef = useRef(new Map())

  useEffect(() => {
    if (openActionMenu === null) return undefined

    function closeOnOutsidePointer(event) {
      const container = actionMenuContainersRef.current.get(openActionMenu)
      if (container?.contains(event.target)) return
      setOpenActionMenu(null)
    }

    function closeOnEscape(event) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      const trigger = actionMenuTriggersRef.current.get(openActionMenu)
      setOpenActionMenu(null)
      window.requestAnimationFrame(() => trigger?.focus())
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [openActionMenu])

  if (!summary) return null
  const schedule = summary.schedule || {}
  const s = mt.summary
  return (
    <div className="rounded-lg border border-indigo-100 bg-indigo-50/60 p-4 text-sm text-gray-800">
      <section>
        <h3 className="text-sm font-extrabold text-gray-950">{s.schedule}</h3>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <MailSummaryValue label={s.date} value={schedule.date} noInfo={s.noInfo} />
          <MailSummaryValue label={s.time} value={schedule.time} noInfo={s.noInfo} />
          <MailSummaryValue label={s.location} value={schedule.location} noInfo={s.noInfo} />
          <MailSummaryValue label={s.participants} value={schedule.participants} noInfo={s.noInfo} />
          <MailSummaryValue label={s.notes} value={schedule.notes} noInfo={s.noInfo} />
        </div>
      </section>

      <section className="mt-5">
        <h3 className="text-sm font-extrabold text-gray-950">{s.keyPoints}</h3>
        <ul className="mt-2 space-y-1.5">
          {(summary.keyPoints || [s.noInfo]).map((item, index) => (
            <li key={`${item}-${index}`} className="flex gap-2 leading-6">
              <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-indigo-400" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-5">
        <h3 className="text-sm font-extrabold text-gray-950">{s.detail}</h3>
        <p className="mt-2 leading-7">{summary.summary || s.noInfo}</p>
      </section>

      <section className="mt-5">
        <h3 className="text-sm font-extrabold text-gray-950">{s.actions}</h3>
        <div className="mt-2 divide-y divide-indigo-100 rounded-md border border-indigo-100 bg-white">
          {(summary.actionItems || [{ task: s.noInfo, time: s.noInfo }]).map((item, index) => {
            const savedDateTime = parseSummaryActionDateTime(item.time)
            const draft = actionTimeDrafts[index] || {}
            const scheduleDate = parseSummaryScheduleDate(schedule.date, referenceDate)
            const useScheduleAllDay = !savedDateTime.date && scheduleDate && isSummaryTimeMissing(schedule.time, s.noInfo)
            const dateValue = draft.date ?? (item.date || savedDateTime.date || (useScheduleAllDay ? scheduleDate : ''))
            const timeValue = draft.time ?? (item.clockTime ?? savedDateTime.time)
            const isAllDay = draft.isAllDay ?? (item.isAllDay === true || Boolean(useScheduleAllDay))
            const effectiveDraft = { ...draft, date: dateValue, time: timeValue, isAllDay }
            const menuOpen = openActionMenu === index
            const menuId = `${actionMenuIdPrefix}-action-time-${index}`
            return (
              <div key={`${item.task}-${index}`} className="grid gap-2 px-3 py-2 lg:grid-cols-[1fr_auto] lg:items-center">
                {editingActionIndex === index ? (
                  <input
                    type="text"
                    autoFocus
                    maxLength={500}
                    value={editingActionValue}
                    disabled={actionTaskSavingKey === String(index)}
                    aria-label={item.task || s.noInfo}
                    onChange={event => setEditingActionValue(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === 'Escape') {
                        cancelledEditRef.current = index
                        setEditingActionIndex(null)
                        setEditingActionValue('')
                        event.currentTarget.blur()
                      } else if (event.key === 'Enter' && !event.isComposing && !event.nativeEvent?.isComposing) {
                        event.preventDefault()
                        event.currentTarget.blur()
                      }
                    }}
                    onBlur={async () => {
                      if (cancelledEditRef.current === index) {
                        cancelledEditRef.current = null
                        return
                      }
                      const saved = await onActionTaskChange?.(index, editingActionValue)
                      if (saved !== false) {
                        setEditingActionIndex(null)
                        setEditingActionValue('')
                      }
                    }}
                    className="h-9 min-w-0 w-full rounded-md border border-indigo-300 bg-white px-2.5 text-sm font-bold text-gray-800 outline-none ring-2 ring-indigo-100 focus:border-indigo-500 disabled:opacity-60"
                  />
                ) : (
                  <span
                    className="cursor-text font-bold text-gray-800"
                    title="더블클릭하여 편집"
                    onDoubleClick={() => {
                      setEditingActionIndex(index)
                      setEditingActionValue(item.task || '')
                    }}
                  >
                    {item.task || s.noInfo}
                  </span>
                )}
                <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                  <div
                    ref={node => {
                      if (node) actionMenuContainersRef.current.set(index, node)
                      else actionMenuContainersRef.current.delete(index)
                    }}
                    className="relative"
                  >
                    <button
                      ref={node => {
                        if (node) actionMenuTriggersRef.current.set(index, node)
                        else actionMenuTriggersRef.current.delete(index)
                      }}
                      type="button"
                      aria-expanded={menuOpen}
                      aria-controls={menuId}
                      aria-haspopup="dialog"
                      onClick={() => setOpenActionMenu(prev => (prev === index ? null : index))}
                      className="inline-flex h-8 min-w-[128px] items-center justify-between gap-2 rounded-md border border-indigo-100 bg-indigo-50/50 px-2.5 text-xs font-extrabold text-gray-600 transition hover:border-indigo-200 hover:bg-indigo-50"
                    >
                      <span>{formatDraftSummaryActionTimeLabel(item, effectiveDraft, mt)}</span>
                      <span className={`transition-transform ${menuOpen ? 'rotate-180' : ''}`}>
                        <MenuIcon type="chevronDown" />
                      </span>
                    </button>
                    {menuOpen && (
                      <div
                        id={menuId}
                        role="dialog"
                        aria-label={`${item.task || s.noInfo} ${s.selectDate}`}
                        className="absolute right-0 z-30 mt-2 w-[278px] rounded-lg border border-indigo-100 bg-white p-3 shadow-xl shadow-indigo-100/70"
                      >
                        <label className="block text-[11px] font-extrabold text-gray-500">
                          {s.selectDate}
                          <input
                            type="date"
                            value={dateValue}
                            aria-label={s.selectDate}
                            title={s.selectDate}
                            onChange={event => onActionTimeChange?.(index, { date: event.target.value })}
                            className="mt-1 h-9 w-full rounded-md border border-indigo-100 bg-indigo-50/50 px-2 text-xs font-bold text-gray-700 outline-none transition focus:border-indigo-300 focus:bg-white"
                          />
                        </label>
                        <div className="mt-3 flex items-center justify-between rounded-md border border-indigo-100 bg-indigo-50/40 px-2.5 py-2 text-xs font-extrabold text-gray-600">
                          <span className={isAllDay ? 'text-indigo-700' : 'text-gray-500'}>{s.allDay}</span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={isAllDay}
                            aria-label={s.allDay}
                            title={s.allDay}
                            onClick={() => onActionTimeChange?.(index, { date: dateValue, time: timeValue, isAllDay: !isAllDay })}
                            className={`relative h-5 w-10 flex-shrink-0 rounded-full transition ${
                              isAllDay ? 'bg-indigo-600' : 'bg-gray-300'
                            }`}
                          >
                            <span className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${isAllDay ? 'translate-x-5' : 'translate-x-0.5'}`} />
                          </button>
                        </div>
                        <label className="mt-3 block text-[11px] font-extrabold text-gray-500">
                          {s.selectTime}
                          <input
                            type="time"
                            value={timeValue}
                            aria-label={s.selectTime}
                            title={s.selectTime}
                            disabled={isAllDay}
                            onChange={event => onActionTimeChange?.(index, { time: event.target.value })}
                            className="mt-1 h-9 w-full rounded-md border border-indigo-100 bg-indigo-50/50 px-2 text-xs font-bold text-gray-700 outline-none transition focus:border-indigo-300 focus:bg-white disabled:cursor-not-allowed disabled:border-gray-100 disabled:bg-gray-50 disabled:text-gray-400"
                          />
                        </label>
                      </div>
                    )}
                  </div>
                  {actionTimeSavingKey === String(index) && (
                    <span className="text-[11px] font-extrabold text-indigo-500">{s.savingActionTime}</span>
                  )}
                  {!item.calendarEventId && editingActionIndex !== index && dateValue && (isAllDay || timeValue) && (
                    <button
                      type="button"
                      disabled={actionTimeSavingKey === String(index) || actionTaskSavingKey === String(index)}
                      onClick={() => onCalendarRegister?.(index)}
                      className="rounded px-1.5 py-1 text-[11px] font-extrabold text-indigo-500 underline decoration-indigo-200 underline-offset-2 transition hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {s.calendarRegister}
                    </button>
                  )}
                  {item.calendarEventId && (
                    <button
                      type="button"
                      disabled={actionTimeSavingKey === String(index) || actionTaskSavingKey === String(index)}
                      onClick={() => onCalendarRegister?.(index)}
                      className="rounded px-1.5 py-1 text-[11px] font-extrabold text-indigo-500 underline decoration-indigo-200 underline-offset-2 transition hover:bg-indigo-50 hover:text-indigo-700"
                      title="연결된 캘린더 이벤트를 다시 확인하고 동기화합니다."
                    >
                      {s.calendarAdded}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        {actionTimeError && (
          <p className="mt-2 text-xs font-bold text-red-500">{actionTimeError}</p>
        )}
        {actionTaskError && (
          <p className="mt-2 text-xs font-bold text-red-500">{actionTaskError}</p>
        )}
      </section>
    </div>
  )
}
