import { useState } from 'react'
import { MAIL_TEXT } from './mailText'
import { MenuIcon } from './mailIcons'
import {
  MAIL_SUMMARY_NO_INFO,
  formatDraftSummaryActionTimeLabel,
  parseSummaryActionDateTime,
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
  onActionTimeChange,
  onCalendarEventOpen,
}) {
  const [openActionMenu, setOpenActionMenu] = useState(null)
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
            const dateValue = draft.date ?? savedDateTime.date
            const timeValue = draft.time ?? savedDateTime.time
            const isAllDay = draft.isAllDay ?? item.isAllDay === true
            const menuOpen = openActionMenu === index
            return (
              <div key={`${item.task}-${index}`} className="grid gap-2 px-3 py-2 lg:grid-cols-[1fr_auto] lg:items-center">
                <span className="font-bold text-gray-800">{item.task || s.noInfo}</span>
                <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                  <div className="relative">
                    <button
                      type="button"
                      aria-expanded={menuOpen}
                      onClick={() => setOpenActionMenu(prev => (prev === index ? null : index))}
                      className="inline-flex h-8 min-w-[128px] items-center justify-between gap-2 rounded-md border border-indigo-100 bg-indigo-50/50 px-2.5 text-xs font-extrabold text-gray-600 transition hover:border-indigo-200 hover:bg-indigo-50"
                    >
                      <span>{formatDraftSummaryActionTimeLabel(item, draft, mt)}</span>
                      <span className={`transition-transform ${menuOpen ? 'rotate-180' : ''}`}>
                        <MenuIcon type="chevronDown" />
                      </span>
                    </button>
                    {menuOpen && (
                      <div className="absolute right-0 z-30 mt-2 w-[278px] rounded-lg border border-indigo-100 bg-white p-3 shadow-xl shadow-indigo-100/70">
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
                            onClick={() => onActionTimeChange?.(index, { isAllDay: !isAllDay })}
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
                  {item.calendarEventId && (
                    <button
                      type="button"
                      onClick={() => onCalendarEventOpen?.(item.calendarEventId)}
                      className="rounded px-1.5 py-1 text-[11px] font-extrabold text-indigo-500 underline decoration-indigo-200 underline-offset-2 transition hover:bg-indigo-50 hover:text-indigo-700"
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
      </section>
    </div>
  )
}
