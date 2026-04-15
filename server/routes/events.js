const express = require('express')
const { randomUUID } = require('crypto')
const pool = require('../db')
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

// GET /api/events — 내 이벤트 + 내가 초대된 이벤트
router.get('/', async (req, res) => {
  const userId = req.user.id
  try {
    const { rows } = await pool.query(
      `SELECT * FROM calendar_events
       WHERE owner_id = $1
          OR invitees @> $2::jsonb
       ORDER BY start_dt->>'year', start_dt->>'month', start_dt->>'day',
                start_dt->>'hour', start_dt->>'minute'`,
      [userId, JSON.stringify([{ id: userId }])]
    )
    res.json(rows.map(toClient))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// POST /api/events — 이벤트 생성 (반복이면 다중 row 삽입)
router.post('/', async (req, res) => {
  const userId = req.user.id
  const { title, color, allDay, startDt, endDt, repeat, invitees, memo, securityLevel, remindDt, remindRepeat } = req.body
  const isRepeat = repeat && repeat !== 'none'
  const seriesId = isRepeat ? randomUUID() : null

  try {
    const occurrences = isRepeat
      ? generateOccurrences(startDt, endDt, repeat, allDay || false)
      : [{ startDt, endDt }]

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const created = []
      for (const occ of occurrences) {
        const { rows } = await client.query(
          `INSERT INTO calendar_events
             (owner_id, title, color, all_day, start_dt, end_dt, repeat, invitees, memo, security_level, remind_dt, remind_repeat, series_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING *`,
          [
            userId,
            title || '',
            color || '#4f46e5',
            allDay || false,
            JSON.stringify(occ.startDt || {}),
            JSON.stringify(occ.endDt   || {}),
            repeat || 'none',
            JSON.stringify(invitees || []),
            memo || '',
            securityLevel || 0,
            JSON.stringify(remindDt || {}),
            remindRepeat || 'none',
            seriesId,
          ]
        )
        created.push(toClient(rows[0]))
      }
      await client.query('COMMIT')
      res.status(201).json(created)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// PUT /api/events/:id — 이벤트 수정 (본인만, 단일 row)
router.put('/:id', async (req, res) => {
  const userId = req.user.id
  const evId = parseInt(req.params.id)
  const { title, color, allDay, startDt, endDt, repeat, invitees, memo, securityLevel, remindDt, remindRepeat } = req.body
  try {
    const { rows } = await pool.query(
      `UPDATE calendar_events SET
         title=$1, color=$2, all_day=$3, start_dt=$4, end_dt=$5, repeat=$6,
         invitees=$7, memo=$8, security_level=$9, remind_dt=$10, remind_repeat=$11,
         updated_at=NOW()
       WHERE id=$12 AND owner_id=$13
       RETURNING *`,
      [
        title || '',
        color || '#4f46e5',
        allDay || false,
        JSON.stringify(startDt || {}),
        JSON.stringify(endDt || {}),
        repeat || 'none',
        JSON.stringify(invitees || []),
        memo || '',
        securityLevel || 0,
        JSON.stringify(remindDt || {}),
        remindRepeat || 'none',
        evId,
        userId,
      ]
    )
    if (!rows[0]) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' })
    res.json(toClient(rows[0]))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// PUT /api/events/series/:seriesId — 반복 이벤트 전체 수정 (본인만, 날짜 오프셋 유지)
router.put('/series/:seriesId', async (req, res) => {
  const userId = req.user.id
  const { seriesId } = req.params
  const { title, color, allDay, startDt, endDt, repeat, invitees, memo, securityLevel, remindDt, remindRepeat } = req.body

  try {
    // 시리즈의 첫 번째 이벤트 기준으로 날짜 오프셋 계산
    const { rows: seriesRows } = await pool.query(
      'SELECT * FROM calendar_events WHERE series_id=$1 AND owner_id=$2 ORDER BY id ASC',
      [seriesId, userId]
    )
    if (seriesRows.length === 0) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' })

    // 새 startDt 기준으로 각 이벤트의 날짜 재생성
    const baseOld = dtToDate(seriesRows[0].start_dt)
    const baseNew = dtToDate(startDt)
    const endOld  = dtToDate(seriesRows[0].end_dt)
    const duration = dtToDate(endDt) - dtToDate(startDt)
    const shift = baseNew - baseOld

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const updated = []
      for (const row of seriesRows) {
        const oldStart = dtToDate(row.start_dt)
        const newStart = new Date(oldStart.getTime() + shift)
        const newEnd   = new Date(newStart.getTime() + duration)
        const { rows: ur } = await client.query(
          `UPDATE calendar_events SET
             title=$1, color=$2, all_day=$3, start_dt=$4, end_dt=$5, repeat=$6,
             invitees=$7, memo=$8, security_level=$9, remind_dt=$10, remind_repeat=$11,
             updated_at=NOW()
           WHERE id=$12 AND owner_id=$13
           RETURNING *`,
          [
            title || '',
            color || '#4f46e5',
            allDay || false,
            JSON.stringify(dateToDt(newStart, allDay || false, startDt)),
            JSON.stringify(dateToDt(newEnd,   allDay || false, endDt)),
            repeat || 'none',
            JSON.stringify(invitees || []),
            memo || '',
            securityLevel || 0,
            JSON.stringify(remindDt || {}),
            remindRepeat || 'none',
            row.id,
            userId,
          ]
        )
        if (ur[0]) updated.push(toClient(ur[0]))
      }
      await client.query('COMMIT')
      res.json(updated)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
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
    const { rowCount } = await pool.query(
      'DELETE FROM calendar_events WHERE series_id=$1 AND owner_id=$2',
      [seriesId, userId]
    )
    if (rowCount === 0) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' })
    res.json({ success: true, deleted: rowCount })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// DELETE /api/events/:id — 이벤트 삭제 (본인만)
router.delete('/:id', async (req, res) => {
  const userId = req.user.id
  const evId = parseInt(req.params.id)
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM calendar_events WHERE id=$1 AND owner_id=$2',
      [evId, userId]
    )
    if (rowCount === 0) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' })
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

function toClient(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    color: row.color,
    allDay: row.all_day,
    startDt: row.start_dt,
    endDt: row.end_dt,
    repeat: row.repeat,
    invitees: row.invitees,
    memo: row.memo,
    securityLevel: row.security_level,
    remindDt: row.remind_dt,
    remindRepeat: row.remind_repeat,
    seriesId: row.series_id,
  }
}

module.exports = router
