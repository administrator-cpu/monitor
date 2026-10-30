import { afterEach, describe, expect, it } from 'vitest';
import type { AgentContainer, AgentMetrics, LiveMessage } from '@cc/shared';
import { createEvaluators, type EvalContext } from '../src/alerts/evaluators';
import type { RuleRow } from '../src/alerts/rules';
import { migrate, openDb } from '../src/db';
import { containerStatus } from '../src/hosts/containers';
import { tlsCollector } from '../src/nginx/collector';
import { StateStore } from '../src/state';
import { addUser, authed, login, makeApp, type TestApp } from './helpers';

/**
 * Phase 11 M2 on the monitor: an agent host's containers become services, their events are
 * stored, and the host and service rules run for that host (TRD 14.5, 14.8).
 */

const VERSION = '0.2.0';

const ctr = (key: string, over: Partial<AgentContainer> = {}): AgentContainer => ({
  key,
  name: key.slice(key.indexOf('/') + 1),
  instances: 1,
  instancesRunning: 1,
  state: 'running',
  health: null,
  restartsTotal: 0,
  cpuPct: 1.25,
  memBytes: 50e6,
  startedAt: 1_799_999_000_000,
  ...over,
});

function metrics(ts: number, over: Partial<AgentMetrics> = {}): AgentMetrics {
  return {
    v: 1,
    ts,
    actions: 'on',
    host: {
      cpuPct: 20,
      cpuPerCore: [20, 20],
      memUsedBytes: 2e9,
      memTotalBytes: 8e9,
      swapUsedBytes: 0,
      swapTotalBytes: 0,
      netRxBps: 10,
      netTxBps: 20,
      uptimeS: 3600,
      pendingReboot: false,
      disks: [{ volume: '/', usedBytes: 30, totalBytes: 100 }],
    },
    containers: [ctr('acs/api'), ctr('acs/cpe-sim'), ctr('cc-agent/cc-node-agent', { own: true })],
    ...over,
  };
}

describe('agent hosts in the monitor (M2)', () => {
  let t: TestApp;
  let admin: string;
  let token: string;
  let hostId: number;
  afterEach(async () => t?.close());

  async function setup() {
    t = await makeApp();
    await addUser(t);
    admin = (await login(t)).cookie!;
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/v1/hosts',
      headers: authed(admin),
      payload: { name: 'ubuntu-acs' },
    });
    const enrolled = await t.app.inject({
      method: 'POST',
      url: '/agent/v1/enroll',
      headers: { 'content-type': 'application/json' },
      payload: { enrollToken: created.json().enrollToken, hostname: 'acs-prod', os: 'linux', agentVersion: VERSION },
    });
    token = enrolled.json().token;
    hostId = created.json().host.id;
  }

  const push = (route: string, body: unknown) =>
    t.app.inject({
      method: 'POST',
      url: `/agent/v1/${route}`,
      headers: { authorization: `Bearer ${token}`, 'x-agent-version': VERSION, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  const report = async (over: Partial<AgentMetrics> = {}) => {
    const r = await push('metrics', metrics(t.clock.t, over));
    expect(r.statusCode).toBe(204);
  };
  const get = (url: string) => t.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: authed(admin) });
  const incidents = (key: string) =>
    t.db
      .prepare(
        `SELECT i.fingerprint, i.host_id, i.service_id, i.state, i.summary, i.suppressed_by FROM alert_incidents i
         JOIN alert_rules r ON r.id = i.rule_id WHERE r.key = ? ORDER BY i.id`,
      )
      .all(key) as {
      fingerprint: string;
      host_id: number;
      service_id: number | null;
      state: string;
      summary: string;
      suppressed_by: number | null;
    }[];
  const ruleSeconds = (key: string) =>
    (t.db.prepare('SELECT duration_s FROM alert_rules WHERE key = ?').get(key) as { duration_s: number }).duration_s;
  /** Reports every 10 s for `ms`, evaluating the rules after each report. */
  const run = async (ms: number, over: () => Partial<AgentMetrics> = () => ({})) => {
    for (let i = 0; i < ms / 10_000; i++) {
      await report(over());
      t.ctx.alerts.evaluate();
      t.clock.t += 10_000;
    }
  };

  it('turns the container list into services of that host, keyed <project>/<service>', async () => {
    await setup();
    await report();
    const rows = t.db
      .prepare('SELECT host_id, kind, name, source_key, is_archived FROM services WHERE host_id = ? ORDER BY source_key')
      .all(hostId);
    expect(rows).toEqual([
      { host_id: 2, kind: 'container', name: 'api', source_key: 'acs/api', is_archived: 0 },
      { host_id: 2, kind: 'container', name: 'cpe-sim', source_key: 'acs/cpe-sim', is_archived: 0 },
      { host_id: 2, kind: 'container', name: 'cc-node-agent', source_key: 'cc-agent/cc-node-agent', is_archived: 0 },
    ]);

    // Host 1 by default, so pages that predate phase 11 are unchanged; ?host= and ?host=all for the switcher.
    expect((await get('/services')).json().services.every((s: { hostId: number }) => s.hostId === 1)).toBe(true);
    const two = (await get('/services?host=2')).json().services;
    expect(two.map((s: { sourceKey: string }) => s.sourceKey)).toEqual(['acs/api', 'cc-agent/cc-node-agent', 'acs/cpe-sim']);
    expect(two[0]).toMatchObject({ kind: 'container', hostId: 2, process: { status: 'online', instances: 1, cpuPct: 1.3, uptimeS: 1000 } });
    expect((await get('/services?host=all')).json().services.some((s: { hostId: number }) => s.hostId === 2)).toBe(true);
    expect((await get('/services?host=x')).statusCode).toBe(400);

    // The 10 s process rows are stored like PM2's.
    t.clock.t += 20_000;
    t.ctx.persistence.flush();
    const stored = t.db
      .prepare('SELECT COUNT(*) AS n FROM metrics_process p JOIN services s ON s.id = p.service_id WHERE s.host_id = 2')
      .get() as { n: number };
    expect(stored.n).toBe(3);
  });

  it('maps Docker states to the dashboard statuses', () => {
    expect(
      (['running', 'restarting', 'removing', 'dead', 'exited', 'paused', 'created'] as const).map(containerStatus),
    ).toEqual(['online', 'launching', 'stopping', 'errored', 'stopped', 'stopped', 'stopped']);
  });

  it('opens "service down" for a stopped container, naming the host, and resolves when it runs again', async () => {
    await setup();
    const stopped = () => ({
      containers: [ctr('acs/api'), ctr('acs/cpe-sim', { state: 'exited', instancesRunning: 0 }), ctr('cc-agent/cc-node-agent', { own: true })],
    });
    await run(10_000);
    await run((ruleSeconds('pm2.service_down') + 20) * 1000, stopped);
    const cpe = (t.db.prepare("SELECT id FROM services WHERE source_key = 'acs/cpe-sim'").get() as { id: number }).id;
    expect(incidents('pm2.service_down')).toEqual([
      expect.objectContaining({ fingerprint: `pm2.service_down:${cpe}`, host_id: 2, service_id: cpe, state: 'firing', summary: 'Service cpe-sim on ubuntu-acs is stopped (0 of 1 instances online)' }),
    ]);
    await run(Math.max(60, ruleSeconds('pm2.service_down') * 2) * 1000 + 20_000);
    expect(incidents('pm2.service_down').map((i) => i.state)).toEqual(['resolved']);
  });

  it('keeps an agent host’s incidents unchanged while it is silent, hidden behind host.silent', async () => {
    await setup();
    await run((ruleSeconds('pm2.service_down') + 20) * 1000, () => ({
      containers: [ctr('acs/cpe-sim', { state: 'exited', instancesRunning: 0 })],
    }));
    expect(incidents('pm2.service_down').map((i) => i.state)).toEqual(['firing']);

    // The agent stops. Its last list said "stopped"; nothing new is known, so nothing resolves.
    for (let i = 0; i < 60; i++) {
      t.clock.t += 10_000;
      t.ctx.alerts.evaluate();
    }
    const silent = incidents('host.silent');
    expect(silent).toMatchObject([{ fingerprint: 'host.silent:@2/', state: 'firing' }]);
    const down = incidents('pm2.service_down');
    expect(down).toMatchObject([{ state: 'firing' }]);
    const silentId = (t.db.prepare("SELECT id FROM alert_incidents WHERE fingerprint = 'host.silent:@2/'").get() as { id: number }).id;
    expect(down[0]!.suppressed_by).toBe(silentId);
  });

  it('counts restarts reported by the agent as a crash loop', async () => {
    await setup();
    const limit = (t.db.prepare("SELECT threshold FROM alert_rules WHERE key = 'pm2.crash_loop'").get() as { threshold: number }).threshold;
    let restarts = 0;
    await run(10_000);
    await run((limit + ruleSeconds('pm2.crash_loop') / 10 + 3) * 10_000, () => ({
      containers: [ctr('acs/cpe-sim', { restartsTotal: ++restarts })],
    }));
    expect(incidents('pm2.crash_loop')).toMatchObject([{ host_id: 2, state: 'firing', summary: expect.stringMatching(/^Service cpe-sim on ubuntu-acs restarted \d+ times/) }]);
  });

  it('runs the host rules for the agent host with prefixed targets; host 1 keeps its fingerprints', async () => {
    await setup();
    const full = () => ({
      host: { ...metrics(0).host, cpuPct: 99, memUsedBytes: 7.9e9, disks: [{ volume: '/', usedBytes: 99, totalBytes: 100 }] },
    });
    // Host 1 needs a disk reading of its own for its disk rule.
    t.ctx.state.setDisks([{ volume: 'C:', usedBytes: 99, totalBytes: 100, readBps: null, writeBps: null }], t.clock.t);
    const longest = Math.max(...['host.disk_high', 'host.disk_critical', 'host.cpu_high', 'host.mem_high'].map(ruleSeconds));
    await run((longest + 20) * 1000, () => {
      t.ctx.state.setDisks([{ volume: 'C:', usedBytes: 99, totalBytes: 100, readBps: null, writeBps: null }], t.clock.t);
      return full();
    });
    expect(incidents('host.disk_critical').map((i) => [i.fingerprint, i.host_id])).toEqual([
      ['host.disk_critical:C:', 1],
      ['host.disk_critical:@2//', 2],
    ]);
    expect(incidents('host.cpu_high').map((i) => [i.fingerprint, i.summary])).toEqual([
      ['host.cpu_high:@2/', 'CPU on ubuntu-acs is at 99.0% (limit 90%)'],
    ]);
    expect(incidents('host.mem_high').map((i) => i.fingerprint)).toEqual(['host.mem_high:@2/']);
  });

  it('judges agent hosts while this server’s collectors are stale, and leaves host 1 alone', () => {
    const state = new StateStore();
    state.setDisks([{ volume: 'C:', usedBytes: 99, totalBytes: 100, readBps: null, writeBps: null }], 1000);
    const slice = state.ensureHost(2);
    slice.setDisks([{ volume: '/', usedBytes: 99, totalBytes: 100, readBps: null, writeBps: null }], 1000);
    const judged = new Set<number>();
    const c: EvalContext = {
      now: 2000,
      state,
      collectors: () => [],
      logs: () => ({}) as never,
      persistence: () => ({ consecutiveFailures: 0 }),
      email: () => ({ consecutiveFailures: 0 }),
      agentEnabled: () => false,
      emailBadSince: () => 0,
      agentHosts: () => [{ id: 2, name: 'ubuntu-acs', lastSeenAt: 2000 }],
      localStale: true,
      judged,
    };
    const rule = { key: 'host.disk_high', threshold: 85, params: null } as RuleRow;
    const obs = createEvaluators()['host.disk_high']!(rule, c)!;
    expect(obs.map((o) => [o.target, o.hostId, o.active])).toEqual([['@2//', 2, true]]);
    expect([...judged]).toEqual([2]);

    // Too old to be evidence (more than 35 s): host 2 is not judged either.
    const later = createEvaluators()['host.disk_high']!(rule, { ...c, now: 40_000, judged: new Set() })!;
    expect(later).toEqual([]);
  });

  it('archives a container service the agent no longer lists, and never on a list of only its own containers', async () => {
    await setup();
    t.ctx.settings.setMany({ 'pm2.auto_archive_minutes': 1 }, null);
    await report();
    const only = (...keys: string[]) => ({ containers: keys.map((k) => ctr(k, { own: k.startsWith('cc-agent/') })) });

    // Only the agent's own project listed: nothing is archived, the others show as stopped.
    await run(90_000, () => only('cc-agent/cc-node-agent'));
    const archived = () =>
      (t.db.prepare('SELECT source_key FROM services WHERE host_id = 2 AND is_archived = 1 ORDER BY source_key').all() as { source_key: string }[]).map((r) => r.source_key);
    expect(archived()).toEqual([]);
    const cpe = (await get('/services?host=2')).json().services.find((s: { sourceKey: string }) => s.sourceKey === 'acs/cpe-sim');
    expect(cpe.process).toMatchObject({ status: 'stopped', instances: 0 });

    // cpe-sim removed while api is still listed: archived after the setting's minute, and audited.
    await run(90_000, () => only('acs/api', 'cc-agent/cc-node-agent'));
    expect(archived()).toEqual(['acs/cpe-sim']);
    const audit = t.db.prepare("SELECT detail FROM audit_log WHERE event = 'service_updated'").all() as { detail: string }[];
    expect(audit.map((a) => JSON.parse(a.detail))).toEqual([
      expect.objectContaining({ hostId: 2, sourceKey: 'acs/cpe-sim', auto: true, reason: 'not listed by the agent' }),
    ]);

    // Listed again: back.
    await report();
    expect(archived()).toEqual([]);
  });

  it('refuses to archive by hand a container its agent still lists', async () => {
    await setup();
    await report();
    const id = (t.db.prepare("SELECT id FROM services WHERE source_key = 'acs/api'").get() as { id: number }).id;
    const r = await t.app.inject({ method: 'PATCH', url: `/api/v1/services/${id}`, headers: authed(admin), payload: { isArchived: true } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('service_active');
  });

  it('stores container events with the service, keeps the last exit, drops unknown ones', async () => {
    await setup();
    await report();
    const r = await push('events', {
      v: 1,
      events: [
        { ts: t.clock.t - 1000, service: 'acs/cpe-sim', event: 'die', detail: { exitCode: 137 } },
        { ts: t.clock.t - 900, service: 'acs/cpe-sim', event: 'start' },
        { ts: t.clock.t - 800, service: 'acs/unknown', event: 'start' },
        { ts: 1_000_000_000_000, service: 'acs/api', event: 'oom' }, // agent clock far off
      ],
    });
    expect(r.statusCode).toBe(204);
    t.ctx.persistence.flush();
    const rows = t.db
      .prepare('SELECT s.source_key, e.event, e.detail, e.ts FROM process_events e JOIN services s ON s.id = e.service_id ORDER BY e.id')
      .all() as { source_key: string; event: string; detail: string | null; ts: number }[];
    expect(rows.map((x) => [x.source_key, x.event, x.detail])).toEqual([
      ['acs/cpe-sim', 'die', '{"exitCode":137}'],
      ['acs/cpe-sim', 'start', null],
      ['acs/api', 'oom', null],
    ]);
    expect(rows[2]!.ts).toBe(t.clock.t);

    await report();
    const cpe = (await get('/services?host=2')).json().services.find((s: { sourceKey: string }) => s.sourceKey === 'acs/cpe-sim');
    expect(cpe.process.lastExit).toEqual({ at: t.clock.t - 1000, code: 137, signal: null });
    const detail = (await get(`/services/${cpe.id}`)).json();
    expect(detail.events.map((e: { event: string }) => e.event)).toEqual(['start', 'die']);
  });

  it('serves an agent host’s figures and agent state on /host?host=, and lists hosts in the live message', async () => {
    await setup();
    await report({
      agent: { droppedLogLines: 3, bufferBytes: 1024, collectors: [{ name: 'docker', lastOkAt: t.clock.t, error: null }] },
    });
    const h = (await get(`/host?host=${hostId}`)).json();
    expect(h).toMatchObject({
      hostId: 2,
      host: { cpuPct: 20, disks: [{ volume: '/' }] },
      collectors: [],
      agent: { version: VERSION, actionsEnabled: true, droppedLogLines: 3, collectors: [{ name: 'docker' }] },
    });
    expect(h.series.cpuPct).toEqual([20]);
    expect((await get('/host')).json()).toMatchObject({ hostId: 1, agent: null });
    expect((await get('/host?host=99')).statusCode).toBe(404);

    const live = t.ctx.hub.buildLive() as LiveMessage;
    expect(live.hosts).toEqual([
      { id: 1, name: 'windows-vps', kind: 'local', os: 'windows', status: 'local' },
      { id: 2, name: 'ubuntu-acs', kind: 'agent', os: 'linux', status: 'online' },
    ]);
    // Host 1's live view is unchanged by host 2's services.
    expect(live.services.every((s) => s.process.serviceId < 100 && !s.process.pm2Name.includes('/'))).toBe(true);
  });

  it('leaves the services of a host that sent no container section as they were', async () => {
    await setup();
    await report();
    const before = t.ctx.state.getProcessesAt(hostId);
    t.clock.t += 10_000;
    const { containers: _c, ...noDocker } = metrics(t.clock.t);
    expect((await push('metrics', noDocker)).statusCode).toBe(204);
    expect(t.ctx.state.getProcessesAt(hostId)).toBe(before);
  });
});

describe('migration 011: certificates per host', () => {
  it('keeps every row as host 1 and lets two hosts hold the same name; the TLS collector still upserts', async () => {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare("INSERT INTO tls_certs (host_id, host, not_after, checked_at) VALUES (1, 'acs.thediv.in', 5, 1)").run();
    db.prepare("INSERT INTO tls_certs (host_id, host, not_after, checked_at) VALUES (2, 'acs.thediv.in', 6, 1)").run();
    expect(() => db.prepare("INSERT INTO tls_certs (host_id, host, checked_at) VALUES (2, 'acs.thediv.in', 1)").run()).toThrow(/UNIQUE/);

    const state = new StateStore();
    const c = tlsCollector({ db, state, hosts: () => ['acs.thediv.in'], now: () => 10, check: async () => ({ notAfter: 99, issuer: 'X' }) as never });
    await c.run();
    expect(db.prepare('SELECT host_id, host, not_after FROM tls_certs ORDER BY host_id').all()).toEqual([
      { host_id: 1, host: 'acs.thediv.in', not_after: 99 },
      { host_id: 2, host: 'acs.thediv.in', not_after: 6 },
    ]);
    expect(state.getTlsCerts().map((x) => x.notAfter)).toEqual([99]);
  });
});
