-- 004_nginx: gateway metrics and TLS certificate expiry. See backend-schema.md section 3.6.

CREATE TABLE metrics_nginx (
  res_s            INTEGER NOT NULL,
  ts               INTEGER NOT NULL,
  active_conn      INTEGER,
  reading          INTEGER,
  writing          INTEGER,
  waiting          INTEGER,
  req_per_s        REAL,
  PRIMARY KEY (res_s, ts)
) WITHOUT ROWID;

CREATE TABLE metrics_nginx_service (
  service_id   INTEGER NOT NULL,                -- 0 = unattributed
  res_s        INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  requests     INTEGER,
  s2xx         INTEGER,
  s3xx         INTEGER,
  s4xx         INTEGER,
  s5xx         INTEGER,
  p50_ms       REAL,
  p95_ms       REAL,
  bytes_out    INTEGER,
  PRIMARY KEY (service_id, res_s, ts)
) WITHOUT ROWID;

CREATE TABLE tls_certs (
  host        TEXT PRIMARY KEY,
  not_after   INTEGER,
  issuer      TEXT,
  checked_at  INTEGER NOT NULL,
  last_error  TEXT
);
