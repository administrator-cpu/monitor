import type { Pm2EventPacket } from './types';

export interface PendingEvent {
  ts: number;
  /** The PM2 name on host 1; for a container event the service's source key. */
  name: string;
  /** Set for events of agent hosts, whose names are not PM2 names on host 1. */
  serviceId?: number;
  pmId: number | null;
  event: string;
  detail: Record<string, unknown> | null;
}

export interface LastExit {
  at: number;
  code: number | null;
  signal: string | null;
}

const MAX_PENDING = 2_000;

/**
 * Process events waiting for the next database batch, plus the last exit per service. A restart
 * storm cannot grow this without limit: past the cap the oldest events are dropped and counted.
 */
export class ProcessEvents {
  private buf: PendingEvent[] = [];
  private lastExits = new Map<string, LastExit>();
  private _dropped = 0;

  constructor(private readonly onEvent?: (e: PendingEvent) => void) {}

  get dropped(): number {
    return this._dropped;
  }

  add(p: Pm2EventPacket): void {
    if (p.isModule) return;
    const detail: Record<string, unknown> = {};
    if (p.exitCode !== null) detail.exitCode = p.exitCode;
    if (p.signal !== null) detail.signal = p.signal;
    if (p.message) detail.message = p.message;
    const e: PendingEvent = {
      ts: p.at,
      name: p.name,
      pmId: p.pmId,
      event: p.event,
      detail: Object.keys(detail).length ? detail : null,
    };
    if (p.event === 'exit') {
      this.lastExits.set(p.name, { at: p.at, code: p.exitCode, signal: p.signal });
    }
    this.buf.push(e);
    if (this.buf.length > MAX_PENDING) {
      this._dropped += this.buf.length - MAX_PENDING;
      this.buf.splice(0, this.buf.length - MAX_PENDING);
    }
    this.onEvent?.(e);
  }

  /** A container event from an agent host, already resolved to its service (M2). */
  addForService(e: PendingEvent & { serviceId: number }): void {
    this.buf.push(e);
    if (this.buf.length > MAX_PENDING) {
      this._dropped += this.buf.length - MAX_PENDING;
      this.buf.splice(0, this.buf.length - MAX_PENDING);
    }
    this.onEvent?.(e);
  }

  /** A copy of what is pending; call `ack` once it is safely stored. */
  peek(): PendingEvent[] {
    return this.buf.slice();
  }

  ack(count: number): void {
    this.buf.splice(0, count);
  }

  lastExit(name: string): LastExit | undefined {
    return this.lastExits.get(name);
  }
}
