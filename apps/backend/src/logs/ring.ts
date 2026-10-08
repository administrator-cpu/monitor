import type { LogLine } from '@cc/shared';

/** Longest message kept in the live view and the in-memory buffer (the stored line is complete). */
export const LIVE_LINE_MAX_CHARS = 16_384;
/** Longest chunk written as one stored line (backend-schema.md section 4). */
export const STORED_LINE_MAX_CHARS = 65_536;

/** Cuts at `max` without splitting a UTF-16 surrogate pair. */
export function cutAt(s: string, max: number): number {
  if (s.length <= max) return s.length;
  const code = s.charCodeAt(max);
  return code >= 0xdc00 && code <= 0xdfff ? max - 1 : max;
}

/** Splits an oversize chunk into pieces of at most `max` characters (same timestamp for all). */
export function splitChunk(data: string, max = STORED_LINE_MAX_CHARS): string[] {
  if (data.length <= max) return [data];
  const parts: string[] = [];
  let i = 0;
  while (i < data.length) {
    const end = i + cutAt(data.slice(i, i + max + 1), max);
    parts.push(data.slice(i, end));
    i = end;
  }
  return parts;
}

/** Display copy of a chunk: long messages are cut and the number of removed characters recorded. */
export function toLiveLine(
  ts: number,
  pm: number,
  s: LogLine['s'],
  msg: string,
  max = LIVE_LINE_MAX_CHARS,
): LogLine {
  if (msg.length <= max) return { ts, pm, s, msg };
  const end = cutAt(msg, max);
  return { ts, pm, s, msg: msg.slice(0, end), cut: msg.length - end };
}

/**
 * Recent lines of one service, bounded by line count AND total characters, so a service that
 * logs very long lines cannot grow the monitor's memory (the byte cap wins over the line cap).
 */
export class LogRing {
  private items: LogLine[] = [];
  private head = 0;
  private chars = 0;

  constructor(
    private readonly maxLines: () => number,
    private readonly maxChars: number,
  ) {}

  get length(): number {
    return this.items.length - this.head;
  }

  push(line: LogLine): void {
    this.items.push(line);
    this.chars += line.msg.length;
    const cap = Math.max(1, this.maxLines());
    while (this.length > cap || (this.chars > this.maxChars && this.length > 1)) {
      const old = this.items[this.head];
      this.items[this.head] = undefined as unknown as LogLine;
      this.head += 1;
      if (old) this.chars -= old.msg.length;
    }
    if (this.head > 1024 && this.head > this.items.length / 2) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }

  /** The last `n` lines, oldest first, optionally limited to one stream. */
  last(n: number, stream: 'all' | 'out' | 'err' = 'all'): LogLine[] {
    const out: LogLine[] = [];
    for (let i = this.items.length - 1; i >= this.head && out.length < n; i--) {
      const l = this.items[i];
      if (l && (stream === 'all' || l.s === stream)) out.push(l);
    }
    return out.reverse();
  }
}

/**
 * One browser's view of one service's log stream. The queue is bounded: when the browser
 * cannot keep up, the oldest queued lines are dropped and counted, never buffered without limit.
 */
export class LogSubscription {
  private q: LogLine[] = [];
  private head = 0;
  private chars = 0;
  private droppedSince = 0;

  constructor(
    readonly service: string,
    readonly stream: 'all' | 'out' | 'err',
    private readonly cap = 2_000,
    private readonly capChars = 1_000_000,
  ) {}

  get pending(): number {
    return this.q.length - this.head;
  }

  push(line: LogLine): void {
    if (this.stream !== 'all' && line.s !== this.stream) return;
    while (this.pending > 0 && (this.pending >= this.cap || this.chars + line.msg.length > this.capChars)) {
      const old = this.q[this.head] as LogLine;
      this.q[this.head] = undefined as unknown as LogLine;
      this.head += 1;
      this.chars -= old.msg.length;
      this.droppedSince += 1;
    }
    this.q.push(line);
    this.chars += line.msg.length;
    if (this.head > 512 && this.head > this.q.length / 2) {
      this.q = this.q.slice(this.head);
      this.head = 0;
    }
  }

  /** Counts lines the caller chose not to send (for example a socket with a full buffer). */
  noteDropped(n: number): void {
    this.droppedSince += n;
  }

  /** Up to `maxLines` lines (and about `maxChars` characters) plus lines dropped since last call. */
  take(maxLines = 200, maxChars = 512 * 1024): { lines: LogLine[]; dropped: number } {
    const lines: LogLine[] = [];
    let chars = 0;
    while (this.pending > 0 && lines.length < maxLines) {
      const l = this.q[this.head] as LogLine;
      if (lines.length > 0 && chars + l.msg.length > maxChars) break;
      this.q[this.head] = undefined as unknown as LogLine;
      this.head += 1;
      this.chars -= l.msg.length;
      chars += l.msg.length;
      lines.push(l);
    }
    const dropped = this.droppedSince;
    this.droppedSince = 0;
    return { lines, dropped };
  }
}
