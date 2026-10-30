// The proxy's allowlist, run through the real HAProxy binary against a fake Docker socket
// (TRD 14.4: "every forbidden path returns 403"). Skipped where haproxy is not installed; CI
// installs it (apt `haproxy`, the same 2.8 series as the image).
//
//   node --test apps/docker-proxy/test/proxy.test.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const CFG = path.resolve(import.meta.dirname, '..', 'haproxy.cfg');
const haproxyBin = (() => {
  const r = spawnSync('haproxy', ['-v'], { encoding: 'utf8' });
  return r.status === 0 ? 'haproxy' : null;
})();

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** A Docker API stand-in on a unix socket: answers 200 and records what reached it. */
function fakeDocker(socket) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve) => server.listen(socket, () => resolve({ server, seen })));
}

async function startProxy({ allowActions }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-'));
  const socket = path.join(dir, 'docker.sock');
  const docker = await fakeDocker(socket);
  const port = await freePort();
  const cfg = fs
    .readFileSync(CFG, 'utf8')
    .replace('bind :2375', `bind 127.0.0.1:${port}`)
    .replace('server docker /var/run/docker.sock', `server docker ${socket}`);
  const cfgFile = path.join(dir, 'haproxy.cfg');
  fs.writeFileSync(cfgFile, cfg);
  const check = spawnSync(haproxyBin, ['-c', '-f', cfgFile], { encoding: 'utf8' });
  if (check.status !== 0) {
    await new Promise((r) => docker.server.close(r));
    assert.fail(`haproxy -c failed:\n${check.stdout}${check.stderr}`);
  }

  const proc = spawn(haproxyBin, ['-db', '-f', cfgFile], {
    env: { ...process.env, ALLOW_ACTIONS: allowActions ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (b) => (log += b));
  proc.stderr.on('data', (b) => (log += b));
  // Wait until it accepts connections.
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise((r) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.destroy();
        r(true);
      });
      s.on('error', () => r(false));
    });
    if (ok) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    base: `http://127.0.0.1:${port}`,
    seen: docker.seen,
    log: () => log,
    async stop() {
      proc.kill('SIGTERM');
      await new Promise((r) => proc.once('exit', r));
      await new Promise((r) => docker.server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A raw request, so paths reach the proxy exactly as written (fetch would normalise "..", "//"). */
function raw(base, method, p) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(port), hostname, () => {
      s.write(`${method} ${p} HTTP/1.1\r\nHost: docker\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    s.on('data', (b) => (buf += b));
    s.on('end', () => resolve(Number(/^HTTP\/1\.[01] (\d{3})/.exec(buf)?.[1] ?? 0)));
    s.on('error', reject);
  });
}

const ALLOWED_READS = [
  ['GET', '/_ping'],
  ['HEAD', '/_ping'],
  ['GET', '/version'],
  ['GET', '/v1.47/version'],
  ['GET', '/containers/json?all=1&filters=%7B%7D'],
  ['GET', '/v1.47/containers/json?all=1'],
  ['GET', '/containers/3f2a9c/stats?stream=false'],
  ['GET', '/v1.43/containers/acs-cpe-sim-1/stats?stream=false'],
  ['GET', '/containers/acs-api-1/logs?follow=1&stdout=1&stderr=1&timestamps=1'],
  ['GET', '/events?filters=%7B%22type%22%3A%5B%22container%22%5D%7D'],
];
const ACTIONS = [
  ['POST', '/containers/acs-cpe-sim-1/start'],
  ['POST', '/v1.47/containers/3f2a9c/stop?t=10'],
  ['POST', '/containers/acs-api-1/restart'],
];
const FORBIDDEN = [
  ['GET', '/containers/acs-api-1/json'], // inspect: every environment variable
  ['GET', '/v1.47/containers/acs-api-1/json'],
  ['GET', '/containers/acs-api-1/archive?path=/'],
  ['HEAD', '/containers/acs-api-1/archive?path=/etc'],
  ['PUT', '/containers/acs-api-1/archive?path=/'],
  ['GET', '/containers/acs-api-1/export'],
  ['GET', '/containers/acs-api-1/top'],
  ['GET', '/containers/acs-api-1/changes'],
  ['POST', '/containers/acs-api-1/exec'],
  ['POST', '/exec/abc/start'],
  ['POST', '/containers/create'],
  ['POST', '/containers/acs-api-1/attach?stream=1'],
  ['GET', '/containers/acs-api-1/attach/ws'],
  ['POST', '/containers/acs-api-1/kill'],
  ['POST', '/containers/acs-api-1/update'],
  ['POST', '/containers/acs-api-1/pause'],
  ['POST', '/containers/acs-api-1/rename?name=x'],
  ['POST', '/containers/acs-api-1/wait'],
  ['POST', '/containers/prune'],
  ['DELETE', '/containers/acs-api-1?force=1'],
  ['GET', '/containers/acs-api-1/stats/../json'],
  ['GET', '/containers/acs-api-1/../acs-api-1/json'],
  ['GET', '/containers/%2e%2e/json'],
  ['GET', '/containers/acs-api-1%2Fjson/stats'],
  ['GET', '//containers/json'],
  ['GET', '/containers//stats'],
  ['GET', '/containers/json/../../info'],
  ['GET', '/v1.47/info'],
  ['GET', '/info'],
  ['GET', '/system/df'],
  ['GET', '/images/json'],
  ['POST', '/images/create?fromImage=alpine'],
  ['GET', '/volumes'],
  ['GET', '/networks'],
  ['POST', '/build'],
  ['GET', '/swarm'],
  ['GET', '/secrets'],
  ['GET', '/configs'],
  ['GET', '/plugins'],
  ['POST', '/session'],
  ['GET', '/services'],
  ['GET', '/nodes'],
  ['GET', '/tasks'],
  ['POST', '/events'],
  ['POST', '/containers/json'],
  ['POST', '/containers/acs-api-1/stats'],
  ['GET', '/containers/acs-api-1/start'],
  ['PUT', '/containers/acs-api-1/start'],
  ['GET', '/vx/containers/json'],
  ['GET', '/v1.47/v1.47/containers/json'],
  ['GET', '/_ping/extra'],
  ['GET', '/'],
];

describe('cc-docker-proxy allowlist', { skip: haproxyBin ? false : 'haproxy is not installed' }, () => {
  describe('with ALLOW_ACTIONS=0 (the image default)', () => {
    let p;
    before(async () => (p = await startProxy({ allowActions: false })));
    after(async () => p?.stop());

    it('passes the reads the agent needs, without logging them', async () => {
      for (const [m, url] of ALLOWED_READS) assert.equal(await raw(p.base, m, url), 200, `${m} ${url}`);
      assert.equal(p.seen.length, ALLOWED_READS.length);
      assert.doesNotMatch(p.log(), /_ping|containers\/json|stats|events/);
    });

    it('refuses the three actions', async () => {
      for (const [m, url] of ACTIONS) assert.equal(await raw(p.base, m, url), 403, `${m} ${url}`);
    });

    it('answers 403 to every other path and method, and none of them reaches Docker', async () => {
      p.seen.length = 0;
      for (const [m, url] of FORBIDDEN) assert.equal(await raw(p.base, m, url), 403, `${m} ${url}`);
      assert.deepEqual(p.seen, []);
      assert.match(p.log(), /403/); // refusals are logged
    });
  });

  describe('with ALLOW_ACTIONS=1', () => {
    let p;
    before(async () => (p = await startProxy({ allowActions: true })));
    after(async () => p?.stop());

    it('passes start, stop and restart, and still refuses everything else', async () => {
      for (const [m, url] of ACTIONS) assert.equal(await raw(p.base, m, url), 200, `${m} ${url}`);
      p.seen.length = 0;
      for (const [m, url] of FORBIDDEN) assert.equal(await raw(p.base, m, url), 403, `${m} ${url}`);
      assert.deepEqual(p.seen, []);
    });
  });
});
