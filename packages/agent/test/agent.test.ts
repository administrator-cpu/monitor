import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { agentReportSchema } from '@cc/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { attachWs, createMonitor, identity } from '../src';
import { RuntimeProbe } from '../src/runtime';
import { percentile, Reservoir } from '../src/stats';
import { ActiveUsers } from '../src/users';
import { Metrics, MAX_TENANTS } from '../src/window';

describe('percentile and reservoir', () => {
  it('uses nearest rank', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([5], 95)).toBe(5);
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
  });

  it('stays bounded under a burst but counts everything', () => {
    const r = new Reservoir(100);
    for (let i = 0; i < 10_000; i++) r.add(i);
    expect(r.count).toBe(10_000);
    expect(r.percentile(50)).toBeGreaterThan(2000);
    expect(r.percentile(50)).toBeLessThan(8000);
  });
});

describe('ActiveUsers', () => {
  it('counts distinct users in the window and forgets old ones', () => {
    const u = new ActiveUsers(1000);
    u.touch('a', 0);
    u.touch('b', 100);
    u.touch('a', 200);
    expect(u.count(300)).toBe(2);
    expect(u.count(1100)).toBe(1); // b (100) expired at 1100, a (200) still inside
    expect(u.count(1300)).toBe(0);
  });

  it('stops adding past the cap instead of growing', () => {
    const u = new ActiveUsers(10_000, 3);
    ['a', 'b', 'c', 'd', 'e'].forEach((id) => u.touch(id, 0));
    expect(u.count(1)).toBe(3);
  });
});

describe('Metrics', () => {
  it('reports window counts, resets them, and keeps levels', () => {
    const m = new Metrics();
    m.recordRequest(200, 10, 'acme', 'u1', 1000);
    m.recordRequest(500, 30, 'acme', 'u2', 1001);
    m.recordRequest(200, 20, 'globex', 'u3', 1002);
    m.socketOpened('acme');
    m.socketOpened('acme');
    m.socketOpened('globex');
    const a = m.collect(2000);
    expect(a.http).toMatchObject({ req_count: 3, err5xx_count: 1 });
    expect(a.sockets).toBe(3);
    const acme = a.tenants.find((t) => t.key === 'acme')!;
    expect(acme).toMatchObject({ sockets: 2, active_users_5m: 2, req_count: 2, p95_ms: 30 });
    const b = m.collect(3000);
    expect(b.http.req_count).toBe(0);
    expect(b.sockets).toBe(3); // sockets are a level
    expect(b.tenants.find((t) => t.key === 'acme')!.active_users_5m).toBe(2); // so are active users
    m.socketClosed('acme');
    m.socketClosed('acme');
    m.socketClosed('acme'); // extra close never goes negative
    expect(m.openSockets).toBe(1);
  });

  it('files unresolved traffic under _unknown', () => {
    const m = new Metrics();
    m.recordRequest(200, 1, undefined, undefined, 0);
    m.recordRequest(200, 1, '', null, 0);
    expect(m.collect(1).tenants).toMatchObject([{ key: '_unknown', req_count: 2, active_users_5m: 0 }]);
  });

  it('caps tenants at 50 plus _other, keeping the busiest by active users', () => {
    const m = new Metrics();
    for (let i = 0; i < 80; i++) for (let u = 0; u <= i; u++) m.recordRequest(200, 1, `t${i}`, `u${i}-${u}`, 0);
    const r = m.collect(1);
    expect(r.truncated).toBe(true);
    expect(r.tenants).toHaveLength(MAX_TENANTS + 1);
    expect(r.tenants[0]!.key).toBe('t79');
    const other = r.tenants.find((t) => t.key === '_other')!;
    const total = r.tenants.reduce((a, t) => a + t.req_count, 0);
    expect(total).toBe(Array.from({ length: 80 }, (_, i) => i + 1).reduce((a, b) => a + b, 0));
    expect(other.active_users_5m).toBe(Array.from({ length: 30 }, (_, i) => i + 1).reduce((a, b) => a + b, 0));
  });

  it('never exposes user identifiers in what it collects', () => {
    const m = new Metrics();
    m.recordRequest(200, 1, 'acme', 'alice@example.com', 0);
    expect(JSON.stringify(m.collect(1))).not.toContain('alice');
  });
});

describe('RuntimeProbe', () => {
  it('reports about zero lag on an idle loop and sees a blocked loop', async () => {
    const probe = new RuntimeProbe();
    probe.start();
    await new Promise((r) => setTimeout(r, 300));
    const idle = probe.read();
    expect(idle.event_loop_lag_ms.p95).toBeLessThan(15);
    // Block the loop for 250 ms while the histogram is running.
    await new Promise((r) => setTimeout(r, 30));
    const end = Date.now() + 250;
    while (Date.now() < end) { /* busy */ }
    await new Promise((r) => setTimeout(r, 50));
    const blocked = probe.read();
    expect(blocked.event_loop_lag_ms.max).toBeGreaterThan(150);
    expect(blocked.event_loop_lag_ms.max).toBeLessThan(600);
    expect(blocked.rss_bytes).toBeGreaterThan(0);
    expect(blocked.heap_used_bytes).toBeGreaterThan(0);
    probe.stop();
  });
});

describe('identity', () => {
  it('reads the PM2 name and instance', () => {
    expect(identity({ name: 'billing-api', pm_id: '3' } as never)).toEqual({ service: 'billing-api', pm: 3 });
    expect(identity({ name: 'x', NODE_APP_INSTANCE: '1' } as never)).toEqual({ service: 'x', pm: 1 });
    expect(identity({} as never)).toEqual({ service: 'unknown', pm: -1 });
  });
});

describe('monitor', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  async function receiver() {
    const got: { headers: http.IncomingHttpHeaders; body: unknown; url?: string }[] = [];
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        got.push({ headers: req.headers, body: JSON.parse(b), url: req.url });
        res.statusCode = 204;
        res.end();
      });
    });
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    return { got, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/ingest/v1/agent` };
  }
  const until = async (fn: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return fn();
  };

  it('measures requests through the middleware and sends a report the backend schema accepts', async () => {
    const rx = await receiver();
    const monitor = createMonitor({ token: 'k'.repeat(30), service: 'billing-api', url: rx.url, intervalMs: 60_000 });
    monitor.tenantResolver((req) => ({ tenantId: req.headers['x-tenant'] as string, userId: req.headers['x-user'] as string }));
    const mw = monitor.middleware();
    const app = http.createServer((req, res) => {
      mw(req, res, () => {
        res.statusCode = req.url === '/boom' ? 500 : 200;
        res.end('x');
      });
    });
    servers.push(app);
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    await fetch(`${base}/a`, { headers: { 'x-tenant': 'acme', 'x-user': 'alice@example.com' } });
    await fetch(`${base}/b`, { headers: { 'x-tenant': 'acme', 'x-user': 'bob@example.com' } });
    await fetch(`${base}/boom`, { headers: { 'x-tenant': 'globex' } });
    monitor.socketOpened('acme', 'alice@example.com');
    await until(() => false, 50); // let 'finish' handlers run
    monitor.flush();
    expect(await until(() => rx.got.length === 1)).toBe(true);
    monitor.stop();

    const sent = rx.got[0]!;
    expect(sent.headers['x-monitor-token']).toBe('k'.repeat(30));
    const parsed = agentReportSchema.parse(sent.body);
    expect(parsed.service).toBe('billing-api');
    expect(parsed.http).toMatchObject({ req_count: 3, err5xx_count: 1 });
    expect(parsed.sockets.open).toBe(1);
    expect(parsed.tenants.find((t) => t.key === 'acme')).toMatchObject({ active_users_5m: 2, req_count: 2, sockets: 1 });
    expect(parsed.runtime.heap_used_bytes).toBeGreaterThan(0);
    expect(JSON.stringify(sent.body)).not.toMatch(/alice|bob/);
  });

  it('survives a resolver that throws and a monitor that is down', async () => {
    const monitor = createMonitor({ token: 'k'.repeat(30), service: 's', url: 'http://127.0.0.1:1/x', intervalMs: 60_000 });
    monitor.tenantResolver(() => {
      throw new Error('boom');
    });
    const mw = monitor.middleware();
    const app = http.createServer((req, res) => mw(req, res, () => res.end('ok')));
    servers.push(app);
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    const r = await fetch(`http://127.0.0.1:${(app.address() as AddressInfo).port}/`);
    expect(r.status).toBe(200);
    monitor.flush();
    expect(await until(() => monitor.stats().failed === 1)).toBe(true);
    monitor.stop();
  });

  it('gives up on a monitor that never answers within about a second', async () => {
    const hang = http.createServer(() => undefined);
    servers.push(hang);
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
    const monitor = createMonitor({ token: 'k'.repeat(30), service: 's', url: `http://127.0.0.1:${(hang.address() as AddressInfo).port}/x`, intervalMs: 60_000 });
    const t0 = Date.now();
    monitor.flush();
    expect(await until(() => monitor.stats().failed === 1, 4000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2500);
    monitor.stop();
    hang.closeAllConnections?.();
  });

  it('is a complete no-op when disabled', async () => {
    const rx = await receiver();
    const monitor = createMonitor({ token: 'k'.repeat(30), service: 's', url: rx.url, enabled: false });
    let nexted = false;
    monitor.middleware()({} as never, {} as never, () => (nexted = true));
    monitor.socketOpened('a');
    monitor.flush();
    expect(nexted).toBe(true);
    expect(monitor.stats().enabled).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(rx.got).toHaveLength(0);
  });

  it('counts sockets through the ws adapter', () => {
    const monitor = createMonitor({ token: 'k'.repeat(30), service: 's', url: 'http://127.0.0.1:1/x', intervalMs: 60_000 });
    let onConn!: (s: { on(e: string, cb: () => void): void }, req: unknown) => void;
    const closers: (() => void)[] = [];
    attachWs(monitor, { on: (_e, cb) => void (onConn = cb as never) }, (req) => ({ tenantId: (req as { t: string }).t }));
    onConn({ on: (_e, cb) => void closers.push(cb) }, { t: 'acme' });
    onConn({ on: (_e, cb) => void closers.push(cb) }, { t: 'acme' });
    monitor.flush();
    closers[0]!();
    closers[0]!(); // a second 'close' is ignored
    monitor.stop();
    expect(closers).toHaveLength(2);
  });
});
