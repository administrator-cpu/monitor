// Starts a throwaway backend for the Playwright run: temp database, one admin, real collectors,
// a pretend Nginx/MongoDB and a real agent, a real PM2 daemon (in a throw-away PM2_HOME) with a chatty app and a crashing app, and a mock
// mail server standing in for Resend. Nothing here touches your own PM2 or sends real email.
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(here, '../../backend');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-'));
// PM2 talks over a unix socket, whose path is limited to about 100 characters: keep it short.
const pm2Home = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'ccpm-'));
const mailPort = Number(process.env.E2E_MAIL_PORT ?? 4101);

const sent = [];
const mail = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/__sent') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(sent));
    return;
  }
  if (req.method === 'POST' && req.url === '/emails') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const m = JSON.parse(body);
      sent.push({ to: m.to, subject: m.subject, from: m.from, auth: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: `mock_${sent.length}` }));
    });
    return;
  }
  res.statusCode = 404;
  res.end();
});
mail.listen(mailPort, '127.0.0.1');

const env = {
  ...process.env,
  NODE_ENV: 'development',
  BIND_HOST: '127.0.0.1',
  PORT_API: process.env.E2E_API_PORT ?? '4100',
  ALLOWED_ORIGINS: process.env.E2E_ORIGIN ?? 'http://127.0.0.1:3100',
  SQLITE_PATH: path.join(dir, 'monitor.db'),
  LOG_ROOT: path.join(dir, 'logs'),
  LOG_LEVEL: 'warn',
  CC_ADMIN_PASSWORD: process.env.E2E_PASSWORD ?? 'e2e test passphrase 1',
  PM2_ENABLED: 'true',
  PM2_HOME: pm2Home,
  LOG_REQUIRE_SEPARATE_VOLUME: 'false',
  RESEND_API_KEY: 're_e2e_not_a_real_key',
  RESEND_API_URL: `http://127.0.0.1:${mailPort}/emails`,
  ALERT_FROM: 'Command Center <alerts@example.com>',
  PUBLIC_DASHBOARD_URL: process.env.E2E_ORIGIN ?? 'http://127.0.0.1:3100',
  // Phases 6-9: a pretend Nginx, MongoDB and an agent inside a small server (see scripts/demo-server.ts).
  DEMO_DIR: path.join(dir, 'demo'),
  DEMO_NGINX_PORT: '4120',
  PORT_INGEST: '4121',
  INGEST_TOKEN: 'e2e-ingest-token-0123456789abcdef',
  DEMO_AGENT_SERVICE: 'chatty',
  DEMO_AGENT_INTERVAL_MS: '1500',
  // Phase 11 M2: the demo's second host (ubuntu-acs, reported by the real node agent). cpe-sim
  // stays down from the start, so the host switcher test sees one stopped container.
  DEMO_HOST_NAME: 'ubuntu-acs',
  DEMO_FLAP_S: '0',
  DEMO_CPE_DOWN: '1',
};
const pm2Bin = path.join(backend, 'node_modules/pm2/bin/pm2');
const pm2 = (...args) => spawnSync(process.execPath, [pm2Bin, ...args], { env, stdio: 'inherit' });
pm2('start', path.join(here, 'apps/chatty.js'), '--name', 'chatty');
pm2('start', path.join(here, 'apps/crasher.js'), '--name', 'crasher', '--restart-delay', '300');
const tsx = path.join(backend, 'node_modules/.bin/tsx');

const seed = spawnSync(
  tsx,
  ['src/create-admin.ts', '--username', 'owner', '--email', 'owner@example.com', '--name', 'Owner'],
  { cwd: backend, env, stdio: 'inherit' },
);
if (seed.status !== 0) process.exit(seed.status ?? 1);

const server = spawn(tsx, ['scripts/demo-server.ts'], { cwd: backend, env, stdio: 'inherit' });
const stop = () => {
  server.kill('SIGTERM');
  pm2('kill');
  mail.close();
  setTimeout(() => process.exit(0), 6_000); // safety net if the backend does not exit
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
server.on('exit', (code) => {
  pm2('kill');
  fs.rmSync(pm2Home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code ?? 0);
});
