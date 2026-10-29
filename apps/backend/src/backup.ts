import { promises as fs } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from './db';
import type { CollectorDef } from './scheduler';
import type { Settings } from './settings';

/** Nightly files are `monitor-YYYYMMDD.db`; nothing else in the folder is ever touched. */
const NIGHTLY = /^monitor-(\d{8})\.db$/;

/** Local time of day after which the day's backup is due. */
export const BACKUP_AT = { hour: 2, minute: 30 };

export interface BackupDeps {
  db: Db;
  settings: Settings;
  dir: string;
  now: () => number;
}

export interface BackupResult {
  file: string;
  bytes: number;
  ms: number;
  removed: string[];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYYMMDD` of a moment in the server's local time zone. */
export function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** The file name of the backup due at `ts`, or null before 02:30 local time. */
export function dueFile(ts: number): string | null {
  const d = new Date(ts);
  const minutes = d.getHours() * 60 + d.getMinutes();
  if (minutes < BACKUP_AT.hour * 60 + BACKUP_AT.minute) return null;
  return `monitor-${localDay(ts)}.db`;
}

function record(db: Db, ts: number, status: 'ok' | 'error', detail: unknown): void {
  db.prepare(
    `INSERT INTO maintenance_runs (job, last_run_at, last_status, last_detail) VALUES ('backup', ?, ?, ?)
     ON CONFLICT(job) DO UPDATE SET last_run_at = excluded.last_run_at,
       last_status = excluded.last_status, last_detail = excluded.last_detail`,
  ).run(ts, status, JSON.stringify(detail));
}

/**
 * Writes one consistent copy of the live database with `VACUUM INTO`, to a temporary name first,
 * checks it with `PRAGMA quick_check`, then renames it into place, so a half-written or broken file
 * never looks like a backup. Then keeps the newest `backup.keep` nightly files.
 */
export async function writeBackup(d: BackupDeps, file: string): Promise<BackupResult> {
  const started = Date.now();
  await fs.mkdir(d.dir, { recursive: true });
  const target = path.join(d.dir, file);
  const tmp = `${target}.partial`;
  await fs.rm(tmp, { force: true });
  try {
    d.db.prepare('VACUUM INTO ?').run(tmp);
    const copy = new Database(tmp, { readonly: true, fileMustExist: true });
    try {
      const rows = copy.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
      if (rows.length !== 1 || rows[0]!.quick_check !== 'ok') {
        throw new Error(`the copy failed quick_check: ${rows.map((r) => r.quick_check).join('; ').slice(0, 200)}`);
      }
    } finally {
      copy.close();
    }
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  const bytes = (await fs.stat(target)).size;
  const removed = await prune(d.dir, d.settings.get('backup.keep'));
  return { file: target, bytes, ms: Date.now() - started, removed };
}

/** Deletes nightly files beyond the newest `keep`, by the date in the name. */
export async function prune(dir: string, keep: number): Promise<string[]> {
  const names = (await fs.readdir(dir)).filter((n) => NIGHTLY.test(n)).sort().reverse();
  const old = names.slice(keep);
  for (const n of old) await fs.rm(path.join(dir, n), { force: true });
  return old;
}

const exists = (f: string) =>
  fs.stat(f).then(
    () => true,
    () => false,
  );

/**
 * The scheduler job. It looks every 10 minutes and writes the day's file once it is past 02:30
 * local time and the file is not there yet. A failed write throws and is retried on the next run;
 * after three failed runs in a row the job shows as stale, which raises `monitor.collector_stale`
 * (target `backup`). Before 02:30 a run fails if yesterday's file is missing while older ones
 * exist, so a day without a backup keeps the alert open until the next one is written. A fresh
 * folder with no backups yet is not an error.
 */
export function backupJob(d: BackupDeps): CollectorDef {
  return {
    name: 'backup',
    intervalMs: 600_000,
    // VACUUM INTO runs synchronously; the timeout only records a run that took far too long.
    timeoutMs: 300_000,
    async run() {
      const ts = d.now();
      const file = dueFile(ts);
      if (!file) {
        const yesterday = `monitor-${localDay(ts - 86_400_000)}.db`;
        const any = (await fs.readdir(d.dir).catch(() => [] as string[])).some((n) => NIGHTLY.test(n));
        if (any && !(await exists(path.join(d.dir, yesterday)))) throw new Error(`the backup ${yesterday} is missing`);
        return;
      }
      if (await exists(path.join(d.dir, file))) return;
      try {
        const r = await writeBackup(d, file);
        record(d.db, ts, 'ok', r);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        record(d.db, ts, 'error', { file, error: message.slice(0, 300) });
        throw new Error(`backup to ${d.dir} failed: ${message}`.slice(0, 300));
      }
    },
  };
}
