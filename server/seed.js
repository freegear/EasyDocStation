/**
 * Seed initial users.
 * Usage: npm run seed
 */
require('dotenv').config()
const bcrypt = require('bcryptjs')
const pool = require('./db')

const SEED_USERS = [
  { username: 'kevin',  name: 'Kevin Im',  email: 'kevin@easydocstation.com', password: 'password123', role: 'site_admin' },
  { username: 'alice',  name: 'Alice Kim', email: 'alice@easydocstation.com', password: 'password123', role: 'team_admin' },
  { username: 'bob',    name: 'Bob Lee',   email: 'bob@easydocstation.com',   password: 'password123', role: 'channel_admin' },
  { username: 'carol',  name: 'Carol Park',email: 'carol@easydocstation.com', password: 'password123', role: 'user' },
]

async function seed() {
  console.log('🌱 Seeding users...')
  for (const u of SEED_USERS) {
    const hash = await bcrypt.hash(u.password, 10)
    await pool.query(
      `INSERT INTO users (username, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE
         SET name = EXCLUDED.name,
             role = EXCLUDED.role,
             updated_at = NOW()`,
      [u.username, u.name, u.email, hash, u.role]
    )
    console.log(`  ✓ ${u.role.padEnd(15)} ${u.email}`)
  }
  console.log('✅ Seed complete. Password for all users: password123')
  process.exit(0)
}

seed().catch(err => { console.error(err); process.exit(1) })
