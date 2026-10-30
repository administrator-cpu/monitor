import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import type { AgentLogs, AgentLogsResponse } from '@cc/shared';
import { errText, gzipJson, type PostResult } from './client';
import type { Log } from './log';

/**
 * Container logs (TRD 14.5, M3): every running container of the watched projects is followed
 * through the proxy (`/containers/{id}/logs?follow=1&stdout=1&stderr=1&timestamps=1`), its lines
 * cut at 64 KB, limited per container (200 lines/s unless the monitor says otherwise; the rest are
 * counted as dropped), and sent in batches every second or at 256 KB. While the monitor cannot take
 * them, batches go to a ring on the state volume (50 MB); when it is full the oldest batch is
 * dropped and its lines counted. Services the monitor lists as excluded are not followed.
 */

const gunzip = promisify(zlib.gunzip);

/** Mirrors `AGENT_LOG_LINE_MAX` and `AGENT_LOG_LINES_PER_S` in @cc/shared (checked by a test). */
export const LINE_MAX = 65_536;
export const DEFAULT_LINES_PER_S = 200;
/** A batch is sent when this much text is waiting, or every FLUSH_MS. */
export const FLUSH_CHARS = 256 * 1024;
export const FLUSH_MS = 1_000;
/** One request carries at most this much text (the monitor accepts 4 MB inflated). */
const REQUEST_CHARS = 1024 * 1024;
const REQUEST_LINES = 20_000;
/** Text waiting in memory past this is dropped and counted (a request can take 20 s to fail). */
const QUEUE_CHARS_MAX = 8 * 1024 * 1024;
/** Buffered batches sent per flush once the monitor answers again (about 5 per second). */
const DRAIN_PER_FLUSH = 5;
/** After a long absence the agent does not reach back further than this for a container's lines. */
const CATCH_UP_S = 3_600;
export const CURSOR_SAVE_MS = 5_000;

export type LogStream = 'out' | 'err';
export interface ParsedLine {
  /** Docker's timestamp: whole seconds and nanoseconds, kept exact for the follow cursor. */
  sec: number;
  nanos: number;
  /** Milliseconds, as sent to the monitor. */
  ts: number;
  s: LogStream;
  msg: string;
}

const TS_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d) /;

/** Docker's RFC 3339 timestamp at the start of a line, and the rest of the line. */
export function parseTs(line: string): { sec: number; nanos: number; rest: string } | null {
  const m = TS_RE.exec(line);
  if (!m) return null;
  const ms = Date.parse(m[1]! + m[3]!);
  if (!Number.isFinite(ms)) return null;
  return { sec: Math.floor(ms / 1000), nanos: Number((m[2] ?? '').padEnd(9, '0')), rest: line.slice(m[0].length) };
}

/** Docker's `since`: seconds with nine decimals. */
export const cursorText = (sec: number, nanos: number): string => `${sec}.${String(nanos).padStart(9, '0')}`;

function parseCursor(c: string): [number, number] | null {
  const m = /^(\d{1,12})\.(\d{9})$/.exec(c);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Cuts at `max` UTF-16 units without splitting a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const c = s.charCodeAt(max);
  return s.slice(0, c >= 0xdc00 && c <= 0xdfff ? max - 1 : max);
}

interface Pending {
  sec: number;
  nanos: number;
  text: string;
}

/**
 * Reads one container's log stream. Without a TTY Docker multiplexes stdout and stderr in frames
 * (8-byte header: stream, three zero bytes, big-endian length), one log message per frame; a
 * message longer than 16 KB comes as several frames, each with its own timestamp, and only the
 * last ends in a newline, so they are joined back. A container with a TTY sends its output raw,
 * all of it as stdout. Which one it is shows in the first bytes (the proxy refuses inspect).
 */
export class LogParser {
  private mode: 'unknown' | 'mux' | 'raw' = 'unknown';
  private buf: Buffer = Buffer.alloc(0);
  private readonly decoder = new StringDecoder('utf8');
  private pending: Record<LogStream, Pending | null> = { out: null, err: null };

  constructor(
    private readonly onLine: (l: ParsedLine) => void,
    private readonly now: () => number = Date.now,
  ) {}

  push(chunk: Uint8Array): void {
    if (this.mode === 'raw') return this.text('out', this.decoder.write(Buffer.from(chunk)));
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    if (this.mode === 'unknown') {
      if (this.buf.length < 4) return;
      const b = this.buf;
      this.mode = b[0]! <= 2 && b[1] === 0 && b[2] === 0 && b[3] === 0 ? 'mux' : 'raw';
      if (this.mode === 'raw') {
        const rest = this.buf;
        this.buf = Buffer.alloc(0);
        return this.text('out', this.decoder.write(rest));
      }
    }
    while (this.buf.length >= 8) {
      const size = this.buf.readUInt32BE(4);
      if (size > 4 * LINE_MAX * 4) {
        // Not a frame Docker would send: give up on this buffer rather than hold it.
        this.buf = Buffer.alloc(0);
        return;
      }
      if (this.buf.length < 8 + size) return;
      const stream: LogStream = this.buf[0] === 2 ? 'err' : 'out';
      const payload = this.buf.subarray(8, 8 + size).toString('utf8');
      this.buf = this.buf.subarray(8 + size);
      this.text(stream, payload);
    }
  }

  /** The stream ended: a message still waiting for its newline is passed on as it is. */
  end(): void {
    if (this.mode === 'raw') this.text('out', this.decoder.end());
    for (const s of ['out', 'err'] as const) {
      const p = this.pending[s];
      if (p) this.emit(s, p);
      this.pending[s] = null;
    }
  }

  private text(stream: LogStream, text: string): void {
    let i = 0;
    while (i < text.length) {
      const nl = text.indexOf('\n', i);
      const piece = nl < 0 ? text.slice(i) : text.slice(i, nl);
      this.piece(stream, piece, nl >= 0);
      i = nl < 0 ? text.length : nl + 1;
    }
  }

  private piece(stream: LogStream, piece: string, complete: boolean): void {
    let p = this.pending[stream];
    if (!p) {
      const t = parseTs(piece);
      if (t) p = { sec: t.sec, nanos: t.nanos, text: cut(t.rest, LINE_MAX) };
      else {
        const ms = this.now();
        p = { sec: Math.floor(ms / 1000), nanos: (ms % 1000) * 1e6, text: cut(piece, LINE_MAX) };
      }
    } else if (p.text.length < LINE_MAX) {
      // The rest of a long message: in frames it carries its own timestamp, raw it does not.
      const t = this.mode === 'mux' ? parseTs(piece) : null;
      p.text = cut(p.text + (t ? t.rest : piece), LINE_MAX);
    }
    if (complete) {
      this.pending[stream] = null;
      this.emit(stream, p);
    } else {
      this.pending[stream] = p;
    }
  }

  private emit(s: LogStream, p: Pending): void {
    const msg = p.text.endsWith('\r') ? p.text.slice(0, -1) : p.text;
    this.onLine({ sec: p.sec, nanos: p.nanos, ts: p.sec * 1000 + Math.floor(p.nanos / 1e6), s, msg });
  }
}

/**
 * A Caddy access record, which must never leave the host (PRD O6): Caddy should write those to its
 * file, and any that reach a container's stdout are dropped here as a second safeguard.
 */
export function isCaddyAccessRecord(msg: string): boolean {
  if (msg.charCodeAt(0) !== 123 /* { */ || !msg.includes('http.log.access')) return false;
  try {
    const o = JSON.parse(msg) as { logger?: unknown };
    return typeof o.logger === 'string' && o.logger.startsWith('http.log.access');
  } catch {
    return false;
  }
}

export interface LogContainer {
  id: string;
  /** `<project>/<service>`. */
  key: string;
  running: boolean;
}

export interface LogDocker {
  logs(id: string, since: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
}

export interface CursorStore {
  load(): Promise<unknown>;
  save(cursors: Record<string, string>): Promise<void>;
}

export interface LogShipperDeps {
  docker: LogDocker;
  post: (gz: Buffer) => Promise<PostResult>;
  /** True while the agent waits on an earlier answer of the monitor (batches go to the buffer). */
  blocked: () => boolean;
  /** The agent's handling of the monitor's answers (waits after 401, 426, 429, unreachable). */
  answer: (r: PostResult) => void;
  log: Log;
  /** Folder for the disk buffer, on the state volume. */
  bufferDir: string;
  bufferMaxBytes: number;
  cursors?: CursorStore;
  /** `CC_LOG_LINES_PER_S`: a limit set on the host, which wins over the monitor's. */
  linesPerS?: number | null;
  now?: () => number;
}

interface Queued {
  lines: AgentLogs['batches'][number]['lines'];
  dropped: number;
}

interface Spooled {
  file: string;
  bytes: number;
  lines: number;
}

export class LogShipper {
  private readonly now: () => number;
  private running = false;
  private followers = new Map<string, { key: string; abort: AbortController }>();
  private cursors = new Map<string, string>();
  private cursorsDirty = false;
  private queue = new Map<string, Queued>();
  private queuedChars = 0;
  private rate = new Map<string, { second: number; n: number }>();
  private excluded = new Set<string>();
  private linesPerS = DEFAULT_LINES_PER_S;
  private spool: Spooled[] = [];
  private spoolBytes = 0;
  private seq = 0;
  private droppedTotal = 0;
  private caddyFiltered = 0;
  private lastSyncSec: number | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private lastError: string | null = null;
  private lastOkAt: number | null = null;
  private lastNoteAt = 0;

  constructor(private readonly d: LogShipperDeps) {
    this.now = d.now ?? Date.now;
    if (d.linesPerS) this.linesPerS = d.linesPerS;
  }

  /** Lines dropped since the agent started (limit, full queue or buffer, refused batches). */
  get dropped(): number {
    return this.droppedTotal;
  }

  get bufferBytes(): number {
    return this.spoolBytes;
  }

  get following(): string[] {
    return [...this.followers.keys()];
  }

  /** The `logs` row of the agent's collector list. */
  state(): { lastOkAt: number | null; error: string | null } {
    return { lastOkAt: this.lastOkAt, error: this.lastError };
  }

  /** Loads the saved cursors and the batches left in the disk buffer by the previous run. */
  async init(): Promise<void> {
    try {
      const raw = this.d.cursors ? await this.d.cursors.load() : null;
      if (raw && typeof raw === 'object') {
        for (const [id, c] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof c === 'string' && /^[0-9a-f]{12,64}$/.test(id) && parseCursor(c)) this.cursors.set(id, c);
        }
      }
    } catch (e) {
      this.d.log.warn('could not read the saved log positions', { error: errText(e) });
    }
    await fs.mkdir(this.d.bufferDir, { recursive: true, mode: 0o700 });
    const names = (await fs.readdir(this.d.bufferDir)).filter((n) => /^\d{12}\.\d+\.json\.gz$/.test(n)).sort();
    for (const n of names) {
      const file = path.join(this.d.bufferDir, n);
      const st = await fs.stat(file).catch(() => null);
      if (!st) continue;
      this.spool.push({ file, bytes: st.size, lines: Number(n.split('.')[1]) });
      this.spoolBytes += st.size;
      this.seq = Math.max(this.seq, Number(n.slice(0, 12)));
    }
    for (const n of await fs.readdir(this.d.bufferDir)) {
      if (n.endsWith('.tmp')) await fs.rm(path.join(this.d.bufferDir, n), { force: true });
    }
    if (this.spool.length > 0) this.d.log.info('log batches left in the buffer will be sent', { batches: this.spool.length, bytes: this.spoolBytes });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_MS);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.flushTimer = this.saveTimer = null;
    for (const f of this.followers.values()) f.abort.abort();
    this.followers.clear();
    if (this.flushing) await this.flushing.catch(() => undefined);
    // What is still waiting goes to the buffer rather than being lost with the process.
    const payloads = this.takePayloads();
    for (const p of payloads) await this.toSpool(p).catch(() => undefined);
    await this.saveCursors();
  }

  /**
   * The container list of this round: follows every running container of a watched project that
   * is not excluded, and stops following the others. Called after each container list (10 s).
   */
  sync(list: readonly LogContainer[]): void {
    if (!this.running) return;
    const nowSec = Math.floor(this.now() / 1000);
    const want = new Map(list.filter((c) => c.running && !this.excluded.has(c.key)).map((c) => [c.id, c.key]));
    for (const [id, f] of this.followers) {
      if (!want.has(id)) {
        f.abort.abort();
        this.followers.delete(id);
      }
    }
    for (const id of this.rate.keys()) if (!want.has(id)) this.rate.delete(id);
    for (const [id, key] of want) {
      if (this.followers.has(id)) continue;
      const abort = new AbortController();
      this.followers.set(id, { key, abort });
      // From where this container was left; a container never seen before: from now on the first
      // round after the agent starts (no reaching back into old history), else from the previous
      // round, when it was not there yet.
      const since = this.cursors.get(id) ?? cursorText(this.lastSyncSec ?? nowSec, 0);
      void this.follow(id, key, since, abort);
    }
    // Positions of containers that no longer exist are forgotten.
    const listed = new Set(list.map((c) => c.id));
    for (const id of this.cursors.keys()) {
      if (!listed.has(id)) {
        this.cursors.delete(id);
        this.cursorsDirty = true;
      }
    }
    this.lastSyncSec = nowSec;
    this.scheduleSave();
  }

  private async follow(id: string, key: string, since: string, abort: AbortController): Promise<void> {
    let wait = 1_000;
    let from = since;
    while (this.running && !abort.signal.aborted) {
      const c = parseCursor(this.cursors.get(id) ?? from)!;
      const floor = Math.floor(this.now() / 1000) - CATCH_UP_S;
      from = c[0] < floor ? cursorText(floor, 0) : cursorText(c[0], c[1]);
      try {
        const body = await this.d.docker.logs(id, from, abort.signal);
        const parser = new LogParser((l) => this.take(id, key, l), this.now);
        for await (const chunk of body) parser.push(chunk);
        parser.end();
        // The stream ended: the container stopped, or the proxy closed a quiet stream. The next
        // container list starts it again from the saved position if it is still running.
        break;
      } catch (e) {
        if (abort.signal.aborted || !this.running) break;
        this.lastError = `${key}: ${errText(e)}`.slice(0, 300);
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(30_000, wait * 2);
      }
    }
    if (this.followers.get(id)?.abort === abort) this.followers.delete(id);
  }

  /** One line of a container: position, Caddy filter, limit, queue. */
  take(id: string, key: string, l: ParsedLine): void {
    const prev = this.cursors.get(id);
    if (prev) {
      const [ps, pn] = parseCursor(prev)!;
      // `since` includes its own second; lines already passed on are not sent twice.
      if (l.sec < ps || (l.sec === ps && l.nanos <= pn)) return;
    }
    this.cursors.set(id, cursorText(l.sec, l.nanos));
    this.cursorsDirty = true;
    this.lastOkAt = this.now();
    if (this.excluded.has(key)) return;
    if (isCaddyAccessRecord(l.msg)) {
      this.caddyFiltered += 1;
      return;
    }
    const q = this.queue.get(key) ?? { lines: [], dropped: 0 };
    this.queue.set(key, q);
    const second = Math.floor(this.now() / 1000);
    let r = this.rate.get(id);
    if (!r || r.second !== second) {
      r = { second, n: 0 };
      this.rate.set(id, r);
    }
    r.n += 1;
    if (r.n > this.linesPerS || this.queuedChars + l.msg.length > QUEUE_CHARS_MAX) {
      q.dropped += 1;
      this.droppedTotal += 1;
      return;
    }
    q.lines.push({ ts: l.ts, s: l.s, msg: l.msg });
    this.queuedChars += l.msg.length + 40;
    if (this.queuedChars >= FLUSH_CHARS && !this.flushing) void this.flush();
  }

  /** Everything queued, as requests of at most REQUEST_CHARS text. */
  private takePayloads(): { body: AgentLogs; lines: number }[] {
    const out: { body: AgentLogs; lines: number }[] = [];
    let cur: AgentLogs = { v: 1, batches: [] };
    let chars = 0;
    let lines = 0;
    const close = (): void => {
      if (cur.batches.length > 0) out.push({ body: cur, lines });
      cur = { v: 1, batches: [] };
      chars = 0;
      lines = 0;
    };
    for (const [service, q] of this.queue) {
      let batch = { service, lines: [] as Queued['lines'], dropped: q.dropped };
      cur.batches.push(batch);
      for (const l of q.lines) {
        const size = l.msg.length + 40;
        if ((chars + size > REQUEST_CHARS && chars > 0) || batch.lines.length >= REQUEST_LINES) {
          close();
          batch = { service, lines: [], dropped: 0 };
          cur.batches.push(batch);
        }
        batch.lines.push(l);
        chars += size;
        lines += 1;
      }
    }
    close();
    this.queue.clear();
    this.queuedChars = 0;
    return out;
  }

  /** Sends what is queued (or buffers it), then some of the buffer once the monitor answers. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    this.note();
    let reachable = !this.d.blocked();
    for (const p of this.takePayloads()) {
      if (!reachable) {
        await this.toSpool(p);
        continue;
      }
      const r = await this.d.post(await gzipJson(p.body));
      this.d.answer(r);
      if (r.kind === 'ok') this.onAnswer(r.body);
      else if (r.kind === 'rejected') {
        this.droppedTotal += p.lines;
        this.lastError = `the monitor refused a log batch (${r.status} ${r.error})`;
      } else {
        reachable = false;
        this.lastError = 'the monitor is not taking logs; batches go to the buffer';
        await this.toSpool(p);
      }
    }
    if (!reachable || this.d.blocked()) return;
    for (let i = 0; i < DRAIN_PER_FLUSH && this.spool.length > 0; i++) {
      const s = this.spool[0]!;
      let gz: Buffer;
      try {
        gz = await fs.readFile(s.file);
      } catch {
        this.unspool(s);
        continue;
      }
      const r = await this.d.post(gz);
      this.d.answer(r);
      if (r.kind === 'ok') {
        this.onAnswer(r.body);
        this.unspool(s);
        await fs.rm(s.file, { force: true });
      } else if (r.kind === 'rejected') {
        this.droppedTotal += s.lines;
        this.unspool(s);
        await fs.rm(s.file, { force: true });
      } else {
        return;
      }
    }
  }

  private unspool(s: Spooled): void {
    const i = this.spool.indexOf(s);
    if (i >= 0) {
      this.spool.splice(i, 1);
      this.spoolBytes -= s.bytes;
    }
  }

  /** Writes a request to the disk buffer; the oldest are dropped (and their lines counted) to stay under the limit. */
  private async toSpool(p: { body: AgentLogs; lines: number }): Promise<void> {
    const gz = await gzipJson(p.body);
    while (this.spool.length > 0 && this.spoolBytes + gz.length > this.d.bufferMaxBytes) {
      const old = this.spool.shift()!;
      this.spoolBytes -= old.bytes;
      await this.countDropped(old);
      await fs.rm(old.file, { force: true });
    }
    if (gz.length > this.d.bufferMaxBytes) {
      this.droppedTotal += p.lines;
      return;
    }
    this.seq += 1;
    const file = path.join(this.d.bufferDir, `${String(this.seq).padStart(12, '0')}.${p.lines}.json.gz`);
    try {
      await fs.writeFile(`${file}.tmp`, gz, { mode: 0o600 });
      await fs.rename(`${file}.tmp`, file);
      this.spool.push({ file, bytes: gz.length, lines: p.lines });
      this.spoolBytes += gz.length;
    } catch (e) {
      this.droppedTotal += p.lines;
      this.lastError = `could not write the log buffer: ${errText(e)}`.slice(0, 300);
    }
  }

  /** A buffered batch dropped for room: its lines are counted on their services for the monitor. */
  private async countDropped(s: Spooled): Promise<void> {
    this.droppedTotal += s.lines;
    try {
      const body = JSON.parse((await gunzip(await fs.readFile(s.file))).toString('utf8')) as AgentLogs;
      for (const b of body.batches) {
        const q = this.queue.get(b.service) ?? { lines: [], dropped: 0 };
        this.queue.set(b.service, q);
        q.dropped += b.lines.length + b.dropped;
      }
    } catch {
      // unreadable: counted in the total only
    }
  }

  /** The monitor's answer: services not to follow and the line limit (an older monitor sends none). */
  onAnswer(body: unknown): void {
    if (!body || typeof body !== 'object') return;
    const a = body as Partial<AgentLogsResponse>;
    if (!this.d.linesPerS && Number.isInteger(a.linesPerS) && a.linesPerS! >= 1 && a.linesPerS! <= 100_000) this.linesPerS = a.linesPerS!;
    if (Array.isArray(a.excluded)) {
      const next = new Set(a.excluded.filter((x): x is string => typeof x === 'string').slice(0, 1000));
      const added = [...next].filter((k) => !this.excluded.has(k));
      this.excluded = next;
      for (const [id, f] of this.followers) {
        if (next.has(f.key)) {
          f.abort.abort();
          this.followers.delete(id);
        }
      }
      for (const k of added) this.queue.delete(k);
      if (added.length > 0) this.d.log.info('the monitor excluded services from log shipping', { services: added });
    }
    this.lastError = null;
  }

  /** Once a minute: Caddy access records kept off the wire. */
  private note(): void {
    const t = this.now();
    if (this.caddyFiltered === 0 || t - this.lastNoteAt < 60_000) return;
    this.lastNoteAt = t;
    this.d.log.warn('dropped Caddy access records from container stdout; configure Caddy to log access to its file', { records: this.caddyFiltered });
    this.caddyFiltered = 0;
  }

  private scheduleSave(): void {
    if (!this.d.cursors || !this.cursorsDirty || this.saveTimer || !this.running) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveCursors();
    }, CURSOR_SAVE_MS);
  }

  async saveCursors(): Promise<void> {
    if (!this.d.cursors || !this.cursorsDirty) return;
    this.cursorsDirty = false;
    try {
      await this.d.cursors.save(Object.fromEntries(this.cursors));
    } catch (e) {
      this.cursorsDirty = true;
      this.d.log.warn('could not save the log positions', { error: errText(e) });
    }
  }
}
