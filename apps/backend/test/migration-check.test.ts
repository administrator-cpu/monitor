import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrate } from '../src/db';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'migration-check.mjs');

/** `node scripts/migration-check.mjs ...`, with only Node itself (no tsx, no better-sqlite3). */
function check(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('migration-check.mjs (node:sqlite, nothing installed)', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-migcheck-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  /** A database as production had it before `010`: migrations 001 to 009 and two services besides the seeded one. */
  function copyAt009(): string {
    const dir = tmp();
    const upTo009 = path.join(dir, 'migrations-009');
    fs.mkdirSync(upTo009);
    for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((n) => /^00\d_.+\.sql$/.test(n))) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(upTo009, f));
    }
    const file = path.join(dir, 'monitor.db');
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db, upTo009);
    const ins = db.prepare(
      'INSERT INTO services (name, pm2_name, first_seen_at, last_seen_at) VALUES (?, ?, 1, 1)',
    );
    ins.run('api', 'api');
    ins.run('web', 'web');
    db.close();
    return file;
  }

  it('applies 010 to a 009 copy, keeps every row and says OK; a second run has nothing to do', () => {
    const file = copyAt009();
    const r = check([file]);
    expect(r.err).not.toMatch(/ExperimentalWarning/);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/migrations applied: 1, 2, 3, 4, 5, 6, 7, 8, 9\n/);
    expect(r.out).toMatch(/Applied 010_hosts\.sql in \d+\.\d\d s/);
    expect(r.out).toMatch(/Services: 3 \(unchanged ids and keys: yes\)/);
    expect(r.out).toMatch(/OK: every row kept/);

    // The result is what the backend itself would have produced.
    const db = new Database(file, { readonly: true });
    const keys = db
      .prepare(
        "SELECT name, source_key, host_id FROM services WHERE name IN ('api', 'web') ORDER BY name",
      )
      .all();
    expect(keys).toEqual([
      { name: 'api', source_key: 'api', host_id: 1 },
      { name: 'web', source_key: 'web', host_id: 1 },
    ]);
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 10 });
    db.close();

    const again = check([file]);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/Nothing to apply/);
  });

  it('stops with exit 1 and leaves the copy as it was when a migration throws', () => {
    const file = copyAt009();
    const bad = path.join(tmp(), 'migrations');
    fs.mkdirSync(bad);
    for (const f of fs.readdirSync(MIGRATIONS_DIR))
      fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(bad, f));
    fs.writeFileSync(
      path.join(bad, '011_broken.sql'),
      'CREATE TABLE t (x);\nSELECT * FROM no_such_table;\n',
    );

    const r = check([file, '--migrations', bad]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Applied|Copy:/);
    expect(r.err).toMatch(/011_broken\.sql threw: .*no_such_table/);

    const db = new Database(file, { readonly: true });
    // 010 committed before 011 failed, exactly as on a backend start; 011 left nothing behind.
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 10 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 't'").get()).toEqual({
      n: 0,
    });
    db.close();
  });

  it('refuses the live database path, a missing file and wrong usage', () => {
    const file = copyAt009();
    const live = check([file], { SQLITE_PATH: file });
    expect(live.code).toBe(2);
    expect(live.err).toMatch(/that is the live database/);

    expect(check([path.join(tmp(), 'nope.db')]).code).toBe(2);
    expect(check([]).code).toBe(2);
    expect(check([file, '--migrations']).code).toBe(2);
  });
});
