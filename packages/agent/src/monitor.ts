import type { IncomingMessage, ServerResponse } from 'node:http';
import { Metrics } from './window';
import { RuntimeProbe } from './runtime';
import { Transport } from './transport';

export interface TenantInfo {
  tenantId?: string | number | null;
  userId?: string | number | null;
}
export type TenantResolver = (req: IncomingMessage) => TenantInfo | null | undefined;

export interface MonitorOptions {
  /** Shared secret; must equal INGEST_TOKEN in the monitor's environment. */
  token: string;
  /** PM2 process name. Defaults to the `name` PM2 puts in the environment. */
  service?: string;
  /** Default `http://127.0.0.1:4001/ingest/v1/agent`. */
  url?: string;
  intervalMs?: number;
  /** `false` turns the whole agent into a no-op (also `COMMAND_CENTER_AGENT=off`). */
  enabled?: boolean;
  tenantResolver?: TenantResolver;
}

export interface Monitor {
  /** Connect/Express style middleware: `app.use(monitor.middleware())`. */
  middleware(): (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => void;
  /** Decide which tenant and user a request belongs to. Called when the response finishes. */
  tenantResolver(fn: TenantResolver): void;
  /** Call when a WebSocket (or other long-lived connection) opens and closes. */
  socketOpened(tenantId?: string | number | null, userId?: string | number | null): void;
  socketClosed(tenantId?: string | number | null): void;
  /** Counts of what the agent could not deliver, for your own diagnostics. */
  stats(): { sent: number; failed: number; enabled: boolean };
  /** Builds and sends one report immediately (mainly for tests). */
  flush(): void;
  stop(): void;
}

const DEFAULT_URL = 'http://127.0.0.1:4001/ingest/v1/agent';

export function identity(env: NodeJS.ProcessEnv = process.env): { service: string; pm: number } {
  const service = env.name || env.pm_exec_path?.split(/[\\/]/).pop() || 'unknown';
  const raw = env.pm_id ?? env.NODE_APP_INSTANCE;
  const pm = raw !== undefined && raw !== '' && Number.isInteger(Number(raw)) ? Number(raw) : -1;
  return { service, pm };
}

export function createMonitor(opts: MonitorOptions): Monitor {
  const off = opts.enabled === false || process.env.COMMAND_CENTER_AGENT === 'off' || !opts.token;
  const metrics = new Metrics();
  let resolver: TenantResolver | undefined = opts.tenantResolver;

  if (off) {
    const noop = () => undefined;
    return {
      middleware: () => (_req, _res, next) => next?.(),
      tenantResolver: noop,
      socketOpened: noop,
      socketClosed: noop,
      stats: () => ({ sent: 0, failed: 0, enabled: false }),
      flush: noop,
      stop: noop,
    };
  }

  const id = identity();
  const service = opts.service ?? id.service;
  const probe = new RuntimeProbe();
  probe.start();
  let url: URL;
  try {
    url = new URL(opts.url ?? DEFAULT_URL);
  } catch {
    url = new URL(DEFAULT_URL);
  }
  const transport = new Transport(url, opts.token);
  const intervalMs = Math.max(1000, opts.intervalMs ?? 5000);
  let last = Date.now();

  const flush = (): void => {
    try {
      const now = Date.now();
      const windowS = Math.max(1, Math.round((now - last) / 1000));
      last = now;
      const c = metrics.collect(now);
      const body = {
        v: 1,
        service,
        pm: id.pm,
        pid: process.pid,
        ts: now,
        window_s: windowS,
        uptime_s: Math.round(process.uptime()),
        runtime: probe.read(),
        http: c.http,
        sockets: { open: c.sockets },
        tenants: c.tenants,
        tenants_truncated: c.truncated,
      };
      transport.post(JSON.stringify(body));
    } catch {
      /* the agent must never throw into the host application */
    }
  };

  const timer = setInterval(flush, intervalMs);
  timer.unref();

  const resolve = (req: IncomingMessage): TenantInfo => {
    if (!resolver) return {};
    try {
      return resolver(req) ?? {};
    } catch {
      return {};
    }
  };

  return {
    middleware() {
      return (req, res, next) => {
        const start = process.hrtime.bigint();
        let done = false;
        res.once('finish', () => {
          if (done) return;
          done = true;
          try {
            const ms = Number(process.hrtime.bigint() - start) / 1e6;
            const who = resolve(req);
            metrics.recordRequest(res.statusCode, ms, who.tenantId, who.userId, Date.now());
          } catch {
            /* ignore */
          }
        });
        next?.();
      };
    },
    tenantResolver(fn) {
      resolver = fn;
    },
    socketOpened(tenantId, userId) {
      try {
        metrics.socketOpened(tenantId);
        if (userId !== undefined && userId !== null) metrics.recordUser(tenantId, userId, Date.now());
      } catch {
        /* ignore */
      }
    },
    socketClosed(tenantId) {
      try {
        metrics.socketClosed(tenantId);
      } catch {
        /* ignore */
      }
    },
    stats: () => ({ ...transport.stats, enabled: true }),
    flush,
    stop() {
      clearInterval(timer);
      probe.stop();
    },
  };
}
