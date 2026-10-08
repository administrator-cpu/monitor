// End-to-end check of the compiled watchdog: real process, fake target, mock Resend.
// Uses short timings so the whole run takes about 15 seconds. Never touches production.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeTarget } from '../tools/fake-target.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'smoke-token-smoke-token-smoke-token-1234';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) failed += 1;
};

const sent = [];
const resend = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    sent.push({ body: JSON.parse(b), key: req.headers['idempotency-key'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `mock_${sent.length}` }));
  });
});
resend.listen(0, '127.0.0.1');
await once(resend, 'listening');

const target = await startFakeTarget(0);
const port = 4250 + Math.floor(Math.random() * 500);
const child = spawn(process.execPath, [join(root, 'dist/server.js')], {
  env: {
    PATH: process.env.PATH,
    TARGET_URL: `http://127.0.0.1:${target.port}/`,
    CRON_TOKEN: TOKEN,
    RESEND_API_KEY: 're_smoke',
    RESEND_API_URL: `http://127.0.0.1:${resend.address().port}/emails`,
    ALERT_FROM: 'watchdog@example.com',
    ALERT_TO: 'ops@example.com',
    PORT: String(port),
    ATTEMPTS: '2',
    ATTEMPT_DELAY_MS: '100',
    ATTEMPT_TIMEOUT_MS: '500',
    REMINDER_AFTER_MS: '2500',
    FLAP_WINDOW_MS: '3000',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`${base}/`)).ok) break;
  } catch {}
  await sleep(100);
}
const ping = async () => {
  const r = await fetch(`${base}/ping`, { headers: { 'x-cron-token': TOKEN } });
  const j = await r.json();
  await sleep(700); // let the background check finish
  return j;
};
const subjects = () => sent.map((m) => m.body.subject);

try {
  check('GET / answers ok', (await (await fetch(`${base}/`)).text()) === 'ok');
  check('/ping without token is refused', (await fetch(`${base}/ping`)).status === 401);

  await ping();
  check('healthy target sends no email', sent.length === 0);

  target.setMode('bad');
  await ping();
  check('bad response sends one DOWN email', sent.length === 1 && /DOWN/.test(subjects()[0]), subjects().join(' | '));
  await ping();
  check('second failing check does not send another', sent.length === 1);

  await sleep(2600);
  await ping();
  check('reminder after the reminder interval', sent.length === 2 && /STILL DOWN/.test(subjects()[1]), subjects().join(' | '));

  target.setMode('ok');
  await ping();
  check('one success is not recovery yet', sent.length === 2);
  await ping();
  check('two successes send RECOVERED', sent.length === 3 && /RECOVERED/.test(subjects()[2]), subjects().join(' | '));

  target.setMode('down');
  await ping();
  check('flap while recovering sends no new DOWN email', sent.length === 3, subjects().join(' | '));
  target.setMode('ok');
  await ping();
  await ping();
  check('at most 3 emails for the whole outage', sent.length === 3, subjects().join(' | '));

  check('every email has a distinct idempotency key', new Set(sent.map((m) => m.key)).size === sent.length);
  check('no secret in any email', !JSON.stringify(sent).includes(TOKEN) && !JSON.stringify(sent).includes('re_smoke'));
} finally {
  child.kill('SIGTERM');
  await target.close();
  resend.close();
}
console.log(failed === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
