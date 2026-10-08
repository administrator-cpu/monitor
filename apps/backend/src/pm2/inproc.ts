import net from 'node:net';
import type { Pm2EventPacket, Pm2Handlers, Pm2LogPacket, Pm2Proc, Pm2Source } from './types';
import { EVENT_ALLOWLIST } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const FLUSH_MS = 50;
const FLUSH_MAX = 500;
const MESSAGE_MAX = 300;

/** Connects to the PM2 RPC socket and closes it again; never launches anything. */
export function probeSocket(socketPath: string, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.destroy();
      resolve();
    });
    sock.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export function describeProbeError(e: unknown, socketPath: string): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  switch (code) {
    case 'ENOENT':
      return `PM2 daemon is not running (no socket at ${socketPath}). Is PM2_HOME correct?`;
    case 'ECONNREFUSED':
      return `PM2 daemon is not running (stale socket at ${socketPath}).`;
    case 'EACCES':
    case 'EPERM':
      return `No permission to use the PM2 socket at ${socketPath}. Run the monitor as the PM2 user or set PM2_HOME.`;
    case 'ETIMEDOUT':
      return `PM2 daemon did not answer on ${socketPath}.`;
    default:
      return `Cannot reach the PM2 daemon: ${(e as Error)?.message ?? String(e)}`;
  }
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** Copies the whitelisted fields out of a PM2 process record. */
export function toProc(p: any): Pm2Proc | null {
  const env = p?.pm2_env ?? {};
  const name = typeof p?.name === 'string' ? p.name : typeof env.name === 'string' ? env.name : null;
  if (!name) return null;
  const uptime = num(env.pm_uptime, 0);
  return {
    name,
    pmId: num(p?.pm_id ?? env.pm_id, -1),
    status: String(env.status ?? 'unknown'),
    restarts: num(env.restart_time, 0),
    pmUptime: uptime > 0 ? uptime : null,
    cpu: num(p?.monit?.cpu, 0),
    memory: num(p?.monit?.memory, 0),
    isModule: env.pmx_module === true,
    outLog: typeof env.pm_out_log_path === 'string' ? env.pm_out_log_path : null,
    errLog: typeof env.pm_err_log_path === 'string' ? env.pm_err_log_path : null,
  };
}

function toEvent(pkt: any, kindOverride?: string): Pm2EventPacket | null {
  const proc = pkt?.process ?? {};
  const name = typeof proc.name === 'string' ? proc.name : null;
  const event = kindOverride ?? (typeof pkt?.event === 'string' ? pkt.event : null);
  if (!name || !event || !EVENT_ALLOWLIST.has(event)) return null;
  const code = proc.exit_code ?? proc.exitCode;
  const msg = kindOverride === 'exception' ? pkt?.data?.message : undefined;
  return {
    name,
    pmId: Number.isFinite(proc.pm_id) ? proc.pm_id : null,
    event,
    at: num(pkt?.at, Date.now()),
    exitCode: typeof code === 'number' ? code : null,
    signal: typeof proc.signal === 'string' ? proc.signal : null,
    isModule: proc.pmx_module === true,
    ...(typeof msg === 'string' ? { message: msg.slice(0, MESSAGE_MAX) } : {}),
  };
}

/**
 * The real PM2 adapter. It runs inside a worker thread (see worker.ts), because the `pm2`
 * package was written for a command line: it prints to the console, and can call
 * `process.exit()` on some errors. In a worker that ends only the worker, not the monitor.
 */
export class InProcPm2Source implements Pm2Source {
  private pm2: any = null;
  private bus: any = null;
  private handlers: Pm2Handlers | null = null;
  private logs: Pm2LogPacket[] = [];
  private events: Pm2EventPacket[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly load: () => any = () => require('pm2')) {}

  private api(): any {
    if (!this.pm2) this.pm2 = this.load();
    return this.pm2;
  }

  async connect(): Promise<void> {
    const consts = require('pm2/constants');
    const socketPath: string = consts.DAEMON_RPC_PORT;
    try {
      await probeSocket(socketPath);
    } catch (e) {
      throw new Error(describeProbeError(e, socketPath));
    }
    const pm2 = this.api();
    await new Promise<void>((resolve, reject) =>
      pm2.connect((err: unknown) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve())),
    );
  }

  async list(): Promise<Pm2Proc[]> {
    const pm2 = this.api();
    const raw: any[] = await new Promise((resolve, reject) =>
      pm2.list((err: unknown, l: any[]) =>
        err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(l ?? []),
      ),
    );
    const out: Pm2Proc[] = [];
    for (const p of raw) {
      const proc = toProc(p);
      if (proc) out.push(proc);
    }
    return out;
  }

  async startBus(handlers: Pm2Handlers): Promise<void> {
    await this.stopBus();
    this.handlers = handlers;
    const pm2 = this.api();
    const bus: any = await new Promise((resolve, reject) =>
      pm2.launchBus((err: unknown, b: any) =>
        err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(b),
      ),
    );
    this.bus = bus;
    const onLog = (stream: 'out' | 'err') => (pkt: any) => {
      const name = pkt?.process?.name;
      if (typeof name !== 'string' || typeof pkt?.data !== 'string') return;
      this.logs.push({
        name,
        pmId: num(pkt.process.pm_id, -1),
        stream,
        data: pkt.data,
        at: num(pkt.at, Date.now()),
      });
      if (this.logs.length >= FLUSH_MAX) this.flush();
    };
    bus.on('log:out', onLog('out'));
    bus.on('log:err', onLog('err'));
    bus.on('process:event', (pkt: any) => {
      const e = toEvent(pkt);
      if (e) this.events.push(e);
    });
    bus.on('process:exception', (pkt: any) => {
      const e = toEvent(pkt, 'exception');
      if (e) this.events.push(e);
    });
    // The socket under the bus reconnects by itself; we close it instead and let the link rebuild
    // everything, otherwise a reconnected old bus and a new one would deliver every line twice.
    const closed = () => {
      if (this.bus !== bus) return;
      this.closeBus();
      this.handlers?.onBusClosed();
    };
    bus.sock?.once?.('close', closed);
    bus.sock?.once?.('reconnect attempt', closed);
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    this.flushTimer.unref();
  }

  private flush(): void {
    const h = this.handlers;
    if (!h) return;
    if (this.logs.length > 0) {
      const items = this.logs;
      this.logs = [];
      h.onLogs(items);
    }
    if (this.events.length > 0) {
      const items = this.events;
      this.events = [];
      h.onEvents(items);
    }
  }

  private closeBus(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    const bus = this.bus;
    this.bus = null;
    try {
      bus?.close?.();
    } catch {
      // already closed
    }
  }

  async stopBus(): Promise<void> {
    this.flush();
    this.closeBus();
    this.handlers = null;
  }

  async dispose(): Promise<void> {
    await this.stopBus();
    try {
      this.pm2?.disconnect?.();
    } catch {
      // ignore
    }
  }
}
