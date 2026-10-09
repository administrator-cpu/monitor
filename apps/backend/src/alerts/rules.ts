import type { AlertCategory, Severity } from '@cc/shared';

export interface RuleRow {
  id: number;
  key: string;
  category: AlertCategory;
  name: string;
  description: string | null;
  severity: Severity;
  enabled: number;
  threshold: number | null;
  duration_s: number;
  cooldown_s: number;
  params: string | null;
  updated_at: number;
  updated_by: number | null;
}

export interface IncidentRow {
  id: number;
  rule_id: number;
  service_id: number | null;
  fingerprint: string;
  state: 'firing' | 'resolved';
  opened_at: number;
  resolved_at: number | null;
  last_notified_at: number | null;
  notify_count: number;
  peak_value: number | null;
  summary: string;
  suppressed_by: number | null;
}

/** An incident joined with its rule and service name. */
export interface IncidentView extends IncidentRow {
  rule_key: string;
  rule_name: string;
  category: AlertCategory;
  severity: Severity;
  service_name: string | null;
}

export interface RuleMeta {
  /** False for rules whose data source arrives in a later phase. */
  implemented: boolean;
  perService: boolean;
  unit: string | null;
  /** False for rules that can only be shown on the dashboard (email itself is what is failing). */
  emailable: boolean;
}

const m = (
  implemented: boolean,
  unit: string | null,
  extra: Partial<Pick<RuleMeta, 'perService' | 'emailable'>> = {},
): RuleMeta => ({ implemented, unit, perService: false, emailable: true, ...extra });

/** Static facts about each default rule. Thresholds and timings live in the database. */
export const RULE_META: Record<string, RuleMeta> = {
  'host.disk_high': m(true, '%'),
  'host.disk_critical': m(true, '%'),
  'host.cpu_high': m(true, '%'),
  'host.mem_high': m(true, '%'),
  'host.pending_reboot': m(true, null),
  'host.eventlog_critical': m(true, null),
  'pm2.service_down': m(true, null, { perService: true }),
  'pm2.crash_loop': m(true, 'restarts / 10 min', { perService: true }),
  'pm2.memory_high': m(true, 'bytes', { perService: true }),
  'nginx.5xx_rate': m(true, '%', { perService: true }),
  'nginx.status_unreachable': m(true, null),
  'nginx.cert_expiring': m(true, 'days'),
  'nginx.cert_critical': m(true, 'days'),
  'mongo.down': m(true, null),
  'mongo.connections_high': m(true, '%'),
  'mongo.long_op': m(true, 's'),
  'mongo.slow_query_burst': m(true, 'queries / 5 min'),
  'mongo.repl_lag': m(true, 's'),
  'app.event_loop_lag': m(true, 'ms', { perService: true }),
  'app.latency_high': m(true, 'ms', { perService: true }),
  'app.cpu_no_users': m(true, '%', { perService: true }),
  'app.agent_silent': m(true, null, { perService: true }),
  'monitor.log_volume_missing': m(true, null),
  'monitor.log_volume_high': m(true, '%'),
  'monitor.log_dropped': m(true, null),
  'monitor.collector_stale': m(true, null),
  'monitor.sqlite_write_failing': m(true, null),
  'monitor.email_bounce_spike': m(true, 'emails / hour'),
  'monitor.email_failing': m(true, null, { emailable: false }),
};

/**
 * Grouping (backend-schema.md section 8). While a parent incident is firing, the listed children
 * for the same scope are still recorded, but not emailed.
 *
 * Service scope (same service):
 *  - service down hides its memory, application and gateway 5xx alerts (from the document);
 *  - a crash loop hides "service down" (the loop is the cause, the downtime is the symptom).
 * Target scope (same volume or host):
 *  - critical disk usage hides the warning for the same volume;
 *  - a critical certificate expiry hides the warning for the same host.
 */
const SERVICE_PARENTS: Record<string, (childKey: string) => boolean> = {
  'pm2.service_down': (k) => k === 'pm2.memory_high' || k.startsWith('app.') || k === 'nginx.5xx_rate',
  'pm2.crash_loop': (k) => k === 'pm2.service_down',
};
const TARGET_PARENTS: Record<string, string[]> = {
  'host.disk_critical': ['host.disk_high'],
  'nginx.cert_critical': ['nginx.cert_expiring'],
};

export const targetOf = (inc: Pick<IncidentRow, 'fingerprint'>, ruleKey: string): string =>
  inc.fingerprint.slice(ruleKey.length + 1);

/** The firing incident that suppresses `child`, if any. */
export function findParent(child: IncidentView, firing: IncidentView[]): IncidentView | undefined {
  const childTarget = targetOf(child, child.rule_key);
  for (const p of firing) {
    if (p.id === child.id || p.state !== 'firing') continue;
    if (child.service_id !== null && p.service_id === child.service_id) {
      if (SERVICE_PARENTS[p.rule_key]?.(child.rule_key)) return p;
    }
    if (TARGET_PARENTS[p.rule_key]?.includes(child.rule_key) && targetOf(p, p.rule_key) === childTarget) {
      return p;
    }
  }
  return undefined;
}

export function parseOverrides(params: string | null): Record<string, number> {
  if (!params) return {};
  try {
    const o = (JSON.parse(params) as { overrides?: Record<string, unknown> }).overrides ?? {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}
