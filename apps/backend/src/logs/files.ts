import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

export const HOUR_MS = 3_600_000;

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** `YYYY-MM-DD-HH` in UTC: the hour a log file covers (backend-schema.md section 4). */
export function hourKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}`;
}

export function hourStart(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

export interface ParsedLogFile {
  /** Start of the hour the file covers, in ms. */
  start: number;
  gz: boolean;
}

const FILE_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})\.jsonl(\.gz)?$/;

/** Retention and search work from the file name alone, never from file contents. */
export function parseLogFile(name: string): ParsedLogFile | null {
  const m = FILE_RE.exec(name);
  if (!m) return null;
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]));
  if (!Number.isFinite(start)) return null;
  return { start, gz: m[5] === '.gz' };
}

export const logFileName = (ms: number): string => `${hourKey(ms)}.jsonl`;

const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Folder name for a service. PM2 names are chosen by whoever starts the process, so they are
 * never used as a path directly: separators, `..`, Windows device names and overlong names are
 * rewritten, and a short hash keeps two different names from sharing a folder.
 * Names starting with `_` are always rewritten so they cannot collide with `_nginx` / `_monitor`.
 */
export function safeDirName(service: string): string {
  if (SAFE_NAME.test(service) && !service.endsWith('.') && !RESERVED_WINDOWS.test(service)) {
    return service;
  }
  const cleaned =
    service
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^[._-]+/, '')
      .replace(/\.+$/, '')
      .slice(0, 40) || 'svc';
  const hash = createHash('sha1').update(service).digest('hex').slice(0, 8);
  const base = RESERVED_WINDOWS.test(cleaned) ? `_${cleaned}` : cleaned;
  return `${base}~${hash}`;
}

export interface LogFile {
  dir: string;
  name: string;
  path: string;
  start: number;
  gz: boolean;
}

/** Every log file under the root (one directory level), by file name only. */
export async function listLogFiles(root: string): Promise<LogFile[]> {
  const out: LogFile[] = [];
  let dirs: string[];
  try {
    dirs = (await fs.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await fs.readdir(path.join(root, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      const p = parseLogFile(name);
      if (p) out.push({ dir, name, path: path.join(root, dir, name), start: p.start, gz: p.gz });
    }
  }
  return out;
}

const exists = async (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false,
  );

/**
 * Compresses a finished hour to `<name>.gz` through a temporary file and deletes the original
 * only after the compressed copy is in place. Streaming zlib runs on libuv's thread pool, so
 * the event loop is not blocked. Returns false when the target already exists (both are kept).
 */
export async function gzipFile(src: string): Promise<boolean> {
  const dst = `${src}.gz`;
  if (await exists(dst)) return false;
  const tmp = `${dst}.tmp`;
  try {
    await pipeline(createReadStream(src), createGzip({ level: 6 }), createWriteStream(tmp));
    await fs.rename(tmp, dst);
    await fs.unlink(src);
    return true;
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** Deletes files whose hour ended more than `retentionHours` ago, by name. Returns the count. */
export async function deleteExpired(
  root: string,
  now: number,
  retentionHours: number,
): Promise<number> {
  let n = 0;
  for (const f of await listLogFiles(root)) {
    if (now - (f.start + HOUR_MS) > retentionHours * HOUR_MS) {
      try {
        await fs.unlink(f.path);
        n += 1;
      } catch {
        // already gone or in use; the next run retries
      }
    }
  }
  return n;
}

/**
 * Early trim for the disk guard: removes every file of the oldest hour (across all services),
 * never the hour currently being written. Returns the number of files removed, 0 when there is
 * nothing older to remove.
 */
export async function deleteOldestHour(root: string, now: number): Promise<number> {
  const files = await listLogFiles(root);
  const current = hourStart(now);
  const old = files.filter((f) => f.start < current);
  if (old.length === 0) return 0;
  const oldest = Math.min(...old.map((f) => f.start));
  let n = 0;
  for (const f of old) {
    if (f.start !== oldest) continue;
    try {
      await fs.unlink(f.path);
      n += 1;
    } catch {
      // skip
    }
  }
  return n;
}

/** Stale `.tmp` files from an interrupted compression. */
export async function removeTempFiles(root: string): Promise<void> {
  let dirs: string[];
  try {
    dirs = (await fs.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return;
  }
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = await fs.readdir(path.join(root, dir));
    } catch {
      continue;
    }
    for (const n of names) {
      if (n.endsWith('.jsonl.gz.tmp')) await fs.rm(path.join(root, dir, n), { force: true });
    }
  }
}
