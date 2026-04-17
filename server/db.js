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
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='stamp_picture') THEN
            ALTER TABLE users ADD COLUMN stamp_picture TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='display_name') THEN
            ALTER TABLE users ADD COLUMN display_name TEXT;
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
      // calendar_events 테이블 생성
      await client.query(`
        CREATE TABLE IF NOT EXISTS calendar_events (
          id            SERIAL        PRIMARY KEY,
          owner_id      INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title         TEXT          NOT NULL DEFAULT '',
          color         VARCHAR(20)   NOT NULL DEFAULT '#4f46e5',
          all_day       BOOLEAN       NOT NULL DEFAULT false,
          start_dt      JSONB         NOT NULL DEFAULT '{}',
          end_dt        JSONB         NOT NULL DEFAULT '{}',
          repeat        VARCHAR(20)   NOT NULL DEFAULT 'none',
          invitees      JSONB         NOT NULL DEFAULT '[]',
          memo          TEXT          NOT NULL DEFAULT '',
          security_level INTEGER      NOT NULL DEFAULT 0,
          remind_dt     JSONB         NOT NULL DEFAULT '{}',
          remind_repeat VARCHAR(20)   NOT NULL DEFAULT 'none',
          series_id     VARCHAR(36),
          created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
          updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_calendar_events_owner ON calendar_events(owner_id);
        CREATE INDEX IF NOT EXISTS idx_calendar_events_series ON calendar_events(series_id);
      `)
      // series_id 컬럼 추가 (기존 테이블용)
      await client.query(`
        ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS series_id VARCHAR(36);
        CREATE INDEX IF NOT EXISTS idx_calendar_events_series ON calendar_events(series_id);
      `)
      // calendar_events.id: SERIAL → TEXT(UUID) 마이그레이션
      await client.query(`
        DO $$
        BEGIN
          IF (SELECT data_type FROM information_schema.columns
              WHERE table_name='calendar_events' AND column_name='id') = 'integer' THEN
            ALTER TABLE calendar_events DROP CONSTRAINT calendar_events_pkey;
            ALTER TABLE calendar_events ALTER COLUMN id DROP DEFAULT;
            ALTER TABLE calendar_events ALTER COLUMN id TYPE TEXT USING gen_random_uuid()::text;
            ALTER TABLE calendar_events ADD PRIMARY KEY (id);
          END IF;
        END $$;
      `)
      // calendar_invitations 테이블 생성 (PostgreSQL)
      await client.query(`
        CREATE TABLE IF NOT EXISTS calendar_invitations (
          invitee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          event_id   TEXT    NOT NULL,
          owner_id   INTEGER NOT NULL,
          PRIMARY KEY (invitee_id, event_id)
        );
        CREATE INDEX IF NOT EXISTS idx_cal_inv_event ON calendar_invitations(event_id);
      `)
      // expense_doc_counter 테이블 생성 (날짜별 순번 관리)
      await client.query(`
        CREATE TABLE IF NOT EXISTS expense_doc_counter (
          date_key CHAR(8) PRIMARY KEY,
          last_seq INTEGER NOT NULL DEFAULT 0
        );
      `)
      // trip_doc_counter 테이블 생성 (날짜별 순번 관리)
      await client.query(`
        CREATE TABLE IF NOT EXISTS trip_doc_counter (
          date_key CHAR(8) PRIMARY KEY,
          last_seq INTEGER NOT NULL DEFAULT 0
        );
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
      // dm_conversations 테이블 생성 (21. Direct Message)
      await client.query(`
        CREATE TABLE IF NOT EXISTS dm_conversations (
          id           VARCHAR(36)  PRIMARY KEY,
          name         TEXT         NOT NULL DEFAULT '',
          created_by   INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          participants JSONB        NOT NULL DEFAULT '[]',
          created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
          updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_dm_conv_created ON dm_conversations(created_by);
      `)
      // dm_messages 테이블 생성
      await client.query(`
        CREATE TABLE IF NOT EXISTS dm_messages (
          id              VARCHAR(36)  PRIMARY KEY,
          conversation_id VARCHAR(36)  NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
          sender_id       INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          content         TEXT         NOT NULL DEFAULT '',
          attachments     JSONB        NOT NULL DEFAULT '[]',
          is_edited       BOOLEAN      NOT NULL DEFAULT false,
          created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_dm_msg_conv ON dm_messages(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_dm_msg_sender ON dm_messages(sender_id);
      `)
      // dm_messages read_by 컬럼 추가 (읽음 추적)
      await client.query(`
        ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS read_by JSONB NOT NULL DEFAULT '[]';
      `)
      // dm_messages soft delete 컬럼 추가 (삭제 메시지 표현)
      await client.query(`
        ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
        ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
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
