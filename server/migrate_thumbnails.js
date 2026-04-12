const pool = require('./db')

async function migrate() {
  try {
    await pool.query('ALTER TABLE attachments ADD COLUMN IF NOT EXISTS thumbnail_path TEXT;')
    console.log('✅ Added thumbnail_path column to attachments table')
  } catch (err) {
    console.error('❌ Migration failed:', err.message)
  } finally {
    process.exit()
  }
}

migrate()
