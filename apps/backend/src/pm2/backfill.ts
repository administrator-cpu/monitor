import fs from 'node:fs/promises';
import type { LogStream } from '@cc/shared';
import type { LogPipeline } from '../logs/pipeline';
import type { Pm2Proc } from './types';

const READ_BYTES = 64 * 1024;
const MAX_LINES = 150;
const LINE_MAX = 4_000;

/** Last lines of a text file with the file's modification time, or [] if unreadable. */
export async function tailFile(path: string): Promise<{ lines: string[]; mtime: number }> {
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(path, 'r');
    const st = await fh.stat();
    if (!st.isFile() || st.size === 0) return { lines: [], mtime: st.mtimeMs };
    const len = Math.min(st.size, READ_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, st.size - len);
    let text = buf.toString('utf8');
    if (st.size > len) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    return { lines: lines.slice(-MAX_LINES).map((l) => l.slice(0, LINE_MAX)), mtime: st.mtimeMs };
  } catch {
    return { lines: [], mtime: 0 };
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/**
 * PM2's event bus has no replay, so a quiet service would show an empty log until it next prints.
 * The first time a service is seen, its recent history is read from PM2's own log files.
 */
export class LogBackfill {
  private done = new Set<string>();

  constructor(private readonly pipeline: LogPipeline) {}

  async run(procs: Pm2Proc[]): Promise<void> {
    const byName = new Map<string, Pm2Proc>();
    for (const p of procs) {
      if (p.isModule || this.done.has(p.name)) continue;
      if (!byName.has(p.name)) byName.set(p.name, p);
    }
    for (const [name, p] of byName) {
      this.done.add(name);
      const merged: { ts: number; s: LogStream; msg: string }[] = [];
      for (const [stream, path] of [['out', p.outLog], ['err', p.errLog]] as const) {
        if (!path) continue;
        const { lines, mtime } = await tailFile(path);
        // Files carry no per-line time: spread the lines just before the file's last write.
        lines.forEach((msg, i) => merged.push({ ts: Math.round(mtime) - (lines.length - i), s: stream, msg: msg + '\n' }));
      }
      merged.sort((a, b) => a.ts - b.ts);
      this.pipeline.seed(name, p.pmId, merged);
    }
  }
}
