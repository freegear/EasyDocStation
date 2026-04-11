const { Pool } = require('pg');
require('dotenv').config({ path: './server/.env' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function getInfo() {
  try {
    const res = await pool.query('SHOW data_directory');
    console.log('Current Data Directory:', res.rows[0].data_directory);
    const version = await pool.query('SELECT version()');
    console.log('PG Version:', version.rows[0].version);
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

getInfo();
