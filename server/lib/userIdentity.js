const crypto = require('crypto')
const pool = require('../db')

function normalizeEmail(raw = '') {
  return String(raw || '').trim().toLowerCase()
}

function slugifyBase(raw = '') {
  return String(raw || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_.-]/g, '')
    .replace(/^[^A-Za-z]+/, '')
    .slice(0, 40)
}

async function generateUniqueUsername(base = 'user') {
  const seed = slugifyBase(base) || 'user'
  for (let i = 0; i < 8; i += 1) {
    const suffix = i === 0 ? '' : `_${Math.floor(Math.random() * 10000)}`
    const candidate = `${seed}${suffix}`.slice(0, 50)
    const { rows } = await pool.query('SELECT 1 FROM users WHERE lower(username) = lower($1) LIMIT 1', [candidate])
    if (!rows[0]) return candidate
  }
  return `user_${crypto.randomBytes(4).toString('hex')}`.slice(0, 50)
}

async function resolveOrProvisionUserBySupabaseClaims(claims = {}) {
  const supabaseUserId = String(claims.sub || '').trim()
  const email = normalizeEmail(claims.email || '')
  const fullName = String(claims.user_metadata?.full_name || claims.user_metadata?.name || claims.email || 'User').trim()
  if (!supabaseUserId) return null

  let query = await pool.query('SELECT * FROM users WHERE supabase_user_id = $1 LIMIT 1', [supabaseUserId])
  if (query.rows[0]) return query.rows[0]

  if (email) {
    query = await pool.query('SELECT * FROM users WHERE lower(email) = $1 LIMIT 1', [email])
    if (query.rows[0]) {
      const linked = await pool.query(
        'UPDATE users SET supabase_user_id = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [supabaseUserId, query.rows[0].id]
      )
      return linked.rows[0]
    }
  }

  const usernameBase = email ? email.split('@')[0] : `user_${supabaseUserId.slice(0, 8)}`
  const username = await generateUniqueUsername(usernameBase)
  const passwordHash = `supabase:${supabaseUserId}`
  const insert = await pool.query(
    `INSERT INTO users (username, password_hash, name, email, role, is_active, failed_login_attempts, supabase_user_id)
     VALUES ($1, $2, $3, $4, 'user', true, 0, $5)
     RETURNING *`,
    [username, passwordHash, fullName || username, email || `${username}@local.invalid`, supabaseUserId]
  )
  return insert.rows[0]
}

module.exports = {
  resolveOrProvisionUserBySupabaseClaims,
}
