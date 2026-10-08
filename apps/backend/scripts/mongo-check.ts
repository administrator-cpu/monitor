/**
 * Phase 7 on-host check: proves the monitoring user can read what the dashboard needs and
 * nothing more.
 *
 *   MONGO_URI=... MONGO_PROFILE_DBS=app pnpm --filter @cc/backend mongo:check
 *
 * Expected: every "read" check passes, and every "must be refused" check is refused.
 * It never writes anything: the write attempts are expected to fail, and if one succeeds the
 * check removes nothing and reports the user as over-privileged.
 */
import { MongoClient } from 'mongodb';
import { DriverMongoSource, redact } from '../src/mongo/source';

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('MONGO_URI is not set.');
  process.exit(2);
}
const profileDbs = (process.env.MONGO_PROFILE_DBS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
let failed = 0;
const report = (ok: boolean, name: string, detail = ''): void => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main(): Promise<void> {
  const src = new DriverMongoSource(uri!);
  try {
    const ping = await src.ping();
    report(ping >= 0, 'ping', `${Math.round(ping)} ms`);
    const ss = await src.serverStatus();
    report(typeof ss.version === 'string', 'serverStatus', `version ${ss.version}`);
    try {
      const repl = await src.replSetStatus();
      report(true, 'replSetGetStatus', repl ? `${repl.length} members` : 'standalone');
    } catch (e) {
      report(false, 'replSetGetStatus', redact((e as Error).message));
    }
    try {
      const size = await src.storageSize();
      report(size >= 0, 'listDatabases (sizes)', `${size} bytes`);
    } catch (e) {
      report(false, 'listDatabases', redact((e as Error).message));
    }
    try {
      const ops = await src.currentOps(0);
      report(true, 'currentOp', `${ops.length} running`);
    } catch (e) {
      report(false, 'currentOp', redact((e as Error).message));
    }
    for (const db of profileDbs) {
      try {
        await src.slowQueries(db, Date.now() - 60_000, 1);
        report(true, `read ${db}.system.profile`);
      } catch (e) {
        report(false, `read ${db}.system.profile`, redact((e as Error).message));
      }
    }
  } finally {
    await src.close();
  }

  // Negative checks, straight through the driver: these MUST be refused.
  const client = new MongoClient(uri!, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  try {
    const dbName = profileDbs[0] ?? 'test';
    const refused = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
        report(false, `${name} must be refused`, 'it succeeded: the monitoring user is over-privileged');
      } catch (e) {
        const code = (e as { code?: number }).code;
        report(code === 13 || code === 8000 || /not authorized|unauthorized|requires authentication/i.test((e as Error).message), `${name} is refused`);
      }
    };
    await refused('reading an application collection', () => client.db(dbName).collection('users').findOne({}));
    await refused('inserting a document', () => client.db(dbName).collection('cc_monitor_probe').insertOne({ probe: true }));
    await refused('dropping a collection', () => client.db(dbName).collection('cc_monitor_probe').drop());
    await refused('killing an operation', () => client.db('admin').command({ killOp: 1, op: 1 }));
  } finally {
    await client.close();
  }

  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('check could not run:', redact((e as Error).message));
  process.exit(2);
});
