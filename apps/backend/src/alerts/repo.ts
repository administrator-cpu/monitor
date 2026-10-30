import type { AlertCategory, IncidentsQuery } from '@cc/shared';
import type { Db } from '../db';
import type { UserRow } from '../auth/users';
import type { IncidentRow, IncidentView, RuleRow } from './rules';

export interface NotificationRow {
  id: number;
  incident_id: number | null;
  kind: 'opened' | 'reminder' | 'resolved' | 'test';
  to_email: string;
  provider_msg_id: string | null;
  status: 'sent' | 'failed' | 'muted';
  attempts: number;
  error: string | null;
  ts: number;
}

export interface MuteRow {
  id: number;
  starts_at: number;
  ends_at: number;
  service_id: number | null;
  category: AlertCategory | null;
  rule_id: number | null;
  reason: string | null;
  created_by: number | null;
  created_at: number;
}

const VIEW_SQL = `
  SELECT i.*, r.key AS rule_key, r.name AS rule_name, r.category AS category,
         r.severity AS severity, s.name AS service_name
  FROM alert_incidents i
  JOIN alert_rules r ON r.id = i.rule_id
  LEFT JOIN services s ON s.id = i.service_id`;

/** SQL for rules, incidents, notifications, mutes and subscriptions. */
export class AlertRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  // --- rules ---------------------------------------------------------------

  listRules(): RuleRow[] {
    return this.db.prepare('SELECT * FROM alert_rules ORDER BY id').all() as RuleRow[];
  }

  getRule(id: number): RuleRow | undefined {
    return this.db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id) as RuleRow | undefined;
  }

  updateRule(
    id: number,
    patch: {
      enabled?: boolean;
      threshold?: number;
      durationS?: number;
      cooldownS?: number;
      overrides?: Record<string, number>;
    },
    userId: number | null,
  ): RuleRow {
    const r = this.getRule(id);
    if (!r) throw new Error('not_found');
    const params =
      patch.overrides === undefined
        ? r.params
        : Object.keys(patch.overrides).length === 0
          ? null
          : JSON.stringify({ overrides: patch.overrides });
    this.db
      .prepare(
        `UPDATE alert_rules SET enabled = ?, threshold = ?, duration_s = ?, cooldown_s = ?, params = ?,
           updated_at = ?, updated_by = ? WHERE id = ?`,
      )
      .run(
        patch.enabled === undefined ? r.enabled : patch.enabled ? 1 : 0,
        patch.threshold === undefined ? r.threshold : patch.threshold,
        patch.durationS ?? r.duration_s,
        patch.cooldownS ?? r.cooldown_s,
        params,
        this.now(),
        userId,
        id,
      );
    return this.getRule(id) as RuleRow;
  }

  // --- incidents -----------------------------------------------------------

  firing(): IncidentView[] {
    return this.db.prepare(`${VIEW_SQL} WHERE i.state = 'firing'`).all() as IncidentView[];
  }

  getIncident(id: number): IncidentView | undefined {
    return this.db.prepare(`${VIEW_SQL} WHERE i.id = ?`).get(id) as IncidentView | undefined;
  }

  listIncidents(q: IncidentsQuery): IncidentView[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.state !== 'all') {
      where.push('i.state = ?');
      args.push(q.state);
    }
    if (q.before !== undefined) {
      where.push('i.id < ?');
      args.push(q.before);
    }
    if (q.serviceId !== undefined) {
      where.push('i.service_id = ?');
      args.push(q.serviceId);
    }
    if (q.to !== undefined) {
      where.push('i.opened_at <= ?');
      args.push(q.to);
    }
    if (q.from !== undefined) {
      where.push('(i.resolved_at IS NULL OR i.resolved_at >= ?)');
      args.push(q.from);
    }
    args.push(q.limit);
    return this.db
      .prepare(`${VIEW_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.id DESC LIMIT ?`)
      .all(...args) as IncidentView[];
  }

  insertIncident(v: {
    ruleId: number;
    serviceId: number | null;
    /** Defaults to host 1, this server. */
    hostId?: number;
    fingerprint: string;
    openedAt: number;
    peak: number | null;
    summary: string;
  }): IncidentView {
    const info = this.db
      .prepare(
        `INSERT INTO alert_incidents (rule_id, service_id, host_id, fingerprint, state, opened_at, peak_value, summary)
         VALUES (?, ?, ?, ?, 'firing', ?, ?, ?)`,
      )
      .run(v.ruleId, v.serviceId, v.hostId ?? 1, v.fingerprint, v.openedAt, v.peak, v.summary);
    return this.getIncident(Number(info.lastInsertRowid)) as IncidentView;
  }

  updateIncident(
    id: number,
    f: Partial<Pick<IncidentRow, 'peak_value' | 'summary' | 'suppressed_by' | 'last_notified_at' | 'notify_count'>>,
  ): void {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(f)) {
      sets.push(`${k} = ?`);
      args.push(v as string | number | null);
    }
    if (sets.length === 0) return;
    args.push(id);
    this.db.prepare(`UPDATE alert_incidents SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  resolveIncident(id: number, at: number): void {
    this.db
      .prepare(`UPDATE alert_incidents SET state = 'resolved', resolved_at = ? WHERE id = ?`)
      .run(at, id);
  }

  countFiring(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM alert_incidents WHERE state = 'firing'`).get() as { n: number }).n;
  }

  // --- notifications -------------------------------------------------------

  insertNotification(n: Omit<NotificationRow, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO alert_notifications (incident_id, kind, to_email, provider_msg_id, status, attempts, error, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(n.incident_id, n.kind, n.to_email, n.provider_msg_id, n.status, n.attempts, n.error, n.ts);
  }

  notificationsFor(incidentId: number): NotificationRow[] {
    return this.db
      .prepare('SELECT * FROM alert_notifications WHERE incident_id = ? ORDER BY id')
      .all(incidentId) as NotificationRow[];
  }

  // --- mutes ---------------------------------------------------------------

  listMutes(): MuteRow[] {
    return this.db.prepare('SELECT * FROM alert_mutes ORDER BY ends_at DESC, id DESC LIMIT 200').all() as MuteRow[];
  }

  activeMutes(at: number): MuteRow[] {
    return this.db
      .prepare('SELECT * FROM alert_mutes WHERE starts_at <= ? AND ends_at > ?')
      .all(at, at) as MuteRow[];
  }

  insertMute(m: Omit<MuteRow, 'id' | 'created_at'>): MuteRow {
    const info = this.db
      .prepare(
        `INSERT INTO alert_mutes (starts_at, ends_at, service_id, category, rule_id, reason, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.starts_at, m.ends_at, m.service_id, m.category, m.rule_id, m.reason, m.created_by, this.now());
    return this.db.prepare('SELECT * FROM alert_mutes WHERE id = ?').get(info.lastInsertRowid) as MuteRow;
  }

  getMute(id: number): MuteRow | undefined {
    return this.db.prepare('SELECT * FROM alert_mutes WHERE id = ?').get(id) as MuteRow | undefined;
  }

  deleteMute(id: number): boolean {
    return this.db.prepare('DELETE FROM alert_mutes WHERE id = ?').run(id).changes > 0;
  }

  /**
   * Deletes the mutes on one rule for one service whose reason starts with `reasonPrefix` and that
   * have not ended yet. Ended ones stay as history. Returns how many were deleted.
   */
  deleteServiceMutes(serviceId: number, ruleId: number, reasonPrefix: string, at: number): number {
    return this.db
      .prepare(
        `DELETE FROM alert_mutes
          WHERE service_id = ? AND rule_id = ? AND category IS NULL AND ends_at > ?
            AND substr(reason, 1, length(?)) = ?`,
      )
      .run(serviceId, ruleId, at, reasonPrefix, reasonPrefix).changes;
  }

  // --- subscriptions and recipients -----------------------------------------

  getSubscriptions(userId: number): AlertCategory[] {
    return (
      this.db.prepare('SELECT category FROM alert_subscriptions WHERE user_id = ?').all(userId) as {
        category: AlertCategory;
      }[]
    ).map((r) => r.category);
  }

  putSubscriptions(userId: number, categories: AlertCategory[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM alert_subscriptions WHERE user_id = ?').run(userId);
      const ins = this.db.prepare('INSERT INTO alert_subscriptions (user_id, category) VALUES (?, ?)');
      for (const c of new Set(categories)) ins.run(userId, c);
    })();
  }

  /** Active admins always; active engineers who subscribed to the category. */
  recipients(category: AlertCategory): UserRow[] {
    return this.db
      .prepare(
        `SELECT u.* FROM users u
         WHERE u.is_active = 1 AND (
           u.role = 'admin' OR EXISTS (
             SELECT 1 FROM alert_subscriptions s WHERE s.user_id = u.id AND s.category = ?))
         ORDER BY u.id`,
      )
      .all(category) as UserRow[];
  }
}
