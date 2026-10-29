import type { AddressInfo } from 'node:net';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentReport, CollectorStatus, LogStatus, ProcessState } from '@cc/shared';
import { AGENT_MAX_BODY_BYTES } from '@cc/shared';
import { AlertEngine } from '../src/alerts/engine';
import { Notifier } from '../src/alerts/notifier';
import { AlertRepo } from '../src/alerts/repo';
import { createIngestHandler, startIngest, tokenMatches } from '../src/agent/ingest';
import { mergeInstances } from '../src/agent/store';
import { fill, gridTimes, makeGrid, parseRange } from '../src/history';
import { migrate, openDb, type Db } from '../src/db';
import { Persistence } from '../src/persist';
import { ProcessEvents } from '../src/pm2/events';
import { ServicesRepo } from '../src/pm2/services';
import { Settings } from '../src/settings';
import { StateStore } from '../src/state';
import { addUser, authed, login, makeApp } from './helpers';

const TOKEN = 'i'.repeat(32);

const report = (over: Partial<AgentReport> = {}): AgentReport => ({
  v: 1,
  service: 'api',
  pm: 0,
  window_s: 5,
  runtime: { event_loop_lag_ms: { mean: 2, p95: 10, max: 30 }, heap_used_bytes: 100, rss_bytes: 200, active_handles: 5 },
  http: { req_count: 50, err5xx_count: 1, p50_ms: 10, p95_ms: 100 },
  sockets: { open: 20 },
  tenants: [
    { key: 'acme', sockets: 12, active_users_5m: 8, req_count: 30, p95_ms: 90 },
    { key: 'globex', sockets: 8, active_users_5m: 4, req_count: 20, p95_ms: 100 },
  ],
  ...over,
});

describe('mergeInstances', () => {
  it('sums counts and takes the worst lag and latency across instances', () => {
    const a = { at: 1000, r: report({ pm: 0 }) };
    const b = {
      at: 2000,
      r: report({
        pm: 1,
        runtime: { event_loop_lag_ms: { mean: 5, p95: 40, max: 90 }, heap_used_bytes: 50, rss_bytes: 60 },
        http: { req_count: 100, err5xx_count: 0, p50_ms: 5, p95_ms: 300 },
        sockets: { open: 10 },
        tenants: [{ key: 'acme', sockets: 10, active_users_5m: 6, req_count: 100, p95_ms: 300 }],
      }),
    };
    const m = mergeInstances([a, b], 3000);
    expect(m).toMatchObject({ instances: 2, sockets: 30, activeUsers: 18, p95Ms: 300, p50Ms: 10, eventLoopLagP95Ms: 40, eventLoopLagMaxMs: 90, heapUsedBytes: 150, rssBytes: 260, activeHandles: 5, updatedAt: 2000 });
    expect(m.reqPerS).toBe(30); // (50 + 100) / 5
    expect(m.err5xxPerS).toBe(0.2);
    expect(m.tenants.find((t) => t.key === 'acme')).toMatchObject({ sockets: 22, activeUsers: 14, reqPerS: 26, p95Ms: 300 });
  });

  it('folds an excess of tenants into _other', () => {
    const tenants = Array.from({ length: 60 }, (_, i) => ({ key: `t${i}`, sockets: 1, active_users_5m: i, req_count: 5, p95_ms: 1 }));
    const m = mergeInstances([{ at: 0, r: report({ tenants: tenants.slice(0, 51) }) }, { at: 0, r: report({ pm: 1, tenants: tenants.slice(30) }) }], 1);
    expect(m.tenants.length).toBeLessThanOrEqual(51);
    expect(m.tenantsTruncated).toBe(true);
    expect(m.tenants.find((t) => t.key === '_other')).toBeTruthy();
  });
});

describe('store freshness', () => {
  it('drops an instance that has not reported within 15 s', () => {
    const s = new StateStore();
    s.app.ingest(1, report({ pm: 0 }), 0);
    s.app.ingest(1, report({ pm: 1 }), 10_000);
    expect(s.app.get(1, 14_000)!.instances).toBe(2);
    expect(s.app.get(1, 16_000)!.instances).toBe(1);
    expect(s.app.get(1, 30_000)).toBeNull();
    expect(s.app.lastReportAt(1)).toBe(10_000); // silence is still measurable
  });
});

describe('token', () => {
  it('compares exactly', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN + 'x', TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
    expect(tokenMatches(['a', 'b'], TOKEN)).toBe(false);
  });
});

describe('ingest listener', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let url: string;
  let close: () => Promise<void>;
  const post = async (body: unknown, headers: Record<string, string> = { 'x-monitor-token': TOKEN }, path = '/ingest/v1/agent') => {
    const r = await fetch(url.replace('/ingest/v1/agent', path), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return r;
  };

  beforeEach(async () => {
    t = await makeApp({ config: { ingestToken: TOKEN } });
    // PM2 reports an 'api' process, so the service exists.
    const svc = t.ctx.services.discover('api');
    t.ctx.state.setProcesses([{ serviceId: svc.id, name: 'api', pm2Name: 'api', updatedAt: t.clock.t, status: 'online', instances: 1, instancesOnline: 1, cpuPct: 5, memBytes: 1, restarts: 0, uptimeS: 1 } as ProcessState], t.clock.t);
    const s = await startIngest(t.ctx, TOKEN);
    close = s.close;
    url = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}/ingest/v1/agent`;
  });
  const done = async () => {
    await close();
    await t.close();
  };

  it('accepts a valid report with 204, enables the agent flag and stores merged data', async () => {
    try {
      expect(t.ctx.services.getByPm2Name('api')!.agent_enabled).toBe(0);
      const r = await post(report());
      expect(r.status).toBe(204);
      const svc = t.ctx.services.getByPm2Name('api')!;
      expect(svc.agent_enabled).toBe(1);
      expect(t.db.prepare('SELECT agent_enabled FROM services WHERE id = ?').get(svc.id)).toEqual({ agent_enabled: 1 });
      expect(t.ctx.state.app.get(svc.id, t.clock.t)).toMatchObject({ sockets: 20, activeUsers: 12, instances: 1 });
    } finally {
      await done();
    }
  });

  it('rejects a bad or missing token with 401 before reading the body', async () => {
    try {
      const bad: Record<string, string>[] = [{}, { 'x-monitor-token': 'wrong' }, { 'x-monitor-token': TOKEN.slice(1) }, { authorization: `Bearer ${TOKEN}` }];
      for (const h of bad) {
        const r = await post(report(), h);
        expect(r.status).toBe(401);
        expect(await r.json()).toEqual({ error: 'unauthorized' });
      }
      expect(t.ctx.state.app.serviceIds()).toEqual([]);
    } finally {
      await done();
    }
  });

  it('rejects invalid payloads, wrong methods and wrong paths', async () => {
    try {
      expect((await post('{not json')).status).toBe(400);
      expect((await post({ v: 2 })).status).toBe(400);
      expect((await post(report({ window_s: 0 }))).status).toBe(400);
      expect((await post({ ...report(), http: { ...report().http, req_count: -1 } })).status).toBe(400);
      expect((await post({ ...report(), runtime: { ...report().runtime, rss_bytes: 'x' } })).status).toBe(400);
      expect((await fetch(url, { headers: { 'x-monitor-token': TOKEN } })).status).toBe(405);
      expect((await post(report(), { 'x-monitor-token': TOKEN }, '/other')).status).toBe(404);
    } finally {
      await done();
    }
  });

  it('refuses a body over 256 KB', async () => {
    try {
      const big = JSON.stringify({ ...report(), pad: 'x'.repeat(AGENT_MAX_BODY_BYTES + 10) });
      const r = await post(big);
      expect(r.status).toBe(413);
    } finally {
      await done();
    }
  });

  it('rejects, and counts, a service that PM2 does not run', async () => {
    try {
      const r = await post(report({ service: 'ghost' }));
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: 'unknown_service' });
      expect(t.ctx.state.app.rejected).toBe(1);
      expect(t.ctx.services.getByPm2Name('ghost')).toBeUndefined();
    } finally {
      await done();
    }
  });

  it('registers a service PM2 lists but has not been discovered yet', async () => {
    try {
      t.ctx.state.setProcesses([{ serviceId: 99, name: 'fresh', pm2Name: 'fresh', updatedAt: 0, status: 'online', instances: 1, instancesOnline: 1, cpuPct: 0, memBytes: 0, restarts: 0, uptimeS: 0 } as ProcessState], t.clock.t);
      expect((await post(report({ service: 'fresh' }))).status).toBe(204);
      expect(t.ctx.services.getByPm2Name('fresh')).toBeTruthy();
    } finally {
      await done();
    }
  });

  it('listens on loopback only', async () => {
    const s = await startIngest(t.ctx, TOKEN);
    try {
      expect((s.server.address() as AddressInfo).address).toBe('127.0.0.1');
    } finally {
      await s.close();
      await done();
    }
  });

  it('createIngestHandler is a plain request listener', () => {
    expect(typeof createIngestHandler(t.ctx, TOKEN)).toBe('function');
    return done();
  });
});

describe('persistence of agent data', () => {
  const T0 = Math.floor(1_800_000_000_000 / 60_000) * 60_000;
  function setup() {
    const db = openDb(':memory:');
    migrate(db);
    const clock = { t: T0 };
    const now = () => clock.t;
    const state = new StateStore();
    const services = new ServicesRepo(db, now);
    const p = new Persistence(db, state, new ProcessEvents(), services, now);
    const svc = services.discover('api');
    return { db, clock, state, p, svc };
  }

  it('writes 10 s service rows, and tenant rows only once a minute', () => {
    const { db, clock, state, p, svc } = setup();
    for (let i = 0; i < 12; i++) {
      clock.t = T0 + i * 5_000;
      state.app.ingest(svc.id, report({ service: 'api' }), clock.t);
      state.app.sample(clock.t, () => ({ cpuPct: 10, memBytes: 1000 }));
    }
    clock.t = T0 + 60_500;
    p.flush();
    const rows = db.prepare('SELECT ts, res_s, sockets, active_users, round(req_per_s, 2) AS rps, p95_ms, event_loop_lag_ms, event_loop_lag_max FROM metrics_app_service ORDER BY ts').all() as Record<string, number>[];
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ ts: T0, res_s: 10, sockets: 20, active_users: 12, rps: 10, p95_ms: 100, event_loop_lag_ms: 10, event_loop_lag_max: 30 });
    const tenants = db.prepare('SELECT t.tenant_key, m.res_s, m.ts, m.sockets, m.active_users FROM metrics_app_tenant m JOIN tenants t ON t.id = m.tenant_id ORDER BY t.tenant_key').all();
    expect(tenants).toEqual([
      { tenant_key: 'acme', res_s: 60, ts: T0, sockets: 12, active_users: 8 },
      { tenant_key: 'globex', res_s: 60, ts: T0, sockets: 8, active_users: 4 },
    ]);
    // Flushing again writes nothing twice.
    p.flush();
    expect((db.prepare('SELECT COUNT(*) AS n FROM metrics_app_tenant').get() as { n: number }).n).toBe(2);
  });

  it('refuses a tenant row that is not 60 s', () => {
    const { db } = setup();
    expect(() => db.prepare('INSERT INTO metrics_app_tenant (service_id, tenant_id, res_s, ts) VALUES (1, 1, 10, 0)').run()).toThrow(/CHECK/);
  });
});

describe('app alert rules', () => {
  let clock: { t: number };
  let state: StateStore;
  let repo: AlertRepo;
  let engine: AlertEngine;
  let db: Db;
  let svcId: number;
  const stale = new Set<string>();

  const proc = (over: Partial<ProcessState> = {}): ProcessState => ({
    serviceId: svcId, name: 'api', pm2Name: 'api', updatedAt: clock.t, status: 'online', instances: 1, instancesOnline: 1,
    cpuPct: 5, memBytes: 1000, restarts: 0, uptimeS: 100, ...over,
  } as ProcessState);

  beforeEach(() => {
    clock = { t: 1_800_000_000_000 };
    const now = () => clock.t;
    db = openDb(':memory:');
    migrate(db);
    state = new StateStore();
    repo = new AlertRepo(db, now);
    stale.clear();
    const settings = new Settings(db, now);
    const services = new ServicesRepo(db, now);
    svcId = services.discover('api').id;
    const notifier = new Notifier({ mailer: null, repo, settings, config: { alertFrom: undefined, publicDashboardUrl: undefined, resendApiKey: undefined }, log: { warn: () => undefined, info: () => undefined }, now, sleep: async () => undefined });
    const logs: LogStatus = { volumeOk: true, volumeReason: null, volumeUsedPct: 1, droppedLines: 0, skippedLines: 0, writerQueue: 0 };
    engine = new AlertEngine({
      repo, state, settings, notifier,
      collectors: (): CollectorStatus[] => ['host', 'disk', 'system', 'pm2'].map((name) => ({ name, intervalMs: 1000, lastOkAt: clock.t, stale: stale.has(name) })),
      logs: () => logs, persistence: () => ({ consecutiveFailures: 0 }), log: { warn: () => undefined, info: () => undefined }, now,
      agentEnabled: (id) => services.get(id)?.agent_enabled === 1,
    });
  });

  const keys = () => repo.firing().map((x) => x.rule_key).filter((k) => k.startsWith('app.'));
  /** Runs `seconds` of 5 s ticks; `r` is reported every tick unless null (silence). */
  const run = async (seconds: number, r: (() => AgentReport) | null, p: Partial<ProcessState> = {}): Promise<void> => {
    for (let i = 0; i < seconds / 5; i++) {
      clock.t += 5_000;
      state.setProcesses([proc(p)], clock.t);
      if (r) state.app.ingest(svcId, r(), clock.t);
      await engine.tick();
    }
  };
  const lag = (p95: number) => () => report({ runtime: { event_loop_lag_ms: { mean: 1, p95, max: p95 * 2 }, heap_used_bytes: 1, rss_bytes: 1 } });

  it('is silent for a service that never had an agent', async () => {
    await run(600, null);
    expect(keys()).toEqual([]);
  });

  it('event loop lag opens after 120 s above 200 ms and resolves afterwards', async () => {
    await run(60, lag(10));
    await run(100, lag(350));
    expect(keys()).toEqual([]);
    await run(40, lag(350));
    expect(keys()).toEqual(['app.event_loop_lag']);
    expect(repo.firing()[0]!.summary).toContain('350 ms');
    await run(300, lag(10));
    expect(keys()).toEqual([]);
  });

  it('latency needs requests: an idle service with a stale p95 does not alert', async () => {
    const idle = () => report({ http: { req_count: 0, err5xx_count: 0, p50_ms: 0, p95_ms: 5000 } });
    await run(400, idle);
    expect(keys()).toEqual([]);
    const slow = () => report({ http: { req_count: 50, err5xx_count: 0, p50_ms: 900, p95_ms: 2500 } });
    await run(320, slow);
    expect(keys()).toEqual(['app.latency_high']);
  });

  it('CPU with no sockets and no users fires; a connected user prevents it', async () => {
    const empty = () => report({ sockets: { open: 0 }, tenants: [{ key: 'acme', sockets: 0, active_users_5m: 0, req_count: 0, p95_ms: 0 }] });
    await run(310, empty, { cpuPct: 95 });
    expect(keys()).toEqual(['app.cpu_no_users']);
    await run(610, () => report(), { cpuPct: 95 }); // resolves after twice the 300 s duration
    expect(keys()).toEqual([]);
  });

  it('agent silent: an online service that stops reporting is flagged, a stopped one is not', async () => {
    await run(30, () => report());
    await run(50, null);
    expect(keys()).toEqual([]); // under the 60 s duration
    await run(40, null);
    expect(keys()).toEqual(['app.agent_silent']);
    expect(repo.firing()[0]!.summary).toContain('event loop may be blocked');
    await run(300, () => report());
    expect(keys()).toEqual([]);
    // PM2 says it is down: that is the service_down rule's business, not "silent".
    await run(200, null, { status: 'stopped' });
    expect(keys()).toEqual([]);
  });

  it('agent silent is paused while PM2 itself is stale', async () => {
    await run(10, () => report());
    stale.add('pm2');
    await run(400, null);
    expect(keys()).toEqual([]);
  });
});

describe('history grid', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ ts: i * 60_000, v: i, spike: i === 500 ? 99 : 1 }));
  it('keeps the stored resolution when the range fits and coarsens it when it does not', () => {
    expect(makeGrid(0, 3_600_000).stepMs).toBe(10_000);
    const g = makeGrid(0, 1000 * 60_000, 100);
    expect(g.size).toBeLessThanOrEqual(100);
    expect(g.stepMs % 10_000).toBe(0);
    const out = fill(g, rows, (r) => r.ts, { v: { pick: (r) => r.v, agg: 'avg' }, spike: { pick: (r) => r.spike, agg: 'max' } });
    expect(out.v).toHaveLength(g.size);
    expect(Math.max(...(out.spike as number[]))).toBe(99); // a peak survives averaging neighbours
    expect(gridTimes(g)).toHaveLength(g.size);
  });

  it('leaves gaps as null', () => {
    const g = makeGrid(0, 600_000, 600);
    const out = fill(g, [{ ts: 0, v: 1 }, { ts: 590_000, v: 5 }], (x) => x.ts, { v: { pick: (x) => x.v, agg: 'avg' } });
    expect(out.v[0]).toBe(1);
    expect(out.v[1]).toBeNull();
    expect(out.v[out.v.length - 1]).toBe(5);
  });

  it('rejects an empty, reversed or over-long range', () => {
    const WEEK = 7 * 86_400_000;
    expect(parseRange({}, 10_000_000, WEEK)).toEqual({ from: 6_400_000, to: 10_000_000 });
    expect(parseRange({ from: '5', to: '1' }, 10, WEEK)).toBeNull();
    expect(parseRange({ from: '0', to: String(40 * 86_400_000) }, 10, WEEK)).toBeNull();
    expect(parseRange({ from: 'abc', to: '9000000' }, 10_000_000, WEEK)).toEqual({ from: 5_400_000, to: 9_000_000 }); // junk falls back to the default
  });

  it('caps the range at the limit it is given, and never defaults past it', () => {
    const HOUR = 3_600_000;
    const to = 100 * HOUR;
    expect(parseRange({ from: String(to - 2 * HOUR), to: String(to) }, to, 2 * HOUR)).toEqual({ from: to - 2 * HOUR, to }); // exactly the limit
    expect(parseRange({ from: String(to - 2 * HOUR - 1), to: String(to) }, to, 2 * HOUR)).toBeNull(); // 1 ms over
    expect(parseRange({}, to, 30 * 60_000)).toEqual({ from: to - 30 * 60_000, to }); // a 1 hour default shrinks to a 30 minute limit
  });
});

describe('agent API', () => {
  it('serves runtime data, tenants and tenant history to a logged-in user', async () => {
    const t = await makeApp();
    try {
      expect((await t.app.inject({ method: 'GET', url: '/api/v1/services/1/tenants' })).statusCode).toBe(401);
      await addUser(t, { role: 'engineer' });
      const { cookie } = await login(t);
      const svc = t.ctx.services.discover('api');
      t.ctx.state.app.ingest(svc.id, report(), t.clock.t);
      t.ctx.state.app.sample(t.clock.t, () => ({ cpuPct: 7, memBytes: 99 }));

      const detail = (await t.app.inject({ method: 'GET', url: `/api/v1/services/${svc.id}`, headers: authed(cookie!) })).json();
      expect(detail.app).toMatchObject({ sockets: 20, activeUsers: 12, eventLoopLagP95Ms: 10 });
      expect(detail.appSeries.cpuPct).toEqual([7]);

      const tenants = (await t.app.inject({ method: 'GET', url: `/api/v1/services/${svc.id}/tenants`, headers: authed(cookie!) })).json();
      expect(tenants.tenants.map((x: { key: string }) => x.key)).toEqual(['acme', 'globex']);

      const ins = t.db.prepare('INSERT INTO tenants (tenant_key, first_seen_at, last_seen_at) VALUES (?, 0, 0)').run('acme');
      for (let i = 0; i < 5; i++) {
        t.db.prepare('INSERT INTO metrics_app_tenant (service_id, tenant_id, res_s, ts, sockets, active_users, req_per_s, p95_ms) VALUES (?, ?, 60, ?, 1, ?, 1, 10)').run(svc.id, ins.lastInsertRowid, t.clock.t - (5 - i) * 60_000, i);
      }
      const hist = (await t.app.inject({ method: 'GET', url: `/api/v1/services/${svc.id}/tenants/history?key=acme&from=${t.clock.t - 600_000}&to=${t.clock.t}`, headers: authed(cookie!) })).json();
      expect(hist.activeUsers.filter((v: number | null) => v !== null)).toEqual([0, 1, 2, 3, 4]);
      expect(hist.ts).toHaveLength(hist.activeUsers.length);
      expect((await t.app.inject({ method: 'GET', url: `/api/v1/services/${svc.id}/tenants/history`, headers: authed(cookie!) })).statusCode).toBe(400);
      expect((await t.app.inject({ method: 'GET', url: `/api/v1/services/${svc.id}/tenants/history?key=acme&from=5&to=1`, headers: authed(cookie!) })).statusCode).toBe(400);
      expect((await t.app.inject({ method: 'GET', url: '/api/v1/services/9999/tenants', headers: authed(cookie!) })).statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });

  it('puts agent totals and per-service figures in the live message', async () => {
    const t = await makeApp();
    try {
      const svc = t.ctx.services.discover('api');
      t.ctx.state.setProcesses([{ serviceId: svc.id, name: 'api', pm2Name: 'api', updatedAt: t.clock.t, status: 'online', instances: 1, instancesOnline: 1, cpuPct: 1, memBytes: 1, restarts: 0, uptimeS: 1 } as ProcessState], t.clock.t);
      expect(t.ctx.hub.buildLive().app).toBeNull();
      t.ctx.state.app.ingest(svc.id, report(), t.clock.t);
      const live = t.ctx.hub.buildLive();
      expect(live.app).toEqual({ services: 1, sockets: 20, activeUsers: 12 });
      expect(live.services[0]!.app).toMatchObject({ sockets: 20 });
      expect(JSON.stringify(live)).not.toContain('acme'); // tenants stay out of the live broadcast
    } finally {
      await t.close();
    }
  });
});

