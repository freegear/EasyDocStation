const ACCESS_DENIED_MESSAGE = '당신은 권한이 없습니다. 필요하시면 스페이스 관리자 또는 채널 관리자에게 연락하여 주시기 바랍니다.'

function getUserSecurityLevel(user = {}) {
  const parsed = Number.parseInt(user?.security_level, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

async function canAccessChannel(db, user = {}, channelId = '') {
  const userId = user?.id
  if (!userId || !channelId) return false

  const isSiteAdmin = user?.role === 'site_admin'
  const securityLevel = getUserSecurityLevel(user)

  const result = await db.query(
    `
    SELECT c.team_id, t.visibility, t.owner_id,
      EXISTS (SELECT 1 FROM team_admins pta WHERE pta.team_id=t.id AND pta.user_id=$2) AS is_space_admin,
      EXISTS (SELECT 1 FROM personal_space_emergency_access pea WHERE pea.team_id=t.id AND pea.site_admin_id=$2 AND pea.revoked_at IS NULL AND pea.expires_at > NOW()) AS emergency_access
    FROM channels c
    JOIN teams t ON t.id = c.team_id
    WHERE c.id = $1
      AND (t.visibility <> 'personal' OR t.owner_id=$2 OR ($3::boolean = false AND EXISTS (SELECT 1 FROM team_admins pta WHERE pta.team_id=t.id AND pta.user_id=$2)) OR ($3::boolean AND EXISTS (SELECT 1 FROM personal_space_emergency_access pea WHERE pea.team_id=t.id AND pea.site_admin_id=$2 AND pea.revoked_at IS NULL AND pea.expires_at > NOW())))
      AND (
        $3::boolean = true
        OR $4::int >= 4
        OR EXISTS (
          SELECT 1 FROM channel_admins ca
          WHERE ca.channel_id = c.id
            AND ca.user_id = $2
            AND (
              EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = c.team_id AND tm.user_id = $2)
              OR EXISTS (SELECT 1 FROM team_admins ta WHERE ta.team_id = c.team_id AND ta.user_id = $2)
            )
        )
        OR EXISTS (
          SELECT 1 FROM channel_members cm
          WHERE cm.channel_id = c.id
            AND cm.user_id = $2
            AND (
              EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = c.team_id AND tm.user_id = $2)
              OR EXISTS (SELECT 1 FROM team_admins ta WHERE ta.team_id = c.team_id AND ta.user_id = $2)
            )
        )
        OR EXISTS (
          SELECT 1 FROM team_admins ta
          WHERE ta.team_id = c.team_id AND ta.user_id = $2
        )
        OR (
          $4::int >= 3
          AND EXISTS (
            SELECT 1 FROM team_members tm
            WHERE tm.team_id = c.team_id AND tm.user_id = $2
          )
        )
      )
    LIMIT 1
    `,
    [channelId, userId, isSiteAdmin, securityLevel],
  )

  if (result.rowCount > 0) {
    const row = result.rows[0]
    if (row.visibility === 'personal' && isSiteAdmin && String(row.owner_id) !== String(userId) && row.emergency_access) {
      await db.query(
        `INSERT INTO personal_space_audit_log(team_id,actor_id,action,details)
         VALUES ($1,$2,'channel_access',$3::jsonb)`,
        [row.team_id, userId, JSON.stringify({ channelId: String(channelId) })],
      )
    }
    return true
  }
  return false
}

async function getAccessibleChannelIds(db, user = {}, channelIds = null) {
  const userId = user?.id
  if (!userId) return []

  const isSiteAdmin = user?.role === 'site_admin'
  const securityLevel = getUserSecurityLevel(user)
  const hasFilter = Array.isArray(channelIds) && channelIds.length > 0

  const result = await db.query(
    `
    SELECT c.id
    FROM channels c
    JOIN teams t ON t.id = c.team_id
    WHERE (t.visibility <> 'personal' OR t.owner_id=$2 OR ($3::boolean = false AND EXISTS (SELECT 1 FROM team_admins pta WHERE pta.team_id=t.id AND pta.user_id=$2)) OR ($3::boolean AND EXISTS (SELECT 1 FROM personal_space_emergency_access pea WHERE pea.team_id=t.id AND pea.site_admin_id=$2 AND pea.revoked_at IS NULL AND pea.expires_at > NOW())))
    AND (
      $3::boolean = true
      OR $4::int >= 4
      OR EXISTS (
        SELECT 1 FROM channel_admins ca
        WHERE ca.channel_id = c.id
          AND ca.user_id = $2
          AND (
            EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = c.team_id AND tm.user_id = $2)
            OR EXISTS (SELECT 1 FROM team_admins ta WHERE ta.team_id = c.team_id AND ta.user_id = $2)
          )
      )
      OR EXISTS (
        SELECT 1 FROM channel_members cm
        WHERE cm.channel_id = c.id
          AND cm.user_id = $2
          AND (
            EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = c.team_id AND tm.user_id = $2)
            OR EXISTS (SELECT 1 FROM team_admins ta WHERE ta.team_id = c.team_id AND ta.user_id = $2)
          )
      )
      OR EXISTS (
        SELECT 1 FROM team_admins ta
        WHERE ta.team_id = c.team_id AND ta.user_id = $2
      )
      OR (
        $4::int >= 3
        AND EXISTS (
          SELECT 1 FROM team_members tm
          WHERE tm.team_id = c.team_id AND tm.user_id = $2
        )
      )
    )
    AND (
      $1::boolean = false
      OR c.id = ANY($5)
    )
    `,
    [hasFilter, userId, isSiteAdmin, securityLevel, channelIds || []],
  )

  return result.rows.map(r => r.id)
}

module.exports = {
  ACCESS_DENIED_MESSAGE,
  getUserSecurityLevel,
  canAccessChannel,
  getAccessibleChannelIds,
}
