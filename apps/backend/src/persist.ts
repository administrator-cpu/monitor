import type { ProcessStatus } from '@cc/shared';
import type { Db } from './db';
import type { ProcessEvents } from './pm2/events';
import type { ServicesRepo } from './pm2/services';
import type { StateStore } from './state';

export const BUCKET_MS = 10_000;
/** Never catch up on more than this many buckets after a long failure (the rings hold 30 minutes). */
const MAX_CATCH_UP_BUCKETS = 180;

const STATUS_RANK: Record<ProcessStatus, number> = {
  online: 1,
  launching: 2,
  stopping: 3,
  stopped: 4,
  errored: 5,
};

const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const last = <T>(xs: T[]): T => xs[xs.length - 1] as T;

export interface PersistenceStatus {
  consecutiveFailures: number;
  lastError: string | null;
  lastOkAt: number | null;
  lastRowCount: number;
}

/**
 * Every 10 s, writes the completed 10-second buckets since the last successful write in one
 * transaction: host (averaged from the 2 s samples), disks, per-service process rows, and the
 * queued PM2 events. If a write fails nothing is lost: the in-memory rings still hold the data,
 * so the next run writes every bucket that is still missing (up to 30 minutes).
 */
export class Persistence {
  private nextBucket: number;
  private lastNginxWindow: number;
  private pendingNginxWindow: number;
  private st: PersistenceStatus = {
    consecutiveFailures: 0,
    lastError: null,
    lastOkAt: null,
    lastRowCount: 0,
  };

  constructor(
    private readonly db: Db,
    private readonly state: StateStore,
    private readonly events: ProcessEvents,
    private readonly services: ServicesRepo,
    private readonly now: () => number = Date.now,
  ) {
    this.nextBucket = Math.floor(this.now() / BUCKET_MS) * BUCKET_MS;
    this.lastNginxWindow = this.nextBucket - 1;
    this.pendingNginxWindow = this.lastNginxWindow;
  }

  status(): PersistenceStatus {
    return { ...this.st };
  }

  /** Throws when the transaction fails (the scheduler records that against the 'persist' job). */
  flush(): void {
    const t = this.now();
    const end = Math.floor(t / BUCKET_MS) * BUCKET_MS; // buckets starting before this are complete
    let from = this.nextBucket;
    if (end - from > MAX_CATCH_UP_BUCKETS * BUCKET_MS) from = end - MAX_CATCH_UP_BUCKETS * BUCKET_MS;
    const pendingEvents = this.events.peek();

    try {
      let rows = 0;
      this.db.transaction(() => {
        rows += this.writeBuckets(from, end);
        rows += this.writeNginxWindows();
        rows += this.writeDisks(end);
        rows += this.writeEvents(pendingEvents);
      })();
      this.nextBucket = Math.max(this.nextBucket, end);
      this.lastNginxWindow = this.pendingNginxWindow;
      this.events.ack(pendingEvents.length);
      this.st = { consecutiveFailures: 0, lastError: null, lastOkAt: t, lastRowCount: rows };
    } catch (e) {
      this.st = {
        ...this.st,
        consecutiveFailures: this.st.consecutiveFailures + 1,
        lastError: e instanceof Error ? e.message : String(e),
      };
      throw e;
    }
  }

  private writeBuckets(from: number, end: number): number {
    if (end <= from) return 0;
    const host = this.db.prepare(
      `INSERT OR REPLACE INTO metrics_host
       (host_id, res_s, ts, cpu_pct, cpu_max_core_pct, mem_used_bytes, mem_total_bytes, swap_used_bytes,
        swap_total_bytes, net_rx_bps, net_tx_bps, uptime_s, pending_reboot)
       VALUES (?, 10, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const proc = this.db.prepare(
      `INSERT OR REPLACE INTO metrics_process
       (service_id, res_s, ts, status, instances, cpu_pct, mem_bytes, restarts, uptime_s)
       VALUES (?, 10, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Every host with a live slice: host 1 from the local collectors, agent hosts from their reports.
    const hosts = this.state.hostIds().map((id) => ({ id, slice: this.state.host(id)!, current: this.state.host(id)!.getHost() }));
    const services = this.state.getProcessStates('all');
    let rows = 0;

    for (let b = from; b < end; b += BUCKET_MS) {
      for (const { id: hostId, slice, current } of hosts) {
        const hs = slice.hostSamplesBetween(b, b + BUCKET_MS);
        if (hs.length === 0) continue;
        const lastS = last(hs);
        host.run(
          hostId,
          b,
          avg(hs.map((x) => x.cpuPct)),
          Math.max(...hs.map((x) => x.maxCorePct)),
          Math.round(avg(hs.map((x) => x.memUsedBytes))),
          lastS.memTotalBytes,
          Math.round(avg(hs.map((x) => x.swapUsedBytes))),
          lastS.swapTotalBytes,
          avg(hs.map((x) => x.netRxBps)),
          avg(hs.map((x) => x.netTxBps)),
          current?.uptimeS ?? null,
          current ? (current.pendingReboot ? 1 : 0) : null,
        );
        rows += 1;
      }
      rows += this.writeNginxStatus(b);
      rows += this.writeMongo(b);
      rows += this.writeApp(b);
      for (const svc of services) {
        const ps = this.state.procSamplesBetween(svc.serviceId, b, b + BUCKET_MS);
        if (ps.length === 0) continue;
        const l = last(ps);
        const worst = ps.reduce((w, x) => (STATUS_RANK[x.status] > STATUS_RANK[w] ? x.status : w), ps[0]!.status);
        proc.run(
          svc.serviceId,
          b,
          worst,
          l.instances,
          avg(ps.map((x) => x.cpuPct)),
          Math.round(avg(ps.map((x) => x.memBytes))),
          l.restarts,
          l.uptimeS,
        );
        rows += 1;
      }
    }
    return rows;
  }

  /**
   * Agent figures averaged into the 10 s bucket starting at `b`. Tenant rows are different: they are
   * written once a minute, when the last 10 s bucket of that minute completes, and never at 10 s.
   */
  private writeApp(b: number): number {
    const ids = this.state.app.serviceIds().filter((id) => this.services.get(id));
    if (ids.length === 0) return 0;
    const svc = this.db.prepare(
      `INSERT OR REPLACE INTO metrics_app_service
       (service_id, res_s, ts, sockets, active_users, req_per_s, err5xx_per_s, p95_ms, event_loop_lag_ms,
        event_loop_lag_max, heap_used_bytes, rss_bytes)
       VALUES (?, 10, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let rows = 0;
    for (const id of ids) {
      const xs = this.state.app.samplesBetween(id, b, b + BUCKET_MS);
      if (xs.length === 0) continue;
      svc.run(
        id,
        b,
        Math.round(avg(xs.map((x) => x.sockets))),
        Math.round(avg(xs.map((x) => x.activeUsers))),
        avg(xs.map((x) => x.reqPerS)),
        avg(xs.map((x) => x.err5xxPerS)),
        Math.max(...xs.map((x) => x.p95Ms)),
        avg(xs.map((x) => x.lagP95Ms)),
        Math.max(...xs.map((x) => x.lagMaxMs)),
        Math.round(avg(xs.map((x) => x.heapUsedBytes))),
        Math.round(avg(xs.map((x) => x.rssBytes))),
      );
      rows += 1;
    }
    if ((b + BUCKET_MS) % 60_000 === 0) rows += this.writeTenantMinute(ids, b + BUCKET_MS - 60_000);
    return rows;
  }

  private writeTenantMinute(ids: number[], from: number): number {
    const ensure = this.db.prepare(
      `INSERT INTO tenants (tenant_key, first_seen_at, last_seen_at) VALUES (?, ?, ?)
       ON CONFLICT(tenant_key) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    );
    const idOf = this.db.prepare('SELECT id FROM tenants WHERE tenant_key = ?');
    const put = this.db.prepare(
      `INSERT OR REPLACE INTO metrics_app_tenant (service_id, tenant_id, res_s, ts, sockets, active_users, req_per_s, p95_ms)
       VALUES (?, ?, 60, ?, ?, ?, ?, ?)`,
    );
    const t = this.now();
    let rows = 0;
    for (const id of ids) {
      const samples = this.state.app.tenantSamplesBetween(id, from, from + 60_000);
      const acc = new Map<string, { sockets: number[]; users: number[]; rps: number[]; p95: number[] }>();
      for (const s of samples) {
        for (const x of s.tenants) {
          const a = acc.get(x.key) ?? { sockets: [], users: [], rps: [], p95: [] };
          a.sockets.push(x.sockets);
          a.users.push(x.activeUsers);
          a.rps.push(x.reqPerS);
          a.p95.push(x.p95Ms);
          acc.set(x.key, a);
        }
      }
      for (const [key, a] of acc) {
        ensure.run(key, t, t);
        const tid = (idOf.get(key) as { id: number }).id;
        put.run(id, tid, from, Math.round(avg(a.sockets)), Math.round(avg(a.users)), avg(a.rps), Math.max(...a.p95));
        rows += 1;
      }
    }
    return rows;
  }

  /** The MongoDB sample taken in the 10 s bucket starting at `b` (the collector runs every 10 s). */
  private writeMongo(b: number): number {
    const xs = this.state.mongoSamplesBetween(b, b + BUCKET_MS);
    if (xs.length === 0) return 0;
    const x = last(xs);
    const up = xs.every((s) => s.up);
    const o = x.op;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO metrics_mongo
         (res_s, ts, up, ping_ms, conn_current, conn_available, op_insert_ps, op_query_ps, op_update_ps, op_delete_ps,
          op_getmore_ps, op_command_ps, mem_resident_mb, data_size_bytes, repl_state, repl_lag_s)
         VALUES (10, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        b,
        up ? 1 : 0,
        x.pingMs,
        x.up ? x.connCurrent : null,
        x.up ? x.connAvailable : null,
        x.up ? o.insert : null,
        x.up ? o.query : null,
        x.up ? o.update : null,
        x.up ? o.delete : null,
        x.up ? o.getmore : null,
        x.up ? o.command : null,
        x.up ? x.memResidentMb : null,
        x.dataSizeBytes,
        x.replState,
        x.replLagS,
      );
    return 1;
  }

  /** `stub_status` readings averaged into the 10 s bucket starting at `b`. */
  private writeNginxStatus(b: number): number {
    const xs = this.state.nginxStatusBetween(b, b + BUCKET_MS);
    if (xs.length === 0) return 0;
    const rates = xs.map((x) => x.reqPerS).filter((x): x is number => x !== null);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO metrics_nginx (res_s, ts, active_conn, reading, writing, waiting, req_per_s)
         VALUES (10, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        b,
        Math.round(avg(xs.map((x) => x.active))),
        Math.round(avg(xs.map((x) => x.reading))),
        Math.round(avg(xs.map((x) => x.writing))),
        Math.round(avg(xs.map((x) => x.waiting))),
        rates.length ? avg(rates) : null,
      );
    return 1;
  }

  /**
   * Per-service windows are written once each, as they appear: a window only exists after its 10 s
   * have passed and the log collector has closed it, which can be a moment after the bucket ends.
   */
  private writeNginxWindows(): number {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO metrics_nginx_service
       (service_id, res_s, ts, requests, s2xx, s3xx, s4xx, s5xx, p50_ms, p95_ms, bytes_out)
       VALUES (?, 10, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let rows = 0;
    let maxTs = this.lastNginxWindow;
    for (const w of this.state.nginxWindowsAfter(this.lastNginxWindow)) {
      for (const x of w.services) {
        if (x.serviceId !== 0 && !this.services.get(x.serviceId)) continue; // the service no longer exists
        stmt.run(x.serviceId, w.ts, x.requests, x.s2xx, x.s3xx, x.s4xx, x.s5xx, x.p50Ms, x.p95Ms, x.bytesOut);
        rows += 1;
      }
      maxTs = Math.max(maxTs, w.ts);
    }
    // Only advance after the transaction commits (the caller's try/catch leaves it untouched on failure).
    this.pendingNginxWindow = maxTs;
    return rows;
  }

  /** Disk rows are written for the newest bucket only, and only from a fresh disk reading, per host. */
  private writeDisks(end: number): number {
    const ts = end - BUCKET_MS;
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO metrics_disk (host_id, volume, res_s, ts, used_bytes, total_bytes, read_bps, write_bps)
       VALUES (?, ?, 10, ?, ?, ?, ?, ?)`,
    );
    let rows = 0;
    for (const hostId of this.state.hostIds()) {
      const slice = this.state.host(hostId)!;
      const d = slice.getDisksAt();
      const host = slice.getHost();
      if (!d || !host || end - d.at > 3 * 10_000 + BUCKET_MS) continue;
      for (const x of host.disks) stmt.run(hostId, x.volume, ts, x.usedBytes, x.totalBytes, x.readBps, x.writeBps);
      rows += host.disks.length;
    }
    return rows;
  }

  private writeEvents(events: ReturnType<ProcessEvents['peek']>): number {
    if (events.length === 0) return 0;
    const stmt = this.db.prepare(
      `INSERT INTO process_events (ts, service_id, pm_id, event, detail) VALUES (?, ?, ?, ?, ?)`,
    );
    let n = 0;
    for (const e of events) {
      const svc = this.services.getByPm2Name(e.name);
      if (!svc) continue; // events are only stored for known services
      stmt.run(e.ts, svc.id, e.pmId, e.event, e.detail ? JSON.stringify(e.detail) : null);
      n += 1;
    }
    return n;
  }
}
