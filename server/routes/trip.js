const express = require('express')
const requireAuth = require('../middleware/auth')
const db = require('../db')

const router = express.Router()

// GET /api/trip/next-doc-no
// 문서번호: REP-{YYYYMMDD}-{일자별 순번}
router.get('/next-doc-no', requireAuth, async (req, res) => {
  try {
    const now = new Date()
    const dateKey = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    const result = await db.query(
      `INSERT INTO trip_doc_counter (date_key, last_seq) VALUES ($1, 1)
       ON CONFLICT (date_key) DO UPDATE SET last_seq = trip_doc_counter.last_seq + 1
       RETURNING last_seq`,
      [dateKey]
    )
    const seq = result.rows[0].last_seq
    const docNo = `REP-${dateKey}-${String(seq).padStart(3, '0')}`
    res.json({ docNo })
  } catch (err) {
    console.error('[Trip DocNo Error]', err.message)
    res.status(500).json({ error: '문서번호 생성 실패: ' + err.message })
  }
})

module.exports = router
