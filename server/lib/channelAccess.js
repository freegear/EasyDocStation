const ACCESS_DENIED_MESSAGE = '당신은 권한이 없습니다. 필요하시면 채널관리자/팀 관리자/채널관리자 에게 연락하여 주시기바랍니다.'

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
    SELECT 1
    FROM channels c
    WHERE c.id = $1
      AND (
        $3::boolean = true
        OR $4::int >= 4
        OR EXISTS (
          SELECT 1 FROM channel_admins ca
          WHERE ca.channel_id = c.id AND ca.user_id = $2
        )
        OR EXISTS (
          SELECT 1 FROM channel_members cm
          WHERE cm.channel_id = c.id AND cm.user_id = $2
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

  return result.rowCount > 0
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
    WHERE (
      $3::boolean = true
      OR $4::int >= 4
      OR EXISTS (
        SELECT 1 FROM channel_admins ca
        WHERE ca.channel_id = c.id AND ca.user_id = $2
      )
      OR EXISTS (
        SELECT 1 FROM channel_members cm
        WHERE cm.channel_id = c.id AND cm.user_id = $2
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
