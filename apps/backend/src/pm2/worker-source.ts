import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Pm2Handlers, Pm2Proc, Pm2Source } from './types';

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export interface WorkerSourceOptions {
  /** Defaults to worker.ts / worker.js next to this file (follows the extension in use). */
  workerFile?: string;
  requestTimeoutMs?: number;
  /** Receives anything the pm2 package prints (debug only). */
  onOutput?: (text: string) => void;
}

/** Runs the real PM2 adapter in a worker thread and exposes it as a `Pm2Source`. */
export class WorkerPm2Source implements Pm2Source {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private handlers: Pm2Handlers | null = null;
  private readonly file: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: WorkerSourceOptions = {}) {
    this.file =
      opts.workerFile ?? path.join(__dirname, `worker${path.extname(__filename) || '.js'}`);
    this.timeoutMs = opts.requestTimeoutMs ?? 15_000;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const options = {
      // Keep the pm2 package's console output away from the monitor's own output.
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    };
    // Development and tests run TypeScript through tsx; a worker does not inherit that loader
    // reliably, so a .ts entry is started through a one-line bootstrap. Production runs compiled .js.
    const w = this.file.endsWith('.ts')
      ? new Worker(`require('tsx/cjs'); require(${JSON.stringify(this.file)});`, { ...options, eval: true })
      : new Worker(this.file, options);
    this.worker = w;
    w.stdout.on('data', (d: Buffer) => this.opts.onOutput?.(d.toString()));
    w.stderr.on('data', (d: Buffer) => this.opts.onOutput?.(d.toString()));
    w.on('message', (m: any) => this.onMessage(m));
    const gone = (err: Error) => {
      if (this.worker !== w) return;
      this.worker = null;
      this.failAll(err);
      this.handlers?.onBusClosed();
    };
    w.on('error', (e) => gone(e));
    w.on('exit', (code) => gone(new Error(`PM2 worker exited (code ${code})`)));
    return w;
  }

  private onMessage(m: any): void {
    if (m?.type === 'logs') this.handlers?.onLogs(m.items);
    else if (m?.type === 'events') this.handlers?.onEvents(m.items);
    else if (m?.type === 'bus_closed') this.handlers?.onBusClosed();
    else if (typeof m?.id === 'number') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(String(m.error)));
    }
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private call<T>(op: string): Promise<T> {
    const w = this.ensureWorker();
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`PM2 ${op} timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      w.postMessage({ id, op });
    });
  }

  connect(): Promise<void> {
    return this.call<void>('connect');
  }

  list(): Promise<Pm2Proc[]> {
    return this.call<Pm2Proc[]>('list');
  }

  async startBus(handlers: Pm2Handlers): Promise<void> {
    this.handlers = handlers;
    await this.call<void>('bus_start');
  }

  async stopBus(): Promise<void> {
    this.handlers = null;
    if (this.worker) await this.call<void>('bus_stop').catch(() => undefined);
  }

  async dispose(): Promise<void> {
    const w = this.worker;
    this.handlers = null;
    if (w) {
      this.worker = null;
      this.failAll(new Error('PM2 worker disposed'));
      await w.terminate().catch(() => undefined);
    }
  }
}
