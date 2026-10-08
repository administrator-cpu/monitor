-- 003_alerts: alert rules (with the default rules), incidents, notifications,
-- subscriptions and mutes. See backend-schema.md sections 3.9, 8 and 11.

CREATE TABLE alert_rules (
  id           INTEGER PRIMARY KEY,
  key          TEXT    NOT NULL UNIQUE,
  category     TEXT    NOT NULL CHECK (category IN ('host','pm2','nginx','mongo','app','monitor')),
  name         TEXT    NOT NULL,
  description  TEXT,
  severity     TEXT    NOT NULL CHECK (severity IN ('info','warning','critical')),
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  threshold    REAL,
  duration_s   INTEGER NOT NULL DEFAULT 0,
  cooldown_s   INTEGER NOT NULL DEFAULT 3600,
  params       TEXT,                            -- JSON: { "overrides": { "<pm2 name>": <threshold> } }
  updated_at   INTEGER NOT NULL,
  updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE alert_incidents (
  id               INTEGER PRIMARY KEY,
  rule_id          INTEGER NOT NULL REFERENCES alert_rules(id),
  service_id       INTEGER,
  fingerprint      TEXT    NOT NULL,
  state            TEXT    NOT NULL CHECK (state IN ('firing','resolved')),
  opened_at        INTEGER NOT NULL,
  resolved_at      INTEGER,
  last_notified_at INTEGER,
  notify_count     INTEGER NOT NULL DEFAULT 0,
  peak_value       REAL,
  summary          TEXT    NOT NULL,
  suppressed_by    INTEGER REFERENCES alert_incidents(id)
);
CREATE UNIQUE INDEX idx_incident_open ON alert_incidents(fingerprint) WHERE state = 'firing';
CREATE INDEX idx_incident_opened  ON alert_incidents(opened_at DESC);
CREATE INDEX idx_incident_service ON alert_incidents(service_id, opened_at DESC);

CREATE TABLE alert_notifications (
  id                INTEGER PRIMARY KEY,
  incident_id       INTEGER REFERENCES alert_incidents(id) ON DELETE CASCADE,
  kind              TEXT    NOT NULL CHECK (kind IN ('opened','reminder','resolved','test')),
  to_email          TEXT    NOT NULL,
  provider_msg_id   TEXT,
  status            TEXT    NOT NULL CHECK (status IN ('sent','failed','muted')),
  attempts          INTEGER NOT NULL DEFAULT 1,
  error             TEXT,
  ts                INTEGER NOT NULL
);
CREATE INDEX idx_notif_incident ON alert_notifications(incident_id);
CREATE INDEX idx_notif_ts       ON alert_notifications(ts DESC);

CREATE TABLE alert_subscriptions (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category  TEXT    NOT NULL CHECK (category IN ('host','pm2','nginx','mongo','app','monitor')),
  PRIMARY KEY (user_id, category)
) WITHOUT ROWID;

CREATE TABLE alert_mutes (
  id          INTEGER PRIMARY KEY,
  starts_at   INTEGER NOT NULL,
  ends_at     INTEGER NOT NULL,
  service_id  INTEGER,
  category    TEXT,
  rule_id     INTEGER REFERENCES alert_rules(id),
  reason      TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_mutes_window ON alert_mutes(ends_at, starts_at);

-- Default rules (backend-schema.md section 8). Admins edit thresholds, durations and cooldowns.
INSERT INTO alert_rules (key, category, name, description, severity, enabled, threshold, duration_s, cooldown_s, updated_at) VALUES
  ('host.disk_high', 'host', 'Disk usage high', 'Volume used percent above threshold', 'warning', 1, 85, 300, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('host.disk_critical', 'host', 'Disk usage critical', 'Volume used percent above threshold', 'critical', 1, 95, 60, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('host.cpu_high', 'host', 'CPU high', 'Overall CPU percent above threshold', 'warning', 1, 90, 600, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('host.mem_high', 'host', 'Memory high', 'RAM used percent above threshold', 'warning', 1, 90, 600, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('host.pending_reboot', 'host', 'Reboot pending', 'A Windows reboot has been pending for a long time', 'info', 1, NULL, 86400, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('host.eventlog_critical', 'host', 'Critical Windows event', 'New critical event in the System or Application log', 'warning', 1, NULL, 0, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('pm2.service_down', 'pm2', 'Service down', 'Service status is not online', 'critical', 1, NULL, 60, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('pm2.crash_loop', 'pm2', 'Crash loop', 'Restarts within 10 minutes at or above threshold', 'critical', 1, 5, 0, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('pm2.memory_high', 'pm2', 'Service memory high', 'Service memory above threshold (per-service override possible)', 'warning', 1, 1073741824, 600, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('nginx.5xx_rate', 'nginx', 'Nginx 5xx rate', '5xx share of requests above threshold (minimum 50 requests per window)', 'warning', 1, 5, 300, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('nginx.status_unreachable', 'nginx', 'Nginx status unreachable', 'stub_status is not reachable', 'warning', 1, NULL, 120, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('nginx.cert_expiring', 'nginx', 'Certificate expiring', 'Days until TLS certificate expiry below threshold', 'warning', 1, 14, 0, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('nginx.cert_critical', 'nginx', 'Certificate expiry critical', 'Days until TLS certificate expiry below threshold', 'critical', 1, 3, 0, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('mongo.down', 'mongo', 'MongoDB down', 'MongoDB is not reachable', 'critical', 1, NULL, 60, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('mongo.connections_high', 'mongo', 'MongoDB connections high', 'Current / (current + available) connections above threshold', 'warning', 1, 80, 300, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('mongo.long_op', 'mongo', 'MongoDB long operation', 'An operation has been running longer than threshold', 'warning', 1, 60, 0, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('mongo.slow_query_burst', 'mongo', 'MongoDB slow query burst', 'Slow queries in 5 minutes above threshold', 'warning', 1, 20, 0, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('mongo.repl_lag', 'mongo', 'MongoDB replication lag', 'Replication lag above threshold', 'warning', 1, 30, 120, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('app.event_loop_lag', 'app', 'Event loop lag', 'Event loop lag p95 above threshold (per service)', 'warning', 1, 200, 120, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('app.latency_high', 'app', 'Request latency high', 'Request p95 above threshold (per service)', 'warning', 1, 2000, 300, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('app.cpu_no_users', 'app', 'CPU busy with no users', 'CPU above threshold while sockets and active users are both zero', 'warning', 1, 80, 300, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('app.agent_silent', 'app', 'Agent silent', 'PM2 reports online but the agent sends no reports', 'warning', 1, NULL, 60, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('monitor.log_volume_missing', 'monitor', 'Log volume unavailable', 'The log volume is missing or on the same volume as the system drive', 'critical', 1, NULL, 0, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('monitor.log_volume_high', 'monitor', 'Log volume filling', 'Log volume used percent above threshold', 'warning', 1, 85, 0, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('monitor.log_dropped', 'monitor', 'Log lines dropped', 'Log lines are being dropped by backpressure', 'warning', 1, NULL, 60, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('monitor.collector_stale', 'monitor', 'Collector stale', 'A collector has not succeeded for 3 intervals', 'warning', 1, NULL, 120, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('monitor.sqlite_write_failing', 'monitor', 'Database writes failing', 'Batched metric writes are failing', 'critical', 1, NULL, 60, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('monitor.email_failing', 'monitor', 'Email delivery failing', 'Email delivery is failing on consecutive attempts (shown on the dashboard only)', 'critical', 1, NULL, 0, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000);
