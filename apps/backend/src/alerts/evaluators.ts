import { AGENT_FRESH_MS, type CollectorStatus, type LogStatus } from '@cc/shared';
import type { StateStore } from '../state';
import { parseOverrides, type RuleRow } from './rules';

/** What one rule sees about one target (a volume, a service, a collector, or the host itself). */
export interface Observation {
  /** Fingerprint suffix: '' for host-wide rules, a volume, a service id or a collector name. */
  target: string;
  serviceId: number | null;
  active: boolean;
  value: number | null;
  summary: string;
  /** The summary describes a moving value (days left): keep it current while the incident is open. */
  refresh?: boolean;
}

export interface EvalContext {
  now: number;
  state: StateStore;
  collectors: () => CollectorStatus[];
  logs: () => LogStatus;
  persistence: () => { consecutiveFailures: number };
  email: () => { consecutiveFailures: number };
  agentEnabled: (serviceId: number) => boolean;
  emailBadSince: (since: number) => number;
}

/** `null` means "cannot evaluate right now": open incidents keep their state. */
export type Evaluator = (rule: RuleRow, c: EvalContext) => Observation[] | null;

export const fingerprintOf = (ruleKey: string, target: string): string =>
  target === '' ? ruleKey : `${ruleKey}:${target}`;

/** Rules stop being evaluated while any of these collectors is stale: stale data is not evidence. */
export const REQUIRED_COLLECTORS: Record<string, string[]> = {
  'host.disk_high': ['disk'],
  'host.disk_critical': ['disk'],
  'host.cpu_high': ['host'],
  'host.mem_high': ['host'],
  'host.pending_reboot': ['system'],
  'pm2.service_down': ['pm2'],
  'pm2.crash_loop': ['pm2'],
  'pm2.memory_high': ['pm2'],
  'nginx.5xx_rate': ['nginxlog'],
  'nginx.cert_expiring': ['tls'],
  'nginx.cert_critical': ['tls'],
  'mongo.down': ['mongo'],
  'mongo.connections_high': ['mongo'],
  'mongo.long_op': ['mongo'],
  'mongo.slow_query_burst': ['mongo'],
  'mongo.repl_lag': ['mongo'],
  'host.eventlog_critical': ['eventlog'],
  // Silence is judged against PM2: with PM2 stale nobody knows whether the service is online.
  'app.agent_silent': ['pm2'],
  'app.cpu_no_users': ['pm2'],
};

const pct = (n: number): string => `${n.toFixed(1)}%`;

const VOLUME_REASON: Record<string, string> = {
  missing: 'the log folder is missing or its drive is not available',
  same_volume: 'the log folder is on the same drive as Windows',
  error: 'the log drive could not be checked',
};
const gib = (b: number): string => `${(b / 1024 ** 3).toFixed(2)} GiB`;

function diskRule(rule: RuleRow, c: EvalContext): Observation[] | null {
  const d = c.state.getDisksAt();
  if (!d || rule.threshold === null) return null;
  return d.list
    .filter((x) => x.totalBytes > 0)
    .map((x) => {
      const used = (x.usedBytes / x.totalBytes) * 100;
      return {
        target: x.volume,
        serviceId: null,
        active: used > (rule.threshold as number),
        value: used,
        summary: `Disk ${x.volume} is ${pct(used)} full (limit ${rule.threshold}%)`,
      };
    });
}

const DAY_MS = 86_400_000;

function certRule(rule: RuleRow, c: EvalContext): Observation[] | null {
  if (rule.threshold === null) return null;
  const limit = rule.threshold;
  const out: Observation[] = [];
  for (const x of c.state.getTlsCerts()) {
    if (x.notAfter === null) continue; // never read successfully: shown on the Nginx page, no evidence either way
    const days = (x.notAfter - c.now) / DAY_MS;
    const when = new Date(x.notAfter).toISOString().slice(0, 10);
    out.push({
      target: x.host,
      serviceId: null,
      refresh: true,
      active: days < limit,
      value: Math.floor(days),
      summary:
        days < 0
          ? `The certificate for ${x.host} expired on ${when}`
          : `The certificate for ${x.host} expires in ${Math.floor(days)} days, on ${when} (limit ${limit} days)`,
    });
  }
  return out;
}

/** Services whose agent has reported at least once (the flag survives restarts of the monitor). */
function agentServices(c: EvalContext): { id: number; name: string }[] {
  return c.state
    .getProcessStates()
    .filter((p) => c.agentEnabled(p.serviceId) || c.state.app.lastReportAt(p.serviceId) !== null)
    .map((p) => ({ id: p.serviceId, name: p.name }));
}

/** Evaluators that exist in this build. Rules for later phases have none and show as not implemented. */
export function createEvaluators(): Record<string, Evaluator> {
  // log_dropped compares the counter with the previous tick: it fires while lines are being lost.
  let lastDropped: number | null = null;

  return {
    'host.disk_high': diskRule,
    'host.disk_critical': diskRule,

    'host.cpu_high': (rule, c) => {
      const h = c.state.getHost();
      if (!h || rule.threshold === null) return null;
      return [
        {
          target: '',
          serviceId: null,
          active: h.cpuPct > rule.threshold,
          value: h.cpuPct,
          summary: `CPU is at ${pct(h.cpuPct)} (limit ${rule.threshold}%)`,
        },
      ];
    },

    'host.mem_high': (rule, c) => {
      const h = c.state.getHost();
      if (!h || h.memTotalBytes <= 0 || rule.threshold === null) return null;
      const used = (h.memUsedBytes / h.memTotalBytes) * 100;
      return [
        {
          target: '',
          serviceId: null,
          active: used > rule.threshold,
          value: used,
          summary: `Memory is ${pct(used)} used, ${gib(h.memUsedBytes)} of ${gib(h.memTotalBytes)} (limit ${rule.threshold}%)`,
        },
      ];
    },

    'host.pending_reboot': (_rule, c) => {
      const h = c.state.getHost();
      if (!h) return null;
      return [
        {
          target: '',
          serviceId: null,
          active: h.pendingReboot,
          value: null,
          summary: 'Windows has had a reboot pending for a long time',
        },
      ];
    },

    'host.eventlog_critical': (_rule, c) => {
      const e = c.state.getEventLog();
      if (!e) return null; // not collecting (not Windows, or the collector has not run yet)
      const last = e.lastCritical;
      // "New" means in the last five minutes; the incident resolves a minute after that window empties.
      const active = last !== null && c.now - last.ts < 300_000;
      return [
        {
          target: '',
          serviceId: null,
          active,
          value: e.criticalLast5m,
          refresh: true,
          // Provider and event id only: the message text can hold paths, user names and other private details.
          summary: last
            ? `${e.criticalLast5m} critical event${e.criticalLast5m === 1 ? '' : 's'} in the last 5 minutes; latest from ${last.provider ?? 'unknown source'}, event id ${last.eventId ?? 'unknown'}, in the ${last.logName} log`
            : 'A critical Windows event was logged',
        },
      ];
    },

    'pm2.service_down': (_rule, c) => {
      if (c.state.getProcessesAt() === null) return null;
      return c.state.getProcessStates().map((p) => ({
        target: String(p.serviceId),
        serviceId: p.serviceId,
        active: p.status !== 'online',
        value: null,
        summary: `Service ${p.name} is ${p.status}${p.instances > 0 ? ` (${p.instancesOnline} of ${p.instances} instances online)` : ''}`,
      }));
    },

    'pm2.crash_loop': (rule, c) => {
      if (c.state.getProcessesAt() === null || rule.threshold === null) return null;
      return c.state.getProcessStates().map((p) => {
        const n = c.state.restartsInWindow(p.serviceId, c.now, 600_000);
        return {
          target: String(p.serviceId),
          serviceId: p.serviceId,
          active: n >= (rule.threshold as number),
          value: n,
          summary: `Service ${p.name} restarted ${n} times in the last 10 minutes (limit ${rule.threshold})`,
        };
      });
    },

    'pm2.memory_high': (rule, c) => {
      if (c.state.getProcessesAt() === null || rule.threshold === null) return null;
      const overrides = parseOverrides(rule.params);
      return c.state.getProcessStates().map((p) => {
        const limit = overrides[p.pm2Name] ?? (rule.threshold as number);
        return {
          target: String(p.serviceId),
          serviceId: p.serviceId,
          active: p.status === 'online' && p.memBytes > limit,
          value: p.memBytes,
          summary: `Service ${p.name} uses ${gib(p.memBytes)} (limit ${gib(limit)})`,
        };
      });
    },

    'nginx.5xx_rate': (rule, c) => {
      if (rule.threshold === null || c.state.getNginx(c.now)?.linesTotal === undefined) return null;
      const limit = rule.threshold;
      // Trailing 60 s: a 10 s window rarely holds the 50 requests the rule needs to mean anything.
      return c.state.nginxActiveServices(c.now, 300_000).map((id) => {
        const r = c.state.nginxRecentService(id, c.now, 60_000);
        const share = r.requests > 0 ? (r.s5xx / r.requests) * 100 : 0;
        const name = id === 0 ? 'Unattributed traffic' : (c.state.getProcessStates().find((p) => p.serviceId === id)?.name ?? `Service ${id}`);
        return {
          target: String(id),
          serviceId: id === 0 ? null : id,
          active: r.requests >= 50 && share > limit,
          value: share,
          summary: `${name}: ${r.s5xx} of ${r.requests} requests in the last minute returned 5xx (${pct(share)}, limit ${limit}%)`,
        };
      });
    },

    'nginx.status_unreachable': (_rule, c) => {
      const n = c.state.getNginx(c.now);
      if (!n || n.statusOk === null) return null;
      return [
        {
          target: '',
          serviceId: null,
          active: !n.statusOk,
          value: null,
          summary: `Nginx stub_status is not reachable${n.statusError ? `: ${n.statusError.slice(0, 120)}` : ''}`,
        },
      ];
    },

    'nginx.cert_expiring': certRule,
    'nginx.cert_critical': certRule,

    'mongo.down': (_rule, c) => {
      const m = c.state.getMongo();
      if (!m) return null; // MongoDB monitoring is not configured, or has not run yet
      return [
        {
          target: '',
          serviceId: null,
          active: !m.up,
          value: null,
          summary: `MongoDB is not reachable${m.error ? `: ${m.error.slice(0, 160)}` : ''}`,
        },
      ];
    },

    'mongo.connections_high': (rule, c) => {
      const m = c.state.getMongo();
      if (!m?.up || rule.threshold === null) return null;
      const total = m.connCurrent + m.connAvailable;
      const used = total > 0 ? (m.connCurrent / total) * 100 : 0;
      return [
        {
          target: '',
          serviceId: null,
          active: used > rule.threshold,
          value: used,
          summary: `MongoDB is using ${m.connCurrent} of ${total} connections (${pct(used)}, limit ${rule.threshold}%)`,
        },
      ];
    },

    'mongo.long_op': (rule, c) => {
      const m = c.state.getMongo();
      if (!m?.up || rule.threshold === null) return null;
      const worst = m.currentOps.reduce((a, o) => (o.secsRunning > a.secsRunning ? o : a), { secsRunning: 0, ns: '', op: '' } as { secsRunning: number; ns: string; op: string });
      return [
        {
          target: '',
          serviceId: null,
          active: worst.secsRunning > rule.threshold,
          value: worst.secsRunning,
          summary: `A MongoDB ${worst.op} on ${worst.ns} has been running for ${Math.round(worst.secsRunning)} s (limit ${rule.threshold} s)`,
        },
      ];
    },

    'mongo.slow_query_burst': (rule, c) => {
      const m = c.state.getMongo();
      if (!m?.up || rule.threshold === null || m.slowQueries5m === null) return null;
      return [
        {
          target: '',
          serviceId: null,
          active: m.slowQueries5m > rule.threshold,
          value: m.slowQueries5m,
          summary: `${m.slowQueries5m} slow MongoDB queries in the last 5 minutes (limit ${rule.threshold})`,
        },
      ];
    },

    'mongo.repl_lag': (rule, c) => {
      const m = c.state.getMongo();
      if (!m?.up || !m.repl || m.repl.lagS === null || rule.threshold === null) return null;
      return [
        {
          target: '',
          serviceId: null,
          active: m.repl.lagS > rule.threshold,
          value: m.repl.lagS,
          summary: `MongoDB replication is ${Math.round(m.repl.lagS)} s behind (limit ${rule.threshold} s)`,
        },
      ];
    },

    'app.event_loop_lag': (rule, c) => {
      if (rule.threshold === null) return null;
      return agentServices(c).flatMap((x) => {
        const a = c.state.app.get(x.id, c.now);
        if (!a) return []; // silence is the agent_silent rule's business
        return [
          {
            target: String(x.id),
            serviceId: x.id,
            active: a.eventLoopLagP95Ms > (rule.threshold as number),
            value: a.eventLoopLagP95Ms,
            summary: `Service ${x.name}: event loop lag p95 is ${Math.round(a.eventLoopLagP95Ms)} ms, worst ${Math.round(a.eventLoopLagMaxMs)} ms (limit ${rule.threshold} ms)`,
          },
        ];
      });
    },

    'app.latency_high': (rule, c) => {
      if (rule.threshold === null) return null;
      return agentServices(c).flatMap((x) => {
        const a = c.state.app.get(x.id, c.now);
        if (!a) return [];
        return [
          {
            target: String(x.id),
            serviceId: x.id,
            // With no requests in the window there is no latency to judge.
            active: a.reqPerS > 0 && a.p95Ms > (rule.threshold as number),
            value: a.p95Ms,
            summary: `Service ${x.name}: request p95 is ${Math.round(a.p95Ms)} ms at ${Math.round(a.reqPerS * 10) / 10} requests/s (limit ${rule.threshold} ms)`,
          },
        ];
      });
    },

    'app.cpu_no_users': (rule, c) => {
      if (rule.threshold === null || c.state.getProcessesAt() === null) return null;
      return agentServices(c).flatMap((x) => {
        const a = c.state.app.get(x.id, c.now);
        const p = c.state.getProcessState(x.id);
        if (!a || !p || p.status !== 'online') return [];
        return [
          {
            target: String(x.id),
            serviceId: x.id,
            active: p.cpuPct > (rule.threshold as number) && a.sockets === 0 && a.activeUsers === 0,
            value: p.cpuPct,
            summary: `Service ${x.name} uses ${pct(p.cpuPct)} CPU with no sockets and no active users (limit ${rule.threshold}%)`,
          },
        ];
      });
    },

    'app.agent_silent': (_rule, c) => {
      if (c.state.getProcessesAt() === null) return null;
      return agentServices(c).flatMap((x) => {
        const p = c.state.getProcessState(x.id);
        if (!p || p.status !== 'online') return []; // a service PM2 reports as down is the service_down rule's business
        const last = c.state.app.lastReportAt(x.id);
        const silentMs = last === null ? null : c.now - last;
        return [
          {
            target: String(x.id),
            serviceId: x.id,
            active: silentMs === null || silentMs > AGENT_FRESH_MS,
            value: silentMs === null ? null : Math.round(silentMs / 1000),
            summary:
              silentMs === null
                ? `Service ${x.name} is online in PM2 but its agent has not reported since the monitor started. The event loop may be blocked`
                : `Service ${x.name} is online in PM2 but its agent has sent nothing for ${Math.round(silentMs / 1000)} s. The event loop may be blocked`,
          },
        ];
      });
    },

    'monitor.log_volume_missing': (_rule, c) => {
      const s = c.logs();
      return [
        {
          target: '',
          serviceId: null,
          active: !s.volumeOk,
          value: null,
          summary: `Log storage is unavailable: ${VOLUME_REASON[s.volumeReason ?? ''] ?? 'unknown reason'}. New log lines are kept in memory only`,
        },
      ];
    },

    'monitor.log_volume_high': (rule, c) => {
      const s = c.logs();
      if (!s.volumeOk || rule.threshold === null) return null;
      return [
        {
          target: '',
          serviceId: null,
          active: s.volumeUsedPct > rule.threshold,
          value: s.volumeUsedPct,
          summary: `Log volume is ${pct(s.volumeUsedPct)} full (limit ${rule.threshold}%)`,
        },
      ];
    },

    'monitor.log_dropped': (_rule, c) => {
      const total = c.logs().droppedLines;
      const delta = lastDropped === null ? 0 : Math.max(0, total - lastDropped);
      lastDropped = total;
      return [
        {
          target: '',
          serviceId: null,
          active: delta > 0,
          value: delta,
          summary: `Log lines are being dropped under load (${total} since start)`,
        },
      ];
    },

    'monitor.collector_stale': (_rule, c) =>
      c.collectors().map((x) => ({
        target: x.name,
        serviceId: null,
        active: x.stale,
        value: null,
        summary: `Collector ${x.name} has not succeeded for 3 intervals${x.lastError ? ` (${x.lastError.slice(0, 120)})` : ''}`,
      })),

    'monitor.sqlite_write_failing': (rule, c) => {
      const n = c.persistence().consecutiveFailures;
      const limit = rule.threshold ?? 3;
      return [
        {
          target: '',
          serviceId: null,
          active: n >= limit,
          value: n,
          summary: `Metric writes to the database failed ${n} times in a row`,
        },
      ];
    },

    'monitor.email_bounce_spike': (rule, c) => {
      const n = c.emailBadSince(c.now - 3_600_000);
      const limit = rule.threshold ?? 5;
      return [
        {
          target: '',
          serviceId: null,
          active: n >= limit,
          value: n,
          summary: `${n} emails bounced or drew a complaint in the last hour (limit ${limit})`,
          refresh: true,
        },
      ];
    },

    'monitor.email_failing': (rule, c) => {
      const n = c.email().consecutiveFailures;
      const limit = rule.threshold ?? 3;
      return [
        {
          target: '',
          serviceId: null,
          active: n >= limit,
          value: n,
          summary: `Alert emails failed ${n} times in a row`,
        },
      ];
    },
  };
}
