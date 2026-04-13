const express = require('express')
const router = express.Router()
const db = require('../db')
const requireAuth = require('../middleware/auth')
const { client, isConnected } = require('../cassandra')

// ─── Unread counts ────────────────────────────────────────────

// GET /api/channels/unread — 현재 사용자의 채널별 읽지 않은 게시글 수
router.get('/unread', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id

    // 사용자가 접근 가능한 모든 채널 ID 조회 (소속 팀의 public + 멤버인 private)
    const channelsRes = await db.query(`
      SELECT DISTINCT c.id
      FROM channels c
      JOIN team_members tm ON tm.team_id = c.team_id AND tm.user_id = $1
      WHERE c.is_archived = false
        AND (
          c.type = 'public'
          OR c.id IN (SELECT channel_id FROM channel_members WHERE user_id = $1)
        )
    `, [userId])

    const channelIds = channelsRes.rows.map(r => r.id)
    if (channelIds.length === 0) return res.json({})

    // 마지막 읽은 시각 조회
    const lastReadRes = await db.query(`
      SELECT channel_id, last_read_at
      FROM channel_last_read
      WHERE user_id = $1 AND channel_id = ANY($2)
    `, [userId, channelIds])

    const lastReadMap = {}
    for (const row of lastReadRes.rows) {
      lastReadMap[row.channel_id] = row.last_read_at
    }

    const unreadCounts = {}

    if (isConnected()) {
      // Cassandra: channel_id 파티션 키 + created_at 클러스터링 키로 효율적 조회
      await Promise.all(channelIds.map(async channelId => {
        const lastRead = lastReadMap[channelId]
        let result
        if (!lastRead) {
          result = await client.execute(
            'SELECT COUNT(*) FROM posts WHERE channel_id = ?',
            [channelId], { prepare: true }
          )
        } else {
          result = await client.execute(
            'SELECT COUNT(*) FROM posts WHERE channel_id = ? AND created_at > ?',
            [channelId, lastRead], { prepare: true }
          )
        }
        unreadCounts[channelId] = result.rows[0] ? Number(result.rows[0].count) : 0
      }))
    } else {
      // PostgreSQL fallback
      await Promise.all(channelIds.map(async channelId => {
        const lastRead = lastReadMap[channelId]
        let result
        if (!lastRead) {
          result = await db.query('SELECT COUNT(*) FROM posts WHERE channel_id = $1', [channelId])
        } else {
          result = await db.query(
            'SELECT COUNT(*) FROM posts WHERE channel_id = $1 AND created_at > $2',
            [channelId, lastRead]
          )
        }
        unreadCounts[channelId] = parseInt(result.rows[0].count, 10)
      }))
    }

    res.json(unreadCounts)
  } catch (err) {
    next(err)
  }
})

// POST /api/channels/:id/read — 채널을 읽음 처리 (last_read_at 갱신)
router.post('/:id/read', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    await db.query(`
      INSERT INTO channel_last_read (user_id, channel_id, last_read_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id, channel_id)
      DO UPDATE SET last_read_at = NOW()
    `, [req.user.id, id])
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

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
    const { name, type, description, team_id, adminIds, memberIds, is_archived } = req.body
    
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
      `INSERT INTO channels (id, team_id, name, type, description, is_archived, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           type = EXCLUDED.type,
           description = EXCLUDED.description,
           is_archived = EXCLUDED.is_archived,
           updated_at = NOW()
       RETURNING *`,
      [id, finalTeamId, name, type, description || null, is_archived ?? false]
    )
    // root_post_id / tail_post_id are managed by the posts system, not here

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

// 채널 멤버 수정 권한 확인 헬퍼
// site_admin, 채널 소속 팀의 team_admin, 또는 channel_admin만 가능
async function requireChannelMemberAdmin(req, res, channelId) {
  if (req.user.role === 'site_admin') return true

  const chRes = await db.query('SELECT team_id FROM channels WHERE id = $1', [channelId])
  if (chRes.rowCount === 0) { res.status(404).json({ error: '채널을 찾을 수 없습니다.' }); return false }
  const teamId = chRes.rows[0].team_id

  const [teamAdminCheck, channelAdminCheck] = await Promise.all([
    db.query('SELECT 1 FROM team_admins WHERE team_id = $1 AND user_id = $2', [teamId, req.user.id]),
    db.query('SELECT 1 FROM channel_admins WHERE channel_id = $1 AND user_id = $2', [channelId, req.user.id]),
  ])

  if (teamAdminCheck.rowCount > 0 || channelAdminCheck.rowCount > 0) return true

  res.status(403).json({ error: '채널 멤버 관리 권한이 없습니다. 사이트 관리자, 팀 관리자, 또는 채널 관리자만 가능합니다.' })
  return false
}

// Add member to channel
router.post('/:id/members', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    const { userId } = req.body

    if (!await requireChannelMemberAdmin(req, res, id)) return

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

    if (!await requireChannelMemberAdmin(req, res, id)) return

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
