/**
 * Phase 6-9 demo: the real backend with believable data for the parts that need infrastructure
 * you may not have on this machine. Nothing here touches real Nginx, MongoDB or your services.
 *
 *   pnpm --filter @cc/agent build
 *   pnpm --filter @cc/backend demo
 *
 * What it adds around the normal backend:
 *   - a stub_status page and a growing JSON access log, as Nginx would write them (traffic for
 *     "chatty.example.com", some 404s and the odd 500, plus a host that matches no service);
 *   - a pretend MongoDB (standalone or replica set, a running operation, new slow queries);
 *   - a real agent (@cc/agent) inside a small HTTP server, with three tenants and some sockets,
 *     reporting to the backend's ingest port as the service named by DEMO_AGENT_SERVICE.
 *
 * Environment: the same variables as the backend (SQLITE_PATH, LOG_ROOT, ALLOWED_ORIGINS, PORT_API...).
 * Extra: DEMO_NGINX_PORT (4120), DEMO_AGENT_SERVICE (chatty), DEMO_AGENT_INTERVAL_MS (5000),
 * DEMO_LONG_OP=1 (a Mongo operation that has been running for 90 s), DEMO_REPL=1 (replica set).
 */
import dotenv from 'dotenv';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config';
import { start } from '../src';
import type { MongoSource, RawOp, RawProfile, RawReplMember, RawServerStatus } from '../src/mongo/source';

dotenv.config({ path: process.env.CC_ENV_FILE, quiet: true });

const dir = process.env.DEMO_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cc-demo-'));
fs.mkdirSync(dir, { recursive: true });
const accessLog = path.join(dir, 'access.json');
fs.writeFileSync(accessLog, '');
const nginxPort = Number(process.env.DEMO_NGINX_PORT ?? 4120);
const agentService = process.env.DEMO_AGENT_SERVICE ?? 'chatty';
const agentInterval = Math.max(1000, Number(process.env.DEMO_AGENT_INTERVAL_MS ?? 5000));
const token = process.env.INGEST_TOKEN ?? 'demo-ingest-token-0123456789abcdef';

process.env.NGINX_STATUS_URL ??= `http://127.0.0.1:${nginxPort}/nginx_status`;
process.env.NGINX_ACCESS_LOG ??= accessLog;
process.env.INGEST_TOKEN = token;
process.env.MONGO_URI ??= 'mongodb://demo:demo@127.0.0.1:1/admin'; // never contacted: the pretend source is used
process.env.MONGO_PROFILE_DBS ??= 'app';
process.env.PORT_INGEST ??= '4121';

// --- pretend Nginx -------------------------------------------------------------------------------
let handled = 1000;
const stub = http.createServer((req, res) => {
  if (req.url !== '/nginx_status') {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader('content-type', 'text/plain');
  res.end(`Active connections: 12 \nserver accepts handled requests\n ${handled} ${handled} ${handled}\nReading: 0 Writing: 2 Waiting: 10 \n`);
});
stub.listen(nginxPort, '127.0.0.1');

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
const traffic = setInterval(() => {
  const n = 8 + Math.floor(Math.random() * 12);
  let out = '';
  for (let i = 0; i < n; i++) {
    const unattributed = Math.random() < 0.1;
    const r = Math.random();
    const status = r < 0.88 ? 200 : r < 0.95 ? 404 : r < 0.97 ? 304 : 500;
    out +=
      JSON.stringify({
        t: new Date().toISOString(),
        ip: `203.0.113.${1 + Math.floor(Math.random() * 40)}`,
        host: unattributed ? 'other.example.com' : 'chatty.example.com',
        method: pick(['GET', 'GET', 'GET', 'POST']),
        uri: pick(['/v1/orders?id=42', '/v1/orders', '/v1/users/me', '/health', '/static/app.js']),
        status,
        bytes: Math.floor(200 + Math.random() * 5000),
        rt: Math.round((0.01 + Math.random() * 0.2) * 1000) / 1000,
        up: '127.0.0.1:3001',
      }) + '\n';
  }
  fs.appendFileSync(accessLog, out);
  handled += n;
}, 1000);

// --- pretend MongoDB -----------------------------------------------------------------------------
class DemoMongo implements MongoSource {
  private ops = { insert: 0, query: 0, update: 0, delete: 0, getmore: 0, command: 0 };
  private slow: RawProfile[] = [];
  private started = Date.now();
  constructor(private readonly replica: boolean, private readonly longOp: boolean) {
    setInterval(() => {
      this.slow.push({
        ts: Date.now(), ns: 'app.orders', op: 'query', millis: 150 + Math.floor(Math.random() * 600), planSummary: 'COLLSCAN',
        docsExamined: 20_000, keysExamined: 0, nreturned: 3, appName: agentService,
        command: { find: 'orders', filter: { customerEmail: 'someone@example.com', status: 'open' } },
      });
    }, 20_000).unref();
  }
  async ping(): Promise<number> { return 2 + Math.random() * 3; }
  async serverStatus(): Promise<RawServerStatus> {
    for (const key of Object.keys(this.ops) as (keyof typeof this.ops)[]) this.ops[key] += Math.floor(Math.random() * 30) + (key === 'query' ? 40 : 0);
    return { version: '7.0.14', connections: { current: 22 + Math.floor(Math.random() * 6), available: 800 }, opcounters: { ...this.ops }, residentMb: 1450 };
  }
  async replSetStatus(): Promise<RawReplMember[] | null> {
    if (!this.replica) return null;
    const now = Date.now();
    return [{ stateStr: 'PRIMARY', optimeDate: now }, { stateStr: 'SECONDARY', self: true, optimeDate: now - 2000 }];
  }
  async storageSize(): Promise<number> { return 5_400_000_000; }
  async currentOps(): Promise<RawOp[]> {
    return this.longOp ? [{ opid: 4242, ns: 'app.reports', op: 'query', secsRunning: 90, planSummary: 'COLLSCAN', appName: 'reporting' }] : [];
  }
  async slowQueries(db: string, since: number, limit: number): Promise<RawProfile[]> {
    return db === 'app' ? this.slow.filter((p) => Number(p.ts) > since).slice(0, limit) : [];
  }
  async close(): Promise<void> {}
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const running = await start(config, { mongoSource: new DemoMongo(process.env.DEMO_REPL === '1', process.env.DEMO_LONG_OP === '1') });
  const { ctx } = running;

  // Make sure the service exists (PM2 would normally list it) and that its gateway host is set.
  const svc = ctx.services.discover(agentService);
  if (!svc.nginx_match) ctx.services.update(svc.id, { nginxMatch: 'chatty.example.com' }, new Set());

  // --- a real agent in a small server ------------------------------------------------------------
  const { createMonitor } = await import('@cc/agent');
  const monitor = createMonitor({
    token,
    service: agentService,
    url: `http://127.0.0.1:${running.ingestPort}/ingest/v1/agent`,
    intervalMs: agentInterval,
    tenantResolver: (req) => ({ tenantId: req.headers['x-tenant'] as string, userId: req.headers['x-user'] as string }),
  });
  const mw = monitor.middleware();
  const app = http.createServer((req, res) => {
    mw(req, res, () => setTimeout(() => { res.statusCode = Math.random() < 0.03 ? 500 : 200; res.end('ok'); }, Math.random() * 40));
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  const port = (app.address() as { port: number }).port;
  const tenants = [['acme', 30], ['globex', 12], ['initech', 5]] as const;
  for (const [t, n] of tenants) for (let i = 0; i < n; i++) monitor.socketOpened(t, `${t}-socket-user-${i}`);
  const load = setInterval(() => {
    const [t, n] = pick(tenants);
    void fetch(`http://127.0.0.1:${port}/x`, { headers: { 'x-tenant': t, 'x-user': `${t}-user-${Math.floor(Math.random() * n)}` } }).catch(() => undefined);
  }, 120);

  ctx.log.info({ api: `http://127.0.0.1:${config.portApi}`, ingest: running.ingestPort, nginx: nginxPort, agentService }, 'demo ready');
  const stop = async (): Promise<void> => {
    clearInterval(load);
    clearInterval(traffic);
    monitor.stop();
    stub.close();
    app.close();
    await running.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
