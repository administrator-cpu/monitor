/**
 * Runs the pending migrations on a COPY of the production database and checks that nothing was
 * lost: row counts, service ids and keys, open incidents and their fingerprints, foreign keys,
 * integrity. Prints how long the migrations took (backend-schema.md section 13: every migration is
 * timed on a production copy before merge).
 *
 * Needs nothing installed: plain Node 22.13 or later, with its built-in `node:sqlite`. Run it from
 * a clone of the branch to be merged, so it applies that branch's `migrations` folder:
 *
 *   node apps\backend\scripts\migration-check.mjs E:\monitor-backups\migration-test\monitor.db
 *
 * Options: `--migrations <dir>` to use another migrations folder. It refuses the live database
 * path. The copy is changed in place; delete it afterwards.
 *
 * It applies each file exactly as the backend does (src/db.ts `migrate`): the same connection
 * pragmas, one transaction per file, a row in `schema_migrations`. Exit codes: 0 OK or nothing to
 * apply, 1 a check failed or a migration threw, 2 wrong usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// node:sqlite prints an ExperimentalWarning on every load; keep other warnings.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.warn(`${w.name}: ${w.message}`);
});

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.error(`This Node (${process.version}) has no node:sqlite. Use Node 22.13 or later.`);
  process.exit(2);
}

const args = process.argv.slice(2);
let migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const mi = args.indexOf('--migrations');
if (mi !== -1) {
  if (!args[mi + 1]) {
    console.error('--migrations needs a folder');
    process.exit(2);
  }
  migrationsDir = path.resolve(args[mi + 1]);
  args.splice(mi, 2);
}
const file = args[0];
if (!file || args.length > 1) {
  console.error(
    'Usage: node apps/backend/scripts/migration-check.mjs <path to a copy of monitor.db> [--migrations <dir>]',
  );
  process.exit(2);
}

const LIVE = [process.env.SQLITE_PATH, 'C:\\monitor\\data\\monitor.db']
  .filter(Boolean)
  .map((p) => path.resolve(p).toLowerCase());
const abs = path.resolve(file);
if (LIVE.includes(abs.toLowerCase())) {
  console.error(
    `Refusing ${abs}: that is the live database. Copy it first (see docs/runbook-hosts.md).`,
  );
  process.exit(2);
}
if (!fs.existsSync(abs)) {
  console.error(`No such file: ${abs}`);
  process.exit(2);
}
if (!fs.existsSync(migrationsDir)) {
  console.error(`No migrations folder at ${migrationsDir}`);
  process.exit(2);
}

const db = new DatabaseSync(abs);
// The pragmas of src/db.ts openDb, so the migrations run under the same rules as on startup.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA temp_store = MEMORY');

const all = (sql) => db.prepare(sql).all();
const tables = () =>
  all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((r) => r.name);
const countAll = () =>
  Object.fromEntries(
    tables().map((t) => [t, Number(db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n)]),
  );
const cols = (t) => all(`PRAGMA table_info("${t}")`).map((c) => c.name);
const services = () => {
  if (!tables().includes('services')) return [];
  const key = cols('services').includes('source_key') ? 'source_key' : 'pm2_name';
  return all(`SELECT id, name, ${key} AS k, is_archived FROM services ORDER BY id`).map(
    (r) => `${r.id}|${r.name}|${r.k}|${r.is_archived}`,
  );
};
const firing = () =>
  tables().includes('alert_incidents')
    ? all(
        "SELECT id, fingerprint, service_id FROM alert_incidents WHERE state = 'firing' ORDER BY id",
      ).map((r) => `${r.id}|${r.fingerprint}|${r.service_id}`)
    : [];

db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
const done = new Set(all('SELECT version FROM schema_migrations').map((r) => Number(r.version)));
const pending = fs
  .readdirSync(migrationsDir)
  .map((f) => ({ file: f, m: /^(\d{3})_(.+)\.sql$/.exec(f) }))
  .filter((x) => x.m !== null)
  .map((x) => ({ file: x.file, version: Number(x.m[1]), name: x.m[2] }))
  .sort((a, b) => a.version - b.version)
  .filter((x) => !done.has(x.version));

const sizeMb = (fs.statSync(abs).size / 1048576).toFixed(1);
const sqliteVersion = db.prepare('SELECT sqlite_version() AS v').get().v;
console.log(
  `Copy: ${abs} (${sizeMb} MB), migrations applied: ${[...done].sort((a, b) => a - b).join(', ') || 'none'}`,
);
console.log(`Node ${process.version}, SQLite ${sqliteVersion}, migrations from ${migrationsDir}`);
if (pending.length === 0) {
  console.log('Nothing to apply: this copy is already up to date.');
  db.close();
  process.exit(0);
}

const before = { counts: countAll(), services: services(), firing: firing() };
const t0 = process.hrtime.bigint();
for (const mig of pending) {
  const sql = fs.readFileSync(path.join(migrationsDir, mig.file), 'utf8');
  db.exec('BEGIN');
  try {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      mig.version,
      mig.name,
      Date.now(),
    );
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the transaction may already be gone */
    }
    console.error(`FAILED: ${mig.file} threw: ${e instanceof Error ? e.message : String(e)}`);
    console.error(
      'On startup the backend would stop the same way and the deploy would roll back. Do not merge.',
    );
    db.close();
    process.exit(1);
  }
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`Applied ${pending.map((p) => p.file).join(', ')} in ${(ms / 1000).toFixed(2)} s`);

const after = { counts: countAll(), services: services(), firing: firing() };
const problems = [];
for (const [t, n] of Object.entries(before.counts)) {
  if (t === 'schema_migrations' || t === 'alert_rules') continue; // these grow by design
  if (after.counts[t] === undefined) problems.push(`table ${t} is gone`);
  else if (after.counts[t] !== n) problems.push(`${t}: ${n} rows before, ${after.counts[t]} after`);
}
const sameServices = after.services.join('\n') === before.services.join('\n');
const sameFiring = after.firing.join('\n') === before.firing.join('\n');
if (!sameServices) problems.push('services: ids, names, keys or archive flags changed');
if (!sameFiring) problems.push('open incidents or their fingerprints changed');
const fk = all('PRAGMA foreign_key_check');
if (fk.length > 0) problems.push(`foreign key check: ${fk.length} problem rows`);
const integrity = all('PRAGMA integrity_check').map((r) => r.integrity_check);
if (integrity.length !== 1 || integrity[0] !== 'ok')
  problems.push(`integrity check: ${integrity.slice(0, 5).join('; ')}`);
if (tables().includes('services') && cols('services').includes('host_id')) {
  const other = Number(db.prepare('SELECT COUNT(*) AS n FROM services WHERE host_id <> 1').get().n);
  if (other > 0) problems.push(`${other} services are not on host 1`);
}

console.log(
  `Services: ${after.services.length} (unchanged ids and keys: ${sameServices ? 'yes' : 'NO'})`,
);
console.log(`Open incidents: ${after.firing.length} (unchanged: ${sameFiring ? 'yes' : 'NO'})`);
db.close();
if (problems.length > 0) {
  console.error(`FAILED:\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log('OK: every row kept, nothing to fix.');
