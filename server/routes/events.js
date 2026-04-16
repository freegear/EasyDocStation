const express = require('express')
const { randomUUID } = require('crypto')
const db = require('../db')
const { trainEventsImmediate, retrainEventImmediate, deleteEventFromRAG } = require('../rag')
const requireAuth = require('../middleware/auth')

const router = express.Router()
router.use(requireAuth)

// dt 객체 → JS Date
function dtToDate(dt) {
  let h = (dt.hour % 12)
  if (dt.ampm === '오후') h += 12
  return new Date(dt.year, dt.month - 1, dt.day, h, dt.minute || 0, 0, 0)
}

// JS Date → dt 객체 (allDay이면 시간 무시)
function dateToDt(date, allDay, baseDt) {
  const h = date.getHours()
  if (allDay) {
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
             ampm: baseDt?.ampm || '오전', hour: baseDt?.hour || 12, minute: baseDt?.minute || 0 }
  }
  return {
    year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
    ampm: h < 12 ? '오전' : '오후',
    hour: h === 0 ? 12 : h > 12 ? h - 12 : h,
    minute: date.getMinutes(),
  }
}

// 반복 옵션에 따라 (startDt, endDt) 쌍 배열 생성
function generateOccurrences(startDt, endDt, repeat, allDay) {
  const startDate = dtToDate(startDt)
  const endDate   = dtToDate(endDt)
  const durationMs = endDate - startDate
  const maxCount = repeat === 'daily' ? 365 : repeat === 'weekly' ? 52 : repeat === 'yearly' ? 10 : 12
  const occurrences = []
  let current = new Date(startDate)
  for (let i = 0; i < maxCount; i++) {
    const occEnd = new Date(current.getTime() + durationMs)
    occurrences.push({
      startDt: dateToDt(current, allDay, startDt),
      endDt:   dateToDt(occEnd,  allDay, endDt),
    })
    if (repeat === 'daily')        current.setDate(current.getDate() + 1)
    else if (repeat === 'weekly')  current.setDate(current.getDate() + 7)
    else if (repeat === 'monthly') current.setMonth(current.getMonth() + 1)
    else if (repeat === 'yearly')  current.setFullYear(current.getFullYear() + 1)
  }
  return occurrences
}

function parseDt(val) {
  if (!val) return {}
  return typeof val === 'string' ? JSON.parse(val) : val
}

function toClient(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title || '',
    color: row.color || '#4f46e5',
    allDay: row.all_day,
    startDt: parseDt(row.start_dt),
    endDt: parseDt(row.end_dt),
    repeat: row.repeat || 'none',
    invitees: parseDt(row.invitees) || [],
    memo: row.memo || '',
    securityLevel: row.security_level || 0,
    remindDt: parseDt(row.remind_dt) || {},
    remindRepeat: row.remind_repeat || 'none',
    seriesId: row.series_id || null,
  }
}

// GET /api/events — 내 이벤트 + 내가 초대된 이벤트
router.get('/', async (req, res) => {
  const userId = req.user.id
  try {
    const { rows: myRows } = await db.query(
      'SELECT * FROM calendar_events WHERE owner_id = $1 ORDER BY created_at ASC',
      [userId]
    )

    const { rows: invitedRows } = await db.query(`
      SELECT ce.* FROM calendar_invitations ci
      JOIN calendar_events ce ON ce.id = ci.event_id
      WHERE ci.invitee_id = $1 AND ce.owner_id != $1
    `, [userId])

    const myIds = new Set(myRows.map(r => r.id))
    const filtered = invitedRows.filter(r => !myIds.has(r.id))

    res.json([...myRows, ...filtered].map(toClient))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// PUT /api/events/series/:seriesId — 반복 이벤트 전체 수정 (본인만, 날짜 오프셋 유지)
// ※ /:id 보다 먼저 등록해야 Express가 /series/xxx를 올바르게 라우팅함
router.put('/series/:seriesId', async (req, res) => {
  const userId = req.user.id
  const { seriesId } = req.params
  const { title, color, allDay, startDt, endDt, repeat, invitees, memo, securityLevel, remindDt, remindRepeat } = req.body
  try {
    const { rows: seriesRows } = await db.query(
      'SELECT * FROM calendar_events WHERE owner_id = $1 AND series_id = $2 ORDER BY created_at ASC',
      [userId, seriesId]
    )
    if (seriesRows.length === 0) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' })

    const baseOld = dtToDate(parseDt(seriesRows[0].start_dt))
    const baseNew = dtToDate(startDt)
    const duration = dtToDate(endDt) - dtToDate(startDt)
    const shift = baseNew - baseOld
    const now = new Date()
    const updated = []

    for (const row of seriesRows) {
      const oldStart = dtToDate(parseDt(row.start_dt))
      const newStart = new Date(oldStart.getTime() + shift)
      const newEnd   = new Date(newStart.getTime() + duration)
      const newStartDt = dateToDt(newStart, allDay || false, startDt)
      const newEndDt   = dateToDt(newEnd,   allDay || false, endDt)

      await db.query(`
        UPDATE calendar_events SET
          title=$1, color=$2, all_day=$3, start_dt=$4, end_dt=$5, repeat=$6,
          invitees=$7, memo=$8, security_level=$9, remind_dt=$10, remind_repeat=$11, updated_at=$12
        WHERE owner_id=$13 AND id=$14
      `, [
        title || '', color || '#4f46e5', allDay || false,
        JSON.stringify(newStartDt), JSON.stringify(newEndDt), repeat || 'none',
        JSON.stringify(invitees || []), memo || '', securityLevel || 0,
        JSON.stringify(remindDt || {}), remindRepeat || 'none',
        now, userId, row.id,
      ])
      updated.push(toClient({
        ...row, title, color, all_day: allDay,
        start_dt: newStartDt, end_dt: newEndDt, repeat,
        invitees: invitees || [], memo, security_level: securityLevel,
        remind_dt: remindDt || {}, remind_repeat: remindRepeat, series_id: seriesId,
      }))
    }
    res.json(updated)

    for (const ev of updated) {
      retrainEventImmediate(ev.id, ev).catch(() => {})
    }
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// DELETE /api/events/series/:seriesId — 반복 이벤트 전체 삭제 (본인만)
router.delete('/series/:seriesId', async (req, res) => {
  const userId = req.user.id
  const { seriesId } = req.params
  try {
    const { rows } = await db.query(
      'SELECT id FROM calendar_events WHERE owner_id = $1 AND series_id = $2',
      [userId, seriesId]
    )
    if (rows.length === 0) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' })

    const deletedIds = rows.map(r => r.id)
    await db.query(
      'DELETE FROM calendar_events WHERE owner_id = $1 AND series_id = $2',
      [userId, seriesId]
    )
    res.json({ success: true, deleted: deletedIds.length })

    for (const id of deletedIds) {
      deleteEventFromRAG(id).catch(() => {})
    }
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// POST /api/events — 이벤트 생성 (반복이면 다중 row 배치 삽입)
router.post('/', async (req, res) => {
  const userId = req.user.id
  const { title, color, allDay, startDt, endDt, repeat, invitees, memo, securityLevel, remindDt, remindRepeat } = req.body
  const isRepeat = repeat && repeat !== 'none'
  const seriesId = isRepeat ? randomUUID() : null

  try {
    const occurrences = isRepeat
      ? generateOccurrences(startDt, endDt, repeat, allDay || false)
      : [{ startDt, endDt }]

    const now = new Date()
    const eventIds = occurrences.map(() => randomUUID())

    // ── 배치 INSERT: 모든 occurrence를 한 번의 쿼리로 삽입 ──────
    const cols = 16
    const valueClauses = occurrences.map((_, i) =>
      `($${i*cols+1},$${i*cols+2},$${i*cols+3},$${i*cols+4},$${i*cols+5},$${i*cols+6},$${i*cols+7},$${i*cols+8},$${i*cols+9},$${i*cols+10},$${i*cols+11},$${i*cols+12},$${i*cols+13},$${i*cols+14},$${i*cols+15},$${i*cols+16})`
    ).join(',')
    const params = occurrences.flatMap((occ, i) => [
      eventIds[i], userId, title || '', color || '#4f46e5', allDay || false,
      JSON.stringify(occ.startDt || {}), JSON.stringify(occ.endDt || {}),
      repeat || 'none', JSON.stringify(invitees || []), memo || '',
      securityLevel || 0, JSON.stringify(remindDt || {}), remindRepeat || 'none',
      seriesId, now, now,
    ])
    const { rows } = await db.query(`
      INSERT INTO calendar_events
        (id, owner_id, title, color, all_day, start_dt, end_dt, repeat, invitees, memo,
         security_level, remind_dt, remind_repeat, series_id, created_at, updated_at)
      VALUES ${valueClauses}
      RETURNING *
    `, params)

    const created = rows.map(toClient)

    // ── 초대 테이블 기록 (invitees가 있을 때만) ─────────────────
    const invList = invitees || []
    if (invList.length > 0) {
      for (let i = 0; i < eventIds.length; i++) {
        for (const inv of invList) {
          if (inv.id && inv.id !== userId) {
            await db.query(
              'INSERT INTO calendar_invitations (invitee_id, event_id, owner_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
              [inv.id, eventIds[i], userId]
            )
          }
        }
      }
    }

    res.status(201).json(created)

    // ── RAG 학습: 모든 이벤트를 python 1번으로 처리 ────────────
    trainEventsImmediate(created).catch(() => {})
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// PUT /api/events/:id — 이벤트 수정 (본인만, 단일 row)
router.put('/:id', async (req, res) => {
  const userId = req.user.id
  const evId = req.params.id
  const { title, color, allDay, startDt, endDt, repeat, invitees, memo, securityLevel, remindDt, remindRepeat } = req.body
  try {
    const { rows } = await db.query(
      'SELECT * FROM calendar_events WHERE owner_id = $1 AND id = $2',
      [userId, evId]
    )
    if (!rows[0]) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' })

    const now = new Date()
    const { rows: updated } = await db.query(`
      UPDATE calendar_events SET
        title=$1, color=$2, all_day=$3, start_dt=$4, end_dt=$5, repeat=$6,
        invitees=$7, memo=$8, security_level=$9, remind_dt=$10, remind_repeat=$11, updated_at=$12
      WHERE owner_id=$13 AND id=$14
      RETURNING *
    `, [
      title || '', color || '#4f46e5', allDay || false,
      JSON.stringify(startDt || {}), JSON.stringify(endDt || {}), repeat || 'none',
      JSON.stringify(invitees || []), memo || '', securityLevel || 0,
      JSON.stringify(remindDt || {}), remindRepeat || 'none',
      now, userId, evId,
    ])
    const updatedEvent = toClient(updated[0])
    res.json(updatedEvent)

    retrainEventImmediate(evId, updatedEvent).catch(() => {})
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// DELETE /api/events/:id — 이벤트 삭제 (본인만)
router.delete('/:id', async (req, res) => {
  const userId = req.user.id
  const evId = req.params.id
  try {
    const { rows } = await db.query(
      'SELECT id FROM calendar_events WHERE owner_id = $1 AND id = $2',
      [userId, evId]
    )
    if (!rows[0]) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' })

    await db.query('DELETE FROM calendar_events WHERE owner_id = $1 AND id = $2', [userId, evId])
    res.json({ success: true })

    deleteEventFromRAG(evId).catch(() => {})
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

module.exports = router
