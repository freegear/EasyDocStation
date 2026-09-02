const express = require('express')
const router = express.Router()
const db = require('../db')
const requireAuth = require('../middleware/auth')
const { client, isConnected } = require('../cassandra')
const { ACCESS_DENIED_MESSAGE, canAccessChannel, getAccessibleChannelIds } = require('../lib/channelAccess')
const { authorizeSpace } = require('../lib/spaceAccess')

function normalizeUserIds(userIds) {
  if (!Array.isArray(userIds)) return []
  const ids = []
  const seen = new Set()
  for (const userId of userIds) {
    const parsed = parseInt(userId, 10)
    if (!Number.isInteger(parsed) || parsed <= 0 || seen.has(parsed)) continue
    seen.add(parsed)
    ids.push(parsed)
  }
  return ids
}

async function getUsersOutsideTeam(teamId, userIds) {
  const ids = normalizeUserIds(userIds)
  if (ids.length === 0) return []

  const result = await db.query(`
    SELECT wanted.user_id
    FROM unnest($2::int[]) AS wanted(user_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = $1 AND tm.user_id = wanted.user_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM team_admins ta
      WHERE ta.team_id = $1 AND ta.user_id = wanted.user_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = wanted.user_id AND u.role = 'site_admin'
    )
  `, [teamId, ids])

  return result.rows.map(row => row.user_id)
}

async function rejectUsersOutsideTeam(res, teamId, userIds) {
  const invalidUserIds = await getUsersOutsideTeam(teamId, userIds)
  if (invalidUserIds.length === 0) return false

  res.status(400).json({
    error: '스페이스에 등록된 사용자만 채널 관리자 또는 멤버로 지정할 수 있습니다.',
    invalidUserIds,
  })
  return true
}

// ─── Unread counts ────────────────────────────────────────────

// GET /api/channels/unread — 현재 사용자의 채널별 읽지 않은 게시글 수
router.get('/unread', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id
    const channelIds = await getAccessibleChannelIds(db, req.user)
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
        let postRows
        if (!lastRead) {
          const result = await client.execute(
            'SELECT author_id FROM posts WHERE channel_id = ?',
            [channelId], { prepare: true }
          )
          postRows = result.rows || []
        } else {
          const result = await client.execute(
            'SELECT author_id FROM posts WHERE channel_id = ? AND created_at > ?',
            [channelId, lastRead], { prepare: true }
          )
          postRows = result.rows || []
        }

        const postCount = postRows.reduce((sum, row) => (
          String(row.author_id) === String(userId) ? sum : sum + 1
        ), 0)

        const commentParams = lastRead
          ? [channelId, lastRead, userId]
          : [channelId, userId]
        // 새 댓글 + 읽은 뒤 수정된 댓글(updated_at)까지 미열람으로 센다(게시글 수정은 배지 효율 유지 위해 제외).
        const commentSql = lastRead
          ? 'SELECT COUNT(*)::int AS count FROM comments WHERE channel_id = $1 AND (created_at > $2 OR updated_at > $2) AND author_id <> $3'
          : 'SELECT COUNT(*)::int AS count FROM comments WHERE channel_id = $1 AND author_id <> $2'
        const commentResult = await db.query(commentSql, commentParams)
        const commentCount = parseInt(commentResult.rows[0]?.count || 0, 10)

        unreadCounts[channelId] = postCount + commentCount
      }))
    } else {
      // PostgreSQL fallback
      await Promise.all(channelIds.map(async channelId => {
        const lastRead = lastReadMap[channelId]
        let result
        if (!lastRead) {
          result = await db.query(
            `SELECT
               (SELECT COUNT(*)::int FROM posts WHERE channel_id = $1 AND author_id <> $2)
               +
               (SELECT COUNT(*)::int FROM comments WHERE channel_id = $1 AND author_id <> $2)
               AS count`,
            [channelId, userId]
          )
        } else {
          result = await db.query(
            `SELECT
               (SELECT COUNT(*)::int FROM posts WHERE channel_id = $1 AND created_at > $2 AND author_id <> $3)
               +
               (SELECT COUNT(*)::int FROM comments WHERE channel_id = $1 AND (created_at > $2 OR updated_at > $2) AND author_id <> $3)
               AS count`,
            [channelId, lastRead, userId]
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
    const allowed = await canAccessChannel(db, req.user, id)
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })
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
    const allowed = await canAccessChannel(db, req.user, id)
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })
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
    let { name, type, description, team_id, adminIds, memberIds, is_archived } = req.body
    const existing = await db.query('SELECT team_id FROM channels WHERE id=$1', [id])
    if (existing.rowCount && !await canAccessChannel(db, req.user, id)) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })
    
    // Ensure team exists or use a default existing team
    let finalTeamId = team_id
    const teamCheck = await db.query('SELECT id FROM teams WHERE id = $1', [finalTeamId])
    if (teamCheck.rowCount === 0) {
      const firstTeam = await db.query('SELECT id FROM teams LIMIT 1')
      if (firstTeam.rowCount > 0) finalTeamId = firstTeam.rows[0].id
      else return res.status(400).json({ error: '유효한 스페이스가 존재하지 않습니다. 먼저 스페이스를 생성해주세요.' })
    }

    const spaceAccess = await authorizeSpace(db, req.user, finalTeamId, { manage: true, auditAction: existing.rowCount ? 'update_channel' : 'create_channel', details: { channelId: id } })
    if (!spaceAccess.allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })
    if (spaceAccess.space.visibility === 'personal') {
      adminIds = [spaceAccess.space.owner_id]
      memberIds = [spaceAccess.space.owner_id]
    }

    if (await rejectUsersOutsideTeam(res, finalTeamId, [
      ...normalizeUserIds(adminIds),
      ...normalizeUserIds(memberIds),
    ])) return

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
      for (const uid of normalizeUserIds(adminIds)) {
        await db.query(
          'INSERT INTO channel_admins (channel_id, user_id, assigned_by) VALUES ($1, $2, $3)',
          [id, uid, req.user.id]
        )
      }
    }

    // Sync Members
    if (memberIds && Array.isArray(memberIds)) {
      await db.query('DELETE FROM channel_members WHERE channel_id = $1', [id])
      for (const uid of normalizeUserIds(memberIds)) {
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
    const target = await db.query('SELECT team_id FROM channels WHERE id=$1', [id])
    if (!target.rowCount) return res.status(404).json({ error: '채널을 찾을 수 없습니다.' })
    const access = await authorizeSpace(db, req.user, target.rows[0].team_id, { manage: true, auditAction: 'delete_channel', details: { channelId: id } })
    if (!access.allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })
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
    const allowed = await canAccessChannel(db, req.user, id)
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })
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
    const allowed = await canAccessChannel(db, req.user, id)
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })
    const result = await db.query(`
      SELECT u.id, u.username, u.name, u.email
      FROM users u
      JOIN channel_admins ca ON u.id = ca.user_id
      JOIN channels c ON c.id = ca.channel_id
      WHERE ca.channel_id = $1
        AND (
          EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = c.team_id AND tm.user_id = u.id)
          OR EXISTS (SELECT 1 FROM team_admins ta WHERE ta.team_id = c.team_id AND ta.user_id = u.id)
          OR u.role = 'site_admin'
        )
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
    const allowed = await canAccessChannel(db, req.user, id)
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })
    const result = await db.query(`
      SELECT u.id, u.username, u.name, u.email, u.role
      FROM users u
      JOIN channel_members cm ON u.id = cm.user_id
      JOIN channels c ON c.id = cm.channel_id
      WHERE cm.channel_id = $1
        AND (
          EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = c.team_id AND tm.user_id = u.id)
          OR EXISTS (SELECT 1 FROM team_admins ta WHERE ta.team_id = c.team_id AND ta.user_id = u.id)
          OR u.role = 'site_admin'
        )
    `, [id])
    res.json(result.rows)
  } catch (err) {
    next(err)
  }
})

// 채널 멤버 수정 권한 확인 헬퍼
// site_admin, 채널 소속 팀의 team_admin, 또는 channel_admin만 가능
async function requireChannelMemberAdmin(req, res, channelId) {
  if (req.user.role === 'site_admin') return canAccessChannel(db, req.user, channelId)

  const chRes = await db.query('SELECT team_id FROM channels WHERE id = $1', [channelId])
  if (chRes.rowCount === 0) { res.status(404).json({ error: '채널을 찾을 수 없습니다.' }); return false }
  const teamId = chRes.rows[0].team_id

  const [teamAdminCheck, channelAdminCheck] = await Promise.all([
    db.query('SELECT 1 FROM team_admins WHERE team_id = $1 AND user_id = $2', [teamId, req.user.id]),
    db.query('SELECT 1 FROM channel_admins WHERE channel_id = $1 AND user_id = $2', [channelId, req.user.id]),
  ])

  if (teamAdminCheck.rowCount > 0 || channelAdminCheck.rowCount > 0) return true

  res.status(403).json({ error: '채널 멤버 관리 권한이 없습니다. 사이트 관리자, 스페이스 관리자, 또는 채널 관리자만 가능합니다.' })
  return false
}

// Add member to channel
router.post('/:id/members', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    const { userId } = req.body

    if (!await requireChannelMemberAdmin(req, res, id)) return

    const chRes = await db.query('SELECT team_id FROM channels WHERE id = $1', [id])
    if (chRes.rowCount === 0) return res.status(404).json({ error: '채널을 찾을 수 없습니다.' })
    if (await rejectUsersOutsideTeam(res, chRes.rows[0].team_id, [userId])) return

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
