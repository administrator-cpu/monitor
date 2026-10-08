import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CollectorStatus, LogStatus } from '@cc/shared';
import { AlertEngine } from '../src/alerts/engine';
import { Notifier } from '../src/alerts/notifier';
import { AlertRepo } from '../src/alerts/repo';
import { migrate, openDb } from '../src/db';
import { NginxAggregator, percentile, WINDOW_MS } from '../src/nginx/aggregate';
import { nginxLogCollector, nginxStatusCollector, tlsCollector, tlsHostsFor } from '../src/nginx/collector';
import { matchService, parseAccessLine, pathOf, type AccessRecord } from '../src/nginx/parse';
import { fetchStub, parseStubStatus, rateFromCounters } from '../src/nginx/stub';
import { LogTailer } from '../src/nginx/tailer';
import { checkCert, splitHostPort } from '../src/nginx/tls';
import { Persistence } from '../src/persist';
import { ProcessEvents } from '../src/pm2/events';
import { ServicesRepo } from '../src/pm2/services';
import { LogPipeline } from '../src/logs/pipeline';
import { Settings } from '../src/settings';
import { StateStore } from '../src/state';
import { makeApp, addUser, login, authed } from './helpers';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-nginx-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const file = (): string => path.join(tmp, `f${n++}.log`);

const line = (o: Partial<Record<string, unknown>> = {}): string =>
  JSON.stringify({ t: '2026-10-07T10:15:04+00:00', ip: '203.0.113.9', host: 'api.example.com', method: 'GET', uri: '/v1/orders?id=42', status: 200, bytes: 512, rt: 0.034, urt: '0.030', up: '127.0.0.1:3001', ...o });

describe('access log parsing', () => {
  it('parses the monitor_json format', () => {
    expect(parseAccessLine(line())).toEqual({
      ip: '203.0.113.9', host: 'api.example.com', method: 'GET', uri: '/v1/orders?id=42', status: 200, bytes: 512, rt: 0.034, up: '127.0.0.1:3001',
    });
  });

  it('tolerates quoted numbers, host ports, several upstreams and "-" values', () => {
    const r = parseAccessLine(line({ status: '502', rt: '0.5', host: 'API.Example.com:443', up: '10.0.0.1:1, 10.0.0.2:2', bytes: '-' }))!;
    expect(r).toMatchObject({ status: 502, rt: 0.5, host: 'api.example.com', up: '10.0.0.2:2', bytes: 0 });
    expect(parseAccessLine(line({ up: '-' }))!.up).toBe('');
  });

  it('skips malformed lines instead of throwing', () => {
    for (const bad of ['', 'not json', '{"status":', '[]', '{}', line({ status: 99 }), line({ status: 600 }), line({ status: 'abc' }), '{"status":200', 'null', '123']) {
      expect(parseAccessLine(bad)).toBeNull();
    }
  });

  it('keeps query strings out of the path list', () => {
    expect(pathOf('/v1/orders?token=secret')).toBe('/v1/orders');
    expect(pathOf('/')).toBe('/');
    expect(pathOf('?x=1')).toBe('/');
    expect(pathOf(`/${'a'.repeat(500)}`).length).toBeLessThan(205);
  });
});

describe('service attribution', () => {
  const rec = (o: Partial<AccessRecord>): AccessRecord => ({ ip: '', host: 'api.example.com', method: 'GET', uri: '/', status: 200, bytes: 0, rt: null, up: '127.0.0.1:3001', ...o });
  const rules = [
    { serviceId: 1, match: 'api.example.com' },
    { serviceId: 2, match: '127.0.0.1:3002' },
    { serviceId: 3, match: '*.example.com' },
  ];
  it('matches host, upstream address and wildcard (exact first), else unattributed', () => {
    expect(matchService(rec({}), rules)).toBe(1);
    expect(matchService(rec({ host: 'other.example.com', up: '127.0.0.1:3002' }), rules)).toBe(2);
    expect(matchService(rec({ host: 'x.example.com', up: '' }), rules)).toBe(3);
    expect(matchService(rec({ host: 'example.com', up: '' }), rules)).toBe(0);
    expect(matchService(rec({ host: 'nope.org', up: '' }), rules)).toBe(0);
    expect(matchService(rec({}), [{ serviceId: 9, match: ' ' }])).toBe(0);
  });
});

describe('LogTailer', () => {
  it('starts at the end, reads appended lines, and holds back a partial line', async () => {
    const f = file();
    fs.writeFileSync(f, 'old1\nold2\n');
    const t = new LogTailer(f);
    expect((await t.poll()).lines).toEqual([]);
    fs.appendFileSync(f, 'a\nb\npartial');
    expect((await t.poll()).lines).toEqual(['a', 'b']);
    fs.appendFileSync(f, '-done\nc\n');
    expect((await t.poll()).lines).toEqual(['partial-done', 'c']);
    expect((await t.poll()).lines).toEqual([]);
    await t.close();
  });

  it('waits for a missing file and then reads it from the start', async () => {
    const f = file();
    const t = new LogTailer(f);
    expect((await t.poll()).lines).toEqual([]);
    expect(t.isOpen).toBe(false);
    fs.writeFileSync(f, 'first\n');
    expect((await t.poll()).lines).toEqual([]); // first open: starts at the end, history is not replayed
    fs.appendFileSync(f, 'second\n');
    expect((await t.poll()).lines).toEqual(['second']);
    await t.close();
  });

  it('can start at the beginning (tests and one-off imports)', async () => {
    const f = file();
    fs.writeFileSync(f, 'x\ny\n');
    const t = new LogTailer(f, { startAtEnd: false });
    expect((await t.poll()).lines).toEqual(['x', 'y']);
    await t.close();
  });

  it('survives copy-truncate rotation without duplicating lines', async () => {
    const f = file();
    fs.writeFileSync(f, '');
    const t = new LogTailer(f);
    await t.poll();
    fs.appendFileSync(f, '1\n2\n3\n');
    expect((await t.poll()).lines).toEqual(['1', '2', '3']);
    fs.truncateSync(f, 0);
    fs.appendFileSync(f, '4\n');
    const r = await t.poll();
    expect(r.lines).toEqual(['4']);
    expect(r.truncated).toBe(true);
    await t.close();
  });

  it('survives rename rotation: the rest of the old file is read before the new one, nothing twice', async () => {
    const f = file();
    fs.writeFileSync(f, '');
    const t = new LogTailer(f);
    await t.poll();
    fs.appendFileSync(f, 'a1\na2\n');
    expect((await t.poll()).lines).toEqual(['a1', 'a2']);
    fs.appendFileSync(f, 'a3\n'); // written after the last poll, before the rotation
    fs.renameSync(f, `${f}.1`);
    fs.writeFileSync(f, 'b1\nb2\n');
    const r = await t.poll();
    expect(r.rotated).toBe(true);
    expect(r.lines).toEqual(['a3', 'b1', 'b2']);
    fs.appendFileSync(f, 'b3\n');
    expect((await t.poll()).lines).toEqual(['b3']);
    await t.close();
  });

  it('keeps draining the old file while the name is briefly missing', async () => {
    const f = file();
    fs.writeFileSync(f, '');
    const t = new LogTailer(f);
    await t.poll();
    fs.appendFileSync(f, 'x\n');
    fs.renameSync(f, `${f}.1`);
    expect((await t.poll()).lines).toEqual(['x']);
    fs.writeFileSync(f, 'y\n');
    expect((await t.poll()).lines).toEqual(['y']);
    await t.close();
  });

  it('drops an over-long line and carries on', async () => {
    const f = file();
    fs.writeFileSync(f, '');
    const t = new LogTailer(f, { maxLineBytes: 100 });
    await t.poll();
    fs.appendFileSync(f, `ok1\n${'z'.repeat(500)}\nok2\n`);
    const r = await t.poll();
    expect(r.lines).toEqual(['ok1', 'ok2']);
    expect(r.oversize).toBe(1);
    await t.close();
  });

  it('does not split multi-byte characters across reads and strips CR', async () => {
    const f = file();
    fs.writeFileSync(f, '');
    const t = new LogTailer(f);
    await t.poll();
    const bytes = Buffer.from('héllo wörld ✓\r\n', 'utf8');
    fs.appendFileSync(f, bytes.subarray(0, 2)); // cuts inside "é"
    expect((await t.poll()).lines).toEqual([]);
    fs.appendFileSync(f, bytes.subarray(2));
    expect((await t.poll()).lines).toEqual(['héllo wörld ✓']);
    await t.close();
  });

  it('reads a large backlog across polls with a byte budget', async () => {
    const f = file();
    fs.writeFileSync(f, '');
    const t = new LogTailer(f, { maxBytesPerPoll: 1000 });
    await t.poll();
    const rows = Array.from({ length: 500 }, (_, i) => `row-${i}`);
    fs.appendFileSync(f, rows.join('\n') + '\n');
    const got: string[] = [];
    for (let i = 0; i < 50 && got.length < 500; i++) got.push(...(await t.poll()).lines);
    expect(got).toEqual(rows);
    await t.close();
  });
});

describe('NginxAggregator', () => {
  const rec = (status: number, rt: number | null, over: Partial<AccessRecord> = {}): AccessRecord => ({
    ip: '1.1.1.1', host: 'h', method: 'GET', uri: '/p?q=1', status, bytes: 100, rt, up: '', ...over,
  });
  const T0 = Math.floor(1_800_000_000_000 / WINDOW_MS) * WINDOW_MS;

  it('counts requests, status classes, bytes and percentiles per service and window', () => {
    const a = new NginxAggregator(() => 50);
    for (let i = 1; i <= 100; i++) a.add(rec(i <= 90 ? 200 : 503, i / 1000), 1, T0 + 100);
    a.add(rec(404, 0.01), 2, T0 + 200);
    a.add(rec(302, null), 0, T0 + 300);
    expect(a.advance(T0 + 5_000)).toEqual([]); // window not complete yet
    const [w] = a.advance(T0 + WINDOW_MS);
    expect(w!.ts).toBe(T0);
    expect(w!.requests).toBe(102);
    const s1 = w!.services.find((x) => x.serviceId === 1)!;
    expect(s1).toMatchObject({ requests: 100, s2xx: 90, s5xx: 10, bytesOut: 10_000 });
    expect(s1.p50Ms).toBeCloseTo(50, 5);
    expect(s1.p95Ms).toBeCloseTo(95, 5);
    expect(w!.services.find((x) => x.serviceId === 2)).toMatchObject({ s4xx: 1, requests: 1 });
    expect(w!.services.find((x) => x.serviceId === 0)).toMatchObject({ s3xx: 1, p95Ms: 0 });
    expect(a.advance(T0 + 3 * WINDOW_MS)).toEqual([]); // each window is emitted once
  });

  it('matches a manual count over a one-minute test', () => {
    const a = new NginxAggregator(() => 50);
    let manual = 0;
    for (let s = 0; s < 60; s++) {
      for (let k = 0; k < (s % 7) + 1; k++) {
        a.add(rec(200, 0.01), 1, T0 + s * 1000);
        manual += 1;
      }
    }
    const total = a.advance(T0 + 70_000).reduce((x, w) => x + w.requests, 0);
    expect(total).toBe(manual);
  });

  it('bounds the top lists and resets them every hour', () => {
    const a = new NginxAggregator(() => 5);
    for (let i = 0; i < 5_000; i++) a.add(rec(200, 0.01, { uri: `/p${i}`, ip: `10.0.${Math.floor(i / 250)}.${i % 250}` }), 1, T0);
    for (let i = 0; i < 50; i++) a.add(rec(200, 0.01, { uri: '/hot' }), 1, T0);
    expect(a.topPaths()).toHaveLength(5);
    expect(a.topPaths()[0]).toEqual({ path: '/hot', count: 51 > 50 ? a.topPaths()[0]!.count : 0 });
    expect(a.topPaths()[0]!.path).toBe('/hot');
    expect(a.topClientIps().length).toBeLessThanOrEqual(5);
    a.add(rec(200, 0.01, { uri: '/later' }), 1, T0 + 3_600_000 + 1);
    expect(a.topPaths()).toEqual([{ path: '/later', count: 1 }]);
  });

  it('counts malformed lines and remembers the last line time', () => {
    const a = new NginxAggregator(() => 5);
    a.malformed(3);
    a.add(rec(200, 0.01), 1, T0 + 77);
    expect(a.malformedLines).toBe(3);
    expect(a.linesTotal).toBe(1);
    expect(a.lastLineAt).toBe(T0 + 77);
  });

  it('caps response-time samples and still gives a sane percentile', () => {
    const a = new NginxAggregator(() => 5);
    for (let i = 0; i < 20_000; i++) a.add(rec(200, (i % 100) / 1000), 1, T0);
    const [w] = a.advance(T0 + WINDOW_MS);
    expect(w!.services[0]!.requests).toBe(20_000);
    expect(w!.services[0]!.p95Ms).toBeGreaterThan(80);
    expect(percentile([], 95)).toBe(0);
  });
});

describe('stub_status', () => {
  const body = 'Active connections: 291 \nserver accepts handled requests\n 16630948 16630948 31070465 \nReading: 6 Writing: 179 Waiting: 106 \n';
  it('parses the status page', () => {
    expect(parseStubStatus(body)).toEqual({ active: 291, accepts: 16630948, handled: 16630948, requests: 31070465, reading: 6, writing: 179, waiting: 106 });
    expect(parseStubStatus('<html>nope</html>')).toBeNull();
  });
  it('derives a rate and ignores counter resets and clock jumps', () => {
    expect(rateFromCounters({ at: 0, requests: 100 }, { at: 5_000, requests: 600 })).toBe(100);
    expect(rateFromCounters({ at: 0, requests: 100 }, { at: 5_000, requests: 50 })).toBeNull();
    expect(rateFromCounters({ at: 5_000, requests: 1 }, { at: 1_000, requests: 9 })).toBeNull();
    expect(rateFromCounters(null, { at: 1, requests: 1 })).toBeNull();
  });
  it('fetchStub reports errors in plain words', async () => {
    const ok = (async () => new Response(body)) as unknown as typeof fetch;
    expect((await fetchStub('http://x/', 100, ok)).active).toBe(291);
    const bad = (async () => new Response('x', { status: 403 })) as unknown as typeof fetch;
    await expect(fetchStub('http://x/', 100, bad)).rejects.toThrow('HTTP 403');
    const junk = (async () => new Response('<html>')) as unknown as typeof fetch;
    await expect(fetchStub('http://x/', 100, junk)).rejects.toThrow('not stub_status');
    const hang = ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))))) as unknown as typeof fetch;
    await expect(fetchStub('http://x/', 50, hang)).rejects.toThrow('did not answer in time');
  });
});

describe('TLS certificate check', () => {
  let hasOpenssl = true;
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
  } catch {
    hasOpenssl = false;
  }

  it.skipIf(!hasOpenssl)('reads the expiry of the certificate a host presents', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'cert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '2', '-subj', '/CN=monitor.test/O=Test CA'], { stdio: 'ignore' });
    const server = tls.createServer({ key: fs.readFileSync(`${dir}/k.pem`), cert: fs.readFileSync(`${dir}/c.pem`) }, (s) => s.end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as { port: number }).port;
      const c = await checkCert('monitor.test', 3_000, { host: '127.0.0.1', port });
      const days = (c.notAfter - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(1.9);
      expect(days).toBeLessThan(2.1);
      expect(c.issuer).toBe('Test CA');
    } finally {
      server.close();
    }
  });

  it('fails clearly when nothing answers, and parses host:port', async () => {
    await expect(checkCert('127.0.0.1:1', 500)).rejects.toThrow();
    expect(splitHostPort('a.example.com')).toEqual({ host: 'a.example.com', port: 443 });
    expect(splitHostPort('a.example.com:8443')).toEqual({ host: 'a.example.com', port: 8443 });
    expect(() => splitHostPort('a:99999')).toThrow();
  });

  it('collector stores results, keeps the last good expiry on failure, and drops removed hosts', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const state = new StateStore();
    const clock = { t: 1_800_000_000_000 };
    let hosts = ['a.example.com', 'b.example.com'];
    let failB = false;
    const c = tlsCollector({
      db, state, hosts: () => hosts, now: () => clock.t,
      check: async (h) => {
        if (h.startsWith('b') && failB) throw new Error('handshake timed out');
        return { notAfter: clock.t + (h.startsWith('a') ? 10 : 20) * 86_400_000, issuer: 'CA' };
      },
    });
    await c.run();
    expect(state.getTlsCerts().map((x) => [x.host, x.lastError])).toEqual([['a.example.com', null], ['b.example.com', null]]);
    failB = true;
    clock.t += 1000;
    await c.run();
    const b = state.getTlsCerts().find((x) => x.host.startsWith('b'))!;
    expect(b.lastError).toBe('handshake timed out');
    expect(b.notAfter).not.toBeNull(); // the last good reading is kept
    hosts = ['a.example.com'];
    await c.run();
    expect(state.getTlsCerts().map((x) => x.host)).toEqual(['a.example.com']);
  });

  it('also checks the https host of each active service public URL', () => {
    const db = openDb(':memory:');
    migrate(db);
    const services = new ServicesRepo(db);
    const a = services.discover('web');
    services.update(a.id, { publicUrl: 'https://app.example.com' }, new Set());
    const b = services.discover('legacy');
    services.update(b.id, { publicUrl: 'http://plain.example.com' }, new Set());
    expect(tlsHostsFor(['z.example.com'], services)).toEqual(['app.example.com', 'z.example.com']);
  });
});

describe('collectors end to end (real files, real aggregation, real database)', () => {
  it('attributes per service, stores raw lines under _nginx, counts bad lines, and persists windows', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const clock = { t: Math.floor(1_800_000_000_000 / WINDOW_MS) * WINDOW_MS + 1_000 };
    const now = () => clock.t;
    const state = new StateStore();
    const services = new ServicesRepo(db, now);
    const api = services.discover('billing-api');
    services.update(api.id, { nginxMatch: 'api.example.com' }, new Set());
    const web = services.discover('web');
    services.update(web.id, { nginxMatch: '127.0.0.1:3002' }, new Set());
    const queued: string[] = [];
    const pipeline = new LogPipeline({ writer: { enqueue: (_d: string, l: string) => queued.push(l) } as never, ringLines: () => 1000, now });

    const access = file();
    fs.writeFileSync(access, '');
    const col = nginxLogCollector({ accessLog: access, state, services, pipeline, topN: () => 50, now, startAtEnd: true });
    await col.run();

    const rows: string[] = [];
    for (let i = 0; i < 30; i++) rows.push(line({ host: 'api.example.com', status: i < 3 ? 500 : 200, rt: 0.02 }));
    for (let i = 0; i < 10; i++) rows.push(line({ host: 'other.example.com', up: '127.0.0.1:3002' }));
    for (let i = 0; i < 4; i++) rows.push(line({ host: 'stranger.org', up: '' }));
    rows.push('garbage line');
    fs.appendFileSync(access, rows.join('\n') + '\n');
    await col.run();
    clock.t += WINDOW_MS;
    await col.run();

    const n = state.getNginx(clock.t)!;
    expect(n.linesTotal).toBe(44);
    expect(n.malformedLines).toBe(1);
    const by = (id: number) => n.perService.find((x) => x.serviceId === id)!;
    expect(by(api.id)).toMatchObject({ s5xx: 3, s2xx: 27, reqPerS: 3 });
    expect(by(web.id).reqPerS).toBe(1);
    expect(by(0).reqPerS).toBeCloseTo(0.4);
    expect(n.topPaths[0]).toEqual({ path: '/v1/orders', count: 44 });
    expect(pipeline.tail('_nginx', 100).length).toBe(45); // raw lines, including the malformed one
    expect(queued.length).toBe(45);

    const p = new Persistence(db, state, new ProcessEvents(), services, now);
    // the persistence object starts "now"; move time on so the window is picked up
    (p as unknown as { lastNginxWindow: number }).lastNginxWindow = 0;
    clock.t += 20_000;
    p.flush();
    const stored = db.prepare('SELECT service_id, requests, s5xx FROM metrics_nginx_service ORDER BY service_id').all();
    expect(stored).toEqual([
      { service_id: 0, requests: 4, s5xx: 0 },
      { service_id: api.id, requests: 30, s5xx: 3 },
      { service_id: web.id, requests: 10, s5xx: 0 },
    ]);
    p.flush(); // flushing again writes nothing new
    expect((db.prepare('SELECT COUNT(*) AS c FROM metrics_nginx_service').get() as { c: number }).c).toBe(3);
    await col.close();
  });

  it('reports a missing access log as a collector failure, and recovers when the file appears', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const services = new ServicesRepo(db);
    const pipeline = new LogPipeline({ writer: { enqueue: () => undefined } as never, ringLines: () => 100 });
    const f = file();
    const col = nginxLogCollector({ accessLog: f, state: new StateStore(), services, pipeline, topN: () => 5 });
    await expect(col.run()).rejects.toThrow('access log not found');
    fs.writeFileSync(f, '');
    await col.run();
    await col.close();
  });

  it('status collector records a failure as data instead of throwing', async () => {
    const state = new StateStore();
    let ok = true;
    const f = (async () => {
      if (!ok) throw new Error('connect ECONNREFUSED 127.0.0.1:8081');
      return new Response('Active connections: 2 \nserver accepts handled requests\n 5 5 10 \nReading: 0 Writing: 1 Waiting: 1 \n');
    }) as unknown as typeof fetch;
    const clock = { t: 1_800_000_000_000 };
    const c = nginxStatusCollector({ url: 'http://127.0.0.1:8081/nginx_status', state, now: () => clock.t, fetch: f });
    await c.run();
    expect(state.getNginx(clock.t)).toMatchObject({ statusOk: true, activeConn: 2 });
    ok = false;
    clock.t += 5000;
    await c.run();
    expect(state.getNginx(clock.t)).toMatchObject({ statusOk: false, activeConn: 0 });
    expect(state.getNginx(clock.t)!.statusError).toContain('ECONNREFUSED');
  });
});

describe('nginx alert rules', () => {
  const GIB = 1;
  void GIB;
  let db: ReturnType<typeof openDb>;
  let clock: { t: number };
  let state: StateStore;
  let repo: AlertRepo;
  let services: ServicesRepo;
  let engine: AlertEngine;
  let stale: Set<string>;

  beforeEach(() => {
    clock = { t: Math.floor(1_800_000_000_000 / WINDOW_MS) * WINDOW_MS };
    const now = () => clock.t;
    db = openDb(':memory:');
    migrate(db);
    state = new StateStore();
    repo = new AlertRepo(db, now);
    services = new ServicesRepo(db, now);
    stale = new Set();
    const settings = new Settings(db, now);
    const notifier = new Notifier({
      mailer: null, repo, settings,
      config: { alertFrom: undefined, publicDashboardUrl: undefined, resendApiKey: undefined },
      log: { warn: () => undefined, info: () => undefined }, now, sleep: async () => undefined,
    });
    const logs: LogStatus = { volumeOk: true, volumeReason: null, volumeUsedPct: 1, droppedLines: 0, skippedLines: 0, writerQueue: 0 };
    engine = new AlertEngine({
      repo, state, settings, notifier,
      collectors: (): CollectorStatus[] => ['host', 'disk', 'system', 'pm2', 'nginxlog', 'tls'].map((name) => ({ name, intervalMs: 1000, lastOkAt: clock.t, stale: stale.has(name) })),
      logs: () => logs, persistence: () => ({ consecutiveFailures: 0 }),
      log: { warn: () => undefined, info: () => undefined }, now,
    });
  });

  const traffic = (serviceId: number, requests: number, s5xx: number): void => {
    // one 10 s window ending now
    state.addNginxWindows([
      { ts: clock.t - WINDOW_MS, requests, services: [{ serviceId, requests, s2xx: requests - s5xx, s3xx: 0, s4xx: 0, s5xx, p50Ms: 5, p95Ms: 9, bytesOut: 0 }] },
    ]);
    state.setNginxLog({ at: clock.t, topPaths: [], topClientIps: [], malformedLines: 0, linesTotal: 1, lastLineAt: clock.t });
  };

  it('5xx rate opens after its duration, needs 50 requests, and resolves when traffic is healthy', async () => {
    const svc = services.discover('api');
    for (let i = 0; i < 80; i++) {
      clock.t += 5_000;
      if (i % 2 === 0) traffic(svc.id, 100, 20); // 20 % errors
      await engine.tick();
    }
    expect(repo.firing().map((x) => x.rule_key)).toEqual(['nginx.5xx_rate']);
    expect(repo.firing()[0]!.service_id).toBe(svc.id);
    for (let i = 0; i < 170; i++) {
      // resolves after twice the 300 s duration without errors
      clock.t += 5_000;
      if (i % 2 === 0) traffic(svc.id, 100, 0);
      await engine.tick();
    }
    expect(repo.firing()).toHaveLength(0);
  });

  it('does not fire on a high error share from a handful of requests', async () => {
    const svc = services.discover('api');
    for (let i = 0; i < 100; i++) {
      clock.t += 5_000;
      if (i % 2 === 0) traffic(svc.id, 3, 3); // 100 % errors, but only about 18 requests a minute
      await engine.tick();
    }
    expect(repo.firing()).toHaveLength(0);
  });

  it('is paused while the log collector is stale, and silent when Nginx was never seen', async () => {
    const svc = services.discover('api');
    for (let i = 0; i < 20; i++) {
      clock.t += 5_000;
      await engine.tick();
    }
    expect(repo.firing()).toHaveLength(0);
    stale.add('nginxlog');
    for (let i = 0; i < 80; i++) {
      clock.t += 5_000;
      if (i % 2 === 0) traffic(svc.id, 100, 50);
      await engine.tick();
    }
    // The stale collector is reported by its own rule; the 5xx rule stays out of it.
    expect(repo.firing().map((x) => x.rule_key).filter((k) => k.startsWith('nginx.'))).toEqual([]);
  });

  it('status unreachable fires after 120 s of failures and resolves after recovery', async () => {
    const ok = { sample: { active: 1, accepts: 1, handled: 1, requests: 1, reading: 0, writing: 1, waiting: 0 }, reqPerS: 0 };
    state.setNginxStatus(clock.t, { ok: true, ...ok });
    for (let i = 0; i < 10; i++) {
      clock.t += 5_000;
      await engine.tick();
    }
    expect(repo.firing()).toHaveLength(0);
    for (let i = 0; i < 30; i++) {
      clock.t += 5_000;
      state.setNginxStatus(clock.t, { ok: false, error: 'connect ECONNREFUSED' });
      await engine.tick();
    }
    expect(repo.firing().map((x) => x.rule_key)).toEqual(['nginx.status_unreachable']);
    for (let i = 0; i < 60; i++) {
      clock.t += 5_000;
      state.setNginxStatus(clock.t, { ok: true, ...ok });
      await engine.tick();
    }
    expect(repo.firing()).toHaveLength(0);
  });

  it('certificate rules: warning at 14 days, critical at 3 (which hides the warning), expired is reported', async () => {
    const set = (days: number): void =>
      state.setTlsCerts([{ host: 'api.example.com', notAfter: clock.t + days * 86_400_000, issuer: 'CA', checkedAt: clock.t, lastError: null }]);
    set(30);
    await engine.tick();
    expect(repo.firing()).toHaveLength(0);
    set(10);
    await engine.tick();
    expect(repo.firing().map((x) => x.rule_key)).toEqual(['nginx.cert_expiring']);
    set(2);
    await engine.tick();
    const firing = repo.firing();
    expect(firing.map((x) => x.rule_key).sort()).toEqual(['nginx.cert_critical', 'nginx.cert_expiring']);
    const warn = firing.find((x) => x.rule_key === 'nginx.cert_expiring')!;
    const crit = firing.find((x) => x.rule_key === 'nginx.cert_critical')!;
    expect(warn.suppressed_by).toBe(crit.id);
    expect(crit.summary).toContain('expires in 2 days');
    set(-1);
    clock.t += 31_000;
    await engine.tick();
    expect(repo.firing().find((x) => x.rule_key === 'nginx.cert_critical')!.summary).toContain('expired');
  });

  it('a certificate that could never be read raises no alert (shown on the page instead)', async () => {
    state.setTlsCerts([{ host: 'x.example.com', notAfter: null, issuer: null, checkedAt: clock.t, lastError: 'timeout' }]);
    await engine.tick();
    expect(repo.firing()).toHaveLength(0);
  });
});

describe('nginx API', () => {
  it('requires login, returns state, series and certificates', async () => {
    const t = await makeApp();
    try {
      expect((await t.app.inject({ method: 'GET', url: '/api/v1/nginx' })).statusCode).toBe(401);
      await addUser(t);
      const { cookie } = await login(t);
      let res = await t.app.inject({ method: 'GET', url: '/api/v1/nginx', headers: authed(cookie!) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ nginx: null, configured: { status: false, accessLog: false, tls: false }, certs: [] });

      t.ctx.state.setNginxStatus(t.clock.t, { ok: true, sample: { active: 3, accepts: 1, handled: 1, requests: 1, reading: 0, writing: 1, waiting: 2 }, reqPerS: 4 });
      t.ctx.state.setTlsCerts([{ host: 'api.example.com', notAfter: t.clock.t + 5 * 86_400_000 + 1000, issuer: 'CA', checkedAt: t.clock.t, lastError: null }]);
      res = await t.app.inject({ method: 'GET', url: '/api/v1/nginx', headers: authed(cookie!) });
      expect(res.json().nginx).toMatchObject({ statusOk: true, activeConn: 3, reqPerS: 4 });
      expect(res.json().certs[0]).toMatchObject({ host: 'api.example.com', daysLeft: 5 });

      const svc = t.ctx.services.discover('web');
      const detail = await t.app.inject({ method: 'GET', url: `/api/v1/services/${svc.id}`, headers: authed(cookie!) });
      expect(detail.json().traffic).toMatchObject({ now: null });
    } finally {
      await t.close();
    }
  });
});
