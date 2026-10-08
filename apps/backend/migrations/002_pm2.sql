-- 002_pm2: host, disk and process metrics, process events.
-- See backend-schema.md sections 3.3, 3.4 and 11. Metric tables carry no foreign keys on purpose.

CREATE TABLE metrics_host (
  res_s              INTEGER NOT NULL,         -- 10 or 60
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
  PRIMARY KEY (res_s, ts)
) WITHOUT ROWID;

CREATE TABLE metrics_disk (
  volume       TEXT    NOT NULL,               -- 'C:' or 'E:'
  res_s        INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  used_bytes   INTEGER,
  total_bytes  INTEGER,
  read_bps     REAL,                           -- NULL when not measured
  write_bps    REAL,
  PRIMARY KEY (volume, res_s, ts)
) WITHOUT ROWID;

CREATE TABLE metrics_process (
  service_id  INTEGER NOT NULL,
  res_s       INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  status      TEXT    NOT NULL,                -- online | stopped | errored | launching | stopping
  instances   INTEGER,
  cpu_pct     REAL,
  mem_bytes   INTEGER,
  restarts    INTEGER,                         -- PM2 cumulative restart counter (summed over instances)
  uptime_s    INTEGER,
  PRIMARY KEY (service_id, res_s, ts)
) WITHOUT ROWID;
CREATE INDEX idx_mproc_res_ts ON metrics_process(res_s, ts);

CREATE TABLE process_events (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  service_id  INTEGER NOT NULL,
  pm_id       INTEGER,
  event       TEXT    NOT NULL,                -- start | stop | restart | exit | online | exception | restart overlimit
  detail      TEXT                             -- JSON (exit code, signal); never the process environment
);
CREATE INDEX idx_pevents_service_ts ON process_events(service_id, ts DESC);
CREATE INDEX idx_pevents_ts         ON process_events(ts);
