import type { Pm2EventPacket, Pm2Handlers, Pm2LogPacket, Pm2Proc, Pm2Source } from './types';

export interface LinkOptions {
  /** Creates a fresh source. Called again after a failure that follows a successful connect. */
  createSource: () => Pm2Source;
  onLogs: (items: Pm2LogPacket[]) => void;
  onEvents: (items: Pm2EventPacket[]) => void;
  now?: () => number;
  log?: { warn: (o: Record<string, unknown>, m: string) => void; info: (o: Record<string, unknown>, m: string) => void };
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

export type LinkState = 'disconnected' | 'connected';

/**
 * Keeps one connection to PM2 and its event bus alive. Every `list()` call first makes sure the
 * connection and the bus exist; failures back off exponentially (1 s up to 30 s) and a source
 * that failed after connecting is thrown away and rebuilt, so a restarted PM2 daemon is picked up
 * without restarting the monitor.
 */
export class Pm2Link {
  private source: Pm2Source | null = null;
  private connected = false;
  private busUp = false;
  private failures = 0;
  private nextAttemptAt = 0;
  private _lastError: string | null = null;
  private readonly now: () => number;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;

  constructor(private readonly o: LinkOptions) {
    this.now = o.now ?? Date.now;
    this.minBackoff = o.minBackoffMs ?? 1_000;
    this.maxBackoff = o.maxBackoffMs ?? 30_000;
  }

  get state(): LinkState {
    return this.connected ? 'connected' : 'disconnected';
  }

  get lastError(): string | null {
    return this._lastError;
  }

  private handlers(): Pm2Handlers {
    return {
      onLogs: (items) => this.o.onLogs(items),
      onEvents: (items) => this.o.onEvents(items),
      onBusClosed: () => {
        this.busUp = false;
      },
    };
  }

  async list(): Promise<Pm2Proc[]> {
    const t = this.now();
    if (t < this.nextAttemptAt) {
      const secs = Math.ceil((this.nextAttemptAt - t) / 1000);
      throw new Error(`${this._lastError ?? 'PM2 unavailable'} (retrying in ${secs}s)`);
    }
    const hadConnection = this.connected;
    try {
      if (!this.source) this.source = this.o.createSource();
      if (!this.connected) {
        await this.source.connect();
        this.connected = true;
        if (this.failures > 0) this.o.log?.info({}, 'PM2 connection restored');
      }
      if (!this.busUp) {
        await this.source.startBus(this.handlers());
        this.busUp = true;
      }
      const list = await this.source.list();
      this.failures = 0;
      this._lastError = null;
      return list;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (this.failures === 0) this.o.log?.warn({ err: msg }, 'PM2 connection problem');
      this.failures += 1;
      this._lastError = msg;
      this.nextAttemptAt = this.now() + Math.min(this.maxBackoff, this.minBackoff * 2 ** (this.failures - 1));
      // A failure before the first successful connect (daemon simply not running) keeps the
      // source; anything after a connect means PM2 itself misbehaved, so start clean.
      if (hadConnection || this.connected) await this.reset();
      throw e;
    }
  }

  private async reset(): Promise<void> {
    const s = this.source;
    this.source = null;
    this.connected = false;
    this.busUp = false;
    if (s) await s.dispose().catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.reset();
  }
}
