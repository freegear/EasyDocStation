-- EasyDocStation Database Schema
-- Run: psql -U postgres -d easydocstation -f schema.sql

-- Create database (run as superuser if needed):
-- CREATE DATABASE easydocstation;

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Users ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(50)  UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  role          VARCHAR(20)  NOT NULL DEFAULT 'user'
                  CHECK (role IN ('site_admin', 'team_admin', 'channel_admin', 'user')),
  is_active     BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

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
  team_id     VARCHAR(50) NOT NULL,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (team_id, user_id)
);

-- ─── Channel admin assignments ────────────────────────────────
CREATE TABLE IF NOT EXISTS channel_admins (
  id          SERIAL PRIMARY KEY,
  channel_id  VARCHAR(50) NOT NULL,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel_id, user_id)
);

-- ─── Channel members ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS channel_members (
  id         SERIAL PRIMARY KEY,
  channel_id VARCHAR(50) NOT NULL,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by   INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel_id, user_id)
);

-- ─── Indexes ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_email          ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role           ON users(role);
CREATE INDEX IF NOT EXISTS idx_login_history_user   ON login_history(user_id);
CREATE INDEX IF NOT EXISTS idx_team_admins_team     ON team_admins(team_id);
CREATE INDEX IF NOT EXISTS idx_channel_admins_ch    ON channel_admins(channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_members_ch   ON channel_members(channel_id);

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
