import type {
  DiskState,
  HostSeries,
  HostState,
  MongoSeries,
  MongoState,
  NginxSeries,
  NginxState,
  ProcessState,
  ProcessStatus,
  ServiceSeries,
} from '@cc/shared';
import { LOCAL_HOST_ID, type AgentContainer } from '@cc/shared';
import type { NginxWindow } from './nginx/aggregate';
import type { StubSample } from './nginx/stub';
import { AppStore } from './agent/store';

/** Fixed-capacity circular buffer. Oldest entries are overwritten. */
export class RingBuffer<T> {
  private items: (T | undefined)[];
  private start = 0;
  private size = 0;

  constructor(private readonly capacity: number) {
    this.items = new Array<T | undefined>(capacity);
  }

  push(v: T): void {
    const idx = (this.start + this.size) % this.capacity;
    this.items[idx] = v;
    if (this.size < this.capacity) {
      this.size += 1;
    } else {
      this.start = (this.start + 1) % this.capacity;
    }
  }

  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.size; i++) {
      out.push(this.items[(this.start + i) % this.capacity] as T);
    }
    return out;
  }

  get length(): number {
    return this.size;
  }
}

interface CpuMemPart {
  at: number;
  cpuPct: number;
  cpuPerCore: number[];
  memUsedBytes: number;
  memTotalBytes: number;
  swapUsedBytes: number;
  swapTotalBytes: number;
  netRxBps: number;
  netTxBps: number;
}

interface SystemPart {
  at: number;
  uptimeS: number;
  pendingReboot: boolean;
}

export interface HostSample {
  ts: number; // ms
  cpuPct: number;
  maxCorePct: number;
  memUsedBytes: number;
  memTotalBytes: number;
  swapUsedBytes: number;
  swapTotalBytes: number;
  memPct: number;
  netRxBps: number;
  netTxBps: number;
}

/** One 5 s observation of a service, kept for 30 minutes and averaged into the 10 s stored rows. */
export interface ProcSample {
  ts: number;
  status: ProcessStatus;
  instances: number;
  cpuPct: number;
  memBytes: number;
  restarts: number;
  uptimeS: number;
}

export interface DiskIo {
  readBps: number;
  writeBps: number;
}

/** One `stub_status` reading with the request rate derived from the counter. */
export interface NginxStatusSample {
  ts: number;
  active: number;
  reading: number;
  writing: number;
  waiting: number;
  reqPerS: number | null;
}

export interface MongoSample {
  ts: number;
  up: boolean;
  pingMs: number | null;
  connCurrent: number;
  connAvailable: number;
  op: { insert: number; query: number; update: number; delete: number; getmore: number; command: number };
  memResidentMb: number;
  dataSizeBytes: number | null;
  replState: string | null;
  replLagS: number | null;
}

export interface EventLogSummary {
  at: number;
  /** Events stored by the latest run. */
  added: number;
  lastCritical: { ts: number; logName: string; provider: string | null; eventId: number | null } | null;
  criticalLast5m: number;
}

export interface TlsCertRow {
  host: string;
  notAfter: number | null;
  issuer: string | null;
  checkedAt: number;
  lastError: string | null;
}

/** 30 minutes at 5 s. */
export const SERVICE_SERIES_CAPACITY = 360;

/** 30 minutes at 2 s (backend-schema.md section 5). */
export const HOST_SERIES_CAPACITY = 900;

/**
 * The host-level part of the live state for one host: CPU, memory, swap, network, uptime and disks,
 * plus the 30-minute host series. Host 1's slice is fed by the local collectors; an agent host's
 * slice by its metrics reports (one sample every 10 s).
 */
export class HostSlice {
  private cpuMem: CpuMemPart | null = null;
  private system: SystemPart | null = null;
  private disks: { at: number; list: DiskState[] } | null = null;
  private diskIo: { at: number; byVolume: Map<string, DiskIo> } | null = null;
  private readonly hostSeries = new RingBuffer<HostSample>(HOST_SERIES_CAPACITY);
  /** Latest container list reported by an agent host (turned into services from M2). */
  private containers: { at: number; list: AgentContainer[] } | null = null;

  /** Disk I/O older than this is reported as "not measured" rather than shown as current. */
  static readonly DISK_IO_FRESH_MS = 40_000;

  setCpuMem(part: CpuMemPart): void {
    this.cpuMem = part;
    this.hostSeries.push({
      ts: part.at,
      cpuPct: part.cpuPct,
      maxCorePct: part.cpuPerCore.reduce((m, v) => (v > m ? v : m), 0),
      memUsedBytes: part.memUsedBytes,
      memTotalBytes: part.memTotalBytes,
      swapUsedBytes: part.swapUsedBytes,
      swapTotalBytes: part.swapTotalBytes,
      memPct: part.memTotalBytes > 0 ? (part.memUsedBytes / part.memTotalBytes) * 100 : 0,
      netRxBps: part.netRxBps,
      netTxBps: part.netTxBps,
    });
  }

  /** Per-volume read/write rates from the disk I/O collector (Windows). */
  setDiskIo(byVolume: Map<string, DiskIo>, at: number): void {
    this.diskIo = { at, byVolume };
  }

  /** Host samples with `ts` in [from, to). */
  hostSamplesBetween(from: number, to: number): HostSample[] {
    return this.hostSeries.toArray().filter((x) => x.ts >= from && x.ts < to);
  }

  /** Freshest usage reading for the volume that holds `root` (drive letter on Windows). */
  diskUsedPctFor(root: string): number | null {
    const list = this.disks?.list ?? [];
    const drive = /^[A-Za-z]:/.exec(root)?.[0].toUpperCase();
    const d = drive ? list.find((x) => x.volume === drive) : list.length === 1 ? list[0] : undefined;
    return d && d.totalBytes > 0 ? (d.usedBytes / d.totalBytes) * 100 : null;
  }

  setSystem(part: SystemPart): void {
    this.system = part;
  }

  setDisks(list: DiskState[], at: number): void {
    this.disks = { at, list };
  }

  /** Null until the first CPU/memory sample, so the UI never shows invented zeros. */
  getHost(): HostState | null {
    const c = this.cpuMem;
    if (!c) return null;
    return {
      // The live sample time. Disk/system freshness is reported per collector.
      updatedAt: c.at,
      cpuPct: c.cpuPct,
      cpuPerCore: c.cpuPerCore,
      memUsedBytes: c.memUsedBytes,
      memTotalBytes: c.memTotalBytes,
      swapUsedBytes: c.swapUsedBytes,
      swapTotalBytes: c.swapTotalBytes,
      netRxBps: c.netRxBps,
      netTxBps: c.netTxBps,
      uptimeS: this.system?.uptimeS ?? 0,
      pendingReboot: this.system?.pendingReboot ?? false,
      disks: this.mergedDisks(c.at),
    };
  }

  private mergedDisks(at: number): DiskState[] {
    const list = this.disks?.list ?? [];
    const io = this.diskIo && at - this.diskIo.at <= HostSlice.DISK_IO_FRESH_MS ? this.diskIo : null;
    if (!io) return list;
    return list.map((d) => {
      const r = io.byVolume.get(d.volume);
      return r ? { ...d, readBps: r.readBps, writeBps: r.writeBps } : d;
    });
  }

  /** Latest disk usage as reported by the disk collector, with its sample time. */
  getDisksAt(): { at: number; list: DiskState[] } | null {
    return this.disks;
  }

  setContainers(list: AgentContainer[], at: number): void {
    this.containers = { at, list };
  }

  getContainersAt(): { at: number; list: AgentContainer[] } | null {
    return this.containers;
  }

  /** Series in seconds-since-epoch, the layout uPlot consumes directly. */
  getHostSeries(): HostSeries {
    const s = this.hostSeries.toArray();
    return {
      ts: s.map((x) => Math.round(x.ts / 1000)),
      cpuPct: s.map((x) => x.cpuPct),
      memPct: s.map((x) => x.memPct),
      netRxBps: s.map((x) => x.netRxBps),
      netTxBps: s.map((x) => x.netTxBps),
    };
  }
}

/**
 * In-memory snapshot of the latest values plus ring buffers. Collectors write
 * here; the WebSocket layer and REST routes only read, so cost does not grow
 * with the number of viewers.
 */
export class StateStore {
  /** Host 1 (this server) is always present; agent hosts are added as they report. */
  private readonly slices = new Map<number, HostSlice>([[LOCAL_HOST_ID, new HostSlice()]]);
  private processes = new Map<number, { hostId: number; state: ProcessState; ring: RingBuffer<ProcSample> }>();
  private processesAt = new Map<number, number>();
  private nginxStatus: { at: number; ok: boolean; error?: string } | null = null;
  private nginxStatusRing = new RingBuffer<NginxStatusSample>(360);
  private nginxWindows = new RingBuffer<NginxWindow>(180);
  private nginxLog: {
    at: number;
    malformedLines: number;
    linesTotal: number;
    lastLineAt: number | null;
  } | null = null;
  private tlsCerts: TlsCertRow[] = [];
  private mongo: MongoState | null = null;
  private mongoRing = new RingBuffer<MongoSample>(360);
  private eventLog: EventLogSummary | null = null;
  /** Reports from the in-app agent (phase 8). */
  readonly app = new AppStore();

  /** Host 1, fed by the local collectors. */
  get local(): HostSlice {
    return this.slices.get(LOCAL_HOST_ID)!;
  }

  /** The slice of an agent host, created on its first report. */
  ensureHost(hostId: number): HostSlice {
    let h = this.slices.get(hostId);
    if (!h) {
      h = new HostSlice();
      this.slices.set(hostId, h);
    }
    return h;
  }

  host(hostId: number): HostSlice | undefined {
    return this.slices.get(hostId);
  }

  hostIds(): number[] {
    return [...this.slices.keys()].sort((a, b) => a - b);
  }

  /** A revoked host leaves the live view; its stored history stays. Host 1 is never dropped. */
  dropHost(hostId: number): void {
    if (hostId === LOCAL_HOST_ID) return;
    this.slices.delete(hostId);
    for (const [id, e] of this.processes) if (e.hostId === hostId) this.processes.delete(id);
    this.processesAt.delete(hostId);
  }

  setCpuMem(part: CpuMemPart): void {
    this.local.setCpuMem(part);
  }

  /** Per-volume read/write rates from the disk I/O collector (Windows). */
  setDiskIo(byVolume: Map<string, DiskIo>, at: number): void {
    this.local.setDiskIo(byVolume, at);
  }

  /** Host samples with `ts` in [from, to). */
  hostSamplesBetween(from: number, to: number): HostSample[] {
    return this.local.hostSamplesBetween(from, to);
  }

  /**
   * Replaces one host's process view (PM2 on host 1, containers on an agent host from M2) and
   * appends one sample per service to its 30-minute ring. Other hosts' entries are left alone.
   */
  setProcesses(list: ProcessState[], at: number, hostId: number = LOCAL_HOST_ID): void {
    const keep = new Set<number>();
    for (const p of list) {
      keep.add(p.serviceId);
      let e = this.processes.get(p.serviceId);
      if (!e) {
        e = { hostId, state: p, ring: new RingBuffer<ProcSample>(SERVICE_SERIES_CAPACITY) };
        this.processes.set(p.serviceId, e);
      }
      e.state = p;
      e.ring.push({
        ts: at,
        status: p.status,
        instances: p.instances,
        cpuPct: p.cpuPct,
        memBytes: p.memBytes,
        restarts: p.restarts,
        uptimeS: p.uptimeS,
      });
    }
    // A service that was archived or renamed away leaves the live view; its ring is released.
    for (const [id, e] of [...this.processes]) if (e.hostId === hostId && !keep.has(id)) this.processes.delete(id);
    this.processesAt.set(hostId, at);
  }

  /** Host 1's processes unless another host, or 'all', is asked for. */
  getProcessStates(hostId: number | 'all' = LOCAL_HOST_ID): ProcessState[] {
    return [...this.processes.values()].filter((e) => hostId === 'all' || e.hostId === hostId).map((e) => e.state);
  }

  getProcessState(serviceId: number): ProcessState | null {
    return this.processes.get(serviceId)?.state ?? null;
  }

  /** When a host's process list was last refreshed, null before the first answer (PM2 on host 1). */
  getProcessesAt(hostId: number = LOCAL_HOST_ID): number | null {
    return this.processesAt.get(hostId) ?? null;
  }

  /** Samples of one service with `ts` in [from, to). */
  procSamplesBetween(serviceId: number, from: number, to: number): ProcSample[] {
    const e = this.processes.get(serviceId);
    return e ? e.ring.toArray().filter((x) => x.ts >= from && x.ts < to) : [];
  }

  /** Restart increments in the window ending at `now` (counter resets and decreases count as 0). */
  restartsInWindow(serviceId: number, now: number, windowMs: number): number {
    const e = this.processes.get(serviceId);
    if (!e) return 0;
    let total = 0;
    let prev: number | null = null;
    for (const x of e.ring.toArray()) {
      if (x.ts < now - windowMs) {
        prev = x.restarts;
        continue;
      }
      if (prev !== null && x.restarts > prev) total += x.restarts - prev;
      prev = x.restarts;
    }
    return total;
  }

  getServiceSeries(serviceId: number): ServiceSeries {
    const e = this.processes.get(serviceId);
    const s = e ? e.ring.toArray() : [];
    return {
      ts: s.map((x) => Math.round(x.ts / 1000)),
      cpuPct: s.map((x) => x.cpuPct),
      memBytes: s.map((x) => x.memBytes),
    };
  }

  /** Freshest usage reading for the volume that holds `root` (drive letter on Windows). */
  diskUsedPctFor(root: string): number | null {
    return this.local.diskUsedPctFor(root);
  }

  setSystem(part: SystemPart): void {
    this.local.setSystem(part);
  }

  setDisks(list: DiskState[], at: number): void {
    this.local.setDisks(list, at);
  }

  /** Null until the first CPU/memory sample, so the UI never shows invented zeros. */
  getHost(): HostState | null {
    return this.local.getHost();
  }

  /** Latest disk usage as reported by the disk collector, with its sample time. */
  getDisksAt(): { at: number; list: DiskState[] } | null {
    return this.local.getDisksAt();
  }

  // --- nginx (phase 6) -------------------------------------------------------

  /** Records one `stub_status` attempt. A failure keeps the previous series and is itself data. */
  setNginxStatus(at: number, res: { ok: true; sample: StubSample; reqPerS: number | null } | { ok: false; error: string }): void {
    if (res.ok) {
      this.nginxStatus = { at, ok: true };
      this.nginxStatusRing.push({
        ts: at,
        active: res.sample.active,
        reading: res.sample.reading,
        writing: res.sample.writing,
        waiting: res.sample.waiting,
        reqPerS: res.reqPerS,
      });
    } else {
      this.nginxStatus = { at, ok: false, error: res.error };
    }
  }

  addNginxWindows(ws: NginxWindow[]): void {
    for (const w of ws) this.nginxWindows.push(w);
  }

  setNginxLog(v: NonNullable<StateStore['nginxLog']>): void {
    this.nginxLog = v;
  }

  nginxStatusBetween(from: number, to: number): NginxStatusSample[] {
    return this.nginxStatusRing.toArray().filter((x) => x.ts >= from && x.ts < to);
  }

  /** Completed windows newer than `after` (exclusive), oldest first. */
  nginxWindowsAfter(after: number): NginxWindow[] {
    return this.nginxWindows.toArray().filter((w) => w.ts > after);
  }

  /** Requests and 5xx for one service over the last `windowMs` (completed windows only). */
  nginxRecentService(serviceId: number, now: number, windowMs: number): { requests: number; s5xx: number } {
    let requests = 0;
    let s5xx = 0;
    for (const w of this.nginxWindows.toArray()) {
      if (w.ts < now - windowMs) continue;
      const x = w.services.find((y) => y.serviceId === serviceId);
      if (x) {
        requests += x.requests;
        s5xx += x.s5xx;
      }
    }
    return { requests, s5xx };
  }

  /** Service ids with any traffic in the last `windowMs`. */
  nginxActiveServices(now: number, windowMs: number): number[] {
    const ids = new Set<number>();
    for (const w of this.nginxWindows.toArray()) {
      if (w.ts >= now - windowMs) for (const x of w.services) ids.add(x.serviceId);
    }
    return [...ids];
  }

  /** Null until Nginx has been seen by either source. */
  getNginx(now: number): NginxState | null {
    const st = this.nginxStatus;
    const lg = this.nginxLog;
    if (!st && !lg) return null;
    const lastStatus = this.nginxStatusRing.length > 0 ? this.nginxStatusRing.toArray().at(-1)! : null;
    const wins = this.nginxWindows.toArray();
    const lastWin = wins.at(-1) ?? null;
    const winFresh = lastWin !== null && now - lastWin.ts <= 60_000;
    const reqPerS =
      lastStatus && st?.ok && lastStatus.reqPerS !== null ? lastStatus.reqPerS : winFresh ? lastWin!.requests / 10 : 0;
    return {
      updatedAt: Math.max(st?.at ?? 0, lg?.at ?? 0),
      statusOk: st ? st.ok : null,
      ...(st && !st.ok && st.error ? { statusError: st.error } : {}),
      activeConn: st?.ok && lastStatus ? lastStatus.active : 0,
      reading: st?.ok && lastStatus ? lastStatus.reading : 0,
      writing: st?.ok && lastStatus ? lastStatus.writing : 0,
      waiting: st?.ok && lastStatus ? lastStatus.waiting : 0,
      reqPerS,
      perService: winFresh
        ? lastWin!.services.map((x) => ({
            serviceId: x.serviceId,
            reqPerS: x.requests / 10,
            s2xx: x.s2xx,
            s3xx: x.s3xx,
            s4xx: x.s4xx,
            s5xx: x.s5xx,
            p50Ms: x.p50Ms,
            p95Ms: x.p95Ms,
          }))
        : [],
      malformedLines: lg?.malformedLines ?? 0,
      linesTotal: lg?.linesTotal ?? 0,
      lastLineAt: lg?.lastLineAt ?? null,
    };
  }

  /** 30-minute series for the Nginx page, one point per 10 s window. */
  getNginxSeries(): NginxSeries {
    const wins = this.nginxWindows.toArray();
    const status = this.nginxStatusRing.toArray();
    const connAt = (ts: number): number => {
      const near = status.filter((x) => x.ts >= ts && x.ts < ts + 10_000);
      return near.length ? Math.round(near.reduce((a, b) => a + b.active, 0) / near.length) : 0;
    };
    return {
      ts: wins.map((w) => Math.round(w.ts / 1000)),
      reqPerS: wins.map((w) => w.requests / 10),
      activeConn: wins.map((w) => connAt(w.ts)),
      err5xxPct: wins.map((w) => (w.requests > 0 ? (w.services.reduce((a, b) => a + b.s5xx, 0) / w.requests) * 100 : 0)),
    };
  }

  /** 30-minute traffic series of one service (0 = unattributed). */
  getNginxServiceSeries(serviceId: number): { ts: number[]; reqPerS: number[]; err5xxPct: number[]; p95Ms: number[] } {
    const out = { ts: [] as number[], reqPerS: [] as number[], err5xxPct: [] as number[], p95Ms: [] as number[] };
    for (const w of this.nginxWindows.toArray()) {
      const x = w.services.find((y) => y.serviceId === serviceId);
      out.ts.push(Math.round(w.ts / 1000));
      out.reqPerS.push(x ? x.requests / 10 : 0);
      out.err5xxPct.push(x && x.requests > 0 ? (x.s5xx / x.requests) * 100 : 0);
      out.p95Ms.push(x ? x.p95Ms : 0);
    }
    return out;
  }

  // --- mongo (phase 7) -------------------------------------------------------

  setMongo(m: MongoState): void {
    this.mongo = m;
    this.mongoRing.push({
      ts: m.updatedAt,
      up: m.up,
      pingMs: m.pingMs,
      connCurrent: m.connCurrent,
      connAvailable: m.connAvailable,
      op: m.opsPerS,
      memResidentMb: m.memResidentMb,
      dataSizeBytes: m.dataSizeBytes,
      replState: m.repl?.state ?? null,
      replLagS: m.repl?.lagS ?? null,
    });
  }

  getMongo(): MongoState | null {
    return this.mongo;
  }

  mongoSamplesBetween(from: number, to: number): MongoSample[] {
    return this.mongoRing.toArray().filter((x) => x.ts >= from && x.ts < to);
  }

  getMongoSeries(): MongoSeries {
    const s = this.mongoRing.toArray();
    const total = (x: MongoSample): number => x.op.insert + x.op.query + x.op.update + x.op.delete + x.op.getmore + x.op.command;
    return {
      ts: s.map((x) => Math.round(x.ts / 1000)),
      connCurrent: s.map((x) => x.connCurrent),
      opsPerS: s.map(total),
      pingMs: s.map((x) => x.pingMs ?? 0),
      memResidentMb: s.map((x) => x.memResidentMb),
    };
  }

  setEventLog(v: EventLogSummary): void {
    this.eventLog = v;
  }

  /** Null until the Windows Event Log collector has run (never on a non-Windows host). */
  getEventLog(): EventLogSummary | null {
    return this.eventLog;
  }

  setTlsCerts(rows: TlsCertRow[]): void {
    this.tlsCerts = rows;
  }

  getTlsCerts(): TlsCertRow[] {
    return this.tlsCerts;
  }


  /** Series in seconds-since-epoch, the layout uPlot consumes directly. */
  getHostSeries(): HostSeries {
    return this.local.getHostSeries();
  }
}
