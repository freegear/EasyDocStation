import { useState, useRef, useEffect } from 'react'
import EventAddModal from './EventAddModal'
import { apiFetch } from '../lib/api'

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']
const MONTHS = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월']
const HOURS = Array.from({ length: 24 }, (_, i) => i)

// Each hour row height in px (1 minute = 1px for DayView, 52/60 px for WeekView)
const DAY_SLOT_PX = 60
const WEEK_SLOT_PX = 52

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// Convert event dt object (with ampm) to { hour, minute } in 24h
function dtTo24h(dt) {
  let h = Number(dt.hour)
  const m = Number(dt.minute)
  if (dt.ampm === 'PM' && h !== 12) h += 12
  if (dt.ampm === 'AM' && h === 12) h = 0
  return { hour: h, minute: m }
}

// Shift a dt object by N days
function addDaysTodt(dt, days) {
  const d = new Date(dt.year, dt.month - 1, dt.day)
  d.setDate(d.getDate() + days)
  return { ...dt, year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() }
}

// Convert total minutes → ampm time object
function to12h(totalMin) {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, totalMin))
  const h = Math.floor(clamped / 60)
  const m = clamped % 60
  return { ampm: h < 12 ? '오전' : '오후', hour: h === 0 ? 12 : h > 12 ? h - 12 : h, minute: m }
}

// Snap minutes to nearest 5
function snapMin(min) {
  return Math.max(0, Math.min(23 * 60, Math.round(min / 5) * 5))
}

// Build a dt object from a JS Date + 24h hour/minute
function makeDt(date, hour24, minute = 0) {
  const snappedMin = Math.round(minute / 5) * 5
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    ...to12h(hour24 * 60 + snappedMin),
  }
}

function eventOnDay(ev, date) {
  const s = ev.startDt
  return s.year === date.getFullYear() && s.month === date.getMonth() + 1 && s.day === date.getDate()
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function getWeekStart(date) {
  const d = new Date(date)
  d.setDate(d.getDate() - d.getDay())
  d.setHours(0, 0, 0, 0)
  return d
}

function getMonthDays(year, month) {
  const firstDay = new Date(year, month, 1)
  const lastDay = new Date(year, month + 1, 0)
  const days = []

  for (let i = 0; i < firstDay.getDay(); i++) {
    days.push({ date: new Date(year, month, i - firstDay.getDay() + 1), isCurrentMonth: false })
  }
  for (let i = 1; i <= lastDay.getDate(); i++) {
    days.push({ date: new Date(year, month, i), isCurrentMonth: true })
  }
  const remaining = 42 - days.length
  for (let i = 1; i <= remaining; i++) {
    days.push({ date: new Date(year, month + 1, i), isCurrentMonth: false })
  }
  return days
}

// Returns timed events for a day with layout info (top/height/colIndex/colCount)
// so overlapping events are split into equal-width columns (1/n each)
function timedEventsForDay(events, date, slotPx) {
  const items = events
    .filter(ev => !ev.allDay && eventOnDay(ev, date))
    .map(ev => {
      const start = dtTo24h(ev.startDt)
      const end = dtTo24h(ev.endDt)
      const startMin = start.hour * 60 + start.minute
      const endMin = end.hour * 60 + end.minute
      const durationMin = Math.max(endMin - startMin, 30)
      const topPx = startMin * (slotPx / 60)
      const heightPx = durationMin * (slotPx / 60)
      return { ev, topPx, heightPx }
    })

  if (items.length === 0) return []

  // Sort by start position
  items.sort((a, b) => a.topPx - b.topPx)

  // Greedy column assignment: find first column whose last event has ended
  const colEnds = [] // colEnds[i] = bottomPx of last event placed in column i
  const assigned = items.map(item => {
    const col = colEnds.findIndex(end => end <= item.topPx)
    const colIndex = col === -1 ? colEnds.length : col
    colEnds[colIndex] = item.topPx + item.heightPx
    return { ...item, colIndex }
  })

  // For each event, colCount = max colIndex among all events that overlap with it + 1
  assigned.forEach((item, i) => {
    const endPx = item.topPx + item.heightPx
    let maxCol = item.colIndex
    assigned.forEach((other, j) => {
      if (i === j) return
      const oEnd = other.topPx + other.heightPx
      if (other.topPx < endPx && oEnd > item.topPx) {
        maxCol = Math.max(maxCol, other.colIndex)
      }
    })
    item.colCount = maxCol + 1
  })

  return assigned
}

// ─── Month View ──────────────────────────────────────────────

function MonthView({ date, events = [], onEventDoubleClick, onEventDragStart, onDayDrop, onCellDoubleClick }) {
  const today = new Date()
  const [dragOverDate, setDragOverDate] = useState(null)
  const days = getMonthDays(date.getFullYear(), date.getMonth())
  const weeks = []
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7))

  return (
    <div className="flex flex-col h-full">
      <div className="grid grid-cols-7 border-b border-gray-200 bg-gray-50 flex-shrink-0">
        {WEEKDAYS.map((d, i) => (
          <div key={d} className={`py-2 text-center text-xs font-semibold tracking-wide ${i === 0 ? 'text-red-500' : i === 6 ? 'text-blue-500' : 'text-gray-500'}`}>
            {d}
          </div>
        ))}
      </div>
      <div className="flex-1 grid" style={{ gridTemplateRows: `repeat(${weeks.length}, 1fr)` }}>
        {weeks.map((week, wi) => (
          <div key={wi} className="grid grid-cols-7 border-b border-gray-100 last:border-0">
            {week.map(({ date: d, isCurrentMonth }, di) => {
              const isToday = isSameDay(d, today)
              const isSun = di === 0
              const isSat = di === 6
              const dayEvents = events.filter(ev => eventOnDay(ev, d))
              const isDragOver = dragOverDate && isSameDay(dragOverDate, d)
              return (
                <div
                  key={di}
                  onDragOver={e => { e.preventDefault(); setDragOverDate(d) }}
                  onDragLeave={() => setDragOverDate(null)}
                  onDrop={e => { e.preventDefault(); setDragOverDate(null); onDayDrop?.(d) }}
                  onDoubleClick={() => { const now = new Date(); onCellDoubleClick?.(d, now.getHours(), now.getMinutes()) }}
                  className={`p-1.5 border-r border-gray-100 last:border-0 min-h-[90px] transition-colors overflow-hidden
                    ${isDragOver ? 'bg-indigo-100/70 ring-2 ring-inset ring-indigo-400' : !isCurrentMonth ? 'bg-gray-50/60 hover:bg-indigo-50/20' : 'bg-white hover:bg-indigo-50/40'}`}
                >
                  <div className={`w-7 h-7 flex items-center justify-center rounded-full text-sm font-medium mb-1
                    ${isToday
                      ? 'bg-indigo-600 text-white'
                      : !isCurrentMonth
                      ? 'text-gray-300'
                      : isSun
                      ? 'text-red-500'
                      : isSat
                      ? 'text-blue-500'
                      : 'text-gray-700'}`}>
                    {d.getDate()}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {dayEvents.slice(0, 3).map(ev => (
                      <div
                        key={ev.id}
                        draggable
                        onDragStart={e => { e.stopPropagation(); onEventDragStart?.(ev.id) }}
                        onDoubleClick={e => { e.stopPropagation(); onEventDoubleClick?.(ev) }}
                        className="text-[10px] font-medium text-white px-1.5 py-0.5 rounded truncate leading-tight cursor-grab active:cursor-grabbing hover:brightness-95"
                        style={{ backgroundColor: ev.color }}
                      >
                        {ev.allDay ? ev.title : `${dtTo24h(ev.startDt).hour.toString().padStart(2,'0')}:${String(dtTo24h(ev.startDt).minute).padStart(2,'0')} ${ev.title}`}
                      </div>
                    ))}
                    {dayEvents.length > 3 && (
                      <div className="text-[10px] text-gray-400 px-1">+{dayEvents.length - 3}개</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Week View ───────────────────────────────────────────────

function WeekView({ date, events = [], onEventDoubleClick, onEventDragStart, onWeekDrop, onCellDoubleClick }) {
  const today = new Date()
  const [dragOverDate, setDragOverDate] = useState(null)
  const weekStart = getWeekStart(date)
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart)
    d.setDate(weekStart.getDate() + i)
    return d
  })
  const currentH = today.getHours()
  const currentM = today.getMinutes()
  const totalGridPx = 24 * WEEK_SLOT_PX
  const grabOffsetRef = useRef(0)
  const gridRef = useRef(null)

  function calcDropTime(clientY) {
    const rect = gridRef.current?.getBoundingClientRect()
    if (!rect) return { hour: 0, minute: 0 }
    const rawY = clientY - rect.top - grabOffsetRef.current
    const rawMin = rawY / (WEEK_SLOT_PX / 60)
    const snapped = snapMin(rawMin)
    return { hour: Math.floor(snapped / 60), minute: snapped % 60 }
  }

  function calcClickTime(clientY) {
    const rect = gridRef.current?.getBoundingClientRect()
    if (!rect) return { hour: 0, minute: 0 }
    const rawMin = (clientY - rect.top) / (WEEK_SLOT_PX / 60)
    const snapped = snapMin(rawMin)
    return { hour: Math.floor(snapped / 60), minute: snapped % 60 }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Day headers */}
      <div className="grid border-b border-gray-200 bg-gray-50 flex-shrink-0" style={{ gridTemplateColumns: '56px repeat(7, 1fr)' }}>
        <div />
        {days.map((d, i) => {
          const isToday = isSameDay(d, today)
          return (
            <div key={i} className="py-2 text-center">
              <div className={`text-xs font-medium ${i === 0 ? 'text-red-500' : i === 6 ? 'text-blue-500' : 'text-gray-500'}`}>
                {WEEKDAYS[i]}
              </div>
              <div className={`w-8 h-8 mx-auto mt-0.5 flex items-center justify-center rounded-full text-sm font-semibold
                ${isToday ? 'bg-indigo-600 text-white' : 'text-gray-700'}`}>
                {d.getDate()}
              </div>
            </div>
          )
        })}
      </div>

      {/* 하루종일 이벤트 행 */}
      <div className="grid border-b border-gray-200 bg-white flex-shrink-0 min-h-[32px]"
        style={{ gridTemplateColumns: '56px repeat(7, 1fr)' }}>
        <div className="pr-2 text-right text-[10px] text-gray-400 leading-8 select-none flex-shrink-0">하루종일</div>
        {days.map((d, i) => {
          const dayAllDayEvents = events.filter(ev => ev.allDay && eventOnDay(ev, d))
          const isTodayCol = isSameDay(d, today)
          return (
            <div key={i} className={`border-l border-gray-100 px-0.5 py-0.5 min-h-[32px] ${isTodayCol ? 'bg-indigo-50/20' : ''}`}>
              {dayAllDayEvents.map(ev => (
                <div key={ev.id}
                  draggable
                  onDragStart={e => { e.stopPropagation(); onEventDragStart?.(ev.id) }}
                  onDoubleClick={e => { e.stopPropagation(); onEventDoubleClick?.(ev) }}
                  className="text-[10px] font-medium text-white px-1.5 py-0.5 rounded mb-0.5 truncate cursor-grab active:cursor-grabbing hover:brightness-95"
                  style={{ backgroundColor: ev.color }}>
                  {ev.title}
                </div>
              ))}
            </div>
          )
        })}
      </div>

      {/* Time grid */}
      <div className="time-grid-scroll flex-1 overflow-y-auto">
        <div ref={gridRef} className="time-grid-inner relative" style={{ display: 'grid', gridTemplateColumns: '56px repeat(7, 1fr)', height: totalGridPx }}>
          {/* Hour labels + horizontal lines */}
          {HOURS.map(h => (
            <div
              key={h}
              style={{
                gridColumn: '1 / -1',
                gridRow: `${h + 1}`,
                display: 'contents',
              }}
            />
          ))}

          {/* Left time labels */}
          <div className="relative" style={{ gridColumn: 1, gridRow: `1 / ${HOURS.length + 1}` }}>
            {HOURS.map(h => (
              <div
                key={h}
                className="absolute left-0 right-0 pr-2 text-right text-[11px] text-gray-400 select-none"
                style={{ top: h * WEEK_SLOT_PX, height: WEEK_SLOT_PX, paddingTop: 2 }}
              >
                {h === 0 ? '' : `${String(h).padStart(2, '0')}:00`}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {days.map((d, ci) => {
            const isTodayCol = isSameDay(d, today)
            const isDragOver = dragOverDate && isSameDay(dragOverDate, d)
            const colTimed = timedEventsForDay(events, d, WEEK_SLOT_PX)
            return (
              <div
                key={ci}
                onDragOver={e => { e.preventDefault(); setDragOverDate(d) }}
                onDragLeave={() => setDragOverDate(null)}
                onDrop={e => {
                  e.preventDefault()
                  setDragOverDate(null)
                  const { hour, minute } = calcDropTime(e.clientY)
                  onWeekDrop?.(d, hour, minute)
                }}
                onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOverDate(null) }}
                onDoubleClick={e => {
                  const { hour, minute } = calcClickTime(e.clientY)
                  onCellDoubleClick?.(d, hour, minute)
                }}
                className={`relative border-l border-gray-100 transition-colors
                  ${isDragOver ? 'bg-indigo-100/60 ring-2 ring-inset ring-indigo-400' : isTodayCol ? 'bg-indigo-50/20' : ''}`}
                style={{ gridColumn: ci + 2, gridRow: `1 / ${HOURS.length + 1}` }}
              >
                {/* Horizontal hour lines */}
                {HOURS.map(h => (
                  <div
                    key={h}
                    className="absolute left-0 right-0 border-b border-gray-100 hover:bg-indigo-50/40 transition-colors cursor-pointer"
                    style={{ top: h * WEEK_SLOT_PX, height: WEEK_SLOT_PX }}
                  />
                ))}

                {/* Current time indicator */}
                {isTodayCol && (
                  <div
                    className="absolute left-0 right-0 flex items-center z-10"
                    style={{ top: (currentH * 60 + currentM) * (WEEK_SLOT_PX / 60) }}
                  >
                    <div className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0 -ml-1" />
                    <div className="flex-1 h-px bg-red-400" />
                  </div>
                )}

                {/* Timed events */}
                {colTimed.map(({ ev, topPx, heightPx, colIndex, colCount }) => {
                  const widthPct = 100 / colCount
                  const leftPct = colIndex * widthPct
                  return (
                    <div
                      key={ev.id}
                      draggable
                      onDragStart={e => {
                        e.stopPropagation()
                        const rect = e.currentTarget.getBoundingClientRect()
                        grabOffsetRef.current = e.clientY - rect.top
                        onEventDragStart?.(ev.id, 'move')
                      }}
                      onDoubleClick={e => { e.stopPropagation(); onEventDoubleClick?.(ev) }}
                      className="absolute rounded overflow-hidden z-20 px-1 font-medium leading-tight cursor-grab active:cursor-grabbing hover:brightness-95"
                      style={{
                        top: topPx,
                        height: heightPx,
                        left: `calc(${leftPct}% + 1px)`,
                        width: `calc(${widthPct}% - 2px)`,
                        backgroundColor: hexToRgba(ev.color, 0.5),
                        borderLeft: `3px solid ${ev.color}`,
                        color: '#1e1b4b',
                        fontSize: 10,
                      }}
                    >
                      {/* Top resize handle */}
                      {heightPx >= 20 && (
                        <div
                          draggable
                          onDragStart={e => { e.stopPropagation(); grabOffsetRef.current = 0; onEventDragStart?.(ev.id, 'resize-start') }}
                          className="absolute top-0 left-0 right-0 h-2 cursor-n-resize z-30 hover:bg-white/30"
                        />
                      )}
                      <div className="truncate pt-1.5 px-1">{ev.title}</div>
                      {heightPx >= 28 && (
                        <div className="px-1 opacity-70 truncate" style={{ fontSize: 9 }}>
                          {String(dtTo24h(ev.startDt).hour).padStart(2,'0')}:{String(dtTo24h(ev.startDt).minute).padStart(2,'0')}
                          {' – '}
                          {String(dtTo24h(ev.endDt).hour).padStart(2,'0')}:{String(dtTo24h(ev.endDt).minute).padStart(2,'0')}
                        </div>
                      )}
                      {/* Bottom resize handle */}
                      {heightPx >= 20 && (
                        <div
                          draggable
                          onDragStart={e => { e.stopPropagation(); grabOffsetRef.current = 0; onEventDragStart?.(ev.id, 'resize-end') }}
                          className="absolute bottom-0 left-0 right-0 h-2 cursor-s-resize z-30 hover:bg-white/30"
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─── Day View ────────────────────────────────────────────────

function DayView({ date, events = [], onEventDoubleClick, onEventDragStart, onTimeDrop, onCellDoubleClick }) {
  const today = new Date()
  const isToday = isSameDay(date, today)
  const currentH = today.getHours()
  const currentM = today.getMinutes()
  const totalGridPx = 24 * DAY_SLOT_PX
  const timedEvents = timedEventsForDay(events, date, DAY_SLOT_PX)
  const grabOffsetRef = useRef(0)
  const gridRef = useRef(null)

  function handleTimedDragStart(e, evId, mode = 'move') {
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    grabOffsetRef.current = e.clientY - rect.top
    onEventDragStart?.(evId, mode)
  }

  function handleGridDrop(e) {
    e.preventDefault()
    if (!gridRef.current) return
    const rect = gridRef.current.getBoundingClientRect()
    const rawY = e.clientY - rect.top - grabOffsetRef.current
    const rawMin = rawY / (DAY_SLOT_PX / 60)
    const snappedMin = Math.max(0, Math.min(23 * 60, Math.round(rawMin / 5) * 5))
    onTimeDrop?.(Math.floor(snappedMin / 60), snappedMin % 60)
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-200 bg-gray-50 flex-shrink-0">
        <div className={`w-11 h-11 flex items-center justify-center rounded-xl text-lg font-bold
          ${isToday ? 'bg-indigo-600 text-white' : 'bg-gray-200 text-gray-700'}`}>
          {date.getDate()}
        </div>
        <div>
          <div className="text-sm font-semibold text-gray-900">{WEEKDAYS[date.getDay()]}요일</div>
          <div className="text-xs text-gray-500">{date.getFullYear()}년 {MONTHS[date.getMonth()]}</div>
        </div>
        {isToday && <span className="ml-1 text-xs bg-indigo-100 text-indigo-700 font-semibold px-2 py-0.5 rounded-full">오늘</span>}
      </div>

      {/* 하루종일 이벤트 행 */}
      {(() => {
        const dayAllDayEvents = events.filter(ev => ev.allDay && eventOnDay(ev, date))
        return (
          <div className="flex border-b border-gray-200 bg-white flex-shrink-0 min-h-[32px] items-start">
            <div className="w-14 pr-3 text-right text-[10px] text-gray-400 leading-8 flex-shrink-0 select-none">하루종일</div>
            <div className="flex-1 px-1 py-1 flex flex-wrap gap-1">
              {dayAllDayEvents.length === 0 && (
                <span className="text-[11px] text-gray-300 leading-6">일정 없음</span>
              )}
              {dayAllDayEvents.map(ev => (
                <div key={ev.id}
                  draggable
                  onDragStart={e => { e.stopPropagation(); onEventDragStart?.(ev.id) }}
                  onDoubleClick={e => { e.stopPropagation(); onEventDoubleClick?.(ev) }}
                  className="text-[11px] font-medium text-white px-2 py-0.5 rounded truncate max-w-xs cursor-grab active:cursor-grabbing hover:brightness-95"
                  style={{ backgroundColor: ev.color }}>
                  {ev.title}
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {/* Time grid */}
      <div className="time-grid-scroll flex-1 overflow-y-auto">
        <div className="time-grid-inner relative flex" style={{ height: totalGridPx }}>
          {/* Hour labels */}
          <div className="flex-shrink-0 w-14 relative">
            {HOURS.map(h => (
              <div
                key={h}
                className="absolute left-0 right-0 pr-3 text-right text-[11px] text-gray-400 select-none"
                style={{ top: h * DAY_SLOT_PX, height: DAY_SLOT_PX, paddingTop: 4 }}
              >
                {h === 0 ? '' : `${String(h).padStart(2, '0')}:00`}
              </div>
            ))}
          </div>

          {/* Day content column */}
          <div
            ref={gridRef}
            className="flex-1 relative border-l border-gray-100"
            onDragOver={e => e.preventDefault()}
            onDrop={handleGridDrop}
            onDoubleClick={e => {
              const rect = gridRef.current?.getBoundingClientRect()
              if (!rect) return
              const rawMin = (e.clientY - rect.top) / (DAY_SLOT_PX / 60)
              const snapped = snapMin(rawMin)
              onCellDoubleClick?.(date, Math.floor(snapped / 60), snapped % 60)
            }}
          >
            {/* Horizontal hour lines */}
            {HOURS.map(h => (
              <div
                key={h}
                className="absolute left-0 right-0 border-b border-gray-100 hover:bg-indigo-50/30 transition-colors cursor-pointer"
                style={{ top: h * DAY_SLOT_PX, height: DAY_SLOT_PX }}
              />
            ))}

            {/* Current time indicator */}
            {isToday && (
              <div
                className="absolute left-0 right-0 flex items-center z-10"
                style={{ top: (currentH * 60 + currentM) * (DAY_SLOT_PX / 60) }}
              >
                <div className="w-2.5 h-2.5 rounded-full bg-red-500 flex-shrink-0 -ml-1.5" />
                <div className="flex-1 h-px bg-red-400" />
              </div>
            )}

            {/* Timed events */}
            {timedEvents.map(({ ev, topPx, heightPx, colIndex, colCount }) => {
              const widthPct = 100 / colCount
              const leftPct = colIndex * widthPct
              return (
                <div
                  key={ev.id}
                  draggable
                  onDragStart={e => handleTimedDragStart(e, ev.id, 'move')}
                  onDoubleClick={e => { e.stopPropagation(); onEventDoubleClick?.(ev) }}
                  className="absolute rounded overflow-hidden z-20 font-medium leading-tight cursor-grab active:cursor-grabbing hover:brightness-95"
                  style={{
                    top: topPx,
                    height: heightPx,
                    left: `calc(${leftPct}% + 2px)`,
                    width: `calc(${widthPct}% - 4px)`,
                    backgroundColor: hexToRgba(ev.color, 0.5),
                    borderLeft: `4px solid ${ev.color}`,
                    color: '#1e1b4b',
                    fontSize: 13,
                  }}
                >
                  {/* Top resize handle */}
                  {heightPx >= 24 && (
                    <div
                      draggable
                      onDragStart={e => { e.stopPropagation(); grabOffsetRef.current = 0; onEventDragStart?.(ev.id, 'resize-start') }}
                      className="absolute top-0 left-0 right-0 h-2.5 cursor-n-resize z-30 hover:bg-white/30"
                    />
                  )}
                  <div className="font-semibold truncate px-2 pt-2">{ev.title}</div>
                  {heightPx >= 44 && (
                    <div className="text-xs opacity-70 mt-0.5 px-2">
                      {String(dtTo24h(ev.startDt).hour).padStart(2,'0')}:{String(dtTo24h(ev.startDt).minute).padStart(2,'0')}
                      {' – '}
                      {String(dtTo24h(ev.endDt).hour).padStart(2,'0')}:{String(dtTo24h(ev.endDt).minute).padStart(2,'0')}
                    </div>
                  )}
                  {/* Bottom resize handle */}
                  {heightPx >= 24 && (
                    <div
                      draggable
                      onDragStart={e => { e.stopPropagation(); grabOffsetRef.current = 0; onEventDragStart?.(ev.id, 'resize-end') }}
                      className="absolute bottom-0 left-0 right-0 h-2.5 cursor-s-resize z-30 hover:bg-white/30"
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Year View ───────────────────────────────────────────────

function MiniMonth({ year, month, today, events = [], onClick, onDayDoubleClick }) {
  const days = getMonthDays(year, month)
  const weeks = []
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7))

  return (
    <div
      onClick={onClick}
      className="bg-white rounded-xl border border-gray-200 p-3 cursor-pointer hover:shadow-md hover:border-indigo-300 transition-all"
    >
      <div className="text-sm font-bold text-gray-700 mb-2 text-center">{MONTHS[month]}</div>
      <div className="grid grid-cols-7">
        {WEEKDAYS.map((d, i) => (
          <div key={d} className={`text-center text-[9px] font-semibold pb-1 ${i === 0 ? 'text-red-400' : i === 6 ? 'text-blue-400' : 'text-gray-400'}`}>
            {d}
          </div>
        ))}
        {days.map(({ date: d, isCurrentMonth }, idx) => {
          const isToday = isSameDay(d, today)
          const col = idx % 7
          const count = events.filter(ev => eventOnDay(ev, d)).length
          // 투명도: 1→80%투명(0.2), 2→60%(0.4), 3→40%(0.6), 4→20%(0.8), 5+→0%(1.0)
          const alphaMap = [0, 0.2, 0.4, 0.6, 0.8, 1.0]
          const opacity = count > 0 ? alphaMap[Math.min(count, 5)] : 0
          const firstColor = count > 0 ? events.find(ev => eventOnDay(ev, d))?.color : null

          return (
            <div
              key={idx}
              onDoubleClick={e => { e.stopPropagation(); onDayDoubleClick?.(d) }}
              className={`text-center text-[10px] py-0.5 mx-0.5 rounded-full leading-4 relative cursor-pointer
                ${isToday ? 'bg-indigo-600 text-white font-bold' :
                  !isCurrentMonth ? 'text-gray-200' :
                  col === 0 ? 'text-red-400' :
                  col === 6 ? 'text-blue-400' :
                  'text-gray-600'}`}
              style={
                !isToday && count > 0 && firstColor
                  ? { backgroundColor: hexToRgba(firstColor, opacity) }
                  : {}
              }
            >
              {d.getDate()}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function YearView({ date, events = [], onMonthClick, onCellDoubleClick }) {
  const today = new Date()
  const year = date.getFullYear()
  return (
    <div className="p-6 overflow-y-auto h-full">
      <div className="grid grid-cols-4 gap-4">
        {Array.from({ length: 12 }, (_, i) => (
          <MiniMonth
            key={i}
            year={year}
            month={i}
            today={today}
            events={events}
            onClick={() => onMonthClick(new Date(year, i, 1))}
            onDayDoubleClick={d => { const now = new Date(); onCellDoubleClick?.(d, now.getHours(), now.getMinutes()) }}
          />
        ))}
      </div>
    </div>
  )
}

// ─── Main CalendarView ────────────────────────────────────────

export default function CalendarView({ onClose }) {
  const [viewType, setViewType] = useState('month')
  const [currentDate, setCurrentDate] = useState(new Date())
  const [showEventModal, setShowEventModal] = useState(false)
  const [editingEvent, setEditingEvent] = useState(null)
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [presetDts, setPresetDts] = useState(null) // { startDt, endDt }
  // { id, mode: 'move' | 'resize-start' | 'resize-end' }
  const draggingRef = useRef(null)

  // 캘린더 열릴 때 이벤트 로드
  useEffect(() => {
    apiFetch('/events')
      .then(data => setEvents(data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // 인쇄 시 일/주 단위 시간 그리드 전체가 페이지에 맞도록 스케일 조정
  useEffect(() => {
    const handleBeforePrint = () => {
      if (viewType !== 'day' && viewType !== 'week') return
      const area = document.getElementById('calendar-print-area')
      const scroll = area?.querySelector('.time-grid-scroll')
      const inner = area?.querySelector('.time-grid-inner')
      if (!area || !scroll || !inner) return
      const availH = area.clientHeight - scroll.offsetTop
      const innerH = inner.scrollHeight
      if (innerH <= 0) return
      const scale = Math.min(1, availH / innerH)
      inner.style.transform = `scale(${scale})`
      inner.style.transformOrigin = 'top left'
      scroll.style.height = `${innerH * scale}px`
    }
    const handleAfterPrint = () => {
      const area = document.getElementById('calendar-print-area')
      const scroll = area?.querySelector('.time-grid-scroll')
      const inner = area?.querySelector('.time-grid-inner')
      if (inner) { inner.style.transform = ''; inner.style.transformOrigin = '' }
      if (scroll) { scroll.style.height = '' }
    }
    window.addEventListener('beforeprint', handleBeforePrint)
    window.addEventListener('afterprint', handleAfterPrint)
    return () => {
      window.removeEventListener('beforeprint', handleBeforePrint)
      window.removeEventListener('afterprint', handleAfterPrint)
    }
  }, [viewType])

  function handleEventDoubleClick(ev) {
    setEditingEvent(ev)
    setPresetDts(null)
    setShowEventModal(true)
  }

  // Double-click on empty calendar cell → open add modal with pre-filled date/time
  function handleCellDoubleClick(date, hour24, minute = 0) {
    const startDt = makeDt(date, hour24, minute)
    const endDt = makeDt(date, Math.min(hour24 + 1, 23), minute)
    setPresetDts({ startDt, endDt })
    setEditingEvent(null)
    setShowEventModal(true)
  }

  function handleEventDragStart(evId, mode = 'move') {
    draggingRef.current = { id: evId, mode }
  }

  // Month view: date-only change (no time)
  function handleDayDrop(newDate) {
    const drag = draggingRef.current
    if (!drag) return
    draggingRef.current = null
    setEvents(prev => {
      const next = prev.map(ev => {
        if (ev.id !== drag.id) return ev
        const startDate = new Date(ev.startDt.year, ev.startDt.month - 1, ev.startDt.day)
        const diffDays = Math.round((newDate - startDate) / 86400000)
        if (diffDays === 0) return ev
        return { ...ev, startDt: addDaysTodt(ev.startDt, diffDays), endDt: addDaysTodt(ev.endDt, diffDays) }
      })
      const updated = next.find(ev => ev.id === drag.id)
      if (updated) apiFetch(`/events/${updated.id}`, { method: 'PUT', body: JSON.stringify(updated) }).catch(() => {})
      return next
    })
  }

  // Day/Week time grid drop: handles move / resize-start / resize-end
  // newDate = null means keep current date (day view), Date = move to that date (week view)
  function handleTimeGridDrop(newDate, newHour, newMinute) {
    const drag = draggingRef.current
    if (!drag) return
    draggingRef.current = null
    const dropMin = snapMin(newHour * 60 + newMinute)

    setEvents(prev => {
      const next = prev.map(ev => {
        if (ev.id !== drag.id) return ev
        const s = dtTo24h(ev.startDt)
        const e2 = dtTo24h(ev.endDt)
        const startMin = s.hour * 60 + s.minute
        const endMin = e2.hour * 60 + e2.minute
        const duration = Math.max(endMin - startMin, 30)

        if (drag.mode === 'resize-start') {
          const newStart = Math.min(dropMin, endMin - 15)
          return { ...ev, startDt: { ...ev.startDt, ...to12h(newStart) } }
        }
        if (drag.mode === 'resize-end') {
          const newEnd = Math.max(dropMin, startMin + 15)
          return { ...ev, endDt: { ...ev.endDt, ...to12h(newEnd) } }
        }

        // mode === 'move'
        const newStartMin = Math.max(0, Math.min(23 * 60, dropMin))
        const newEndMin = Math.min(newStartMin + duration, 24 * 60 - 1)
        let newStartDt = { ...ev.startDt, ...to12h(newStartMin) }
        let newEndDt = { ...ev.endDt, ...to12h(newEndMin) }
        if (newDate) {
          const startDate = new Date(ev.startDt.year, ev.startDt.month - 1, ev.startDt.day)
          const diffDays = Math.round((newDate - startDate) / 86400000)
          if (diffDays !== 0) {
            newStartDt = addDaysTodt(newStartDt, diffDays)
            newEndDt = addDaysTodt(newEndDt, diffDays)
          }
        }
        return { ...ev, startDt: newStartDt, endDt: newEndDt }
      })
      const updated = next.find(ev => ev.id === drag.id)
      if (updated) apiFetch(`/events/${updated.id}`, { method: 'PUT', body: JSON.stringify(updated) }).catch(() => {})
      return next
    })
  }

  function navigate(delta) {
    const d = new Date(currentDate)
    if (viewType === 'day') d.setDate(d.getDate() + delta)
    else if (viewType === 'week') d.setDate(d.getDate() + delta * 7)
    else if (viewType === 'month') d.setMonth(d.getMonth() + delta)
    else if (viewType === 'year') d.setFullYear(d.getFullYear() + delta)
    setCurrentDate(d)
  }

  function getTitle() {
    const y = currentDate.getFullYear()
    const m = currentDate.getMonth()
    const day = currentDate.getDate()
    if (viewType === 'year') return `${y}년`
    if (viewType === 'month') return `${y}년 ${MONTHS[m]}`
    if (viewType === 'week') {
      const start = getWeekStart(currentDate)
      const end = new Date(start)
      end.setDate(start.getDate() + 6)
      if (start.getMonth() === end.getMonth())
        return `${start.getFullYear()}년 ${MONTHS[start.getMonth()]} ${start.getDate()}일 – ${end.getDate()}일`
      return `${MONTHS[start.getMonth()]} ${start.getDate()}일 – ${MONTHS[end.getMonth()]} ${end.getDate()}일`
    }
    return `${y}년 ${MONTHS[m]} ${day}일 ${WEEKDAYS[currentDate.getDay()]}요일`
  }

  return (
    <div id="calendar-print-area" className="flex-1 flex flex-col min-h-0 bg-white overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 bg-white flex-shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCurrentDate(new Date())}
            className="no-print px-3 py-1.5 text-sm font-medium border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
          >
            오늘
          </button>
          <div className="no-print flex items-center">
            <button
              onClick={() => navigate(-1)}
              className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <button
              onClick={() => navigate(1)}
              className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
          <h2 className="text-base font-bold text-gray-900 ml-1">{getTitle()}</h2>
        </div>

        <div className="flex items-center gap-2">
          {/* 이벤트 추가 버튼 (뷰 선택 왼쪽) */}
          <button
            onClick={() => { setPresetDts(null); setEditingEvent(null); setShowEventModal(true) }}
            className="no-print flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            이벤트 추가
          </button>

          {/* View switcher */}
          <div className="no-print flex rounded-lg border border-gray-200 overflow-hidden text-sm">
            {[['day', '일'], ['week', '주'], ['month', '월'], ['year', '연']].map(([k, label]) => (
              <button
                key={k}
                onClick={() => setViewType(k)}
                className={`px-3.5 py-1.5 font-medium transition-colors ${viewType === k ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* 닫기 버튼 (뷰 선택 오른쪽) */}
          <button
            onClick={onClose}
            className="no-print w-8 h-8 flex items-center justify-center rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
            title="캘린더 닫기"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          {/* 인쇄 버튼 */}
          <button
            onClick={() => window.print()}
            className="no-print w-8 h-8 flex items-center justify-center rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
            title="PDF로 인쇄"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Calendar body */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70 z-50">
            <div className="w-6 h-6 border-2 border-indigo-200 border-t-indigo-500 rounded-full animate-spin" />
          </div>
        )}
        {viewType === 'month' && <MonthView date={currentDate} events={events} onEventDoubleClick={handleEventDoubleClick} onEventDragStart={handleEventDragStart} onDayDrop={handleDayDrop} onCellDoubleClick={handleCellDoubleClick} />}
        {viewType === 'week' && <WeekView date={currentDate} events={events} onEventDoubleClick={handleEventDoubleClick} onEventDragStart={handleEventDragStart} onWeekDrop={(date, h, m) => handleTimeGridDrop(date, h, m)} onCellDoubleClick={handleCellDoubleClick} />}
        {viewType === 'day' && <DayView date={currentDate} events={events} onEventDoubleClick={handleEventDoubleClick} onEventDragStart={handleEventDragStart} onTimeDrop={(h, m) => handleTimeGridDrop(null, h, m)} onCellDoubleClick={handleCellDoubleClick} />}
        {viewType === 'year' && (
          <YearView
            date={currentDate}
            events={events}
            onMonthClick={(d) => { setCurrentDate(d); setViewType('month') }}
            onCellDoubleClick={handleCellDoubleClick}
          />
        )}
      </div>

      {showEventModal && (
        <EventAddModal
          event={editingEvent}
          initialStartDt={presetDts?.startDt}
          initialEndDt={presetDts?.endDt}
          onClose={() => { setShowEventModal(false); setEditingEvent(null); setPresetDts(null) }}
          onAdd={async (data) => {
            try {
              const created = await apiFetch('/events', {
                method: 'POST',
                body: JSON.stringify(data),
              })
              // 반복 이벤트는 배열, 단일은 객체로 반환
              const newEvents = Array.isArray(created) ? created : [created]
              setEvents(prev => [...prev, ...newEvents])
            } catch (e) {
              alert('이벤트 저장 실패: ' + e.message)
            }
            setShowEventModal(false)
          }}
          onSave={async (updated) => {
            try {
              const saved = await apiFetch(`/events/${updated.id}`, {
                method: 'PUT',
                body: JSON.stringify(updated),
              })
              setEvents(prev => prev.map(ev => ev.id === saved.id ? saved : ev))
            } catch (e) {
              alert('이벤트 수정 실패: ' + e.message)
            }
            setShowEventModal(false)
            setEditingEvent(null)
          }}
          onDelete={async (id, mode, seriesId) => {
            try {
              if (mode === 'all' && seriesId) {
                await apiFetch(`/events/series/${seriesId}`, { method: 'DELETE' })
                setEvents(prev => prev.filter(ev => ev.seriesId !== seriesId))
              } else {
                await apiFetch(`/events/${id}`, { method: 'DELETE' })
                setEvents(prev => prev.filter(ev => ev.id !== id))
              }
            } catch (e) {
              alert('이벤트 삭제 실패: ' + e.message)
            }
          }}
        />
      )}
    </div>
  )
}
