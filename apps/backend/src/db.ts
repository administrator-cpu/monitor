import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/** Opens SQLite with the pragmas from backend-schema.md section 2. */
export function openDb(file: string): Db {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  return db;
}

export const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

export interface MigrationResult {
  applied: string[];
}

/**
 * Numbered, forward-only SQL migrations (`001_init.sql`, ...). Each file runs
 * inside one transaction and is recorded in `schema_migrations`. A failing
 * migration throws, which stops startup.
 */
export function migrate(
  db: Db,
  dir: string = MIGRATIONS_DIR,
  now: () => number = Date.now,
): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);

  const files = fs
    .readdirSync(dir)
    .map((f) => ({ f, m: /^(\d{3})_(.+)\.sql$/.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null)
    .map((x) => ({ file: x.f, version: Number(x.m[1]), name: x.m[2] as string }))
    .sort((a, b) => a.version - b.version);

  const done = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  const applied: string[] = [];

  for (const mig of files) {
    if (done.has(mig.version)) continue;
    const sql = fs.readFileSync(path.join(dir, mig.file), 'utf8');
    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        mig.version,
        mig.name,
        now(),
      );
    });
    run();
    applied.push(mig.file);
  }
  return { applied };
}
