const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

// Auto-migration on startup
async function initDb() {
  try {
    const client = await pool.connect()
    try {
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='image_url') THEN
            ALTER TABLE users ADD COLUMN image_url TEXT;
          END IF;
        END $$;
      `)
      console.log('✅ Database migration: users.image_url column checked/added.')
    } finally {
      client.release()
    }
  } catch (err) {
    console.error('❌ Database initialization error:', err)
  }
}

initDb()

pool.on('error', (err) => {
  console.error('PostgreSQL connection error:', err)
})

module.exports = pool
