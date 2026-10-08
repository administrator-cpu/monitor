import type { LogLine, LogStream } from '@cc/shared';
import { safeDirName } from './files';
import { LogRing, LogSubscription, splitChunk, toLiveLine } from './ring';
import type { LogWriter } from './writer';

/** Distinct log streams (services plus special folders) kept in memory. */
export const MAX_STREAMS = 200;
const RING_MAX_CHARS = 2 * 1024 * 1024;
/** Packet timestamps further than this from "now" are replaced by the receive time. */
const MAX_CLOCK_SKEW_MS = 24 * 3_600_000;

export const SPECIAL_DIRS = { _nginx: '_nginx', _monitor: '_monitor' } as const;

export interface PipelineOptions {
  writer: LogWriter;
  ringLines: () => number;
  now?: () => number;
}

/**
 * Entry point for every log line. `ingest` only appends to memory (ring buffer, subscriber
 * queues, writer queue); it never touches the disk, so it can sit directly in the PM2 bus handler.
 */
export class LogPipeline {
  private readonly now: () => number;
  private rings = new Map<string, LogRing>();
  private dirs = new Map<string, string>();
  private subs = new Map<string, Set<LogSubscription>>();
  private rejected = 0;

  constructor(private readonly o: PipelineOptions) {
    this.now = o.now ?? Date.now;
  }

  /** Lines refused because too many distinct streams exist. */
  get rejectedLines(): number {
    return this.rejected;
  }

  has(service: string): boolean {
    return this.rings.has(service);
  }

  private dirFor(service: string): string {
    let d = this.dirs.get(service);
    if (!d) {
      d = service in SPECIAL_DIRS ? service : safeDirName(service);
      this.dirs.set(service, d);
    }
    return d;
  }

  /** `at` is the PM2 packet time when available; otherwise the receive time is used. */
  ingest(service: string, pm: number, stream: LogStream, data: string, at?: number): void {
    if (!data) return;
    let ring = this.rings.get(service);
    if (!ring) {
      if (this.rings.size >= MAX_STREAMS) {
        this.rejected += 1;
        return;
      }
      ring = new LogRing(this.o.ringLines, RING_MAX_CHARS);
      this.rings.set(service, ring);
    }
    const received = this.now();
    const ts =
      typeof at === 'number' && Number.isFinite(at) && Math.abs(at - received) < MAX_CLOCK_SKEW_MS
        ? Math.round(at)
        : received;
    const dir = this.dirFor(service);
    const subs = this.subs.get(service);

    for (const chunk of splitChunk(data)) {
      this.o.writer.enqueue(
        dir,
        JSON.stringify({ ts, svc: service, pm, s: stream, msg: chunk }) + '\n',
      );
      const line = toLiveLine(ts, pm, stream, chunk);
      ring.push(line);
      if (subs) for (const sub of subs) sub.push(line);
    }
  }

  /**
   * Fills the live view with history read from PM2's own log files. Memory only: these lines are
   * already on disk in PM2's files, so they are not queued for the monitor's writer. Skipped when
   * the service already has live lines, so history never lands after newer output.
   */
  seed(service: string, pm: number, lines: { ts: number; s: LogStream; msg: string }[]): void {
    if (lines.length === 0 || this.rings.has(service)) return;
    if (this.rings.size >= MAX_STREAMS) return;
    const ring = new LogRing(this.o.ringLines, RING_MAX_CHARS);
    this.rings.set(service, ring);
    for (const l of lines) ring.push(toLiveLine(l.ts, pm, l.s, l.msg));
  }

  /** The last lines of a service for a new subscriber (oldest first). */
  tail(service: string, n: number, stream: 'all' | 'out' | 'err' = 'all'): LogLine[] {
    return this.rings.get(service)?.last(n, stream) ?? [];
  }

  subscribe(sub: LogSubscription): () => void {
    let set = this.subs.get(sub.service);
    if (!set) {
      set = new Set();
      this.subs.set(sub.service, set);
    }
    set.add(sub);
    return () => {
      set.delete(sub);
      if (set.size === 0) this.subs.delete(sub.service);
    };
  }

  subscriberCount(): number {
    let n = 0;
    for (const s of this.subs.values()) n += s.size;
    return n;
  }
}
