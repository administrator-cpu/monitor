// Measures what the agent adds to each request. Run with: pnpm --filter @cc/agent bench
// Nothing here talks to a real monitor: the report endpoint is a local sink.
import http from 'node:http';
import { createMonitor } from '../dist/index.js';
import { Metrics } from '../dist/window.js';

const REQUESTS = 20000;
const CONCURRENCY = 50;
const ROUNDS = 5;

function startServer(mw) {
  const srv = http.createServer((req, res) => {
    const handle = () => {
      res.statusCode = 200;
      res.end('ok');
    };
    if (mw) mw(req, res, handle);
    else handle();
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

async function load(port) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });
  let sent = 0;
  const t0 = process.hrtime.bigint();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (sent < REQUESTS) {
        sent += 1;
        await new Promise((resolve, reject) => {
          const r = http.get({ port, host: '127.0.0.1', agent, headers: { 'x-tenant': `t${sent % 20}`, 'x-user': `u${sent % 500}` } }, (res) => {
            res.resume();
            res.on('end', resolve);
          });
          r.on('error', reject);
        });
      }
    }),
  );
  agent.destroy();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function measure(withAgent) {
  let monitor = null;
  if (withAgent) {
    monitor = createMonitor({ token: 'b'.repeat(32), service: 'bench', url: 'http://127.0.0.1:1/x', intervalMs: 5000 });
    monitor.tenantResolver((req) => ({ tenantId: req.headers['x-tenant'], userId: req.headers['x-user'] }));
  }
  const srv = await startServer(monitor ? monitor.middleware() : null);
  const port = srv.address().port;
  await load(port); // warm-up
  const times = [];
  for (let i = 0; i < ROUNDS; i++) times.push(await load(port));
  srv.closeAllConnections();
  await new Promise((r) => srv.close(r));
  monitor?.stop();
  return median(times);
}

const base = await measure(false);
const withAgent = await measure(true);
const perReqUs = ((withAgent - base) / REQUESTS) * 1000;
console.log(`baseline          ${base.toFixed(0)} ms for ${REQUESTS} requests (${Math.round((REQUESTS / base) * 1000)} req/s)`);
console.log(`with agent        ${withAgent.toFixed(0)} ms for ${REQUESTS} requests (${Math.round((REQUESTS / withAgent) * 1000)} req/s)`);
console.log(`added per request ${perReqUs.toFixed(1)} us (includes load-generator noise)`);

// The agent's own work, without the HTTP stack around it.
const m = new Metrics();
const N = 1_000_000;
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) m.recordRequest(200, 12.5, `t${i % 20}`, `u${i % 500}`, Date.now());
const direct = Number(process.hrtime.bigint() - t0) / 1e3 / N;
console.log(`recordRequest     ${direct.toFixed(2)} us per call (${N} calls)`);
console.log(`memory            heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB after the run`);

// A budget generous enough to be stable on a loaded CI machine, tight enough to catch an accident.
const BUDGET_US = 25;
if (direct > BUDGET_US) {
  console.error(`FAIL: recordRequest costs ${direct.toFixed(2)} us, over the ${BUDGET_US} us budget`);
  process.exit(1);
}
console.log(`PASS: recordRequest is within the ${BUDGET_US} us budget`);
