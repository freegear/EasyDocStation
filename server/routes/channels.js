const express = require('express')
const router = express.Router()
const db = require('../db')
const requireAuth = require('../middleware/auth')

// ─── Channels ────────────────────────────────────────────────

// Get channel info
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    const result = await db.query('SELECT * FROM channels WHERE id = $1', [id])
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '채널을 찾을 수 없습니다.' })
    }
    res.json(result.rows[0])
  } catch (err) {
    next(err)
  }
})

// Update channel (name, type)
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    const { name, type } = req.body

    const result = await db.query(
      'UPDATE channels SET name = $1, type = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
      [name, type, id]
    )

    if (result.rows.length === 0) {
      // If not exists, maybe create it? For now just return 404
      return res.status(404).json({ error: '채널을 찾을 수 없습니다.' })
    }

    res.json(result.rows[0])
  } catch (err) {
    next(err)
  }
})

// Archive channel
router.patch('/:id/archive', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    const result = await db.query(
      'UPDATE channels SET is_archived = true, updated_at = NOW() WHERE id = $1 RETURNING *',
      [id]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: '채널을 찾을 수 없습니다.' })
    res.json(result.rows[0])
  } catch (err) {
    next(err)
  }
})

// ─── Members ─────────────────────────────────────────────────

// Get channel members
router.get('/:id/members', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    const result = await db.query(`
      SELECT u.id, u.username, u.name, u.email, u.role
      FROM users u
      JOIN channel_members cm ON u.id = cm.user_id
      WHERE cm.channel_id = $1
    `, [id])
    res.json(result.rows)
  } catch (err) {
    next(err)
  }
})

// Add member to channel
router.post('/:id/members', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    const { userId } = req.body

    await db.query(
      'INSERT INTO channel_members (channel_id, user_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [id, userId, req.user.id]
    )

    res.status(201).json({ success: true })
  } catch (err) {
    next(err)
  }
})

// Remove member from channel
router.delete('/:id/members/:userId', requireAuth, async (req, res, next) => {
  try {
    const { id, userId } = req.params
    await db.query(
      'DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [id, userId]
    )
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

module.exports = router
