-- 005_mongo: database health and slow queries. See backend-schema.md section 3.7.

CREATE TABLE metrics_mongo (
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
  PRIMARY KEY (res_s, ts)
) WITHOUT ROWID;

CREATE TABLE mongo_slow_queries (
  id               INTEGER PRIMARY KEY,
  ts               INTEGER NOT NULL,
  namespace        TEXT    NOT NULL,
  op               TEXT,
  millis           INTEGER NOT NULL,
  plan_summary     TEXT,
  docs_examined    INTEGER,
  keys_examined    INTEGER,
  n_returned       INTEGER,
  app_name         TEXT,
  command_shape    TEXT
);
CREATE INDEX idx_slowq_ts      ON mongo_slow_queries(ts DESC);
CREATE INDEX idx_slowq_ns_ts   ON mongo_slow_queries(namespace, ts DESC);
