import { Reservoir } from './stats';
import { ActiveUsers } from './users';

export const UNKNOWN_TENANT = '_unknown';
export const OTHER_TENANT = '_other';
export const MAX_TENANTS = 50;
/** Tenant keys are capped in length and in number so a hostile header cannot grow memory. */
const MAX_KEY_LENGTH = 100;
const MAX_TRACKED_TENANTS = 1000;

interface TenantAcc {
  reqs: number;
  latencies: Reservoir;
  users: ActiveUsers;
}

export interface TenantReport {
  key: string;
  sockets: number;
  active_users_5m: number;
  req_count: number;
  p95_ms: number;
}

export interface HttpReport {
  req_count: number;
  err5xx_count: number;
  p50_ms: number;
  p95_ms: number;
}

const cleanKey = (raw: unknown): string => {
  const s = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  return s === '' ? UNKNOWN_TENANT : s.slice(0, MAX_KEY_LENGTH);
};

/**
 * Everything the agent counts. Request figures are per reporting window and reset after each
 * report; sockets and active users are levels that carry across windows.
 */
export class Metrics {
  private reqs = 0;
  private err5xx = 0;
  private latencies = new Reservoir();
  private tenants = new Map<string, TenantAcc>();
  private socketsByTenant = new Map<string, number>();

  constructor(private readonly userWindowMs = 300_000) {}

  private tenant(key: string): TenantAcc {
    let t = this.tenants.get(key);
    if (!t) {
      // Past the tracking cap, new tenants share one bucket instead of growing the map.
      if (this.tenants.size >= MAX_TRACKED_TENANTS) return this.tenant(OTHER_TENANT);
      t = { reqs: 0, latencies: new Reservoir(500), users: new ActiveUsers(this.userWindowMs) };
      this.tenants.set(key, t);
    }
    return t;
  }

  recordRequest(statusCode: number, durationMs: number, tenantId: unknown, userId: unknown, now: number): void {
    this.reqs += 1;
    if (statusCode >= 500) this.err5xx += 1;
    this.latencies.add(durationMs);
    const t = this.tenant(cleanKey(tenantId));
    t.reqs += 1;
    t.latencies.add(durationMs);
    if (userId !== undefined && userId !== null && userId !== '') t.users.touch(String(userId).slice(0, 200), now);
  }

  /** A user seen on a socket (not an HTTP request) still counts as active. */
  recordUser(tenantId: unknown, userId: unknown, now: number): void {
    if (userId === undefined || userId === null || userId === '') return;
    this.tenant(cleanKey(tenantId)).users.touch(String(userId).slice(0, 200), now);
  }

  socketOpened(tenantId?: unknown): void {
    const k = cleanKey(tenantId);
    this.socketsByTenant.set(k, (this.socketsByTenant.get(k) ?? 0) + 1);
  }

  socketClosed(tenantId?: unknown): void {
    const k = cleanKey(tenantId);
    const n = (this.socketsByTenant.get(k) ?? 0) - 1;
    if (n > 0) this.socketsByTenant.set(k, n);
    else this.socketsByTenant.delete(k);
  }

  get openSockets(): number {
    let n = 0;
    for (const v of this.socketsByTenant.values()) n += v;
    return n;
  }

  /**
   * Builds the report body and starts a new window. Tenants are ranked by active users and capped
   * at 50; the rest are summed under `_other`.
   */
  collect(now: number): { http: HttpReport; sockets: number; tenants: TenantReport[]; truncated: boolean } {
    const http: HttpReport = {
      req_count: this.reqs,
      err5xx_count: this.err5xx,
      p50_ms: round(this.latencies.percentile(50)),
      p95_ms: round(this.latencies.percentile(95)),
    };
    const keys = new Set<string>([...this.tenants.keys(), ...this.socketsByTenant.keys()]);
    const rows: TenantReport[] = [];
    for (const key of keys) {
      const t = this.tenants.get(key);
      rows.push({
        key,
        sockets: this.socketsByTenant.get(key) ?? 0,
        active_users_5m: t ? t.users.count(now) : 0,
        req_count: t?.reqs ?? 0,
        p95_ms: t ? round(t.latencies.percentile(95)) : 0,
      });
    }
    rows.sort((a, b) => b.active_users_5m - a.active_users_5m || b.req_count - a.req_count || a.key.localeCompare(b.key));
    let tenants = rows;
    let truncated = false;
    if (rows.length > MAX_TENANTS) {
      truncated = true;
      const rest = rows.slice(MAX_TENANTS);
      tenants = rows.slice(0, MAX_TENANTS);
      const other = tenants.find((r) => r.key === OTHER_TENANT);
      const sum: TenantReport = other ?? { key: OTHER_TENANT, sockets: 0, active_users_5m: 0, req_count: 0, p95_ms: 0 };
      for (const r of rest) {
        sum.sockets += r.sockets;
        sum.active_users_5m += r.active_users_5m;
        sum.req_count += r.req_count;
        sum.p95_ms = Math.max(sum.p95_ms, r.p95_ms);
      }
      if (!other) tenants.push(sum);
    }
    // New window: request figures restart, and tenants that are completely idle are forgotten.
    this.reqs = 0;
    this.err5xx = 0;
    this.latencies.reset();
    for (const [k, t] of this.tenants) {
      t.reqs = 0;
      t.latencies.reset();
      if (t.users.count(now) === 0 && !this.socketsByTenant.has(k)) this.tenants.delete(k);
    }
    return { http, sockets: this.openSockets, tenants, truncated };
  }
}

const round = (n: number): number => Math.round(n * 100) / 100;
