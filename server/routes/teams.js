const express = require('express')
const router = express.Router()
const db = require('../db')
const requireAuth = require('../middleware/auth')
const { getUserSecurityLevel } = require('../lib/channelAccess')
const { authorizeSpace, grantEmergencyAccess, revokeEmergencyAccess } = require('../lib/spaceAccess')

async function requireSpace(req, res, teamId, options = {}) {
  const access = await authorizeSpace(db, req.user, teamId, options)
  if (access.allowed) return access
  res.status(403).json({ error: '스페이스 접근 권한이 없습니다.' })
  return null
}

// GET /api/teams — 역할에 따른 팀/채널 목록 반환
//   site_admin  : 공유 스페이스 전체 + 자신의 개인 스페이스 + 긴급 접근 중인 개인 스페이스
//   team_admin  : 자신이 속한 팀 + 해당 팀의 모든 채널
//   channel_admin / user : 자신이 속한 팀 + (public 채널 + 자신이 멤버인 채널 + 자신이 admin인 채널)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id
    const isSiteAdmin = req.user.role === 'site_admin'
    const userSecurityLevel = getUserSecurityLevel(req.user)

    const result = await db.query(`
      SELECT t.*,
        (SELECT json_agg(
          json_build_object(
            'id', c.id,
            'name', c.name,
            'type', c.type,
            'description', c.description,
            'is_archived', c.is_archived,
            'unread', 0,
            'admin_ids', (
              SELECT json_agg(ca.user_id)
              FROM channel_admins ca
              WHERE ca.channel_id = c.id
            )
          ) ORDER BY c.name ASC
        )
        FROM channels c
        WHERE c.team_id = t.id
          AND (
            $2::boolean = true
            OR $3::int >= 4
            OR EXISTS (SELECT 1 FROM team_admins ta WHERE ta.team_id = t.id AND ta.user_id = $1)
            OR EXISTS (SELECT 1 FROM channel_admins ca WHERE ca.channel_id = c.id AND ca.user_id = $1)
            OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $1)
            OR (
              $3::int >= 3
              AND EXISTS (SELECT 1 FROM team_members tm2 WHERE tm2.team_id = t.id AND tm2.user_id = $1)
            )
          )
        ) as channels,
        (SELECT json_agg(u.username)
         FROM users u JOIN team_admins ta ON u.id = ta.user_id
         WHERE ta.team_id = t.id) as admins,
        (SELECT json_agg(ta2.user_id)
         FROM team_admins ta2 WHERE ta2.team_id = t.id) as admin_ids,
        (SELECT json_build_object(
           'id', pea.id,
           'expires_at', pea.expires_at,
           'reason', pea.reason
         )
         FROM personal_space_emergency_access pea
         WHERE pea.team_id=t.id
           AND pea.site_admin_id=$1
           AND pea.revoked_at IS NULL
           AND pea.expires_at > NOW()
         ORDER BY pea.expires_at DESC
         LIMIT 1) AS emergency_access
      FROM teams t
      WHERE (t.visibility <> 'personal' OR t.owner_id=$1 OR ($2::boolean = false AND EXISTS (SELECT 1 FROM team_admins pta WHERE pta.team_id=t.id AND pta.user_id=$1)) OR ($2::boolean AND EXISTS (SELECT 1 FROM personal_space_emergency_access pea WHERE pea.team_id=t.id AND pea.site_admin_id=$1 AND pea.revoked_at IS NULL AND pea.expires_at > NOW())))
      AND (
        $2::boolean = true
        OR $3::int >= 4
        OR EXISTS (SELECT 1 FROM team_admins ta WHERE ta.team_id = t.id AND ta.user_id = $1)
        OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = t.id AND tm.user_id = $1)
      )
      ORDER BY t.created_at ASC
    `, [userId, isSiteAdmin, userSecurityLevel])

    if (isSiteAdmin) {
      for (const space of result.rows) {
        if (space.visibility !== 'personal' || String(space.owner_id) === String(userId) || !space.emergency_access?.id) continue
        await db.query(
          `INSERT INTO personal_space_audit_log(team_id,actor_id,action,reason,details)
           VALUES ($1,$2,'list_space',$3,$4::jsonb)`,
          [space.id, userId, space.emergency_access.reason, JSON.stringify({ emergencyAccessId: space.emergency_access.id })],
        )
      }
    }
    res.json(result.rows)
  } catch (err) {
    next(err)
  }
})

// GET /api/teams/:id/admins — Get list of admins for a specific team
router.get('/:id/admins', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    if (!await requireSpace(req, res, id, { auditAction: 'view_space_admins' })) return
    const result = await db.query(`
      SELECT u.id, u.username, u.name, u.email 
      FROM users u
      JOIN team_admins ta ON u.id = ta.user_id
      WHERE ta.team_id = $1
    `, [id])
    res.json(result.rows)
  } catch (err) {
    next(err)
  }
})

// GET /api/teams/:id/members — Get list of members for a specific team
router.get('/:id/members', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    if (!await requireSpace(req, res, id, { auditAction: 'view_space_members' })) return
    const result = await db.query(`
      SELECT u.id, u.username, u.name, u.display_name, u.email, u.role
      FROM users u
      JOIN team_members tm ON u.id = tm.user_id
      WHERE tm.team_id = $1
      ORDER BY u.name ASC
    `, [id])
    res.json(result.rows)
  } catch (err) {
    next(err)
  }
})

// POST /api/teams — Create a new team
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { name, description, adminIds, memberIds, visibility = 'shared' } = req.body
    const isPersonal = visibility === 'personal'
    if (!['shared', 'personal'].includes(visibility)) return res.status(400).json({ error: '스페이스 공개 범위가 올바르지 않습니다.' })
    // 같은 이름의 팀이 이미 존재하면 거부
    const dup = await db.query('SELECT id FROM teams WHERE name = $1', [name])
    if (dup.rowCount > 0) {
      return res.status(409).json({ error: `이미 같은 이름의 스페이스가 존재합니다: "${name}"` })
    }

    const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now().toString().slice(-4)

    await db.query('BEGIN')

    const teamResult = await db.query(
      'INSERT INTO teams (id, name, description, visibility, owner_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [id, name, description || null, isPersonal ? 'personal' : 'shared', isPersonal ? req.user.id : null]
    )

    // Add admins
    const finalAdmins = isPersonal ? [req.user.id] : ((adminIds && adminIds.length > 0) ? adminIds : [req.user.id])
    for (const userId of finalAdmins) {
      await db.query(
        'INSERT INTO team_admins (team_id, user_id, assigned_by) VALUES ($1, $2, $3)',
        [id, userId, req.user.id]
      )
      // Admins are also members
      await db.query(
        'INSERT INTO team_members (team_id, user_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [id, userId, req.user.id]
      )
    }

    // Add members
    if (!isPersonal && memberIds && Array.isArray(memberIds)) {
      for (const userId of memberIds) {
        await db.query(
          'INSERT INTO team_members (team_id, user_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [id, userId, req.user.id]
        )
      }
    }

    await db.query('COMMIT')
    res.status(201).json(teamResult.rows[0])
  } catch (err) {
    await db.query('ROLLBACK')
    next(err)
  }
})

// PUT /api/teams/:id — Update team info
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    let { name, description, adminIds, memberIds } = req.body
    const spaceAccess = await requireSpace(req, res, id, { manage: true, auditAction: 'update_space' })
    if (!spaceAccess) return
    if (spaceAccess.space.visibility === 'personal') {
      adminIds = [spaceAccess.space.owner_id]
      memberIds = [spaceAccess.space.owner_id]
    }

    // 권한 체크: site_admin 또는 해당 팀의 team_admin만 수정 가능
    if (req.user.role !== 'site_admin') {
      const check = await db.query(
        'SELECT 1 FROM team_admins WHERE team_id = $1 AND user_id = $2',
        [id, req.user.id]
      )
      if (check.rowCount === 0) {
        return res.status(403).json({ error: '스페이스 관리자 권한이 필요합니다.' })
      }
    }

    // 자신을 제외한 다른 팀과 이름이 겹치면 거부
    const dup = await db.query('SELECT id FROM teams WHERE name = $1 AND id <> $2', [name, id])
    if (dup.rowCount > 0) {
      return res.status(409).json({ error: `이미 같은 이름의 스페이스가 존재합니다: "${name}"` })
    }

    await db.query('BEGIN')

    const result = await db.query(
      'UPDATE teams SET name = $1, description = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
      [name, description ?? null, id]
    )

    // Sync admins
    if (adminIds && Array.isArray(adminIds)) {
      await db.query('DELETE FROM team_admins WHERE team_id = $1', [id])
      for (const userId of adminIds) {
        await db.query(
          'INSERT INTO team_admins (team_id, user_id, assigned_by) VALUES ($1, $2, $3)',
          [id, userId, req.user.id]
        )
      }
    }

    // Sync members
    if (memberIds && Array.isArray(memberIds)) {
      await db.query('DELETE FROM team_members WHERE team_id = $1', [id])
      for (const userId of memberIds) {
        await db.query(
          'INSERT INTO team_members (team_id, user_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [id, userId, req.user.id]
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

// DELETE /api/teams/:id — Delete team and all its channels
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    if (!await requireSpace(req, res, id, { manage: true, auditAction: 'delete_space' })) return
    // ON DELETE CASCADE in schema handles channels, members, etc.
    const result = await db.query('DELETE FROM teams WHERE id = $1 RETURNING *', [id])
    if (result.rowCount === 0) return res.status(404).json({ error: '스페이스를 찾을 수 없습니다.' })
    res.json({ success: true, message: 'Space and related channels deleted.' })
  } catch (err) {
    next(err)
  }
})

router.post('/:id/emergency-access', requireAuth, async (req, res, next) => {
  try {
    res.status(201).json(await grantEmergencyAccess(db, req.user, req.params.id, req.body || {}))
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message })
    next(error)
  }
})

router.delete('/emergency-access/:accessId', requireAuth, async (req, res, next) => {
  try {
    res.json(await revokeEmergencyAccess(db, req.user, req.params.accessId, req.body?.reason))
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message })
    next(error)
  }
})
module.exports = router
