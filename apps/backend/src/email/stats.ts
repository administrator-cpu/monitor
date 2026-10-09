import type { Db } from '../db';

export const BUCKET_MS = 600_000; // 10 minutes
export const COUNTED_EVENTS = ['sent', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'failed', 'suppressed'] as const;
export type EmailEvent = (typeof COUNTED_EVENTS)[number];

/** Resend event type (`email.bounced`) to our event name, or null for events we do not count. */
export function eventOf(type: unknown): EmailEvent | null {
  if (typeof type !== 'string' || !type.startsWith('email.')) return null;
  const name = type.slice(6);
  return (COUNTED_EVENTS as readonly string[]).includes(name) ? (name as EmailEvent) : null;
}

/** `Name <alerts@Example.com>` or `alerts@example.com` to `example.com`; 'unknown' when unreadable. */
export function senderDomain(from: unknown): string {
  if (typeof from !== 'string') return 'unknown';
  const m = /@([A-Za-z0-9.-]{1,253})>?\s*$/.exec(from.trim());
  return m ? m[1]!.toLowerCase() : 'unknown';
}

export function bounceKind(data: unknown): string {
  const t = (data as { bounce?: { type?: unknown } } | null)?.bounce?.type;
  if (typeof t !== 'string') return 'undetermined';
  const k = t.toLowerCase();
  return k === 'permanent' || k === 'transient' ? k : 'undetermined';
}

export interface EmailSummaryRow {
  domain: string;
  sent: number;
  delivered: number;
  delayed: number;
  bounced: number;
  complained: number;
  failed: number;
  suppressed: number;
}

export class EmailStats {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  /** Counts one event. Returns false when this delivery id was already handled. */
  record(deliveryId: string, event: EmailEvent, domain: string, kind: string, at: number): boolean {
    const bucket = Math.floor(at / BUCKET_MS) * BUCKET_MS;
    return this.db.transaction(() => {
      const fresh = this.db.prepare('INSERT OR IGNORE INTO email_webhook_seen (id, seen_at) VALUES (?, ?)').run(deliveryId, this.now()).changes === 1;
      if (!fresh) return false;
      this.db
        .prepare(
          `INSERT INTO email_event_counts (bucket, domain, event, bounce_kind, count) VALUES (?, ?, ?, ?, 1)
           ON CONFLICT(bucket, domain, event, bounce_kind) DO UPDATE SET count = count + 1`,
        )
        .run(bucket, domain, event, event === 'bounced' ? kind : '');
      return true;
    })();
  }

  lastReceivedAt(): number | null {
    const r = this.db.prepare('SELECT MAX(seen_at) AS t FROM email_webhook_seen').get() as { t: number | null };
    return r.t;
  }

  /** Bounces plus complaints since `since` (all domains). */
  badSince(since: number): number {
    const r = this.db
      .prepare(`SELECT COALESCE(SUM(count), 0) AS n FROM email_event_counts WHERE bucket >= ? AND event IN ('bounced','complained')`)
      .get(Math.floor(since / BUCKET_MS) * BUCKET_MS) as { n: number };
    return r.n;
  }

  summary(since: number): EmailSummaryRow[] {
    const rows = this.db
      .prepare('SELECT domain, event, SUM(count) AS n FROM email_event_counts WHERE bucket >= ? GROUP BY domain, event')
      .all(Math.floor(since / BUCKET_MS) * BUCKET_MS) as { domain: string; event: string; n: number }[];
    const by = new Map<string, EmailSummaryRow>();
    for (const r of rows) {
      const row = by.get(r.domain) ?? { domain: r.domain, sent: 0, delivered: 0, delayed: 0, bounced: 0, complained: 0, failed: 0, suppressed: 0 };
      if (r.event === 'sent') row.sent = r.n;
      else if (r.event === 'delivered') row.delivered = r.n;
      else if (r.event === 'delivery_delayed') row.delayed = r.n;
      else if (r.event === 'bounced') row.bounced = r.n;
      else if (r.event === 'complained') row.complained = r.n;
      else if (r.event === 'failed') row.failed = r.n;
      else if (r.event === 'suppressed') row.suppressed = r.n;
      by.set(r.domain, row);
    }
    return [...by.values()].sort((a, b) => b.sent + b.delivered - (a.sent + a.delivered) || a.domain.localeCompare(b.domain));
  }

  /** Bounces and complaints per hour, oldest first, for the chart. */
  hourly(since: number, until: number): { ts: number; delivered: number; bad: number }[] {
    const H = 3_600_000;
    const from = Math.floor(since / H) * H;
    const rows = this.db
      .prepare(
        `SELECT (bucket / ${H}) * ${H} AS hour, event, SUM(count) AS n FROM email_event_counts
         WHERE bucket >= ? AND event IN ('delivered','bounced','complained') GROUP BY hour, event`,
      )
      .all(from) as { hour: number; event: string; n: number }[];
    const out = new Map<number, { ts: number; delivered: number; bad: number }>();
    for (let t = from; t <= until; t += H) out.set(t, { ts: t, delivered: 0, bad: 0 });
    for (const r of rows) {
      const o = out.get(r.hour);
      if (!o) continue;
      if (r.event === 'delivered') o.delivered += r.n;
      else o.bad += r.n;
    }
    return [...out.values()];
  }
}
