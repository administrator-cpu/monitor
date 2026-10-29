import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { backupJob, dueFile, prune } from '../src/backup';
import { Scheduler } from '../src/scheduler';
import { addUser, makeApp, type TestApp } from './helpers';

/** A moment in the server's local time zone, so the tests pass in any zone. */
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe('nightly backup', () => {
  let t: TestApp;
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-backup-'));
    dirs.push(d);
    return d;
  };
  afterEach(async () => {
    await t?.close();
    dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  });

  async function setup(clockAt: number) {
    t = await makeApp();
    await addUser(t);
    const clock = { t: clockAt };
    const dir = path.join(tmp(), 'monitor-backups');
    const job = backupJob({ db: t.db, settings: t.ctx.settings, dir, now: () => clock.t });
    return { clock, dir, job };
  }

  const nightly = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^monitor-\d{8}\.db$/.test(n)).sort() : []);
  const lastRun = () => t.db.prepare("SELECT * FROM maintenance_runs WHERE job = 'backup'").get() as { last_status: string; last_detail: string } | undefined;

  it('is due from 02:30 local time, named by the local date', () => {
    expect(dueFile(at(2026, 10, 29, 2, 29))).toBeNull();
    expect(dueFile(at(2026, 10, 29, 2, 30))).toBe('monitor-20261029.db');
    expect(dueFile(at(2026, 10, 29, 23, 59))).toBe('monitor-20261029.db');
  });

  it('writes a readable copy once a day after 02:30 and records it', async () => {
    const { clock, dir, job } = await setup(at(2026, 10, 29, 1, 0));
    await job.run();
    expect(nightly(dir)).toEqual([]);

    clock.t = at(2026, 10, 29, 2, 35);
    await job.run();
    expect(nightly(dir)).toEqual(['monitor-20261029.db']);
    expect(fs.readdirSync(dir).some((n) => n.endsWith('.partial'))).toBe(false);
    const copy = new Database(path.join(dir, 'monitor-20261029.db'), { readonly: true });
    expect((copy.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(1);
    copy.close();
    expect(lastRun()).toMatchObject({ last_status: 'ok' });
    expect(JSON.parse(lastRun()!.last_detail)).toMatchObject({ bytes: expect.any(Number), removed: [] });

    // Later the same day: nothing new is written.
    const mtime = fs.statSync(path.join(dir, 'monitor-20261029.db')).mtimeMs;
    clock.t = at(2026, 10, 29, 9, 0);
    await job.run();
    expect(fs.statSync(path.join(dir, 'monitor-20261029.db')).mtimeMs).toBe(mtime);
  });

  it('before 02:30, a missing backup for yesterday is an error, but an empty folder is not', async () => {
    const { clock, dir, job } = await setup(at(2026, 10, 29, 1, 0));
    await expect(job.run()).resolves.toBeUndefined();

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'monitor-20261027.db'), '');
    await expect(job.run()).rejects.toThrow('monitor-20261028.db is missing');

    fs.writeFileSync(path.join(dir, 'monitor-20261028.db'), '');
    await expect(job.run()).resolves.toBeUndefined();
    clock.t = at(2026, 10, 29, 3, 0);
    await job.run();
    expect(nightly(dir)).toContain('monitor-20261029.db');
  });

  it('keeps the newest backup.keep nightly files and leaves every other file alone', async () => {
    const dir = tmp();
    for (let d = 1; d <= 5; d++) fs.writeFileSync(path.join(dir, `monitor-2026100${d}.db`), '');
    fs.writeFileSync(path.join(dir, 'monitor-20261001-120000-abc1234.db'), ''); // deploy-style name
    fs.writeFileSync(path.join(dir, 'notes.txt'), '');
    fs.mkdirSync(path.join(dir, 'deploy'));
    const removed = await prune(dir, 3);
    expect(removed.sort()).toEqual(['monitor-20261001.db', 'monitor-20261002.db']);
    expect(fs.readdirSync(dir).sort()).toEqual(
      ['deploy', 'monitor-20261001-120000-abc1234.db', 'monitor-20261003.db', 'monitor-20261004.db', 'monitor-20261005.db', 'notes.txt'].sort(),
    );
  });

  it('applies the backup.keep setting after a write', async () => {
    const { dir, job } = await setup(at(2026, 10, 29, 3, 0));
    fs.mkdirSync(dir, { recursive: true });
    for (const d of ['20261025', '20261026', '20261027', '20261028']) fs.writeFileSync(path.join(dir, `monitor-${d}.db`), '');
    t.ctx.settings.setMany({ 'backup.keep': 2 });
    await job.run();
    expect(nightly(dir)).toEqual(['monitor-20261028.db', 'monitor-20261029.db']);
  });

  it('a failing backup is recorded, leaves no partial file, and turns the job stale after three runs', async () => {
    const root = tmp();
    const blocker = path.join(root, 'not-a-folder');
    fs.writeFileSync(blocker, '');
    t = await makeApp();
    const clock = { t: at(2026, 10, 29, 3, 0) };
    const dir = path.join(blocker, 'monitor-backups');
    const job = backupJob({ db: t.db, settings: t.ctx.settings, dir, now: () => clock.t });
    await expect(job.run()).rejects.toThrow('backup to');
    expect(lastRun()).toMatchObject({ last_status: 'error' });

    const s = new Scheduler({ warn: () => undefined, debug: () => undefined }, () => clock.t);
    s.register(job);
    for (let i = 0; i < 3; i++) {
      await s.runOnce('backup');
      clock.t += job.intervalMs;
    }
    clock.t += 1;
    const st = s.status().find((x) => x.name === 'backup')!;
    expect(st.stale).toBe(true);
    expect(st.lastError).toContain('backup to');
    expect(fs.readdirSync(root)).toEqual(['not-a-folder']);
  });
});
