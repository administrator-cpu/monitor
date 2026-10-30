import type { WebSocket } from 'ws';
import {
  wsClientMessageSchema,
  WS_CLOSE,
  type LiveMessage,
  type LogLine,
  type WsServerMessage,
} from '@cc/shared';
import type { AppContext } from './context';
import { LogSubscription } from './logs/ring';
import { logDirOf } from './logs/remote';

interface LogSub {
  sub: LogSubscription;
  unsubscribe: () => void;
}

interface Client {
  socket: WebSocket;
  userId: number;
  username: string;
  token: string;
  live: boolean;
  logSubs: Map<string, LogSub>;
  lastPongAt: number;
  lastPingAt: number;
  lastRecheckAt: number;
}

export const LIVE_INTERVAL_MS = 2_000;
export const LOG_FLUSH_MS = 250;
export const MAX_CONNECTIONS_PER_USER = 5;
export const MAX_LOG_SUBSCRIPTIONS = 5;
export const LOG_BATCH_LINES = 200;
const PING_EVERY_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;
const RECHECK_EVERY_MS = 60_000;
/** Skip a frame for a client whose send buffer is already this large (it cannot keep up). */
const MAX_BUFFERED_BYTES = 1_048_576;
/** One audit entry per user and service for this long, however often the browser resubscribes. */
const TAIL_AUDIT_EVERY_MS = 5 * 60_000;

type HubCtx = Pick<
  AppContext,
  'state' | 'scheduler' | 'sessions' | 'audit' | 'now' | 'log' | 'logs' | 'services' | 'alerts'
> & {
  /** Set by createContext right after the hub; optional so tests can build a hub without it. */
  health?: AppContext['health'];
  /** Optional for the same reason; without it the live message lists no hosts. */
  hosts?: AppContext['hosts'];
};

/**
 * Pushes one shared snapshot to every subscribed browser, and fans log lines out to the browsers
 * tailing a service. The snapshot is built once per tick, so the number of viewers does not change
 * collection work.
 */
export class LiveHub {
  private clients = new Set<Client>();
  private liveTimer: NodeJS.Timeout | null = null;
  private logTimer: NodeJS.Timeout | null = null;
  private housekeepingTimer: NodeJS.Timeout | null = null;
  private tailAudit = new Map<string, number>();

  constructor(private readonly ctx: HubCtx) {}

  get size(): number {
    return this.clients.size;
  }

  countForUser(userId: number): number {
    let n = 0;
    for (const c of this.clients) if (c.userId === userId) n += 1;
    return n;
  }

  start(): void {
    if (this.liveTimer) return;
    this.liveTimer = setInterval(() => this.broadcast(), LIVE_INTERVAL_MS);
    this.logTimer = setInterval(() => this.flushLogs(), LOG_FLUSH_MS);
    this.housekeepingTimer = setInterval(() => this.housekeeping(), 5_000);
  }

  stop(): void {
    for (const t of [this.liveTimer, this.logTimer, this.housekeepingTimer]) {
      if (t) clearInterval(t);
    }
    this.liveTimer = this.logTimer = this.housekeepingTimer = null;
    for (const c of [...this.clients]) {
      c.socket.close(1001, 'server shutting down');
      this.dropClient(c);
    }
  }

  buildLive(): LiveMessage {
    return {
      type: 'live',
      ts: this.ctx.now(),
      host: this.ctx.state.getHost(),
      services: this.ctx.state.getProcessStates().map((process) => {
        const full = this.ctx.state.app.get(process.serviceId, this.ctx.now());
        if (!full) return { process, app: null };
        const { tenants: _tenants, ...app } = full;
        return { process, app };
      }),
      nginx: this.ctx.state.getNginx(this.ctx.now()),
      mongo: this.ctx.state.getMongo(),
      app: this.ctx.state.app.totals(this.ctx.now()),
      collectors: this.ctx.scheduler.status(),
      logs: this.ctx.logs.status(),
      openIncidents: this.ctx.alerts.openCount(),
      monitor: this.ctx.health?.snapshot(),
      hosts: (this.ctx.hosts?.list() ?? [])
        .filter((h) => h.revoked_at === null)
        .map((h) => ({ id: h.id, name: h.name, kind: h.kind, os: h.os, status: this.ctx.hosts!.status(h) })),
    };
  }

  /** Registers an already-authenticated socket. */
  attach(socket: WebSocket, userId: number, token: string, username = ''): void {
    const now = this.ctx.now();
    const client: Client = {
      socket,
      userId,
      username,
      token,
      live: false,
      logSubs: new Map(),
      lastPongAt: now,
      lastPingAt: now,
      lastRecheckAt: now,
    };
    this.clients.add(client);

    socket.on('pong', () => {
      client.lastPongAt = this.ctx.now();
    });
    socket.on('close', () => this.dropClient(client));
    socket.on('error', (err) => {
      this.ctx.log.debug({ err: err.message }, 'websocket error');
      this.dropClient(client);
    });
    socket.on('message', (raw) => this.onMessage(client, raw.toString()));
  }

  private dropClient(c: Client): void {
    for (const s of c.logSubs.values()) s.unsubscribe();
    c.logSubs.clear();
    this.clients.delete(c);
  }

  /** Ends every socket of a user (disabled account, password reset, revoked sessions). */
  closeUser(
    userId: number,
    code: number = WS_CLOSE.UNAUTHENTICATED,
    reason = 'session ended',
  ): void {
    for (const c of [...this.clients]) {
      if (c.userId === userId) {
        c.socket.close(code, reason);
        this.dropClient(c);
      }
    }
  }

  /** Sends an event (alert opened/resolved, process restart...) to every live viewer. */
  broadcastEvent(kind: string, fields: Record<string, unknown> = {}): void {
    this.broadcastRaw({ type: 'event', kind, ts: this.ctx.now(), ...fields });
  }

  broadcastWarning(code: string, detail?: unknown): void {
    this.broadcastRaw({ type: 'warning', code, detail });
  }

  private broadcastRaw(msg: WsServerMessage): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c.live && c.socket.readyState === 1) c.socket.send(payload);
    }
  }

  private onMessage(client: Client, text: string): void {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.send(client, { type: 'error', code: 'bad_message', message: 'Invalid JSON.' });
      return;
    }
    const parsed = wsClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.send(client, { type: 'error', code: 'bad_message', message: 'Unrecognised message.' });
      return;
    }
    const msg = parsed.data;
    switch (msg.type) {
      case 'ping':
        this.send(client, { type: 'pong' });
        return;
      case 'subscribe':
        if (msg.channel === 'live') {
          client.live = true;
          this.send(client, this.buildLive()); // first paint without waiting for the tick
        } else {
          this.subscribeLogs(client, msg.service, msg.stream, msg.backfill);
        }
        return;
      case 'unsubscribe':
        if (msg.channel === 'live') client.live = false;
        else if (msg.service) this.unsubscribeLogs(client, msg.service);
        return;
    }
  }

  private knownLogService(name: string): boolean {
    return logDirOf(name, this.ctx.services, this.ctx.hosts ?? { get: () => undefined }) !== null;
  }

  private subscribeLogs(
    client: Client,
    service: string,
    stream: 'all' | 'out' | 'err',
    backfill: number,
  ): void {
    if (!this.knownLogService(service)) {
      this.send(client, { type: 'error', code: 'unknown_service', message: 'Unknown service.' });
      return;
    }
    // Re-subscribing (for example to change the stream filter) replaces the existing subscription.
    this.unsubscribeLogs(client, service);
    if (client.logSubs.size >= MAX_LOG_SUBSCRIPTIONS) {
      this.send(client, {
        type: 'error',
        code: 'subscription_limit',
        message: `Maximum ${MAX_LOG_SUBSCRIPTIONS} log subscriptions per connection.`,
      });
      return;
    }

    const sub = new LogSubscription(service, stream);
    const pipeline = this.ctx.logs.pipeline;
    // Both calls run in the same tick, so no line can fall between the backfill and the live feed.
    const unsubscribe = pipeline.subscribe(sub);
    client.logSubs.set(service, { sub, unsubscribe });
    const backlog = pipeline.tail(service, backfill, stream);
    for (let i = 0; i < backlog.length; i += LOG_BATCH_LINES) {
      this.sendLogBatch(client, service, backlog.slice(i, i + LOG_BATCH_LINES), 0);
    }
    if (backlog.length === 0) this.sendLogBatch(client, service, [], 0);

    const key = `${client.userId}:${service}`;
    const now = this.ctx.now();
    if (now - (this.tailAudit.get(key) ?? 0) >= TAIL_AUDIT_EVERY_MS) {
      this.tailAudit.set(key, now);
      this.ctx.audit.write({
        event: 'log_tail_opened',
        userId: client.userId,
        username: client.username || null,
        detail: { service, stream },
      });
    }
  }

  private unsubscribeLogs(client: Client, service: string): void {
    const s = client.logSubs.get(service);
    if (!s) return;
    s.unsubscribe();
    client.logSubs.delete(service);
  }

  private sendLogBatch(client: Client, service: string, lines: LogLine[], dropped: number): void {
    this.send(client, { type: 'log_batch', service, lines, dropped });
  }

  /** Every 250 ms: up to 200 lines per subscription, or a dropped count if the browser is behind. */
  flushLogs(): void {
    for (const c of this.clients) {
      if (c.logSubs.size === 0 || c.socket.readyState !== 1) continue;
      for (const [service, { sub }] of c.logSubs) {
        if (sub.pending === 0) continue;
        if (c.socket.bufferedAmount > MAX_BUFFERED_BYTES) continue; // behind: the queue sheds old lines
        const { lines, dropped } = sub.take(LOG_BATCH_LINES);
        if (lines.length > 0 || dropped > 0) this.sendLogBatch(c, service, lines, dropped);
      }
    }
  }

  private send(client: Client, msg: WsServerMessage | LiveMessage): void {
    if (client.socket.readyState !== 1 /* OPEN */) return;
    client.socket.send(JSON.stringify(msg));
  }

  private broadcast(): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify(this.buildLive());
    for (const c of this.clients) {
      if (!c.live || c.socket.readyState !== 1) continue;
      if (c.socket.bufferedAmount > MAX_BUFFERED_BYTES) continue; // slow client: drop this frame
      c.socket.send(payload);
    }
  }

  /** Keepalive pings, dead-peer termination and the 60 s session re-check. */
  housekeeping(): void {
    const now = this.ctx.now();
    for (const c of [...this.clients]) {
      if (now - c.lastPongAt > PONG_TIMEOUT_MS) {
        c.socket.terminate();
        this.dropClient(c);
        continue;
      }
      if (now - c.lastPingAt >= PING_EVERY_MS) {
        c.lastPingAt = now;
        try {
          c.socket.ping();
        } catch {
          // socket is closing; the close handler removes it
        }
      }
      if (now - c.lastRecheckAt >= RECHECK_EVERY_MS) {
        c.lastRecheckAt = now;
        const r = this.ctx.sessions.validate(c.token, { touch: false });
        if (!r.ok || r.user.must_change_password === 1) {
          if (!r.ok && (r.reason === 'expired' || r.reason === 'idle')) {
            this.ctx.audit.write({
              event: 'session_expired',
              userId: r.userId,
              detail: { via: 'websocket' },
            });
          }
          c.socket.close(WS_CLOSE.UNAUTHENTICATED, 'session ended');
          this.dropClient(c);
        }
      }
    }
    // Forget old tail-audit keys.
    for (const [k, t] of this.tailAudit) if (now - t > 2 * TAIL_AUDIT_EVERY_MS) this.tailAudit.delete(k);
  }
}
