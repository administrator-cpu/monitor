import type { AuditEntry, AuditQuery } from '@cc/shared';
import type { Db } from './db';

/** Event names from backend-schema.md section 3.1 (those used in phase 1 plus the reserved rest). */
export type AuditEvent =
  | 'login_success'
  | 'login_failed'
  | 'login_locked'
  | 'logout'
  | 'session_expired'
  | 'session_revoked'
  | 'user_created'
  | 'user_updated'
  | 'user_disabled'
  | 'user_enabled'
  | 'password_reset'
  | 'password_changed'
  | 'settings_changed'
  | 'alert_rule_changed'
  | 'alert_mute_created'
  | 'alert_mute_deleted'
  | 'test_email_sent'
  | 'log_search'
  | 'log_tail_opened'
  | 'service_updated'
  | 'service_action'
  | 'service_action_failed';

export interface AuditInput {
  event: AuditEvent;
  userId?: number | null;
  /** As typed, so failed logins for unknown users are still recorded. */
  username?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: unknown;
}

interface Row {
  id: number;
  ts: number;
  user_id: number | null;
  username: string | null;
  event: string;
  ip: string | null;
  user_agent: string | null;
  detail: string | null;
}

const clip = (s: string | null | undefined, n: number): string | null =>
  s == null ? null : s.length > n ? s.slice(0, n) : s;

export class Audit {
  private insert;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.insert = db.prepare(
      `INSERT INTO audit_log (ts, user_id, username, event, ip, user_agent, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  write(input: AuditInput): void {
    this.insert.run(
      this.now(),
      input.userId ?? null,
      clip(input.username, 100),
      input.event,
      clip(input.ip, 64),
      clip(input.userAgent, 300),
      input.detail === undefined ? null : JSON.stringify(input.detail),
    );
  }

  list(q: Pick<AuditQuery, 'limit' | 'before' | 'event' | 'username'>): AuditEntry[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.before !== undefined) {
      where.push('id < ?');
      args.push(q.before);
    }
    if (q.event) {
      where.push('event = ?');
      args.push(q.event);
    }
    if (q.username) {
      where.push('username = ? COLLATE NOCASE');
      args.push(q.username);
    }
    const sql = `SELECT id, ts, user_id, username, event, ip, user_agent, detail FROM audit_log
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    args.push(q.limit);
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => ({
      id: r.id,
      ts: r.ts,
      userId: r.user_id,
      username: r.username,
      event: r.event,
      ip: r.ip,
      userAgent: r.user_agent,
      detail: r.detail ? safeParse(r.detail) : null,
    }));
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
