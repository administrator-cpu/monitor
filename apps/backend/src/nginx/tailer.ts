import fs from 'node:fs/promises';

export interface TailResult {
  lines: string[];
  /** The file shrank (copy-truncate style rotation); reading restarted at the beginning. */
  truncated: boolean;
  /** The path now points at a different file; the old one was read to its end first. */
  rotated: boolean;
  /** Lines dropped because they were longer than the limit. */
  oversize: number;
}

export interface TailerOptions {
  /** First open starts at the end of the file (no replay of history). Later files start at 0. */
  startAtEnd?: boolean;
  /** Most bytes read per poll; a backlog is worked off over the following polls. */
  maxBytesPerPoll?: number;
  maxLineBytes?: number;
}

interface Identity {
  key: string;
}

type Handle = Awaited<ReturnType<typeof fs.open>>;

/**
 * Follows a log file from a byte offset. It holds the file open, so when nginx rotates the file
 * (rename, then a new file under the old name) the rest of the old file is still read before the
 * new one is opened, and no line is lost or read twice. Copy-truncate rotation is detected by the
 * file becoming smaller than the offset. A line is only returned once its newline has been seen.
 *
 * File identity is the inode plus the creation time, because inode numbers are not reliable on
 * every Windows file system (backend-schema/TRD "[Verify in phase 6]").
 */
export class LogTailer {
  private fh: Handle | null = null;
  private identity: Identity | null = null;
  private offset = 0;
  private carry: Buffer = Buffer.alloc(0);
  private skipping = false;
  private everOpened = false;
  private readonly startAtEnd: boolean;
  private readonly maxBytes: number;
  private readonly maxLine: number;

  constructor(
    private readonly path: string,
    o: TailerOptions = {},
  ) {
    this.startAtEnd = o.startAtEnd ?? true;
    this.maxBytes = o.maxBytesPerPoll ?? 4 * 1024 * 1024;
    this.maxLine = o.maxLineBytes ?? 65_536;
  }

  get isOpen(): boolean {
    return this.fh !== null;
  }

  get position(): number {
    return this.offset;
  }

  async close(): Promise<void> {
    const fh = this.fh;
    this.fh = null;
    await fh?.close().catch(() => undefined);
  }

  private static idOf(st: { ino: bigint | number; birthtimeMs: bigint | number }): Identity {
    return { key: `${String(st.ino)}|${String(Math.round(Number(st.birthtimeMs)))}` };
  }

  private async open(): Promise<boolean> {
    try {
      const fh = await fs.open(this.path, 'r');
      const st = await fh.stat({ bigint: true });
      this.fh = fh;
      this.identity = LogTailer.idOf(st);
      this.offset = !this.everOpened && this.startAtEnd ? Number(st.size) : 0;
      this.everOpened = true;
      this.carry = Buffer.alloc(0);
      this.skipping = false;
      return true;
    } catch {
      return false; // file not there (yet)
    }
  }

  async poll(): Promise<TailResult> {
    const res: TailResult = { lines: [], truncated: false, rotated: false, oversize: 0 };

    if (!this.fh && !(await this.open())) return res;

    // Has the name been replaced by a different file?
    try {
      const now = await fs.stat(this.path, { bigint: true });
      const id = LogTailer.idOf(now);
      if (this.identity && id.key !== this.identity.key) {
        await this.drain(res); // the rest of the old file first
        await this.close();
        this.carry = Buffer.alloc(0);
        this.skipping = false;
        res.rotated = true;
        try {
          const fh = await fs.open(this.path, 'r');
          this.fh = fh;
          this.identity = id;
          this.offset = 0;
        } catch {
          return res;
        }
      }
    } catch {
      // The name is gone but we still hold the old file: keep reading it until a new one appears.
    }

    await this.drain(res);
    return res;
  }

  /** Reads up to `maxBytes` from the open handle and splits complete lines. */
  private async drain(res: TailResult): Promise<void> {
    const fh = this.fh;
    if (!fh) return;
    let st;
    try {
      st = await fh.stat({ bigint: true });
    } catch {
      await this.close();
      return;
    }
    let size = Number(st.size);
    if (size < this.offset) {
      this.offset = 0; // truncated in place
      this.carry = Buffer.alloc(0);
      this.skipping = false;
      res.truncated = true;
    }
    let budget = this.maxBytes;
    while (size > this.offset && budget > 0) {
      const len = Math.min(size - this.offset, budget, 1024 * 1024);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, this.offset);
      if (bytesRead === 0) break;
      this.offset += bytesRead;
      budget -= bytesRead;
      this.split(buf.subarray(0, bytesRead), res);
      size = Number((await fh.stat({ bigint: true })).size);
    }
  }

  private split(chunk: Buffer, res: TailResult): void {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl === -1) {
        const rest = chunk.subarray(start);
        if (this.skipping) return;
        this.carry = this.carry.length === 0 ? Buffer.from(rest) : Buffer.concat([this.carry, rest]);
        if (this.carry.length > this.maxLine) {
          this.carry = Buffer.alloc(0);
          this.skipping = true;
          res.oversize += 1;
        }
        return;
      }
      const piece = chunk.subarray(start, nl);
      start = nl + 1;
      if (this.skipping) {
        this.skipping = false; // the oversize line ends here
        continue;
      }
      const full = this.carry.length === 0 ? piece : Buffer.concat([this.carry, piece]);
      this.carry = Buffer.alloc(0);
      if (full.length > this.maxLine) {
        res.oversize += 1;
        continue;
      }
      const text = full.toString('utf8').replace(/\r$/, '');
      if (text.length > 0) res.lines.push(text);
    }
  }
}
