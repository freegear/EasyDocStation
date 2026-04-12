const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

// Auto-migration on startup
async function initDb() {
  try {
    const client = await pool.connect()
    try {
      // users 테이블 image_url 컬럼 추가
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='image_url') THEN
            ALTER TABLE users ADD COLUMN image_url TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channels' AND column_name='description') THEN
            ALTER TABLE channels ADD COLUMN description TEXT;
          END IF;
        END $$;
      `)
      // comments 테이블 생성 (없는 경우)
      await client.query(`
        CREATE TABLE IF NOT EXISTS comments (
          id          VARCHAR(50)  PRIMARY KEY,
          post_id     VARCHAR(50)  NOT NULL,
          channel_id  VARCHAR(50)  NOT NULL,
          author_id   INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          content     TEXT         NOT NULL,
          attachments JSONB        NOT NULL DEFAULT '[]',
          created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
      `)
      console.log('✅ Database migration complete.')
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
