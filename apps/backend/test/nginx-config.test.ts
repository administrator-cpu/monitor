import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The Nginx configuration in docs/runbook-nginx.md (H8) is what the owner pastes onto the server.
 * This takes the two ```nginx blocks from that file as they are, checks them with `nginx -t`, runs
 * them in front of a stub backend and checks the limits. Skipped where nginx is not installed.
 */
const RUNBOOK = path.resolve(__dirname, '../../../docs/runbook-nginx.md');

const nginxBin = (() => {
  for (const c of ['nginx', '/usr/sbin/nginx']) {
    try {
      execFileSync(c, ['-v'], { stdio: 'ignore' });
      return c;
    } catch {
      // try the next one
    }
  }
  return null;
})();

function blocks(): { zones: string; server: string } {
  const md = fs.readFileSync(RUNBOOK, 'utf8');
  const found = [...md.matchAll(/```nginx\n([\s\S]*?)```/g)].map((m) => m[1]!);
  if (found.length !== 2) throw new Error(`expected 2 nginx blocks in the runbook, found ${found.length}`);
  return { zones: found[0]!, server: found[1]! };
}

describe.skipIf(!nginxBin)('Nginx configuration in the runbook (H8)', () => {
  let dir = '';
  let base = '';
  let stub: http.Server;
  let started = false;

  const conf = () => path.join(dir, 'nginx.conf');
  const nginx = (...args: string[]) =>
    execFileSync(nginxBin!, ['-p', dir, '-e', path.join(dir, 'error.log'), '-c', conf(), ...args], { encoding: 'utf8', stdio: 'pipe' });

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-nginx-'));
    stub = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    const backend = (stub.address() as AddressInfo).port;

    // A free port for Nginx: take one from the OS, then release it.
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    base = `http://127.0.0.1:${port}`;

    const { zones, server } = blocks();
    const local = server
      .replace(/listen 443 ssl;/, `listen 127.0.0.1:${port};`)
      .replaceAll('127.0.0.1:4111', `127.0.0.1:${backend}`);
    const tmp = path.join(dir, 'tmp');
    fs.mkdirSync(tmp);
    fs.writeFileSync(
      conf(),
      `worker_processes 1;
pid ${path.join(dir, 'nginx.pid')};
error_log ${path.join(dir, 'error.log')} warn;
events { worker_connections 64; }
http {
  access_log off;
  client_body_temp_path ${tmp}; proxy_temp_path ${tmp}; fastcgi_temp_path ${tmp}; uwsgi_temp_path ${tmp}; scgi_temp_path ${tmp};
${zones}
${local}
}
`,
    );
  });

  afterAll(async () => {
    if (started) {
      try {
        nginx('-s', 'stop');
      } catch {
        // already gone
      }
    }
    await new Promise<void>((r) => stub.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const hit = async (p: string, init: RequestInit = {}) => {
    const r = await fetch(base + p, { method: 'POST', ...init });
    return { status: r.status, headers: r.headers, body: await r.text() };
  };

  it('passes nginx -t', () => {
    expect(() => nginx('-t')).not.toThrow();
  });

  it('limits log search with a JSON 429 the dashboard can read, without counting preflights', async () => {
    nginx();
    started = true;
    await new Promise((r) => setTimeout(r, 300));

    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await hit('/api/v1/logs/search')).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 429, 429]);

    const r = await hit('/api/v1/logs/search');
    expect(r.status).toBe(429);
    expect(JSON.parse(r.body)).toMatchObject({ error: 'rate_limited', message: expect.any(String) });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://monitor.thediv.in');
    expect(r.headers.get('access-control-allow-credentials')).toBe('true');

    for (let i = 0; i < 5; i++) expect((await hit('/api/v1/logs/search', { method: 'OPTIONS' })).status).toBe(200);
    expect((await hit('/api/v1/services', { method: 'GET' })).status).toBe(200);
  });

  it('limits webhooks after the burst and refuses large bodies', async () => {
    const big = await fetch(`${base}/webhooks/resend`, { method: 'POST', body: 'x'.repeat(300_000) });
    expect(big.status).toBe(413);
    const statuses: number[] = [];
    for (let i = 0; i < 64; i++) statuses.push((await hit('/webhooks/resend', { body: '{}' })).status);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(60);
    expect(statuses.at(-1)).toBe(429);
  });

  it('answers the auth limit in JSON too', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await hit('/api/v1/auth/login')).status;
    expect(last).toBe(429);
    expect(JSON.parse((await hit('/api/v1/auth/login')).body)).toMatchObject({ error: 'rate_limited' });
  });
});
