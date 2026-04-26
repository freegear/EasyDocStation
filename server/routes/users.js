const express = require('express')
const bcrypt = require('bcryptjs')
const pool = require('../db')
const requireAuth = require('../middleware/auth')

const router = express.Router()
router.use(requireAuth)
const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.]*$/

function toPublicUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    display_name: u.display_name ?? null,
    email: u.email,
    phone: u.phone ?? null,
    telegram_id: u.telegram_id ?? null,
    kakaotalk_api_key: u.kakaotalk_api_key ?? null,
    line_channel_access_token: u.line_channel_access_token ?? null,
    use_sns_channel: u.use_sns_channel ?? null,
    role: u.role,
    is_active: u.is_active,
    avatar: u.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2),
    image_url: u.image_url,
    stamp_picture: u.stamp_picture ?? null,
    last_login_at: u.last_login_at,
    created_at: u.created_at,
    department_id: u.department_id ?? null,
    security_level: u.security_level ?? 0,
  }
}

function requireSiteAdmin(req, res, next) {
  if (req.user.role !== 'site_admin') {
    return res.status(403).json({ error: '사이트 관리자 권한이 필요합니다.' })
  }
  next()
}

// ─── Permission check helpers ─────────────────────────────────
function canAssignRole(requesterRole, targetRole) {
  // site_admin can assign any role
  if (requesterRole === 'site_admin') return true
  // team_admin can assign team_admin, channel_admin, user
  if (requesterRole === 'team_admin' && targetRole !== 'site_admin') return true
  return false
}

// GET /api/users/search — search users by username or name prefix
router.get('/search', async (req, res) => {
  const { q } = req.query
  if (!q) return res.json([])

  try {
    const { rows } = await pool.query(
      `SELECT id, username, name, email, role, is_active, image_url FROM users
       WHERE (username ILIKE $1 OR name ILIKE $1)
       AND is_active = true
       ORDER BY username
       LIMIT 10`,
      [`${q}%`]
    )
    res.json(rows.map(toPublicUser))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// GET /api/users — site admin only
router.get('/', requireSiteAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM users ORDER BY
         CASE role
           WHEN 'site_admin'    THEN 1
           WHEN 'team_admin'    THEN 2
           WHEN 'channel_admin' THEN 3
           ELSE 4
         END, created_at DESC`
    )
    res.json(rows.map(toPublicUser))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// GET /api/users/:id/basic — any authenticated user (calendar owner display fallback)
router.get('/:id/basic', async (req, res) => {
  const targetId = parseInt(req.params.id, 10)
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: '유효하지 않은 사용자 ID입니다.' })
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, username, name, display_name, image_url FROM users WHERE id = $1 LIMIT 1',
      [targetId]
    )
    if (!rows[0]) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' })
    const row = rows[0]
    res.json({
      id: row.id,
      username: row.username ?? null,
      name: row.name ?? null,
      displayName: row.display_name ?? null,
      imageUrl: row.image_url ?? null,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// POST /api/users — site admin only
router.post('/', requireSiteAdmin, async (req, res) => {
  const {
    username, name, display_name, email, phone, password, role, image_url, stamp_picture, department_id, security_level, is_active,
    telegram_id, kakaotalk_api_key, line_channel_access_token, use_sns_channel,
  } = req.body
  if (!username || !name || !email || !password) {
    return res.status(400).json({ error: '필수 항목을 모두 입력하세요.' })
  }
  const normalizedUsername = username.trim()
  if (!USERNAME_PATTERN.test(normalizedUsername)) {
    return res.status(400).json({
      error: '아이디 형식이 올바르지 않습니다. 첫 글자는 영문자여야 하며 이후에는 영문/숫자/밑줄(_)과 마침표(.)만 사용할 수 있습니다.'
    })
  }
  const assignRole = role || 'user'
  if (!canAssignRole(req.user.role, assignRole)) {
    return res.status(403).json({ error: '해당 권한을 부여할 수 없습니다.' })
  }
  const secLevel = (security_level !== undefined && security_level !== null) ? parseInt(security_level) : 0
  const active = is_active !== undefined ? is_active : true
  const useSns = use_sns_channel || null
  if (useSns && !['telegram', 'kakaotalk', 'line'].includes(useSns)) {
    return res.status(400).json({ error: 'UseSNSChannel 값이 올바르지 않습니다.' })
  }

  try {
    const hash = await bcrypt.hash(password, 10)
    const { rows } = await pool.query(
      `INSERT INTO users (username, name, display_name, email, phone, password_hash, role, image_url, stamp_picture, department_id, security_level, is_active, telegram_id, kakaotalk_api_key, line_channel_access_token, use_sns_channel)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
      [normalizedUsername, name.trim(), display_name?.trim() || null, email.trim().toLowerCase(), phone?.trim() || null, hash, assignRole,
       image_url || null, stamp_picture || null, department_id || null, secLevel, active,
       telegram_id?.trim() || null, kakaotalk_api_key?.trim() || null, line_channel_access_token?.trim() || null, useSns]
    )
    res.status(201).json(toPublicUser(rows[0]))
  } catch (err) {
    console.error('POST /users error:', err)
    if (err.code === '23505') return res.status(400).json({ error: '이미 사용 중인 아이디 또는 이메일입니다.' })
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// PUT /api/users/:id — site admin only
router.put('/:id', requireSiteAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id)
  const {
    name, display_name, email, phone, role, password, is_active, image_url, stamp_picture, department_id, security_level,
    telegram_id, kakaotalk_api_key, line_channel_access_token, use_sns_channel,
  } = req.body

  if (role && !canAssignRole(req.user.role, role)) {
    return res.status(403).json({ error: '해당 권한을 부여할 수 없습니다.' })
  }

  if (use_sns_channel !== undefined && use_sns_channel !== null && use_sns_channel !== '' && !['telegram', 'kakaotalk', 'line'].includes(use_sns_channel)) {
    return res.status(400).json({ error: 'UseSNSChannel 값이 올바르지 않습니다.' })
  }

  try {
    const sets = []
    const vals = []
    let i = 1

    if (name !== undefined)             { sets.push(`name = $${i++}`);             vals.push(name.trim()) }
    if (display_name !== undefined)     { sets.push(`display_name = $${i++}`);     vals.push(display_name?.trim() || null) }
    if (email !== undefined)            { sets.push(`email = $${i++}`);            vals.push(email.trim().toLowerCase()) }
    if (phone !== undefined)            { sets.push(`phone = $${i++}`);            vals.push(phone?.trim() || null) }
    if (role !== undefined)             { sets.push(`role = $${i++}`);             vals.push(role) }
    if (is_active !== undefined)        { sets.push(`is_active = $${i++}`);        vals.push(is_active) }
    if (image_url !== undefined)        { sets.push(`image_url = $${i++}`);        vals.push(image_url) }
    if (stamp_picture !== undefined)    { sets.push(`stamp_picture = $${i++}`);    vals.push(stamp_picture || null) }
    if (department_id !== undefined)    { sets.push(`department_id = $${i++}`);    vals.push(department_id || null) }
    if (security_level !== undefined)   { sets.push(`security_level = $${i++}`);   vals.push(parseInt(security_level)) }
    if (telegram_id !== undefined)      { sets.push(`telegram_id = $${i++}`);      vals.push(telegram_id?.trim() || null) }
    if (kakaotalk_api_key !== undefined) { sets.push(`kakaotalk_api_key = $${i++}`); vals.push(kakaotalk_api_key?.trim() || null) }
    if (line_channel_access_token !== undefined) { sets.push(`line_channel_access_token = $${i++}`); vals.push(line_channel_access_token?.trim() || null) }
    if (use_sns_channel !== undefined)  { sets.push(`use_sns_channel = $${i++}`);  vals.push(use_sns_channel || null) }
    if (password) {
      const hash = await bcrypt.hash(password, 10)
      sets.push(`password_hash = $${i++}`); vals.push(hash)
    }

    if (sets.length === 0) return res.status(400).json({ error: '변경할 내용이 없습니다.' })

    vals.push(targetId)
    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    )
    if (!rows[0]) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' })
    res.json(toPublicUser(rows[0]))
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: '이미 사용 중인 이메일입니다.' })
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// DELETE /api/users/:id — site admin only
router.delete('/:id', requireSiteAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id)
  if (targetId === req.user.id) {
    return res.status(400).json({ error: '자신의 계정은 삭제할 수 없습니다.' })
  }
  try {
    const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [targetId])
    if (rowCount === 0) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// GET /api/users/:id/login-history — site admin only
router.get('/:id/login-history', requireSiteAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, logged_in_at, ip_address FROM login_history WHERE user_id = $1 ORDER BY logged_in_at DESC LIMIT 20',
      [parseInt(req.params.id)]
    )
    res.json(rows)
  } catch (err) {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

module.exports = router
