const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { randomUUID } = require('crypto')
const pool = require('../db')
const requireAuth = require('../middleware/auth')
const { getAuthCookieOptions, getAuthCookieClearOptions } = require('../lib/authToken')
const { encryptSecret, maskSecret, isMaskedValue } = require('../lib/secrets')

const router = express.Router()

async function getUsersColumnSupport() {
  const { rows } = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'users'`
  )
  const names = new Set(rows.map(r => String(r.column_name || '')))
  return {
    hasFailedLoginAttempts: names.has('failed_login_attempts'),
    hasActiveSessionId: names.has('active_session_id'),
    hasLastLoginAt: names.has('last_login_at'),
  }
}

function toPublicUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    display_name: u.display_name ?? null,
    email: u.email,
    phone: u.phone ?? null,
    telegram_id: u.telegram_id ?? null,
    kakaotalk_api_key: maskSecret(u.kakaotalk_api_key),
    line_channel_access_token: maskSecret(u.line_channel_access_token),
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

async function issueLegacySessionCookie(res, user, meta = {}, columnSupport = null) {
  const cs = columnSupport || await getUsersColumnSupport()
  const newSessionId = randomUUID()
  const sets = []
  const vals = []
  let i = 1
  if (cs.hasFailedLoginAttempts) {
    sets.push(`failed_login_attempts = $${i++}`)
    vals.push(0)
  }
  if (cs.hasLastLoginAt) {
    sets.push('last_login_at = NOW()')
  }
  if (cs.hasActiveSessionId) {
    sets.push(`active_session_id = $${i++}`)
    vals.push(newSessionId)
  }
  if (sets.length > 0) {
    vals.push(user.id)
    await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${i}`, vals)
  }
  await pool.query(
    'INSERT INTO login_history (user_id, ip_address, user_agent) VALUES ($1, $2, $3)',
    [user.id, meta.ip, meta.userAgent]
  )
  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, security_level: user.security_level || 0, session_id: newSessionId },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  )
  res.cookie('eds_auth', token, getAuthCookieOptions())
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { identifier, email, username, password, forceRelogin } = req.body
  const loginId = String(identifier || username || email || '').trim()
  if (!loginId || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' })

  try {
    const columnSupport = await getUsersColumnSupport()
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
      if (columnSupport.hasFailedLoginAttempts) {
        const newAttempts = (user.failed_login_attempts || 0) + 1

        if (newAttempts >= MAX_FAILED_ATTEMPTS) {
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

      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' })
    }

    // 중복 로그인 체크: active_session_id가 있고 JWT 유효 기간(7일) 이내이면 차단
    if (columnSupport.hasActiveSessionId && user.active_session_id && !forceRelogin) {
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

    await issueLegacySessionCookie(res, user, { ip: req.ip, userAgent: req.headers['user-agent'] }, columnSupport)
    res.json({ user: { ...toPublicUser(user), last_login_at: new Date().toISOString() } })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// POST /api/auth/supabase/exchange
// Supabase Bearer token을 검증한 뒤 EasyStation 세션 쿠키를 발급한다.
router.post('/supabase/exchange', requireAuth, async (req, res) => {
  try {
    if (req.authProvider !== 'supabase') {
      return res.status(400).json({ error: 'Supabase 인증 토큰이 필요합니다.' })
    }
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id])
    if (!rows[0]) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' })
    const user = rows[0]
    const columnSupport = await getUsersColumnSupport()
    await issueLegacySessionCookie(res, user, { ip: req.ip, userAgent: req.headers['user-agent'] }, columnSupport)
    res.json({ ok: true })
  } catch (err) {
    console.error('[auth/supabase/exchange]', err)
    res.status(500).json({ error: '세션 교환 중 오류가 발생했습니다.' })
  }
})

// POST /api/auth/logout
router.post('/logout', requireAuth, async (req, res) => {
  try {
    const columnSupport = await getUsersColumnSupport()
    if (req.authProvider !== 'supabase' && columnSupport.hasActiveSessionId) {
      await pool.query('UPDATE users SET active_session_id = NULL WHERE id = $1', [req.user.id])
    }
    res.clearCookie('eds_auth', getAuthCookieClearOptions())
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const columnSupport = await getUsersColumnSupport()
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id])
    if (!rows[0]) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' })
    const user = rows[0]

    // Legacy JWT session validation only
    if (req.authProvider !== 'supabase' && columnSupport.hasActiveSessionId) {
      if (!user.active_session_id || req.user.session_id !== user.active_session_id) {
        return res.status(401).json({ error: '세션이 만료되었습니다. 다시 로그인해 주세요.', code: 'SESSION_INVALIDATED' })
      }
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
    if (kakaotalk_api_key !== undefined && !isMaskedValue(kakaotalk_api_key)) {
      const plain = kakaotalk_api_key?.trim() || null
      sets.push(`kakaotalk_api_key = $${i++}`)
      vals.push(plain ? encryptSecret(plain) : null)
    }
    if (line_channel_access_token !== undefined && !isMaskedValue(line_channel_access_token)) {
      const plain = line_channel_access_token?.trim() || null
      sets.push(`line_channel_access_token = $${i++}`)
      vals.push(plain ? encryptSecret(plain) : null)
    }
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
