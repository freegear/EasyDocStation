const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { randomUUID } = require('crypto')
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
    phone: u.phone ?? null,
    telegram_id: u.telegram_id ?? null,
    kakaotalk_api_key: u.kakaotalk_api_key ?? null,
    line_channel_access_token: u.line_channel_access_token ?? null,
    use_sns_channel: u.use_sns_channel ?? null,
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
  const { identifier, email, username, password, forceRelogin } = req.body
  const loginId = String(identifier || username || email || '').trim()
  if (!loginId || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' })

  try {
    const normalizedId = loginId.toLowerCase()
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE lower(username) = $1 OR lower(email) = $1 LIMIT 1',
      [normalizedId]
    )
    const user = rows[0]

    // 계정이 없는 경우
    if (!user) {
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' })
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

    // 중복 로그인 체크: active_session_id가 있고 JWT 유효 기간(7일) 이내이면 차단
    if (user.active_session_id && !forceRelogin) {
      const loginAge = user.last_login_at
        ? Date.now() - new Date(user.last_login_at).getTime()
        : 0
      const JWT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000
      if (!user.last_login_at || loginAge < JWT_EXPIRY_MS) {
        return res.status(409).json({
          error: '이미 동일한 정보로 로그인 되어 있습니다.',
          code: 'DUPLICATE_LOGIN',
        })
      }
    }

    // 로그인 성공 — 실패 횟수 초기화 및 세션 ID 갱신
    const newSessionId = randomUUID()
    await pool.query(
      'UPDATE users SET failed_login_attempts = 0, last_login_at = NOW(), active_session_id = $2 WHERE id = $1',
      [user.id, newSessionId]
    )
    await pool.query(
      'INSERT INTO login_history (user_id, ip_address, user_agent) VALUES ($1, $2, $3)',
      [user.id, req.ip, req.headers['user-agent']]
    )

    // session_id를 JWT에 포함 → /auth/me에서 검증
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, security_level: user.security_level || 0, session_id: newSessionId },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    )

    res.json({ token, user: { ...toPublicUser(user), last_login_at: new Date().toISOString() } })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// POST /api/auth/logout
router.post('/logout', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE users SET active_session_id = NULL WHERE id = $1', [req.user.id])
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id])
    if (!rows[0]) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' })
    const user = rows[0]

    // 세션 유효성 검사: DB의 active_session_id와 JWT의 session_id가 일치해야 함
    // active_session_id가 DB에 있는데 JWT session_id가 다르면 다른 기기에서 로그인된 것
    if (user.active_session_id && req.user.session_id !== user.active_session_id) {
      return res.status(401).json({ error: '다른 기기에서 로그인되었습니다.', code: 'SESSION_INVALIDATED' })
    }

    res.json(toPublicUser(user))
  } catch (err) {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// PUT /api/auth/me — update own profile
router.put('/me', requireAuth, async (req, res) => {
  const {
    name, display_name, email, phone, image_url, stamp_picture, currentPassword, newPassword,
    telegram_id, kakaotalk_api_key, line_channel_access_token, use_sns_channel,
  } = req.body
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id])
    const user = rows[0]

    const sets = []
    const vals = []
    let i = 1

    if (name?.trim()) { sets.push(`name = $${i++}`); vals.push(name.trim()) }
    if (display_name !== undefined) { sets.push(`display_name = $${i++}`); vals.push(display_name?.trim() || null) }
    if (email?.trim()) { sets.push(`email = $${i++}`); vals.push(email.trim().toLowerCase()) }
    if (phone !== undefined) { sets.push(`phone = $${i++}`); vals.push(phone?.trim() || null) }
    if (telegram_id !== undefined) { sets.push(`telegram_id = $${i++}`); vals.push(telegram_id?.trim() || null) }
    if (kakaotalk_api_key !== undefined) { sets.push(`kakaotalk_api_key = $${i++}`); vals.push(kakaotalk_api_key?.trim() || null) }
    if (line_channel_access_token !== undefined) { sets.push(`line_channel_access_token = $${i++}`); vals.push(line_channel_access_token?.trim() || null) }
    if (use_sns_channel !== undefined) {
      if (use_sns_channel !== null && use_sns_channel !== '' && !['telegram', 'kakaotalk', 'line'].includes(use_sns_channel)) {
        return res.status(400).json({ error: 'UseSNSChannel 값이 올바르지 않습니다.' })
      }
      sets.push(`use_sns_channel = $${i++}`); vals.push(use_sns_channel || null)
    }
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
