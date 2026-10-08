-- 007_events: Windows Event Log entries of level critical and error (phase 9).
-- backend-schema.md section 3.8. Messages are truncated to 2000 characters before they are stored.

CREATE TABLE windows_events (
  id          INTEGER PRIMARY KEY,
  log_name    TEXT    NOT NULL,                 -- System | Application
  record_id   INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  level       TEXT    NOT NULL,                 -- critical | error | warning
  provider    TEXT,
  event_id    INTEGER,
  message     TEXT,
  UNIQUE (log_name, record_id)
);
CREATE INDEX idx_wevents_ts ON windows_events(ts DESC);
