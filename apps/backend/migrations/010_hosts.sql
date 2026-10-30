-- 010_hosts: more than one monitored host (phase 11, M1). See backend-schema.md section 13.1 to 13.3.
-- Host 1 is this Windows server. Every existing row becomes host 1, ids are kept, and no
-- fingerprint is rewritten, so open incidents stay open (section 8.3). No table gets a foreign
-- key to `services`, which is why the rebuild below is safe with foreign_keys = ON.

CREATE TABLE hosts (
  id                 INTEGER PRIMARY KEY,
  name               TEXT    NOT NULL UNIQUE COLLATE NOCASE,   -- 'windows-vps', 'ubuntu-acs'
  kind               TEXT    NOT NULL CHECK (kind IN ('local','agent')),
  os                 TEXT    NOT NULL CHECK (os IN ('windows','linux')),
  token_hash         TEXT,                                      -- SHA-256 hex of the host token
  enroll_hash        TEXT,                                      -- SHA-256 hex of the one-time token
  enroll_expires_at  INTEGER,
  agent_version      TEXT,
  actions_enabled    INTEGER CHECK (actions_enabled IN (0,1)),  -- as last reported by the agent
  last_seen_at       INTEGER,
  clock_skew_ms      INTEGER,
  created_at         INTEGER NOT NULL,
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  revoked_at         INTEGER,
  notes              TEXT
);
CREATE UNIQUE INDEX idx_hosts_token  ON hosts(token_hash)  WHERE token_hash  IS NOT NULL;
CREATE UNIQUE INDEX idx_hosts_enroll ON hosts(enroll_hash) WHERE enroll_hash IS NOT NULL;

INSERT INTO hosts (id, name, kind, os, created_at)
VALUES (1, 'windows-vps', 'local', 'windows', CAST(strftime('%s','now') AS INTEGER) * 1000);

-- services: pm2_name becomes source_key (the PM2 name on host 1, '<project>/<service>' for
-- containers); names and keys are unique per host.
CREATE TABLE services_new (
  id            INTEGER PRIMARY KEY,
  host_id       INTEGER NOT NULL DEFAULT 1 REFERENCES hosts(id),
  kind          TEXT    NOT NULL DEFAULT 'pm2' CHECK (kind IN ('pm2','container','pseudo')),
  name          TEXT    NOT NULL,
  source_key    TEXT    NOT NULL,
  nginx_match   TEXT,
  public_url    TEXT,
  agent_enabled INTEGER NOT NULL DEFAULT 0 CHECK (agent_enabled IN (0,1)),
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  is_archived   INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
  notes         TEXT,
  git_repo      TEXT,
  git_branch    TEXT    NOT NULL DEFAULT 'main',
  git_path      TEXT,
  log_excluded  INTEGER NOT NULL DEFAULT 0 CHECK (log_excluded IN (0,1)),  -- remote log shipping off (M3)
  UNIQUE (host_id, source_key),
  UNIQUE (host_id, name)
);

INSERT INTO services_new (id, host_id, kind, name, source_key, nginx_match, public_url, agent_enabled,
                          first_seen_at, last_seen_at, is_archived, notes, git_repo, git_branch, git_path)
SELECT id, 1, CASE WHEN id = 0 THEN 'pseudo' ELSE 'pm2' END, name, pm2_name, nginx_match, public_url,
       agent_enabled, first_seen_at, last_seen_at, is_archived, notes, git_repo, git_branch, git_path
FROM services;

DROP TABLE services;
ALTER TABLE services_new RENAME TO services;
CREATE INDEX idx_services_host ON services(host_id, is_archived);

-- Metric tables whose primary key gains host_id. Rows are copied as host 1.
CREATE TABLE metrics_host_new (
  host_id            INTEGER NOT NULL DEFAULT 1,
  res_s              INTEGER NOT NULL,
  ts                 INTEGER NOT NULL,
  cpu_pct            REAL,
  cpu_max_core_pct   REAL,
  mem_used_bytes     INTEGER,
  mem_total_bytes    INTEGER,
  swap_used_bytes    INTEGER,
  swap_total_bytes   INTEGER,
  net_rx_bps         REAL,
  net_tx_bps         REAL,
  uptime_s           INTEGER,
  pending_reboot     INTEGER CHECK (pending_reboot IN (0,1)),
  PRIMARY KEY (host_id, res_s, ts)
) WITHOUT ROWID;
INSERT INTO metrics_host_new (host_id, res_s, ts, cpu_pct, cpu_max_core_pct, mem_used_bytes, mem_total_bytes,
                              swap_used_bytes, swap_total_bytes, net_rx_bps, net_tx_bps, uptime_s, pending_reboot)
SELECT 1, res_s, ts, cpu_pct, cpu_max_core_pct, mem_used_bytes, mem_total_bytes,
       swap_used_bytes, swap_total_bytes, net_rx_bps, net_tx_bps, uptime_s, pending_reboot
FROM metrics_host;
DROP TABLE metrics_host;
ALTER TABLE metrics_host_new RENAME TO metrics_host;

CREATE TABLE metrics_disk_new (
  host_id      INTEGER NOT NULL DEFAULT 1,
  volume       TEXT    NOT NULL,               -- 'C:' on Windows, a mount point on Linux
  res_s        INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  used_bytes   INTEGER,
  total_bytes  INTEGER,
  read_bps     REAL,
  write_bps    REAL,
  PRIMARY KEY (host_id, volume, res_s, ts)
) WITHOUT ROWID;
INSERT INTO metrics_disk_new (host_id, volume, res_s, ts, used_bytes, total_bytes, read_bps, write_bps)
SELECT 1, volume, res_s, ts, used_bytes, total_bytes, read_bps, write_bps FROM metrics_disk;
DROP TABLE metrics_disk;
ALTER TABLE metrics_disk_new RENAME TO metrics_disk;

CREATE TABLE metrics_mongo_new (
  host_id             INTEGER NOT NULL DEFAULT 1,
  res_s               INTEGER NOT NULL,
  ts                  INTEGER NOT NULL,
  up                  INTEGER NOT NULL CHECK (up IN (0,1)),
  ping_ms             REAL,
  conn_current        INTEGER,
  conn_available      INTEGER,
  op_insert_ps        REAL,
  op_query_ps         REAL,
  op_update_ps        REAL,
  op_delete_ps        REAL,
  op_getmore_ps       REAL,
  op_command_ps       REAL,
  mem_resident_mb     INTEGER,
  data_size_bytes     INTEGER,
  repl_state          TEXT,
  repl_lag_s          REAL,
  PRIMARY KEY (host_id, res_s, ts)
) WITHOUT ROWID;
INSERT INTO metrics_mongo_new (host_id, res_s, ts, up, ping_ms, conn_current, conn_available, op_insert_ps, op_query_ps,
                               op_update_ps, op_delete_ps, op_getmore_ps, op_command_ps, mem_resident_mb,
                               data_size_bytes, repl_state, repl_lag_s)
SELECT 1, res_s, ts, up, ping_ms, conn_current, conn_available, op_insert_ps, op_query_ps,
       op_update_ps, op_delete_ps, op_getmore_ps, op_command_ps, mem_resident_mb,
       data_size_bytes, repl_state, repl_lag_s
FROM metrics_mongo;
DROP TABLE metrics_mongo;
ALTER TABLE metrics_mongo_new RENAME TO metrics_mongo;

-- Tables that only gain a column.
ALTER TABLE mongo_slow_queries ADD COLUMN host_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX idx_slowq_host_ts ON mongo_slow_queries(host_id, ts DESC);

ALTER TABLE tls_certs ADD COLUMN host_id INTEGER NOT NULL DEFAULT 1;

ALTER TABLE alert_incidents ADD COLUMN host_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX idx_incident_host ON alert_incidents(host_id, opened_at DESC);

INSERT INTO alert_rules (key, category, name, description, severity, enabled, threshold, duration_s, cooldown_s, updated_at) VALUES
  ('host.silent', 'monitor', 'Host silent', 'No request from a remote host''s agent. While it fires, the other alerts of that host are recorded but not emailed', 'critical', 1, NULL, 120, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000);
