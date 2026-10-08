-- 001_init: accounts, sessions, audit log, settings, services, tenants,
-- housekeeping tables, reserved rows. See backend-schema.md sections 3.1, 3.2, 3.10, 11.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  applied_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS maintenance_runs (
  job          TEXT PRIMARY KEY,
  last_run_at  INTEGER,
  last_status  TEXT,
  last_detail  TEXT
);

CREATE TABLE users (
  id                   INTEGER PRIMARY KEY,
  username             TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name         TEXT    NOT NULL,
  email                TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  phone                TEXT,
  notes                TEXT,
  role                 TEXT    NOT NULL CHECK (role IN ('admin','engineer')),
  is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  password_hash        TEXT    NOT NULL,
  password_changed_at  INTEGER NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  -- reserved for the later TOTP phase, unused now
  totp_secret_enc      BLOB,
  totp_enabled         INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0,1)),
  can_operate          INTEGER NOT NULL DEFAULT 0 CHECK (can_operate IN (0,1)),
  -- lockout and login tracking
  failed_attempts      INTEGER NOT NULL DEFAULT 0,
  locked_until         INTEGER,
  last_login_at        INTEGER,
  last_login_ip        TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE TABLE sessions (
  id           TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  revoked_at   INTEGER
);
CREATE INDEX idx_sessions_user    ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY,
  ts         INTEGER NOT NULL,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username   TEXT,
  event      TEXT    NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  detail     TEXT
);
CREATE INDEX idx_audit_ts       ON audit_log(ts DESC);
CREATE INDEX idx_audit_user_ts  ON audit_log(user_id, ts DESC);
CREATE INDEX idx_audit_event_ts ON audit_log(event, ts DESC);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE services (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL UNIQUE,
  pm2_name      TEXT    NOT NULL UNIQUE,
  nginx_match   TEXT,
  public_url    TEXT,
  agent_enabled INTEGER NOT NULL DEFAULT 0 CHECK (agent_enabled IN (0,1)),
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  is_archived   INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
  notes         TEXT
);

CREATE TABLE tenants (
  id            INTEGER PRIMARY KEY,
  tenant_key    TEXT    NOT NULL UNIQUE,
  display_name  TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

-- Reserved row: Nginx traffic that matches no service.
INSERT INTO services (id, name, pm2_name, first_seen_at, last_seen_at)
VALUES (0, '_unattributed', '_unattributed',
        CAST(strftime('%s','now') AS INTEGER) * 1000,
        CAST(strftime('%s','now') AS INTEGER) * 1000);
