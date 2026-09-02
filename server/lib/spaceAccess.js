const PERSONAL = 'personal'

function normalizeUserId(user = {}) {
  const id = Number.parseInt(user?.id, 10)
  return Number.isFinite(id) ? id : null
}

async function getSpaceAccess(db, user = {}, teamId = '') {
  const userId = normalizeUserId(user)
  const safeTeamId = String(teamId || '').trim()
  if (!db || !userId || !safeTeamId) return null

  const { rows } = await db.query(
    `SELECT t.id, t.visibility, t.owner_id,
       EXISTS (SELECT 1 FROM team_admins ta WHERE ta.team_id=t.id AND ta.user_id=$2) AS is_admin,
       EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id=t.id AND tm.user_id=$2) AS is_member,
       pea.id AS emergency_id, pea.reason AS emergency_reason
     FROM teams t
     LEFT JOIN LATERAL (
       SELECT id, reason FROM personal_space_emergency_access
       WHERE team_id=t.id AND site_admin_id=$2 AND revoked_at IS NULL AND expires_at > NOW()
       ORDER BY expires_at DESC LIMIT 1
     ) pea ON $3::boolean
     WHERE t.id=$1 LIMIT 1`,
    [safeTeamId, userId, user.role === 'site_admin'],
  )
  return rows[0] || null
}

function decideSpaceAccess(row, user = {}, { manage = false } = {}) {
  if (!row) return { allowed: false, via: 'none' }
  if (row.visibility === PERSONAL) {
    const userId = normalizeUserId(user)
    if (userId && String(row.owner_id) === String(userId)) {
      return { allowed: true, via: 'space_owner' }
    }
    if (user.role === 'site_admin') {
      if (row.emergency_id) return { allowed: true, via: 'emergency' }
      return { allowed: false, via: 'private_denied' }
    }
    if (row.is_admin) return { allowed: true, via: 'space_admin' }
    return { allowed: false, via: 'private_denied' }
  }
  if (row.is_admin) return { allowed: true, via: 'space_admin' }
  if (user.role === 'site_admin') return { allowed: true, via: 'site_admin' }
  if (!manage && row.is_member) return { allowed: true, via: 'space_member' }
  return { allowed: false, via: 'membership_denied' }
}

async function authorizeSpace(db, user, teamId, options = {}) {
  const row = await getSpaceAccess(db, user, teamId)
  const decision = decideSpaceAccess(row, user, options)
  if (decision.allowed && decision.via === 'emergency' && options.auditAction) {
    await db.query(
      `INSERT INTO personal_space_audit_log(team_id, actor_id, action, reason, details)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [String(teamId), normalizeUserId(user), options.auditAction, row.emergency_reason, JSON.stringify(options.details || {})],
    )
  }
  return { ...decision, space: row }
}

async function getSearchAccessibleSpaceIds(db, user = {}, options = {}) {
  const userId = normalizeUserId(user)
  if (!db || !userId) return []

  const isSiteAdmin = user.role === 'site_admin'
  const { rows } = await db.query(
    `SELECT t.id, t.visibility, t.owner_id,
       (SELECT pea.reason
          FROM personal_space_emergency_access pea
         WHERE pea.team_id=t.id
           AND pea.site_admin_id=$1
           AND pea.revoked_at IS NULL
           AND pea.expires_at > NOW()
         ORDER BY pea.expires_at DESC LIMIT 1) AS emergency_reason
       FROM teams t
      WHERE (
        $2::boolean = true
        AND (
          t.visibility <> $3
          OR t.owner_id=$1
          OR EXISTS (
            SELECT 1
              FROM personal_space_emergency_access pea
             WHERE pea.team_id=t.id
               AND pea.site_admin_id=$1
               AND pea.revoked_at IS NULL
               AND pea.expires_at > NOW()
          )
        )
      ) OR (
        $2::boolean = false
        AND (
          t.owner_id=$1
          OR EXISTS (SELECT 1 FROM team_admins ta WHERE ta.team_id=t.id AND ta.user_id=$1)
          OR (t.visibility <> $3 AND EXISTS (
            SELECT 1 FROM team_members tm WHERE tm.team_id=t.id AND tm.user_id=$1
          ))
        )
      )
      ORDER BY t.id`,
    [userId, isSiteAdmin, PERSONAL],
  )
  if (isSiteAdmin && options.auditAction) {
    for (const row of rows) {
      if (row.visibility !== PERSONAL || String(row.owner_id) === String(userId) || !row.emergency_reason) continue
      await db.query(
        `INSERT INTO personal_space_audit_log(team_id,actor_id,action,reason,details)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [String(row.id), userId, options.auditAction, row.emergency_reason, JSON.stringify(options.details || {})],
      )
    }
  }
  return rows.map(row => String(row.id))
}

function accessError(message, status) {
  return Object.assign(new Error(message), { status })
}

async function grantEmergencyAccess(db, user = {}, teamId = '', options = {}) {
  const userId = normalizeUserId(user)
  const reason = String(options.reason || '').trim()
  const duration = Number.parseInt(options.durationMinutes, 10)
  if (user.role !== 'site_admin' || !userId) throw accessError('사이트 관리자 권한이 필요합니다.', 403)
  if (reason.length < 10) throw accessError('긴급 접근 사유는 10자 이상이어야 합니다.', 400)
  if (!Number.isFinite(duration) || duration < 1 || duration > 60) throw accessError('긴급 접근은 1~60분만 허용됩니다.', 400)
  const target = await db.query('SELECT id, owner_id FROM teams WHERE id=$1 AND visibility=$2', [String(teamId), PERSONAL])
  if (!target.rowCount) throw accessError('개인스페이스를 찾을 수 없습니다.', 404)
  if (String(target.rows[0].owner_id) === String(userId)) throw accessError('자신의 개인스페이스에는 긴급 접근이 필요하지 않습니다.', 400)
  const { rows } = await db.query(
    `WITH granted AS (
       INSERT INTO personal_space_emergency_access(team_id,site_admin_id,reason,expires_at)
       VALUES ($1,$2,$3,NOW()+($4::int*INTERVAL '1 minute')) RETURNING *
     ), logged AS (
       INSERT INTO personal_space_audit_log(team_id,actor_id,action,reason,details)
       SELECT team_id,$2,'emergency_granted',$3,jsonb_build_object('accessId',id,'durationMinutes',$4) FROM granted
     ) SELECT * FROM granted`,
    [String(teamId), userId, reason, duration],
  )
  return rows[0]
}

async function revokeEmergencyAccess(db, user = {}, accessId = '', reason = '') {
  const userId = normalizeUserId(user)
  const safeReason = String(reason || '').trim()
  if (user.role !== 'site_admin' || !userId) throw accessError('사이트 관리자 권한이 필요합니다.', 403)
  if (safeReason.length < 10) throw accessError('해제 사유는 10자 이상이어야 합니다.', 400)
  const { rows } = await db.query(
    `WITH revoked AS (
       UPDATE personal_space_emergency_access SET revoked_at=NOW()
       WHERE id=$1 AND site_admin_id=$2 AND revoked_at IS NULL RETURNING *
     ), logged AS (
       INSERT INTO personal_space_audit_log(team_id,actor_id,action,reason,details)
       SELECT team_id,$2,'emergency_revoked',$3,jsonb_build_object('accessId',id) FROM revoked
     ) SELECT * FROM revoked`,
    [accessId, userId, safeReason],
  )
  if (!rows[0]) throw accessError('활성 긴급 접근을 찾을 수 없습니다.', 404)
  return rows[0]
}
module.exports = {
  PERSONAL,
  getSpaceAccess,
  decideSpaceAccess,
  authorizeSpace,
  getSearchAccessibleSpaceIds,
  grantEmergencyAccess,
  revokeEmergencyAccess,
}
