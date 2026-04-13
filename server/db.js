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
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channels' AND column_name='is_archived') THEN
            ALTER TABLE channels ADD COLUMN is_archived BOOLEAN DEFAULT false;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channels' AND column_name='root_post_id') THEN
            ALTER TABLE channels ADD COLUMN root_post_id VARCHAR(50);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channels' AND column_name='tail_post_id') THEN
            ALTER TABLE channels ADD COLUMN tail_post_id VARCHAR(50);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attachments' AND column_name='thumbnail_path') THEN
            ALTER TABLE attachments ADD COLUMN thumbnail_path TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attachments' AND column_name='uploader_id') THEN
            ALTER TABLE attachments ADD COLUMN uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='department_id') THEN
            ALTER TABLE users ADD COLUMN department_id VARCHAR(100) REFERENCES teams(id) ON DELETE SET NULL;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='security_level') THEN
            ALTER TABLE users ADD COLUMN security_level INTEGER NOT NULL DEFAULT 0 CHECK (security_level BETWEEN 0 AND 4);
          END IF;
          -- posts 테이블 컬럼 추가
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='posts' AND column_name='security_level') THEN
            ALTER TABLE posts ADD COLUMN security_level INTEGER NOT NULL DEFAULT 0;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='posts' AND column_name='is_edited') THEN
            ALTER TABLE posts ADD COLUMN is_edited BOOLEAN DEFAULT false;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='posts' AND column_name='prev_post_id') THEN
            ALTER TABLE posts ADD COLUMN prev_post_id VARCHAR(50);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='posts' AND column_name='next_post_id') THEN
            ALTER TABLE posts ADD COLUMN next_post_id VARCHAR(50);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='posts' AND column_name='child_post_id') THEN
            ALTER TABLE posts ADD COLUMN child_post_id VARCHAR(50);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='posts' AND column_name='parent_id') THEN
            ALTER TABLE posts ADD COLUMN parent_id VARCHAR(50);
          END IF;
          FOR i IN 1..10 LOOP
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='posts' AND column_name='attachments_' || i) THEN
              EXECUTE 'ALTER TABLE posts ADD COLUMN attachments_' || i || ' VARCHAR(50)';
            END IF;
          END LOOP;
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
          security_level INTEGER    NOT NULL DEFAULT 0,
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
