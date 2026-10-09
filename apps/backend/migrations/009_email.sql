-- 009_email: Resend delivery monitoring. Counts only: no addresses, subjects or message bodies.

CREATE TABLE email_event_counts (
  bucket      INTEGER NOT NULL,                  -- start of a 10 minute window, ms since epoch
  domain      TEXT    NOT NULL,                  -- sender domain, lower case
  event       TEXT    NOT NULL,                  -- sent | delivered | delivery_delayed | bounced | complained | failed | suppressed
  bounce_kind TEXT    NOT NULL DEFAULT '',       -- permanent | transient | undetermined, only for bounced
  count       INTEGER NOT NULL,
  PRIMARY KEY (bucket, domain, event, bounce_kind)
) WITHOUT ROWID;

-- Resend retries webhooks; a delivery with an id we already handled is acknowledged and ignored.
CREATE TABLE email_webhook_seen (
  id       TEXT    PRIMARY KEY,
  seen_at  INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX email_webhook_seen_at ON email_webhook_seen (seen_at);

INSERT INTO alert_rules (key, category, name, description, severity, enabled, threshold, duration_s, cooldown_s, updated_at) VALUES
  ('monitor.email_bounce_spike', 'monitor', 'Email bounces or complaints', 'Bounced or complained emails in the last hour at or above threshold (from Resend webhooks)', 'warning', 1, 5, 0, 3600, CAST(strftime('%s','now') AS INTEGER) * 1000);
