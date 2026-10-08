import type { CollectorStatus } from '@cc/shared';
import type { Logger } from './logger';

export interface CollectorDef {
  name: string;
  intervalMs: number;
  /** A run exceeding this is recorded as failed. Defaults to the interval, capped at 30 s. */
  timeoutMs?: number;
  run(): Promise<void>;
}

interface Entry {
  def: CollectorDef;
  timeoutMs: number;
  registeredAt: number;
  lastOkAt: number | null;
  lastError?: string;
  timer: NodeJS.Timeout | null;
  /** The promise of the run currently executing, if any (prevents overlap after a timeout). */
  inFlight: Promise<void> | null;
}

/**
 * Runs each collector on its own interval with its own timeout and error
 * isolation. A failing or hanging collector marks only its own data stale.
 */
export class Scheduler {
  private entries = new Map<string, Entry>();
  private running = false;

  constructor(
    private readonly log: Pick<Logger, 'warn' | 'debug'>,
    private readonly now: () => number = Date.now,
  ) {}

  register(def: CollectorDef): void {
    if (this.entries.has(def.name)) throw new Error(`Collector already registered: ${def.name}`);
    this.entries.set(def.name, {
      def,
      timeoutMs: def.timeoutMs ?? Math.min(def.intervalMs, 30_000),
      registeredAt: this.now(),
      lastOkAt: null,
      timer: null,
      inFlight: null,
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const e of this.entries.values()) {
      e.registeredAt = this.now();
      this.schedule(e, 0);
    }
  }

  stop(): void {
    this.running = false;
    for (const e of this.entries.values()) {
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
    }
  }

  /** Stale = no success within 3 intervals (counted from registration if never successful). */
  status(): CollectorStatus[] {
    const ts = this.now();
    return [...this.entries.values()].map((e) => ({
      name: e.def.name,
      intervalMs: e.def.intervalMs,
      lastOkAt: e.lastOkAt,
      ...(e.lastError ? { lastError: e.lastError } : {}),
      stale: ts - (e.lastOkAt ?? e.registeredAt) > 3 * e.def.intervalMs,
    }));
  }

  /** Executes one run of a collector now. Exposed for the loop and for tests. */
  async runOnce(name: string): Promise<void> {
    const e = this.entries.get(name);
    if (!e) throw new Error(`Unknown collector: ${name}`);
    if (e.inFlight) {
      e.lastError = 'previous run still in flight';
      return;
    }
    const p = (async () => e.def.run())();
    e.inFlight = p.then(
      () => undefined,
      () => undefined,
    );
    void e.inFlight.then(() => {
      e.inFlight = null;
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${e.timeoutMs} ms`)), e.timeoutMs);
    });
    try {
      await Promise.race([p, timeout]);
      e.lastOkAt = this.now();
      delete e.lastError;
    } catch (err) {
      e.lastError = err instanceof Error ? err.message : String(err);
      this.log.warn({ collector: e.def.name, err: e.lastError }, 'collector failed');
    } finally {
      clearTimeout(timer);
    }
  }

  private schedule(e: Entry, delayMs: number): void {
    if (!this.running) return;
    e.timer = setTimeout(async () => {
      const started = this.now();
      await this.runOnce(e.def.name);
      const elapsed = this.now() - started;
      this.schedule(e, Math.max(50, e.def.intervalMs - elapsed));
    }, delayMs);
  }
}
