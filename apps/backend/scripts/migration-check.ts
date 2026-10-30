/**
 * Runs the pending migrations on a COPY of the production database and checks that nothing was
 * lost: row counts, service ids and keys, open incidents and their fingerprints, integrity.
 * Prints how long the migrations took (backend-schema.md section 13: every migration is timed on a
 * production copy before merge).
 *
 *   pnpm --filter @cc/backend migration:check E:\monitor-backups\migration-test\monitor.db
 *
 * It refuses the live database path. The copy is changed in place; delete it afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { migrate, openDb } from '../src/db';

const LIVE = [process.env.SQLITE_PATH, 'C:\\monitor\\data\\monitor.db']
  .filter((x): x is string => !!x)
  .map((p) => path.resolve(p).toLowerCase());

const file = process.argv[2];
if (!file) {
  console.error('Usage: migration:check <path to a copy of monitor.db>');
  process.exit(2);
}
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

const db = openDb(abs);
const tables = (): string[] =>
  (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
const countAll = (): Record<string, number> =>
  Object.fromEntries(
    tables().map((t) => [
      t,
      (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n,
    ]),
  );
const cols = (t: string): string[] =>
  (db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name);
const services = (): string[] => {
  const key = cols('services').includes('source_key') ? 'source_key' : 'pm2_name';
  return (
    db
      .prepare(`SELECT id, name, ${key} AS k, is_archived FROM services ORDER BY id`)
      .all() as Record<string, unknown>[]
  ).map((r) => `${r.id}|${r.name}|${r.k}|${r.is_archived}`);
};
const firing = (): string[] =>
  (
    db
      .prepare(
        "SELECT id, fingerprint, service_id FROM alert_incidents WHERE state = 'firing' ORDER BY id",
      )
      .all() as Record<string, unknown>[]
  ).map((r) => `${r.id}|${r.fingerprint}|${r.service_id}`);
const versions = (): number[] =>
  (
    db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[]
  ).map((r) => r.version);

const sizeMb = (fs.statSync(abs).size / 1048576).toFixed(1);
const before = { counts: countAll(), services: services(), firing: firing(), versions: versions() };
console.log(`Copy: ${abs} (${sizeMb} MB), migrations applied: ${before.versions.join(', ')}`);

const t0 = process.hrtime.bigint();
const { applied } = migrate(db);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
if (applied.length === 0) {
  console.log('Nothing to apply: this copy is already up to date.');
  process.exit(0);
}
console.log(`Applied ${applied.join(', ')} in ${(ms / 1000).toFixed(2)} s`);

const after = { counts: countAll(), services: services(), firing: firing() };
const problems: string[] = [];
for (const [t, n] of Object.entries(before.counts)) {
  if (t === 'schema_migrations' || t === 'alert_rules') continue; // these grow by design
  if (after.counts[t] === undefined) problems.push(`table ${t} is gone`);
  else if (after.counts[t] !== n) problems.push(`${t}: ${n} rows before, ${after.counts[t]} after`);
}
if (after.services.join('\n') !== before.services.join('\n'))
  problems.push('services: ids, names, keys or archive flags changed');
if (after.firing.join('\n') !== before.firing.join('\n'))
  problems.push('open incidents or their fingerprints changed');
const fk = db.pragma('foreign_key_check') as unknown[];
if (fk.length > 0) problems.push(`foreign key check: ${fk.length} problem rows`);
const integrity = db.pragma('integrity_check', { simple: true });
if (integrity !== 'ok') problems.push(`integrity check: ${String(integrity)}`);
if (cols('services').includes('host_id')) {
  const other = (
    db.prepare('SELECT COUNT(*) AS n FROM services WHERE host_id <> 1').get() as { n: number }
  ).n;
  if (other > 0) problems.push(`${other} services are not on host 1`);
}

console.log(
  `Services: ${after.services.length} (unchanged ids and keys: ${after.services.join('\n') === before.services.join('\n') ? 'yes' : 'NO'})`,
);
console.log(
  `Open incidents: ${after.firing.length} (unchanged: ${after.firing.join('\n') === before.firing.join('\n') ? 'yes' : 'NO'})`,
);
db.close();
if (problems.length > 0) {
  console.error(`FAILED:\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log('OK: every row kept, nothing to fix.');
