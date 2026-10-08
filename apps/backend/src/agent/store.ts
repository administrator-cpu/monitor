import {
  AGENT_FRESH_MS,
  AGENT_MAX_TENANTS,
  type AgentReport,
  type AppSeries,
  type AppServiceState,
  type AppTenantState,
  type AppTotals,
} from '@cc/shared';
import { RingBuffer } from '../state';

/** One merged 5 s observation of a service, with CPU and memory from PM2 at the same instant. */
export interface AppSample {
  ts: number;
  sockets: number;
  activeUsers: number;
  reqPerS: number;
  err5xxPerS: number;
  p95Ms: number;
  lagP95Ms: number;
  lagMaxMs: number;
  heapUsedBytes: number;
  rssBytes: number;
  cpuPct: number;
  memBytes: number;
}

interface Instance {
  at: number;
  r: AgentReport;
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const max = (xs: number[]): number => (xs.length ? Math.max(...xs) : 0);

/** Merges instances of one service: counts add up, lag and latency take the worst case. */
export function mergeInstances(list: Instance[], now: number): AppServiceState {
  const rate = (i: Instance, n: number): number => n / i.r.window_s;
  const byTenant = new Map<string, AppTenantState>();
  let truncated = false;
  for (const i of list) {
    truncated ||= i.r.tenants_truncated === true;
    for (const t of i.r.tenants) {
      const cur = byTenant.get(t.key) ?? { key: t.key, sockets: 0, activeUsers: 0, reqPerS: 0, p95Ms: 0 };
      cur.sockets += t.sockets;
      cur.activeUsers += t.active_users_5m;
      cur.reqPerS += rate(i, t.req_count);
      cur.p95Ms = Math.max(cur.p95Ms, t.p95_ms);
      byTenant.set(t.key, cur);
    }
  }
  let tenants = [...byTenant.values()].sort((a, b) => b.activeUsers - a.activeUsers || a.key.localeCompare(b.key));
  if (tenants.length > AGENT_MAX_TENANTS + 1) {
    // Several instances can each name different tenants; fold the tail into `_other`.
    truncated = true;
    const keep = tenants.slice(0, AGENT_MAX_TENANTS);
    const other = keep.find((t) => t.key === '_other') ?? { key: '_other', sockets: 0, activeUsers: 0, reqPerS: 0, p95Ms: 0 };
    for (const t of tenants.slice(AGENT_MAX_TENANTS)) {
      other.sockets += t.sockets;
      other.activeUsers += t.activeUsers;
      other.reqPerS += t.reqPerS;
      other.p95Ms = Math.max(other.p95Ms, t.p95Ms);
    }
    tenants = keep.includes(other) ? keep : [...keep, other];
  }
  const handles = list.filter((i) => i.r.runtime.active_handles !== undefined);
  return {
    updatedAt: max(list.map((i) => i.at)),
    instances: list.length,
    sockets: sum(list.map((i) => i.r.sockets.open)),
    activeUsers: sum(tenantsOf(list)),
    reqPerS: sum(list.map((i) => rate(i, i.r.http.req_count))),
    err5xxPerS: sum(list.map((i) => rate(i, i.r.http.err5xx_count))),
    p50Ms: max(list.map((i) => i.r.http.p50_ms)),
    p95Ms: max(list.map((i) => i.r.http.p95_ms)),
    eventLoopLagMeanMs: max(list.map((i) => i.r.runtime.event_loop_lag_ms.mean)),
    eventLoopLagP95Ms: max(list.map((i) => i.r.runtime.event_loop_lag_ms.p95)),
    eventLoopLagMaxMs: max(list.map((i) => i.r.runtime.event_loop_lag_ms.max)),
    heapUsedBytes: sum(list.map((i) => i.r.runtime.heap_used_bytes)),
    rssBytes: sum(list.map((i) => i.r.runtime.rss_bytes)),
    activeHandles: handles.length ? sum(handles.map((i) => i.r.runtime.active_handles ?? 0)) : null,
    tenants,
    tenantsTruncated: truncated,
  };
}

/** Active users per instance are the sum of its tenants' counts (a user belongs to one tenant). */
const tenantsOf = (list: Instance[]): number[] =>
  list.map((i) => i.r.tenants.reduce((a, t) => a + t.active_users_5m, 0));

export const APP_RING = 360;
/** Tenant detail is kept for three minutes only: enough to write a 60 s row, not a history. */
const TENANT_RING = 36;

/**
 * Latest report per (service, instance), a 30-minute ring of merged samples per service, and a
 * short ring of tenant detail. Instance data older than 15 s never reaches a reader.
 */
export class AppStore {
  private instances = new Map<number, Map<number, Instance>>();
  private lastAt = new Map<number, number>();
  private rings = new Map<number, RingBuffer<AppSample>>();
  private tenantRings = new Map<number, RingBuffer<{ ts: number; tenants: AppTenantState[] }>>();
  rejected = 0;

  ingest(serviceId: number, r: AgentReport, now: number): void {
    let m = this.instances.get(serviceId);
    if (!m) this.instances.set(serviceId, (m = new Map()));
    m.set(r.pm, { at: now, r });
    this.lastAt.set(serviceId, now);
  }

  private fresh(serviceId: number, now: number): Instance[] {
    const m = this.instances.get(serviceId);
    if (!m) return [];
    for (const [pm, i] of m) if (now - i.at > AGENT_FRESH_MS) m.delete(pm);
    return [...m.values()];
  }

  get(serviceId: number, now: number): AppServiceState | null {
    const list = this.fresh(serviceId, now);
    return list.length ? mergeInstances(list, now) : null;
  }

  /** When any instance of the service last reported, or null if none has since the monitor started. */
  lastReportAt(serviceId: number): number | null {
    return this.lastAt.get(serviceId) ?? null;
  }

  serviceIds(): number[] {
    return [...this.lastAt.keys()];
  }

  forget(serviceId: number): void {
    this.instances.delete(serviceId);
    this.lastAt.delete(serviceId);
    this.rings.delete(serviceId);
    this.tenantRings.delete(serviceId);
  }

  /** Called every 5 s: appends one merged sample for each service that has fresh data. */
  sample(now: number, proc: (serviceId: number) => { cpuPct: number; memBytes: number } | null): void {
    for (const id of this.serviceIds()) {
      const s = this.get(id, now);
      if (!s) continue;
      let ring = this.rings.get(id);
      if (!ring) this.rings.set(id, (ring = new RingBuffer<AppSample>(APP_RING)));
      const p = proc(id);
      ring.push({
        ts: now,
        sockets: s.sockets,
        activeUsers: s.activeUsers,
        reqPerS: s.reqPerS,
        err5xxPerS: s.err5xxPerS,
        p95Ms: s.p95Ms,
        lagP95Ms: s.eventLoopLagP95Ms,
        lagMaxMs: s.eventLoopLagMaxMs,
        heapUsedBytes: s.heapUsedBytes,
        rssBytes: s.rssBytes,
        cpuPct: p?.cpuPct ?? 0,
        memBytes: p?.memBytes ?? 0,
      });
      let tr = this.tenantRings.get(id);
      if (!tr) this.tenantRings.set(id, (tr = new RingBuffer(TENANT_RING)));
      tr.push({ ts: now, tenants: s.tenants });
    }
  }

  samplesBetween(serviceId: number, from: number, to: number): AppSample[] {
    return (this.rings.get(serviceId)?.toArray() ?? []).filter((x) => x.ts >= from && x.ts < to);
  }

  tenantSamplesBetween(serviceId: number, from: number, to: number): { ts: number; tenants: AppTenantState[] }[] {
    return (this.tenantRings.get(serviceId)?.toArray() ?? []).filter((x) => x.ts >= from && x.ts < to);
  }

  series(serviceId: number): AppSeries {
    const s = this.rings.get(serviceId)?.toArray() ?? [];
    return {
      ts: s.map((x) => Math.round(x.ts / 1000)),
      sockets: s.map((x) => x.sockets),
      activeUsers: s.map((x) => x.activeUsers),
      reqPerS: s.map((x) => x.reqPerS),
      p95Ms: s.map((x) => x.p95Ms),
      eventLoopLagP95Ms: s.map((x) => x.lagP95Ms),
      cpuPct: s.map((x) => x.cpuPct),
      memBytes: s.map((x) => x.memBytes),
    };
  }

  totals(now: number): AppTotals | null {
    let services = 0;
    let sockets = 0;
    let activeUsers = 0;
    for (const id of this.serviceIds()) {
      const s = this.get(id, now);
      if (!s) continue;
      services += 1;
      sockets += s.sockets;
      activeUsers += s.activeUsers;
    }
    return services > 0 ? { services, sockets, activeUsers } : null;
  }
}
