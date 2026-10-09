import type { Db } from './db';
import { METRIC_TABLES } from './rollup';
import type { Settings } from './settings';

const DAY = 86_400_000;

/**
 * Hourly deletion by age (backend-schema.md section 9.1). Metric rows of any resolution older than
 * `retention.metrics_days` go (10 s rows normally leave through the rollup long before, this also
 * clears them if the rollup has been failing). Events, slow queries, resolved alert incidents with
 * their notifications and the audit log each follow their own setting.
 */
export function runRetention(db: Db, settings: Settings, now: number): Record<string, number> {
  const metrics = now - settings.get('retention.metrics_days') * DAY;
  const events = now - settings.get('retention.events_days') * DAY;
  const alerts = now - settings.get('retention.alerts_days') * DAY;
  const audit = now - settings.get('retention.audit_days') * DAY;

  const del = (sql: string, ...args: number[]): number => db.prepare(sql).run(...args).changes;
  const removed: Record<string, number> = {};
  db.transaction(() => {
    for (const t of METRIC_TABLES) removed[t] = del(`DELETE FROM ${t} WHERE ts < ?`, metrics);
    removed.process_events = del('DELETE FROM process_events WHERE ts < ?', events);
    removed.windows_events = del('DELETE FROM windows_events WHERE ts < ?', events);
    removed.mongo_slow_queries = del('DELETE FROM mongo_slow_queries WHERE ts < ?', events);
    removed.alert_notifications = del('DELETE FROM alert_notifications WHERE ts < ?', alerts);
    // Notifications reference incidents; children go first (also covered by ON DELETE CASCADE).
    removed.alert_incidents = del(
      `DELETE FROM alert_incidents WHERE state = 'resolved' AND opened_at < ?
         AND id NOT IN (SELECT suppressed_by FROM alert_incidents WHERE suppressed_by IS NOT NULL)`,
      alerts,
    );
    removed.email_counts = emailPrune(db, now, settings.get('retention.email_days'));
    removed.audit_log = del('DELETE FROM audit_log WHERE ts < ?', audit);
  })();
  db.prepare(
    `INSERT INTO maintenance_runs (job, last_run_at, last_status, last_detail)
     VALUES ('retention', ?, 'ok', ?)
     ON CONFLICT(job) DO UPDATE SET last_run_at = excluded.last_run_at,
       last_status = excluded.last_status, last_detail = excluded.last_detail`,
  ).run(now, JSON.stringify(removed));
  return removed;
}

function emailPrune(db: Db, now: number, days: number): number {
  const cut = now - days * DAY;
  return (
    db.prepare('DELETE FROM email_event_counts WHERE bucket < ?').run(cut).changes +
    db.prepare('DELETE FROM email_webhook_seen WHERE seen_at < ?').run(cut).changes
  );
}
