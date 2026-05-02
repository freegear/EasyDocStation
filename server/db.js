const { Pool } = require('pg')
const fs = require('fs')
const path = require('path')
const bcrypt = require('bcryptjs')
const { getPostgresPoolOptions } = require('./runtimeDbConfig')

const pool = new Pool(getPostgresPoolOptions())

const SCHEMA_PATH = path.resolve(__dirname, './schema.sql')

const DEFAULT_SEED_USERS = [
  { username: 'kevin', name: 'Kevin Im', email: 'kevin@easydocstation.com', password: 'password123', role: 'site_admin' },
  { username: 'alice', name: 'Alice Kim', email: 'alice@easydocstation.com', password: 'password123', role: 'team_admin' },
  { username: 'bob', name: 'Bob Lee', email: 'bob@easydocstation.com', password: 'password123', role: 'channel_admin' },
  { username: 'carol', name: 'Carol Park', email: 'carol@easydocstation.com', password: 'password123', role: 'user' },
]

async function applyBaseSchema(client) {
  try {
    if (!fs.existsSync(SCHEMA_PATH)) return
    let schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8')
    // Extension 권한이 없는 환경에서도 나머지 테이블 생성이 진행되도록 분리 처리
    schemaSql = schemaSql.replace(/CREATE EXTENSION IF NOT EXISTS "pgcrypto";/gi, '')
    await client.query(schemaSql)
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";')
    } catch (e) {
      console.warn('⚠️ pgcrypto extension 생성 권한이 없어 건너뜁니다:', e.message)
    }
  } catch (err) {
    if (err && err.code === '42501') {
      console.error('권한 복구 가이드: sudo -u postgres psql -d <DB명> -c "GRANT USAGE, CREATE ON SCHEMA public TO <DB유저>; ALTER SCHEMA public OWNER TO <DB유저>;"')
      console.error('테이블 owner 복구는 setup-ubuntu.sh를 다시 실행하면 자동 처리됩니다.')
      console.warn('⚠️ 권한 부족으로 base schema 변경을 건너뜁니다. 기존 스키마로 계속 동작합니다.')
      return
    }
    console.error('❌ Base schema apply error:', err.message)
    throw err
  }
}

async function ensureDefaultUsers(client) {
  const { rows } = await client.query('SELECT COUNT(*)::int AS count FROM users')
  const userCount = rows[0]?.count ?? 0
  if (userCount > 0) return

  for (const u of DEFAULT_SEED_USERS) {
    const hash = await bcrypt.hash(u.password, 10)
    await client.query(
      `INSERT INTO users
        (username, name, email, password_hash, role, is_active, failed_login_attempts)
       VALUES ($1, $2, $3, $4, $5, true, 0)
       ON CONFLICT (email) DO UPDATE
         SET username = EXCLUDED.username,
             name = EXCLUDED.name,
             role = EXCLUDED.role,
             password_hash = EXCLUDED.password_hash,
             is_active = true,
             failed_login_attempts = 0,
             updated_at = NOW()`,
      [u.username, u.name, u.email, hash, u.role]
    )
  }
  console.log('✅ Default users seeded (password: password123)')
}

async function runMigrationStep(client, label, sql) {
  try {
    await client.query(sql)
  } catch (err) {
    if (err && err.code === '42501') {
      console.warn(`⚠️ [DB migration] ${label} 건너뜀(테이블 owner 권한 필요): ${err.message}`)
      return false
    }
    throw err
  }
  return true
}

// Auto-migration on startup
async function initDb() {
  try {
    const client = await pool.connect()
    try {
      await applyBaseSchema(client)
      // users 테이블 image_url 컬럼 추가
      await runMigrationStep(client, 'legacy columns backfill', `
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
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='phone') THEN
            ALTER TABLE users ADD COLUMN phone VARCHAR(30);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='telegram_id') THEN
            ALTER TABLE users ADD COLUMN telegram_id VARCHAR(100);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='kakaotalk_api_key') THEN
            ALTER TABLE users ADD COLUMN kakaotalk_api_key TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='line_channel_access_token') THEN
            ALTER TABLE users ADD COLUMN line_channel_access_token TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='use_sns_channel') THEN
            ALTER TABLE users ADD COLUMN use_sns_channel VARCHAR(20);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='active_session_id') THEN
            ALTER TABLE users ADD COLUMN active_session_id TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='supabase_user_id') THEN
            ALTER TABLE users ADD COLUMN supabase_user_id UUID;
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
      await runMigrationStep(client, 'create calendar_events', `
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
      await runMigrationStep(client, 'calendar_events add series_id', `
        ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS series_id VARCHAR(36);
        CREATE INDEX IF NOT EXISTS idx_calendar_events_series ON calendar_events(series_id);
      `)
      // calendar_events.id: SERIAL → TEXT(UUID) 마이그레이션
      await runMigrationStep(client, 'calendar_events id type migration', `
        DO $$
        BEGIN
          IF EXISTS (
              SELECT 1
              FROM pg_proc
              WHERE proname = 'gen_random_uuid'
            )
            AND (SELECT data_type FROM information_schema.columns
              WHERE table_name='calendar_events' AND column_name='id') = 'integer' THEN
            ALTER TABLE calendar_events DROP CONSTRAINT calendar_events_pkey;
            ALTER TABLE calendar_events ALTER COLUMN id DROP DEFAULT;
            ALTER TABLE calendar_events ALTER COLUMN id TYPE TEXT USING gen_random_uuid()::text;
            ALTER TABLE calendar_events ADD PRIMARY KEY (id);
          END IF;
        END $$;
      `)
      // calendar_invitations 테이블 생성 (PostgreSQL)
      await runMigrationStep(client, 'create calendar_invitations', `
        CREATE TABLE IF NOT EXISTS calendar_invitations (
          invitee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          event_id   TEXT    NOT NULL,
          owner_id   INTEGER NOT NULL,
          PRIMARY KEY (invitee_id, event_id)
        );
        CREATE INDEX IF NOT EXISTS idx_cal_inv_event ON calendar_invitations(event_id);
      `)
      // expense_doc_counter 테이블 생성 (날짜별 순번 관리)
      await runMigrationStep(client, 'create expense_doc_counter', `
        CREATE TABLE IF NOT EXISTS expense_doc_counter (
          date_key CHAR(8) PRIMARY KEY,
          last_seq INTEGER NOT NULL DEFAULT 0
        );
      `)
      // trip_doc_counter 테이블 생성 (날짜별 순번 관리)
      await runMigrationStep(client, 'create trip_doc_counter', `
        CREATE TABLE IF NOT EXISTS trip_doc_counter (
          date_key CHAR(8) PRIMARY KEY,
          last_seq INTEGER NOT NULL DEFAULT 0
        );
      `)
      // comments 테이블 생성 (없는 경우)
      await runMigrationStep(client, 'create comments', `
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
      await runMigrationStep(client, 'create dm_conversations', `
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
      await runMigrationStep(client, 'create dm_messages', `
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
      await runMigrationStep(client, 'dm_messages add read_by', `
        ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS read_by JSONB NOT NULL DEFAULT '[]';
      `)
      // dm_messages soft delete 컬럼 추가 (삭제 메시지 표현)
      await runMigrationStep(client, 'dm_messages soft-delete columns', `
        ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
        ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
      `)
      await ensureDefaultUsers(client)
      console.log('✅ Database migration complete.')
    } finally {
      client.release()
    }
  } catch (err) {
    if (err && err.code === '42501') {
      console.warn('⚠️ DB migration 권한 부족(ownership). 서버는 계속 실행됩니다.')
      return
    }
    console.error('❌ Database initialization error:', err)
  }
}

initDb()

pool.on('error', (err) => {
  console.error('PostgreSQL connection error:', err)
})

module.exports = pool
