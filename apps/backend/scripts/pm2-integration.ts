/**
 * Phase 3 demo and check against a REAL PM2 daemon (in a throw-away PM2_HOME).
 *
 *   pnpm --filter @cc/backend pm2:check
 *
 * It starts three small apps (a chatty one, one that crashes, one with a secret in its
 * environment), runs the monitor's PM2 path against them, then kills the daemon and starts it
 * again to prove the monitor recovers on its own. It never touches your real PM2.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config';
import { createContext } from '../src/context';
import { migrate, openDb } from '../src/db';
import { createLogger } from '../src/logger';
import { pm2Collector } from '../src/pm2/collector';

const tmp = fs.mkdtempSync(path.join('/tmp', 'ccp-')); // short path: unix socket paths are limited to ~100 chars
const pm2Home = path.join(tmp, 'home');
const logRoot = path.join(tmp, 'logs');
fs.mkdirSync(pm2Home);
process.env.PM2_HOME = pm2Home; // must be set before the PM2 worker thread starts
const SECRET = 'supersecret-value-9f3a1c';

const pm2Bin = path.join(path.dirname(require.resolve('pm2/package.json')), 'bin', 'pm2');
const pm2 = (...args: string[]): string =>
  execFileSync(process.execPath, [pm2Bin, ...args], { env: { ...process.env, SECRET_TOKEN: SECRET }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

fs.writeFileSync(
  path.join(tmp, 'chatty.js'),
  `let i = 0; setInterval(() => { console.log('chatty line ' + (i++)); if (i % 5 === 0) console.error('chatty error ' + i); }, 200);`,
);
fs.writeFileSync(
  path.join(tmp, 'crasher.js'),
  `console.log('crasher starting'); setTimeout(() => { console.error('crasher about to die'); process.exit(3); }, 1200);`,
);
fs.writeFileSync(path.join(tmp, 'secret.js'), `console.log('has a secret: ' + (process.env.SECRET_TOKEN ? 'yes' : 'no')); setInterval(() => {}, 1e6);`);

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  (${detail})` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms: number, step = 250): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(step);
  }
  return fn();
}

const config: Config = {
  nodeEnv: 'test', bindHost: '127.0.0.1', portApi: 0, portIngest: 0, allowedOrigins: ['http://localhost:3111'],
  cookieSecure: false, cookieName: 'cc_session', sqlitePath: ':memory:', logRoot, logLevel: 'silent',
  logRequireSeparateVolume: false, pm2Enabled: true, resendApiUrl: 'http://127.0.0.1:1/x',
} as Config;

async function main(): Promise<void> {
  const db = openDb(':memory:');
  migrate(db);
  const ctx = createContext({ config, db, log: createLogger('silent') });
  ctx.scheduler.register(pm2Collector({ link: ctx.pm2!, services: ctx.services, state: ctx.state, events: ctx.procEvents }));
  ctx.logs.writer.start();
  const poll = () => ctx.scheduler.runOnce('pm2');
  const status = () => ctx.scheduler.status().find((c) => c.name === 'pm2')!;
  const proc = (name: string) => ctx.state.getProcessStates().find((p) => p.pm2Name === name);

  console.log(`PM2_HOME=${pm2Home}`);

  // 1. Before any daemon exists: a clean error, and the monitor must not start a daemon itself.
  await poll();
  check('no daemon: collector reports a clear error', !!status().lastError && /not running|not reachable|ENOENT|ECONNREFUSED/i.test(status().lastError!), status().lastError);
  check('no daemon: the monitor did not start one', !fs.existsSync(path.join(pm2Home, 'rpc.sock')) && !fs.existsSync(path.join(pm2Home, 'pm2.pid')));

  // 2. Start the apps (this starts the daemon).
  pm2('start', path.join(tmp, 'chatty.js'), '--name', 'chatty');
  pm2('start', path.join(tmp, 'crasher.js'), '--name', 'crasher', '--restart-delay', '500');
  await sleep(500);

  const found = await until(async () => {
    await sleep(300);
    await poll();
    return ctx.state.getProcessStates().length >= 2;
  }, 40_000, 300);
  // Started after the monitor is connected: PM2's bus has no replay, so earlier output is only in PM2's own files.
  pm2('start', path.join(tmp, 'secret.js'), '--name', 'secretive');
  await until(async () => {
    await poll();
    return !!proc('secretive');
  }, 15_000, 500);
  check('services are discovered from PM2 names', found && ctx.state.getProcessStates().length === 3, JSON.stringify(ctx.state.getProcessStates().map((p) => p.pm2Name)) + ' ' + (status().lastError ?? ''));
  check('chatty is online', proc('chatty')?.status === 'online');
  check('services were registered in the database', ctx.services.list().length === 3, String(ctx.services.list().length));

  // 3. Logs flow through the bus into the pipeline.
  const gotLogs = await until(() => ctx.logs.pipeline.tail('chatty', 50).some((l) => l.msg.includes('chatty line')), 10_000);
  check('stdout lines arrive in the log pipeline', gotLogs);
  check('stderr lines are tagged err', await until(() => ctx.logs.pipeline.tail('chatty', 100, 'err').some((l) => l.msg.includes('chatty error')), 5_000));

  // 4. Crash behaviour: restarts counted, exit recorded with its code.
  const crashed = await until(async () => {
    await poll();
    return (proc('crasher')?.restarts ?? 0) >= 2 && proc('crasher')?.lastExit?.code === 3;
  }, 20_000, 500);
  check('crash loop: restarts counted and last exit code recorded', crashed, JSON.stringify(proc('crasher')));
  check('crasher stderr reached the log tail', ctx.logs.pipeline.tail('crasher', 100, 'err').some((l) => l.msg.includes('about to die')));
  ctx.persistence.flush();
  const exits = db.prepare("SELECT COUNT(*) AS n FROM process_events WHERE event = 'exit'").get() as { n: number };
  check('exit events were stored', exits.n >= 1, String(exits.n));

  // 5. Secrets in a process environment must not be copied anywhere.
  await until(() => ctx.logs.pipeline.tail('secretive', 10).length > 0, 5_000);
  await ctx.logs.writer.flushNow();
  const dump = JSON.stringify(ctx.state.getProcessStates()) + JSON.stringify(db.prepare('SELECT * FROM process_events').all()) + JSON.stringify(db.prepare('SELECT * FROM services').all());
  let onDisk = '';
  for (const f of fs.readdirSync(logRoot, { recursive: true }) as string[]) {
    const p = path.join(logRoot, f);
    if (fs.statSync(p).isFile()) onDisk += fs.readFileSync(p, 'utf8');
  }
  check('the environment secret is not in state, database or log files', !dump.includes(SECRET) && !onDisk.includes(SECRET));
  check('a log line about the secret exists but not the secret itself', onDisk.includes('has a secret: yes'));

  // 6. No duplicate delivery.
  const lines = ctx.logs.pipeline.tail('chatty', 1000).filter((l) => l.msg.startsWith('chatty line'));
  const keys = new Set(lines.map((l) => l.msg));
  check('no log line is delivered twice', keys.size === lines.length, `${keys.size} unique of ${lines.length}`);

  // 7. Kill the daemon: the monitor reports it and keeps its last view; nothing crashes.
  pm2('kill');
  await sleep(500);
  await poll();
  check('daemon killed: collector fails with a message', !!status().lastError, status().lastError ?? '');
  check('daemon killed: the monitor did not resurrect it', !fs.existsSync(path.join(pm2Home, 'rpc.sock')));
  check('daemon killed: the last known view is still there', ctx.state.getProcessStates().length === 3);

  // 8. Start it again: the monitor recovers by itself, and logs flow again.
  pm2('start', path.join(tmp, 'chatty.js'), '--name', 'chatty');
  const before = ctx.logs.pipeline.tail('chatty', 1000).length;
  const recovered = await until(async () => {
    await poll();
    return !status().lastError && proc('chatty')?.status === 'online';
  }, 45_000, 1000);
  check('daemon restarted: the monitor reconnects on its own (back-off up to 30 s)', recovered, status().lastError ?? '');
  const flowing = await until(() => ctx.logs.pipeline.tail('chatty', 5000).length > before, 10_000);
  check('daemon restarted: logs flow again over a fresh bus', flowing);
  check('daemon restarted: services that did not return show as stopped', proc('crasher')?.status === 'stopped' && proc('crasher')?.instances === 0);

  // 9. Archiving.
  const sid = ctx.services.getByPm2Name('crasher')!.id;
  ctx.services.update(sid, { isArchived: true }, new Set(ctx.state.getProcessStates().filter((p) => p.instances > 0).map((p) => p.pm2Name)));
  await poll();
  check('an archived service leaves the live view', !proc('crasher'));

  await ctx.pm2!.close();
  await ctx.logs.writer.stop();
}

main()
  .catch((e) => {
    check('script ran without throwing', false, e instanceof Error ? e.stack : String(e));
  })
  .finally(() => {
    try {
      pm2('kill');
    } catch {
      /* already stopped */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  });
