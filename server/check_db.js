require('dotenv').config()
const pool = require('./db')

async function check() {
  try {
    const res = await pool.query("SELECT id, filename, thumbnail_path FROM attachments WHERE thumbnail_path IS NOT NULL;")
    console.log('--- Attachments with Thumbnails ---')
    console.table(res.rows)
  } catch (err) {
    console.error(err)
  } finally {
    process.exit()
  }
}

check()
