const express = require('express')
const bcrypt = require('bcryptjs')
const pool = require('../db')
const requireAuth = require('../middleware/auth')

const router = express.Router()
router.use(requireAuth)

function toPublicUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    email: u.email,
    role: u.role,
    is_active: u.is_active,
    avatar: u.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2),
    image_url: u.image_url,
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

// GET /api/users/search — search users by username prefix
router.get('/search', async (req, res) => {
  const { q } = req.query
  if (!q) return res.json([])

  try {
    const { rows } = await pool.query(
      `SELECT id, username, name, email, role, is_active, image_url FROM users
       WHERE username ILIKE $1
       AND is_active = true
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

// POST /api/users — site admin only
router.post('/', requireSiteAdmin, async (req, res) => {
  const { username, name, email, password, role, image_url, department_id, security_level, is_active } = req.body
  if (!username || !name || !email || !password) {
    return res.status(400).json({ error: '필수 항목을 모두 입력하세요.' })
  }
  const assignRole = role || 'user'
  if (!canAssignRole(req.user.role, assignRole)) {
    return res.status(403).json({ error: '해당 권한을 부여할 수 없습니다.' })
  }
  const secLevel = (security_level !== undefined && security_level !== null) ? parseInt(security_level) : 0
  const active = is_active !== undefined ? is_active : true
  try {
    const hash = await bcrypt.hash(password, 10)
    const { rows } = await pool.query(
      `INSERT INTO users (username, name, email, password_hash, role, image_url, department_id, security_level, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [username.trim(), name.trim(), email.trim().toLowerCase(), hash, assignRole, image_url || null,
       department_id || null, secLevel, active]
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
  const { name, email, role, password, is_active, image_url, department_id, security_level } = req.body

  if (role && !canAssignRole(req.user.role, role)) {
    return res.status(403).json({ error: '해당 권한을 부여할 수 없습니다.' })
  }

  try {
    const sets = []
    const vals = []
    let i = 1

    if (name !== undefined)             { sets.push(`name = $${i++}`);             vals.push(name.trim()) }
    if (email !== undefined)            { sets.push(`email = $${i++}`);            vals.push(email.trim().toLowerCase()) }
    if (role !== undefined)             { sets.push(`role = $${i++}`);             vals.push(role) }
    if (is_active !== undefined)        { sets.push(`is_active = $${i++}`);        vals.push(is_active) }
    if (image_url !== undefined)        { sets.push(`image_url = $${i++}`);        vals.push(image_url) }
    if (department_id !== undefined)    { sets.push(`department_id = $${i++}`);    vals.push(department_id || null) }
    if (security_level !== undefined)   { sets.push(`security_level = $${i++}`);   vals.push(parseInt(security_level)) }
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
