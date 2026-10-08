import fs from 'node:fs/promises';
import path from 'node:path';
import {
  gzipFile,
  HOUR_MS,
  hourKey,
  listLogFiles,
  logFileName,
  removeTempFiles,
} from './files';

type Warn = (obj: Record<string, unknown>, msg: string) => void;

export interface WriterOptions {
  root: string;
  now?: () => number;
  /** Receives warnings and errors; rate limited by the writer. */
  warn?: Warn;
  flushIntervalMs?: number;
  /** Pending lines across all services above which the noisiest service is trimmed. */
  maxQueue?: number;
  /** Pending bytes of one service that trigger an immediate flush. */
  flushBytes?: number;
}

export interface WriterStats {
  enabled: boolean;
  /** Lines waiting to be written (including the batch being written). */
  queue: number;
  /** Lines lost to backpressure or failed writes since start. */
  dropped: number;
  /** Lines not written because the volume is unavailable (still shown live). */
  skipped: number;
  writeErrors: number;
  droppedByService: Record<string, number>;
}

interface Segment {
  key: string;
  parts: string[];
  count: number;
}

interface Stream {
  dir: string;
  segments: Segment[];
  pendingCount: number;
  pendingChars: number;
  inflight: number;
  writing: boolean;
  handle: fs.FileHandle | null;
  openKey: string | null;
}

const WARN_EVERY_MS = 30_000;

/**
 * Buffered, append-only log writer: one file per service per UTC hour, flushed every 250 ms or
 * 64 KB. The ingest path only appends to memory and never waits for the disk. If the queue grows
 * past `maxQueue` the oldest queued lines of the noisiest service are dropped and counted.
 */
export class LogWriter {
  private readonly root: string;
  private readonly now: () => number;
  private readonly warn: Warn;
  private readonly flushIntervalMs: number;
  private readonly maxQueue: number;
  private readonly flushChars: number;

  private streams = new Map<string, Stream>();
  private total = 0;
  private enabled = true;
  private droppedTotal = 0;
  private skippedTotal = 0;
  private writeErrors = 0;
  private droppedBy = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private lastWarnAt = 0;

  private compressQueue: string[] = [];
  private compressing: Promise<void> | null = null;

  constructor(opts: WriterOptions) {
    this.root = opts.root;
    this.now = opts.now ?? Date.now;
    this.warn = opts.warn ?? (() => undefined);
    this.flushIntervalMs = opts.flushIntervalMs ?? 250;
    this.maxQueue = opts.maxQueue ?? 10_000;
    this.flushChars = opts.flushBytes ?? 64 * 1024;
  }

  start(): void {
    if (this.timer) return;
    void removeTempFiles(this.root);
    this.timer = setInterval(() => {
      for (const s of this.streams.values()) if (s.pendingCount > 0) void this.drain(s);
    }, this.flushIntervalMs);
    this.timer.unref();
  }

  /** Flushes everything and closes the files. Does not compress (the hour may not be over). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flushNow();
    for (const s of this.streams.values()) await this.closeHandle(s);
    if (this.compressing) await this.compressing.catch(() => undefined);
  }

  /** Called by the volume guard. Turning it off discards the queue (counted) and releases files. */
  setEnabled(ok: boolean): void {
    if (ok === this.enabled) return;
    this.enabled = ok;
    if (!ok) {
      for (const s of this.streams.values()) {
        this.skippedTotal += s.pendingCount;
        this.total -= s.pendingCount;
        s.segments = [];
        s.pendingCount = 0;
        s.pendingChars = 0;
        void this.closeHandle(s);
      }
    }
  }

  stats(): WriterStats {
    let inflight = 0;
    for (const s of this.streams.values()) inflight += s.inflight;
    return {
      enabled: this.enabled,
      queue: this.total + inflight,
      dropped: this.droppedTotal,
      skipped: this.skippedTotal,
      writeErrors: this.writeErrors,
      droppedByService: Object.fromEntries(this.droppedBy),
    };
  }

  /** Paths of the files currently open for writing (the disk guard never trims these hours). */
  openHours(): Set<string> {
    const set = new Set<string>();
    for (const s of this.streams.values()) if (s.openKey) set.add(s.openKey);
    return set;
  }

  /** `text` is one complete JSON line including its trailing newline. */
  enqueue(dir: string, text: string): void {
    if (!this.enabled) {
      this.skippedTotal += 1;
      return;
    }
    let s = this.streams.get(dir);
    if (!s) {
      s = {
        dir,
        segments: [],
        pendingCount: 0,
        pendingChars: 0,
        inflight: 0,
        writing: false,
        handle: null,
        openKey: null,
      };
      this.streams.set(dir, s);
    }
    const key = hourKey(this.now());
    let seg = s.segments[s.segments.length - 1];
    if (!seg || seg.key !== key) {
      seg = { key, parts: [], count: 0 };
      s.segments.push(seg);
    }
    seg.parts.push(text);
    seg.count += 1;
    s.pendingCount += 1;
    s.pendingChars += text.length;
    this.total += 1;

    if (this.total > this.maxQueue) this.shed();
    if (s.pendingChars >= this.flushChars && !s.writing) void this.drain(s);
  }

  async flushNow(): Promise<void> {
    await Promise.all([...this.streams.values()].map((s) => this.drain(s)));
    // A drain already in progress returns immediately; wait for those too.
    for (let i = 0; i < 200; i++) {
      if ([...this.streams.values()].every((s) => !s.writing && s.pendingCount === 0)) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Drop the oldest queued lines of the noisiest service until the queue is back to 90 %. */
  private shed(): void {
    let excess = this.total - Math.floor(this.maxQueue * 0.9);
    while (excess > 0) {
      let target: Stream | null = null;
      for (const s of this.streams.values()) {
        if (s.pendingCount > 0 && (!target || s.pendingCount > target.pendingCount)) target = s;
      }
      if (!target) return;
      const n = Math.min(excess, target.pendingCount);
      this.dropOldest(target, n);
      excess -= n;
    }
  }

  private dropOldest(s: Stream, n: number): void {
    let left = n;
    while (left > 0 && s.segments.length > 0) {
      const seg = s.segments[0] as Segment;
      const take = Math.min(left, seg.count);
      const removed = seg.parts.splice(0, take);
      for (const p of removed) s.pendingChars -= p.length;
      seg.count -= take;
      left -= take;
      if (seg.count === 0) s.segments.shift();
    }
    const dropped = n - left;
    s.pendingCount -= dropped;
    this.total -= dropped;
    this.droppedTotal += dropped;
    this.droppedBy.set(s.dir, (this.droppedBy.get(s.dir) ?? 0) + dropped);
    this.rateLimitedWarn({ service: s.dir, dropped }, 'log writer queue full; dropped oldest lines');
  }

  private async drain(s: Stream): Promise<void> {
    if (s.writing) return;
    s.writing = true;
    try {
      while (s.segments.length > 0) {
        const seg = s.segments.shift() as Segment;
        s.pendingCount -= seg.count;
        this.total -= seg.count;
        for (const p of seg.parts) s.pendingChars -= p.length;
        s.inflight = seg.count;
        try {
          await this.ensureOpen(s, seg.key);
          await (s.handle as fs.FileHandle).appendFile(seg.parts.join(''));
        } catch (e) {
          this.writeErrors += 1;
          this.droppedTotal += seg.count;
          this.droppedBy.set(s.dir, (this.droppedBy.get(s.dir) ?? 0) + seg.count);
          this.rateLimitedWarn(
            { service: s.dir, lines: seg.count, err: (e as Error).message },
            'log write failed; lines lost',
          );
          await this.closeHandle(s); // reopen on the next write
        } finally {
          s.inflight = 0;
        }
      }
    } finally {
      s.writing = false;
    }
  }

  private async ensureOpen(s: Stream, key: string): Promise<void> {
    if (s.handle && s.openKey === key) return;
    const previous = s.openKey;
    const prevPath = previous ? path.join(this.root, s.dir, `${previous}.jsonl`) : null;
    await this.closeHandle(s);
    if (prevPath && previous !== key) this.compressSoon(prevPath);
    const dir = path.join(this.root, s.dir);
    await fs.mkdir(dir, { recursive: true });
    s.handle = await fs.open(path.join(dir, `${key}.jsonl`), 'a');
    s.openKey = key;
  }

  private async closeHandle(s: Stream): Promise<void> {
    const h = s.handle;
    s.handle = null;
    s.openKey = null;
    if (h) await h.close().catch(() => undefined);
  }

  /** Compression of finished hours runs one file at a time, off the event loop. */
  compressSoon(file: string): void {
    if (this.compressQueue.includes(file)) return;
    this.compressQueue.push(file);
    if (!this.compressing) {
      this.compressing = this.runCompress().finally(() => {
        this.compressing = null;
      });
    }
  }

  private async runCompress(): Promise<void> {
    while (this.compressQueue.length > 0) {
      const file = this.compressQueue.shift() as string;
      try {
        await gzipFile(file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.rateLimitedWarn({ file, err: (e as Error).message }, 'log compression failed');
        }
      }
    }
  }

  /**
   * Compresses every finished, uncompressed hour that is not open for writing (startup and
   * after crashes). Returns the number of files queued.
   */
  async sweepCompress(): Promise<number> {
    const nowMs = this.now();
    const open = this.openHours();
    let n = 0;
    for (const f of await listLogFiles(this.root)) {
      if (f.gz) continue;
      const finished = f.start + HOUR_MS <= nowMs;
      const isOpen = open.has(hourKey(f.start)) && this.streams.get(f.dir)?.openKey === hourKey(f.start);
      if (finished && !isOpen && f.name === logFileName(f.start)) {
        this.compressSoon(f.path);
        n += 1;
      }
    }
    return n;
  }

  /** Waits until queued compressions are done (used by tests and shutdown). */
  async idle(): Promise<void> {
    while (this.compressing) await this.compressing.catch(() => undefined);
  }

  private rateLimitedWarn(obj: Record<string, unknown>, msg: string): void {
    const t = this.now();
    if (t - this.lastWarnAt < WARN_EVERY_MS) return;
    this.lastWarnAt = t;
    this.warn(obj, msg);
  }
}
