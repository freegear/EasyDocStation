const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const pool = require('../db')
const requireAuth = require('../middleware/auth')

const router = express.Router()

function toPublicUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    display_name: u.display_name ?? null,
    email: u.email,
    role: u.role,
    is_active: u.is_active,
    avatar: (u.display_name || u.name).split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2),
    image_url: u.image_url,
    stamp_picture: u.stamp_picture ?? null,
    security_level: u.security_level || 0,
    department_id: u.department_id ?? null,
    last_login_at: u.last_login_at,
    created_at: u.created_at,
  }
}

const MAX_FAILED_ATTEMPTS = 3

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: '이메일과 비밀번호를 입력하세요.' })

  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email.trim().toLowerCase()]
    )
    const user = rows[0]

    // 계정이 없는 경우
    if (!user) {
      return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' })
    }

    // 계정이 비활성화된 경우 (잠김)
    if (!user.is_active) {
      return res.status(401).json({ error: '계정이 잠겼습니다. 관리자에게 문의하세요.', code: 'ACCOUNT_LOCKED' })
    }

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      const newAttempts = (user.failed_login_attempts || 0) + 1

      if (newAttempts >= MAX_FAILED_ATTEMPTS) {
        // 3회 이상 실패 → 계정 비활성화
        await pool.query(
          'UPDATE users SET failed_login_attempts = $1, is_active = false WHERE id = $2',
          [newAttempts, user.id]
        )
        return res.status(401).json({
          error: `비밀번호를 ${MAX_FAILED_ATTEMPTS}회 이상 틀렸습니다. 계정이 잠겼습니다. 관리자에게 문의하세요.`,
          code: 'ACCOUNT_LOCKED',
        })
      }

      await pool.query(
        'UPDATE users SET failed_login_attempts = $1 WHERE id = $2',
        [newAttempts, user.id]
      )
      return res.status(401).json({
        error: `비밀번호가 올바르지 않습니다. (${newAttempts}/${MAX_FAILED_ATTEMPTS}회 실패)`,
      })
    }

    // 로그인 성공 — 실패 횟수 초기화 및 기록
    await pool.query(
      'UPDATE users SET failed_login_attempts = 0, last_login_at = NOW() WHERE id = $1',
      [user.id]
    )
    await pool.query(
      'INSERT INTO login_history (user_id, ip_address, user_agent) VALUES ($1, $2, $3)',
      [user.id, req.ip, req.headers['user-agent']]
    )

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, security_level: user.security_level || 0 },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    )

    res.json({ token, user: { ...toPublicUser(user), last_login_at: new Date().toISOString() } })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id])
    if (!rows[0]) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' })
    res.json(toPublicUser(rows[0]))
  } catch (err) {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// PUT /api/auth/me — update own profile
router.put('/me', requireAuth, async (req, res) => {
  const { name, email, image_url, stamp_picture, currentPassword, newPassword } = req.body
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id])
    const user = rows[0]

    const sets = []
    const vals = []
    let i = 1

    if (name?.trim()) { sets.push(`name = $${i++}`); vals.push(name.trim()) }
    if (email?.trim()) { sets.push(`email = $${i++}`); vals.push(email.trim().toLowerCase()) }
    if (image_url !== undefined) { sets.push(`image_url = $${i++}`); vals.push(image_url) }
    if (stamp_picture !== undefined) { sets.push(`stamp_picture = $${i++}`); vals.push(stamp_picture || null) }

    if (newPassword) {
      if (!currentPassword) return res.status(400).json({ error: '현재 비밀번호를 입력하세요.' })
      const ok = await bcrypt.compare(currentPassword, user.password_hash)
      if (!ok) return res.status(400).json({ error: '현재 비밀번호가 올바르지 않습니다.' })
      const hash = await bcrypt.hash(newPassword, 10)
      sets.push(`password_hash = $${i++}`); vals.push(hash)
    }

    if (sets.length === 0) return res.status(400).json({ error: '변경할 내용이 없습니다.' })

    vals.push(user.id)
    const { rows: updated } = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    )
    res.json(toPublicUser(updated[0]))
  } catch (err) {
    console.error('Profile update error:', err)
    if (err.code === '23505') return res.status(400).json({ error: '이미 사용 중인 이메일입니다.' })
    res.status(500).json({ error: '서버 오류가 발생했습니다: ' + err.message })
  }
})

module.exports = router
