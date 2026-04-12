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

// Update channel (name, type, admins, members)
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    const { name, type, description, team_id, adminIds, memberIds } = req.body
    
    // Ensure team exists or use a default existing team
    let finalTeamId = team_id
    const teamCheck = await db.query('SELECT id FROM teams WHERE id = $1', [finalTeamId])
    if (teamCheck.rowCount === 0) {
      const firstTeam = await db.query('SELECT id FROM teams LIMIT 1')
      if (firstTeam.rowCount > 0) finalTeamId = firstTeam.rows[0].id
      else return res.status(400).json({ error: '유효한 팀이 존재하지 않습니다. 먼저 팀을 생성해주세요.' })
    }

    await db.query('BEGIN')

    const result = await db.query(
      `INSERT INTO channels (id, team_id, name, type, description, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name, 
           type = EXCLUDED.type, 
           description = EXCLUDED.description,
           updated_at = NOW()
       RETURNING *`,
      [id, finalTeamId, name, type, description || null]
    )

    // Sync Admins
    if (adminIds && Array.isArray(adminIds)) {
      await db.query('DELETE FROM channel_admins WHERE channel_id = $1', [id])
      for (const uid of adminIds) {
        await db.query(
          'INSERT INTO channel_admins (channel_id, user_id, assigned_by) VALUES ($1, $2, $3)',
          [id, uid, req.user.id]
        )
      }
    }

    // Sync Members
    if (memberIds && Array.isArray(memberIds)) {
      await db.query('DELETE FROM channel_members WHERE channel_id = $1', [id])
      for (const uid of memberIds) {
        await db.query(
          'INSERT INTO channel_members (channel_id, user_id, added_by) VALUES ($1, $2, $3)',
          [id, uid, req.user.id]
        )
      }
    }

    await db.query('COMMIT')
    res.json(result.rows[0])
  } catch (err) {
    await db.query('ROLLBACK')
    next(err)
  }
})

// Delete channel
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    const result = await db.query('DELETE FROM channels WHERE id = $1 RETURNING *', [id])
    if (result.rowCount === 0) return res.status(404).json({ error: '채널을 찾을 수 없습니다.' })
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// Get channel stats (messages, files, size)
router.get('/:id/stats', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    const stats = await db.query(`
      SELECT 
        ( (SELECT COUNT(*) FROM posts WHERE channel_id = $1) + (SELECT COUNT(*) FROM comments WHERE channel_id = $1) ) as message_count,
        (SELECT COUNT(*) FROM attachments WHERE channel_id = $1) as file_count,
        (SELECT COALESCE(SUM(size), 0) FROM attachments WHERE channel_id = $1) as total_size
    `, [id])
    
    res.json(stats.rows[0])
  } catch (err) {
    next(err)
  }
})

// ─── Admins & Members ─────────────────────────────────────────

// Get channel admins
router.get('/:id/admins', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    const result = await db.query(`
      SELECT u.id, u.username, u.name, u.email
      FROM users u
      JOIN channel_admins ca ON u.id = ca.user_id
      WHERE ca.channel_id = $1
    `, [id])
    res.json(result.rows)
  } catch (err) {
    next(err)
  }
})

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
      [id, parseInt(userId), req.user.id]
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
      [id, parseInt(userId)]
    )
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

module.exports = router
