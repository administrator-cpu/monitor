-- 006_agent: application metrics reported by the in-app agent (phase 8).
-- Per-service rows follow the 10 s / 60 s resolution rule; tenant rows exist at 60 s only.

CREATE TABLE metrics_app_service (
  service_id           INTEGER NOT NULL,
  res_s                INTEGER NOT NULL,
  ts                   INTEGER NOT NULL,
  sockets              INTEGER,
  active_users         INTEGER,
  req_per_s            REAL,
  err5xx_per_s         REAL,
  p95_ms               REAL,
  event_loop_lag_ms    REAL,
  event_loop_lag_max   REAL,
  heap_used_bytes      INTEGER,
  rss_bytes            INTEGER,
  PRIMARY KEY (service_id, res_s, ts)
) WITHOUT ROWID;
CREATE INDEX idx_mapp_res_ts ON metrics_app_service(res_s, ts);

CREATE TABLE metrics_app_tenant (
  service_id    INTEGER NOT NULL,
  tenant_id     INTEGER NOT NULL,
  res_s         INTEGER NOT NULL CHECK (res_s = 60),
  ts            INTEGER NOT NULL,
  sockets       INTEGER,
  active_users  INTEGER,
  req_per_s     REAL,
  p95_ms        REAL,
  PRIMARY KEY (service_id, tenant_id, res_s, ts)
) WITHOUT ROWID;
CREATE INDEX idx_mtenant_res_ts ON metrics_app_tenant(res_s, ts);
