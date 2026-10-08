import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { LogSearchResponse } from '@cc/shared';
import type { SearchJob, SearchOutput } from './search';

export class SearchBusyError extends Error {
  constructor(public readonly scope: 'user' | 'global') {
    super(`search_busy_${scope}`);
  }
}

export const SEARCH_LIMIT_MS = 30_000;
/** The worker stops itself at the limit; this is how long it is given to hand its partial answer over. */
const GRACE_MS = 4_000;

export interface SearcherOptions {
  workerFile?: string;
  perUser?: number;
  global?: number;
  limitMs?: number;
  /** How long past the limit a worker may take to hand over its partial answer. */
  graceMs?: number;
  now?: () => number;
}

/**
 * Runs each search in its own worker thread so a big or slow search can never stall the monitor's
 * event loop. One search per user and four overall; a worker that has not answered shortly after
 * the 30 s limit (a runaway regular expression) is terminated.
 */
export class LogSearcher {
  private active = new Map<number, number>();
  private total = 0;
  private readonly file: string;
  private readonly perUser: number;
  private readonly global: number;
  private readonly limitMs: number;
  private readonly graceMs: number;
  private readonly now: () => number;

  constructor(opts: SearcherOptions = {}) {
    this.file = opts.workerFile ?? path.join(__dirname, `search-worker${path.extname(__filename) || '.js'}`);
    this.perUser = opts.perUser ?? 1;
    this.global = opts.global ?? 4;
    this.limitMs = opts.limitMs ?? SEARCH_LIMIT_MS;
    this.graceMs = opts.graceMs ?? GRACE_MS;
    this.now = opts.now ?? Date.now;
  }

  get running(): number {
    return this.total;
  }

  async search(userId: number, job: Omit<SearchJob, 'deadline'>): Promise<LogSearchResponse> {
    if ((this.active.get(userId) ?? 0) >= this.perUser) throw new SearchBusyError('user');
    if (this.total >= this.global) throw new SearchBusyError('global');
    this.active.set(userId, (this.active.get(userId) ?? 0) + 1);
    this.total += 1;
    const started = this.now();
    try {
      const full: SearchJob = { ...job, deadline: started + this.limitMs };
      const out = await this.spawn(full);
      return { ...out, tookMs: this.now() - started };
    } finally {
      this.total -= 1;
      const n = (this.active.get(userId) ?? 1) - 1;
      if (n <= 0) this.active.delete(userId);
      else this.active.set(userId, n);
    }
  }

  private spawn(job: SearchJob): Promise<SearchOutput> {
    return new Promise<SearchOutput>((resolve, reject) => {
      const options = { resourceLimits: { maxOldGenerationSizeMb: 512 } };
      // Same bootstrap as the PM2 worker: a TypeScript entry (development, tests) needs tsx.
      const w = this.file.endsWith('.ts')
        ? new Worker(`require('tsx/cjs'); require(${JSON.stringify(this.file)});`, { ...options, eval: true })
        : new Worker(this.file, options);
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(kill);
        void w.terminate();
        fn();
      };
      const kill = setTimeout(
        () =>
          done(() =>
            resolve({ lines: [], matched: 0, truncated: false, timedOut: true, filesScanned: 0, linesScanned: 0 }),
          ),
        this.limitMs + this.graceMs,
      );
      w.once('message', (m: { ok: boolean; result?: SearchOutput; error?: string }) =>
        done(() => (m.ok && m.result ? resolve(m.result) : reject(new Error(m.error ?? 'search failed')))),
      );
      w.once('error', (e) => done(() => reject(e)));
      w.once('exit', (code) => done(() => reject(new Error(`search worker exited (code ${code})`))));
      w.postMessage(job);
    });
  }
}
