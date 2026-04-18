-- EasyDocStation Database Schema
-- Run: psql -U postgres -d easydocstation -f schema.sql

-- Create database (run as superuser if needed):
-- CREATE DATABASE easydocstation;

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Channels ────────────────────────────────────────────────
-- ─── Teams ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teams (
  id          VARCHAR(50) PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  icon        VARCHAR(10)  NOT NULL DEFAULT '🏢',
  description TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── Channels ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS channels (
  id            VARCHAR(50) PRIMARY KEY,
  team_id       VARCHAR(50) NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name          VARCHAR(100) NOT NULL,
  type          VARCHAR(20)  NOT NULL DEFAULT 'public' CHECK (type IN ('public', 'private')),
  is_archived   BOOLEAN      NOT NULL DEFAULT false,
  description   TEXT,
  root_post_id  VARCHAR(50),
  tail_post_id  VARCHAR(50),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Migration: add columns if they don't exist (safe to re-run)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channels' AND column_name='description')
  THEN ALTER TABLE channels ADD COLUMN description TEXT; END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channels' AND column_name='root_post_id')
  THEN ALTER TABLE channels ADD COLUMN root_post_id VARCHAR(50); END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channels' AND column_name='tail_post_id')
  THEN ALTER TABLE channels ADD COLUMN tail_post_id VARCHAR(50); END IF;
END $$;

-- ─── Users ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(50)  UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  phone         VARCHAR(30),
  telegram_id   VARCHAR(100),
  kakaotalk_api_key TEXT,
  line_channel_access_token TEXT,
  use_sns_channel VARCHAR(20) CHECK (use_sns_channel IN ('telegram', 'kakaotalk', 'line')),
  role          VARCHAR(20)  NOT NULL DEFAULT 'user'
                  CHECK (role IN ('site_admin', 'team_admin', 'channel_admin', 'user')),
  display_name  VARCHAR(100),
  image_url     TEXT,
  is_active     BOOLEAN      NOT NULL DEFAULT true,
  department_id VARCHAR(50),
  security_level INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

-- Migration: failed_login_attempts 컬럼 추가 (안전하게 재실행 가능)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='failed_login_attempts')
  THEN ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='telegram_id')
  THEN ALTER TABLE users ADD COLUMN telegram_id VARCHAR(100); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='kakaotalk_api_key')
  THEN ALTER TABLE users ADD COLUMN kakaotalk_api_key TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='line_channel_access_token')
  THEN ALTER TABLE users ADD COLUMN line_channel_access_token TEXT; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='use_sns_channel')
  THEN ALTER TABLE users ADD COLUMN use_sns_channel VARCHAR(20); END IF;
END $$;

-- ─── Login history ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS login_history (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  logged_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address   INET,
  user_agent   TEXT
);

-- ─── Team admin assignments ───────────────────────────────────
CREATE TABLE IF NOT EXISTS team_admins (
  id          SERIAL PRIMARY KEY,
  team_id     VARCHAR(50) NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (team_id, user_id)
);

-- ─── Team members ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS team_members (
  id          SERIAL PRIMARY KEY,
  team_id     VARCHAR(50) NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by    INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (team_id, user_id)
);

-- ─── Channel admin assignments ────────────────────────────────
CREATE TABLE IF NOT EXISTS channel_admins (
  id          SERIAL PRIMARY KEY,
  channel_id  VARCHAR(50) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel_id, user_id)
);

-- ─── Channel members ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS channel_members (
  id         SERIAL PRIMARY KEY,
  channel_id VARCHAR(50) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by   INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel_id, user_id)
);

-- ─── Posts (Messages) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS posts (
  id          VARCHAR(50) PRIMARY KEY,
  channel_id  VARCHAR(50) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id   INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT,
  content        TEXT        NOT NULL,
  pinned         BOOLEAN     DEFAULT false,
  views          INTEGER     DEFAULT 0,
  security_level INTEGER     NOT NULL DEFAULT 0,
  is_edited      BOOLEAN     DEFAULT false,
  prev_post_id   VARCHAR(50),
  next_post_id   VARCHAR(50),
  child_post_id  VARCHAR(50),
  parent_id      VARCHAR(50),
  attachments_1  VARCHAR(50),
  attachments_2  VARCHAR(50),
  attachments_3  VARCHAR(50),
  attachments_4  VARCHAR(50),
  attachments_5  VARCHAR(50),
  attachments_6  VARCHAR(50),
  attachments_7  VARCHAR(50),
  attachments_8  VARCHAR(50),
  attachments_9  VARCHAR(50),
  attachments_10 VARCHAR(50),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Attachments (DS.005) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS attachments (
  id            VARCHAR(50)  PRIMARY KEY,             -- File ID
  post_id       VARCHAR(50),                          -- Post ID (FK)
  channel_id    VARCHAR(50)  REFERENCES channels(id) ON DELETE CASCADE,
  uploader_id   INTEGER      REFERENCES users(id) ON DELETE SET NULL, -- Uploader ID
  filename      VARCHAR(255) NOT NULL,                -- File Name (원본 파일명)
  storage_path  TEXT         NOT NULL,               -- Stored Path (UUID 기반 저장 경로)
  content_type  VARCHAR(100),                        -- File Type
  size          BIGINT       DEFAULT 0,              -- File Size (bytes)
  status        VARCHAR(20)  DEFAULT 'PENDING',
  thumbnail_path TEXT,
  created_at    TIMESTAMPTZ  DEFAULT NOW()           -- Created At
);

-- Migration: DS.005 컬럼 추가 (안전하게 재실행 가능)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attachments' AND column_name='uploader_id')
  THEN ALTER TABLE attachments ADD COLUMN uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL; END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attachments' AND column_name='thumbnail_path')
  THEN ALTER TABLE attachments ADD COLUMN thumbnail_path TEXT; END IF;
END $$;

-- ─── Channel last-read tracking ──────────────────────────────
CREATE TABLE IF NOT EXISTS channel_last_read (
  user_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id   VARCHAR(50) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, channel_id)
);

-- ─── Indexes ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_channel_last_read_user ON channel_last_read(user_id);
CREATE INDEX IF NOT EXISTS idx_users_email          ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role           ON users(role);
CREATE INDEX IF NOT EXISTS idx_login_history_user   ON login_history(user_id);
CREATE INDEX IF NOT EXISTS idx_team_admins_team     ON team_admins(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_team    ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_channel_admins_ch    ON channel_admins(channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_members_ch   ON channel_members(channel_id);
CREATE INDEX IF NOT EXISTS idx_posts_channel        ON posts(channel_id);
CREATE INDEX IF NOT EXISTS idx_attachments_post     ON attachments(post_id);

-- ─── Auto-update updated_at trigger ──────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_teams_updated_at ON teams;
CREATE TRIGGER trg_teams_updated_at
  BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_channels_updated_at ON channels;
CREATE TRIGGER trg_channels_updated_at
  BEFORE UPDATE ON channels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_posts_updated_at ON posts;
CREATE TRIGGER trg_posts_updated_at
  BEFORE UPDATE ON posts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
