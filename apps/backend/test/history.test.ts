import { beforeEach, describe, expect, it } from 'vitest';
import type { CollectorStatus, LogStatus } from '@cc/shared';
import { AlertEngine } from '../src/alerts/engine';
import { Notifier } from '../src/alerts/notifier';
import { AlertRepo } from '../src/alerts/repo';
import { eventLogCollector, eventLogScript, parseEventLog } from '../src/collectors/eventlog';
import { migrate, openDb, type Db } from '../src/db';
import { ServicesRepo } from '../src/pm2/services';
import { Settings } from '../src/settings';
import { StateStore } from '../src/state';
import { addUser, authed, login, makeApp } from './helpers';

const NOW = Math.floor(1_800_000_000_000 / 3_600_000) * 3_600_000;

describe('GET /history/*', () => {
  async function setup() {
    const t = await makeApp();
    t.clock.t = NOW;
    await addUser(t, { role: 'engineer' });
    const { cookie } = await login(t);
    return { t, cookie: cookie! };
  }
  const get = (t: Awaited<ReturnType<typeof makeApp>>, cookie: string, url: string) =>
    t.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: authed(cookie) });

  it('require a session and reject impossible ranges', async () => {
    const { t, cookie } = await setup();
    try {
      for (const u of ['/history/host', '/history/nginx', '/history/mongo', '/history/services/1']) {
        expect((await t.app.inject({ method: 'GET', url: `/api/v1${u}` })).statusCode).toBe(401);
      }
      expect((await get(t, cookie, `/history/host?from=${NOW}&to=${NOW - 1}`)).statusCode).toBe(400);
      expect((await get(t, cookie, `/history/host?from=0&to=${NOW}`)).statusCode).toBe(400); // far over the retention
      expect((await get(t, cookie, '/history/services/9999')).statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });

  it('accept at most retention.metrics_days, and follow a changed setting at once', async () => {
    const { t, cookie } = await setup();
    try {
      const DAY = 86_400_000;
      t.ctx.services.discover('api');
      const svc = t.ctx.services.list(true)[0]!;
      const urls = (span: number) => [
        `/history/host?from=${NOW - span}&to=${NOW}`,
        `/history/nginx?from=${NOW - span}&to=${NOW}`,
        `/history/mongo?from=${NOW - span}&to=${NOW}`,
        `/history/services/${svc.id}?from=${NOW - span}&to=${NOW}`,
        `/services/${svc.id}/tenants/history?key=acme&from=${NOW - span}&to=${NOW}`,
      ];
      // Default 7 days: exactly 7 days is accepted, one millisecond more is not (the old limit was 31 days).
      for (const u of urls(7 * DAY)) expect((await get(t, cookie, u)).statusCode, u).toBe(200);
      for (const u of urls(7 * DAY + 1)) {
        const r = await get(t, cookie, u);
        expect(r.statusCode, u).toBe(400);
        expect(r.json().message).toBe('The range must be positive and at most 7 days.');
      }
      for (const u of urls(20 * DAY)) expect((await get(t, cookie, u)).statusCode, u).toBe(400);
      expect((await get(t, cookie, '/limits')).json().historyMaxMs).toBe(7 * DAY);

      // Lowered to 3 days: a 7 day range is now refused, and /limits reports the new value.
      t.ctx.settings.setMany({ 'retention.metrics_days': 3 }, null);
      for (const u of urls(7 * DAY)) expect((await get(t, cookie, u)).statusCode, u).toBe(400);
      for (const u of urls(3 * DAY)) expect((await get(t, cookie, u)).statusCode, u).toBe(200);
      expect((await get(t, cookie, `/history/host?from=${NOW - 4 * DAY}&to=${NOW}`)).json().message).toBe(
        'The range must be positive and at most 3 days.',
      );
      expect((await get(t, cookie, '/limits')).json().historyMaxMs).toBe(3 * DAY);

      // Raised to 30 days: a 20 day range is accepted.
      t.ctx.settings.setMany({ 'retention.metrics_days': 30 }, null);
      for (const u of urls(20 * DAY)) expect((await get(t, cookie, u)).statusCode, u).toBe(200);
      for (const u of urls(31 * DAY)) expect((await get(t, cookie, u)).statusCode, u).toBe(400);
    } finally {
      await t.close();
    }
  });

  it('GET /limits needs a session and reports both limits from the settings', async () => {
    const { t, cookie } = await setup();
    try {
      expect((await t.app.inject({ method: 'GET', url: '/api/v1/limits' })).statusCode).toBe(401);
      expect((await get(t, cookie, '/limits')).json()).toEqual({ historyMaxMs: 7 * 86_400_000, logSearchMaxMs: 24 * 3_600_000 });
      t.ctx.settings.setMany({ 'logs.retention_hours': 1.5, 'retention.metrics_days': 1 }, null);
      expect((await get(t, cookie, '/limits')).json()).toEqual({ historyMaxMs: 86_400_000, logSearchMaxMs: 5_400_000 });
    } finally {
      await t.close();
    }
  });

  it('host: mixes rolled-up and raw rows, marks the boundary, and leaves gaps empty', async () => {
    const { t, cookie } = await setup();
    try {
      const ins = t.db.prepare('INSERT INTO metrics_host (res_s, ts, cpu_pct, cpu_max_core_pct, mem_used_bytes, mem_total_bytes) VALUES (?, ?, ?, ?, ?, 1000)');
      // two hours ago: 60 s rows (rolled up); the last ten minutes: 10 s rows. The hour between is missing.
      for (let m = 0; m < 5; m++) ins.run(60, NOW - 2 * 3_600_000 + m * 60_000, 20, 90, 250);
      for (let i = 0; i < 60; i++) ins.run(10, NOW - 600_000 + i * 10_000, 40, 55, 500);
      t.db.prepare('INSERT INTO metrics_disk (volume, res_s, ts, used_bytes, total_bytes) VALUES (?, 10, ?, 30, 100)').run('C:', NOW - 60_000);

      const r = (await get(t, cookie, `/history/host?from=${NOW - 3 * 3_600_000}&to=${NOW}`)).json();
      expect(r.range.stepS).toBe(20); // 3 h / 600 points, rounded up to a multiple of 10 s
      expect(r.range.boundary).toBe(NOW - 600_000);
      expect(r.ts).toHaveLength(r.series.cpuPct.length);
      const vals = (k: string) => (r.series[k] as (number | null)[]).filter((v) => v !== null);
      expect(vals('cpuPct')).toContain(20);
      expect(vals('cpuPct')).toContain(40);
      expect(Math.max(...vals('cpuMaxCorePct'))).toBe(90); // a peak is not averaged away
      expect(vals('memPct')).toContain(25);
      expect(r.series['disk C:'].filter((v: number | null) => v !== null)).toEqual([30]);
      // The hour with no rows is a stretch of nulls, not a line drawn through nothing.
      const gap = r.ts.findIndex((s: number) => s * 1000 >= NOW - 3_600_000);
      expect(r.series.cpuPct[gap]).toBeNull();
    } finally {
      await t.close();
    }
  });

  it('host: a short range keeps the stored 10 s resolution and has no boundary', async () => {
    const { t, cookie } = await setup();
    try {
      t.db.prepare('INSERT INTO metrics_host (res_s, ts, cpu_pct) VALUES (10, ?, 12)').run(NOW - 20_000);
      const r = (await get(t, cookie, `/history/host?from=${NOW - 3_600_000}&to=${NOW}`)).json();
      expect(r.range.stepS).toBe(10);
      expect(r.range.boundary).toBeNull();
    } finally {
      await t.close();
    }
  });

  it('service: process, agent and gateway series on one time axis, plus its events', async () => {
    const { t, cookie } = await setup();
    try {
      const svc = t.ctx.services.discover('api');
      const ts = NOW - 120_000;
      t.db.prepare("INSERT INTO metrics_process (service_id, res_s, ts, status, cpu_pct, mem_bytes, restarts) VALUES (?, 10, ?, 'online', 33, 4096, 2)").run(svc.id, ts);
      t.db.prepare('INSERT INTO metrics_app_service (service_id, res_s, ts, sockets, active_users, req_per_s, p95_ms, event_loop_lag_ms, event_loop_lag_max) VALUES (?, 10, ?, 7, 5, 3, 120, 8, 40)').run(svc.id, ts);
      t.db.prepare('INSERT INTO metrics_nginx_service (service_id, res_s, ts, requests, s5xx, p95_ms) VALUES (?, 10, ?, 100, 5, 800)').run(svc.id, ts);
      t.db.prepare("INSERT INTO process_events (ts, service_id, pm_id, event, detail) VALUES (?, ?, 0, 'restart', NULL)").run(ts, svc.id);
      t.db.prepare('INSERT INTO metrics_app_service (service_id, res_s, ts, sockets) VALUES (999, 10, ?, 1)').run(ts); // another service

      const r = (await get(t, cookie, `/history/services/${svc.id}?from=${NOW - 600_000}&to=${NOW}`)).json();
      const at = r.ts.indexOf(Math.round(ts / 1000));
      expect(at).toBeGreaterThanOrEqual(0);
      const row = Object.fromEntries(Object.entries(r.series as Record<string, (number | null)[]>).map(([k, v]) => [k, v[at]]));
      expect(row).toMatchObject({ cpuPct: 33, memBytes: 4096, restarts: 2, sockets: 7, activeUsers: 5, appReqPerS: 3, appP95Ms: 120, lagP95Ms: 8, lagMaxMs: 40, gwReqPerS: 10, gw5xxPct: 5, gwP95Ms: 800 });
      expect(r.events.map((e: { event: string }) => e.event)).toEqual(['restart']);
    } finally {
      await t.close();
    }
  });

  it('nginx: sums services per stored row and divides by its width, so 10 s and 60 s rows agree', async () => {
    const { t, cookie } = await setup();
    try {
      const ins = t.db.prepare('INSERT INTO metrics_nginx_service (service_id, res_s, ts, requests, s5xx, p95_ms) VALUES (?, ?, ?, ?, ?, ?)');
      ins.run(1, 10, NOW - 30_000, 50, 1, 100); // 10 s row: 10 req/s in total with the next line
      ins.run(2, 10, NOW - 30_000, 50, 4, 300);
      ins.run(1, 60, NOW - 7_200_000, 300, 0, 50); // 60 s row: 5 req/s
      t.db.prepare('INSERT INTO metrics_nginx (res_s, ts, active_conn, req_per_s) VALUES (10, ?, 12, 9.5)').run(NOW - 30_000);
      const r = (await get(t, cookie, `/history/nginx?from=${NOW - 3 * 3_600_000}&to=${NOW}`)).json();
      const vals = (k: string) => (r.series[k] as (number | null)[]).filter((v) => v !== null);
      expect(vals('reqPerS').sort((a, b) => a - b)).toEqual([5, 10]);
      expect(vals('err5xxPct')).toContain(5);
      expect(vals('p95Ms')).toContain(300);
      expect(vals('activeConn')).toEqual([12]);
    } finally {
      await t.close();
    }
  });

  it('mongo: total operations, the worst lag and a down minute', async () => {
    const { t, cookie } = await setup();
    try {
      t.db.prepare('INSERT INTO metrics_mongo (res_s, ts, up, ping_ms, conn_current, op_insert_ps, op_query_ps, repl_lag_s) VALUES (10, ?, ?, 3, 11, 1, 2, ?)').run(NOW - 20_000, 1, 4);
      t.db.prepare('INSERT INTO metrics_mongo (res_s, ts, up) VALUES (10, ?, 0)').run(NOW - 10_000);
      const r = (await get(t, cookie, `/history/mongo?from=${NOW - 600_000}&to=${NOW}`)).json();
      const at = (k: string, secs: number) => (r.series[k] as (number | null)[])[r.ts.indexOf(Math.round((NOW - secs * 1000) / 1000))];
      expect(at('opsPerS', 20)).toBe(3);
      expect(at('replLagS', 20)).toBe(4);
      expect(at('up', 10)).toBe(0);
    } finally {
      await t.close();
    }
  });

  it('incidents can be listed for a time range', async () => {
    const { t, cookie } = await setup();
    try {
      const rule = t.ctx.alertRepo.listRules()[0]!;
      const a = t.ctx.alertRepo.insertIncident({ ruleId: rule.id, serviceId: null, fingerprint: 'x:a', openedAt: NOW - 7_200_000, peak: 1, summary: 'old' });
      t.ctx.alertRepo.resolveIncident(a.id, NOW - 7_000_000);
      t.ctx.alertRepo.insertIncident({ ruleId: rule.id, serviceId: null, fingerprint: 'x:b', openedAt: NOW - 1_000_000, peak: 1, summary: 'recent' });
      const list = async (q: string) => ((await get(t, cookie, `/alerts/incidents?${q}`)).json().incidents as { summary: string }[]).map((i) => i.summary);
      expect(await list(`from=${NOW - 3_600_000}&to=${NOW}`)).toEqual(['recent']);
      expect((await list(`from=${NOW - 8_000_000}&to=${NOW}`)).sort()).toEqual(['old', 'recent']);
    } finally {
      await t.close();
    }
  });
});

describe('Windows Event Log', () => {
  const ev = (rec: number, level: number, extra: Record<string, unknown> = {}) => ({
    log: 'System', rec, ts: NOW - 1000 * rec, level, provider: 'disk', id: 7, msg: 'The device has a bad block', ...extra,
  });

  it('builds a fixed script whose only input is a checked integer', () => {
    const s = eventLogScript(1_800_000_000_000);
    expect(s).toContain('FromUnixTimeMilliseconds(1800000000000)');
    expect(s).toContain('Get-WinEvent');
    expect(() => eventLogScript(NaN)).toThrow();
    expect(() => eventLogScript(1.5)).toThrow();
    expect(() => eventLogScript('1); calc' as unknown as number)).toThrow();
    expect(() => eventLogScript(-1)).toThrow();
  });

  it('parses an empty answer, one object, many objects, and skips bad entries', () => {
    expect(parseEventLog('')).toEqual([]);
    expect(parseEventLog('﻿  \r\n')).toEqual([]);
    expect(parseEventLog(JSON.stringify(ev(1, 1)))).toHaveLength(1);
    const many = parseEventLog(JSON.stringify([ev(1, 1), ev(2, 2), ev(3, 3), ev(4, 4), { nope: true }, 'x', ev(5, 2, { log: 'Security' }), ev(6, 2, { rec: 'abc' })]));
    expect(many.map((e) => [e.recordId, e.level])).toEqual([[1, 'critical'], [2, 'error'], [3, 'warning']]);
    expect(parseEventLog(JSON.stringify([ev(1, 2, { msg: 'x'.repeat(5000) })]))[0]!.message).toHaveLength(2000);
    expect(parseEventLog(JSON.stringify([ev(1, 2, { msg: null, provider: null, id: null })]))[0]).toMatchObject({ message: null, provider: null, eventId: null });
    expect(() => parseEventLog('not json')).toThrow(/valid JSON/);
  });

  function collector(output: () => string) {
    const db = openDb(':memory:');
    migrate(db);
    const state = new StateStore();
    const scripts: string[] = [];
    const c = eventLogCollector({ db, state, now: () => NOW, ps: async (s) => (scripts.push(s), output()) });
    return { db, state, c, scripts };
  }

  it('stores new events once, looks back an hour the first time and from the newest event afterwards', async () => {
    let out = JSON.stringify([ev(1, 1), ev(2, 2)]);
    const { db, state, c, scripts } = collector(() => out);
    await c.run();
    expect(scripts[0]).toContain(`FromUnixTimeMilliseconds(${NOW - 3_600_000})`);
    expect(db.prepare('SELECT COUNT(*) AS n FROM windows_events').get()).toEqual({ n: 2 });
    expect(state.getEventLog()).toMatchObject({ added: 2, criticalLast5m: 1, lastCritical: { provider: 'disk', eventId: 7, logName: 'System' } });

    out = JSON.stringify([ev(1, 1), ev(2, 2), ev(3, 3)]); // an overlapping answer: two duplicates and one new
    await c.run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM windows_events').get()).toEqual({ n: 3 });
    expect(state.getEventLog()!.added).toBe(1);
    const newest = NOW - 1000; // record 1 is the newest by timestamp
    expect(scripts[1]).toContain(`FromUnixTimeMilliseconds(${newest - 60_000})`);
  });

  it('a failing read leaves the previous state alone', async () => {
    let fail = false;
    const { state, c } = collector(() => {
      if (fail) throw new Error('powershell timed out');
      return JSON.stringify([ev(1, 1)]);
    });
    await c.run();
    fail = true;
    await expect(c.run()).rejects.toThrow(/timed out/);
    expect(state.getEventLog()!.criticalLast5m).toBe(1);
  });

  describe('rule host.eventlog_critical', () => {
    let clock: { t: number };
    let state: StateStore;
    let repo: AlertRepo;
    let engine: AlertEngine;
    let db: Db;
    const stale = new Set<string>();

    beforeEach(() => {
      clock = { t: NOW };
      const now = () => clock.t;
      db = openDb(':memory:');
      migrate(db);
      state = new StateStore();
      repo = new AlertRepo(db, now);
      stale.clear();
      const settings = new Settings(db, now);
      const notifier = new Notifier({ mailer: null, repo, settings, config: { alertFrom: undefined, publicDashboardUrl: undefined, resendApiKey: undefined }, log: { warn: () => undefined, info: () => undefined }, now, sleep: async () => undefined });
      const logs: LogStatus = { volumeOk: true, volumeReason: null, volumeUsedPct: 1, droppedLines: 0, skippedLines: 0, writerQueue: 0 };
      engine = new AlertEngine({
        repo, state, settings, notifier,
        collectors: (): CollectorStatus[] => ['host', 'disk', 'system', 'pm2', 'eventlog'].map((name) => ({ name, intervalMs: 1000, lastOkAt: clock.t, stale: stale.has(name) })),
        logs: () => logs, persistence: () => ({ consecutiveFailures: 0 }), log: { warn: () => undefined, info: () => undefined }, now,
      });
    });
    const keys = () => repo.firing().map((x) => x.rule_key).filter((k) => k === 'host.eventlog_critical');
    const tick = async (secs: number, crit: { ts: number } | null) => {
      for (let i = 0; i < secs / 5; i++) {
        clock.t += 5_000;
        state.setEventLog({ at: clock.t, added: 0, lastCritical: crit ? { ts: crit.ts, logName: 'System', provider: 'Kernel-Power', eventId: 41 } : null, criticalLast5m: crit ? 1 : 0 });
        await engine.tick();
      }
    };

    it('is silent when nothing is collecting (not Windows)', async () => {
      for (let i = 0; i < 20; i++) {
        clock.t += 5_000;
        await engine.tick();
      }
      expect(keys()).toEqual([]);
    });

    it('opens at once for a new critical event, names provider and id but not the message, and resolves later', async () => {
      await tick(10, null);
      expect(keys()).toEqual([]);
      await tick(10, { ts: clock.t - 2_000 });
      expect(keys()).toEqual(['host.eventlog_critical']);
      const s = repo.firing()[0]!.summary;
      expect(s).toContain('Kernel-Power');
      expect(s).toContain('41');
      expect(s).toContain('System');
      const last = clock.t - 22_000;
      await tick(280, { ts: last }); // still inside five minutes of the event
      expect(keys()).toEqual(['host.eventlog_critical']);
      await tick(200, { ts: last }); // the event is old now
      expect(keys()).toEqual([]);
    });

    it('is paused while the event log collector is stale', async () => {
      stale.add('eventlog');
      await tick(60, { ts: clock.t });
      expect(keys()).toEqual([]);
    });
  });
});

describe('GET /events/windows', () => {
  it('lists stored events, filters by level, and says whether collection is on', async () => {
    const t = await makeApp();
    try {
      await addUser(t, { role: 'engineer' });
      const { cookie } = await login(t);
      expect((await t.app.inject({ method: 'GET', url: '/api/v1/events/windows' })).statusCode).toBe(401);
      const ins = t.db.prepare('INSERT INTO windows_events (log_name, record_id, ts, level, provider, event_id, message) VALUES (?, ?, ?, ?, ?, ?, ?)');
      ins.run('System', 1, NOW - 3000, 'critical', 'Kernel-Power', 41, 'The system rebooted without cleanly shutting down');
      ins.run('Application', 2, NOW - 2000, 'error', 'App', 1000, 'crash');
      ins.run('System', 3, NOW - 1000, 'warning', 'disk', 51, 'paging');
      let r = (await t.app.inject({ method: 'GET', url: '/api/v1/events/windows', headers: authed(cookie!) })).json();
      expect(r.collecting).toBe(false);
      expect(r.events.map((e: { recordId: number }) => e.recordId)).toEqual([3, 2, 1]);
      r = (await t.app.inject({ method: 'GET', url: '/api/v1/events/windows?level=critical', headers: authed(cookie!) })).json();
      expect(r.events).toHaveLength(1);
      expect(r.events[0]).toMatchObject({ provider: 'Kernel-Power', eventId: 41 });
      t.ctx.state.setEventLog({ at: NOW, added: 0, lastCritical: null, criticalLast5m: 0 });
      r = (await t.app.inject({ method: 'GET', url: '/api/v1/events/windows?limit=1', headers: authed(cookie!) })).json();
      expect(r.collecting).toBe(true);
      expect(r.events).toHaveLength(1);
    } finally {
      await t.close();
    }
  });
});
