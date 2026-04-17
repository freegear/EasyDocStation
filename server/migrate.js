const { Pool } = require('pg');
const { getPostgresPoolOptions } = require('./runtimeDbConfig');
require('dotenv').config();

const pool = new Pool(getPostgresPoolOptions());

async function migrate() {
  try {
    console.log('Checking/Migrating database...');
    // Add image_url to users if not exists
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='image_url') THEN
          ALTER TABLE users ADD COLUMN image_url TEXT;
        END IF;
      END $$;
    `);
    console.log('Migration successful.');
  } catch (err) {
    console.error('Migration failed:', err.message);
  } finally {
    await pool.end();
  }
}

migrate();
