import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { logKeyOf, parseLogKey, type AgentContainer, type AgentLogs, type AgentMetrics } from '@cc/shared';
import { deleteExpired, hostServiceDir, hourKey, listLogFiles } from '../src/logs/files';
import { addUser, authed, login, makeApp, type TestApp } from './helpers';

/**
 * Phase 11 M3 on the monitor: container logs from an agent host are stored per service under
 * `@<host name>/<project>.<service>`, searchable and tailed by log key, and a service switched off
 * on its page is neither stored nor followed (TRD 14.5, 14.6).
 */

const VERSION = '0.3.0';
const H = 3_600_000;

const ctr = (key: string): AgentContainer => ({
  key,
  name: key.slice(key.indexOf('/') + 1),
  instances: 1,
  instancesRunning: 1,
  state: 'running',
  health: null,
  restartsTotal: 0,
  cpuPct: 1,
  memBytes: 1e6,
  startedAt: 1_799_999_000_000,
});

const metrics = (ts: number): AgentMetrics => ({
  v: 1,
  ts,
  actions: 'on',
  host: {
    cpuPct: 1,
    cpuPerCore: [1],
    memUsedBytes: 1,
    memTotalBytes: 2,
    swapUsedBytes: 0,
    swapTotalBytes: 0,
    netRxBps: 0,
    netTxBps: 0,
    uptimeS: 1,
    pendingReboot: false,
    disks: [{ volume: '/', usedBytes: 1, totalBytes: 2 }],
  },
  containers: [ctr('acs/api'), ctr('acs/caddy')],
});

describe('container logs from agent hosts (M3)', () => {
  let t: TestApp;
  let admin: string;
  let token: string;
  let hostId: number;
  afterEach(async () => t?.close());

  async function setup() {
    t = await makeApp();
    t.clock.t = Math.floor(1_800_000_000_000 / H) * H + 30 * 60_000; // half past an hour
    await addUser(t);
    admin = (await login(t)).cookie!;
    const created = await t.app.inject({ method: 'POST', url: '/api/v1/hosts', headers: authed(admin), payload: { name: 'ubuntu-acs' } });
    const enrolled = await t.app.inject({
      method: 'POST',
      url: '/agent/v1/enroll',
      headers: { 'content-type': 'application/json' },
      payload: { enrollToken: created.json().enrollToken, hostname: 'acs-prod', os: 'linux', agentVersion: VERSION },
    });
    token = enrolled.json().token;
    hostId = created.json().host.id;
    expect((await push('metrics', metrics(t.clock.t))).statusCode).toBe(204);
  }

  const push = (route: string, body: unknown) =>
    t.app.inject({
      method: 'POST',
      url: `/agent/v1/${route}`,
      headers: { authorization: `Bearer ${token}`, 'x-agent-version': VERSION, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  const logs = (batches: AgentLogs['batches']) => push('logs', { v: 1, batches });
  const search = (body: Record<string, unknown>) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/logs/search',
      headers: authed(admin),
      payload: { from: t.clock.t - 2 * H, to: t.clock.t + 1000, ...body },
    });
  const service = (key: string) => t.ctx.services.getBySource(hostId, key)!;
  const readStored = (dir: string, hourMs: number) =>
    fs
      .readFileSync(path.join(t.ctx.config.logRoot, dir, `${hourKey(hourMs)}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { ts: number; svc: string; s: string; msg: string });

  it('log keys name host 1 services by their PM2 name and other hosts’ services with @<id>/', () => {
    expect(logKeyOf(1, 'api')).toBe('api');
    expect(logKeyOf(2, 'acs/api')).toBe('@2/acs/api');
    expect(parseLogKey('@2/acs/api')).toEqual({ hostId: 2, sourceKey: 'acs/api' });
    expect(parseLogKey('api')).toEqual({ hostId: 1, sourceKey: 'api' });
    expect(parseLogKey('@1/x')).toEqual({ hostId: 1, sourceKey: '@1/x' });
    expect(hostServiceDir('ubuntu-acs', 'acs/genieacs-cwmp')).toBe('@ubuntu-acs/acs.genieacs-cwmp');
  });

  it('stores lines in the host’s folder, answers with the exclusions and the limit, and finds them by log key', async () => {
    await setup();
    const r = await logs([
      {
        service: 'acs/api',
        lines: [
          { ts: t.clock.t - 1000, s: 'out', msg: 'GET /devices 200' },
          { ts: t.clock.t - 500, s: 'err', msg: 'warn: slow inform' },
        ],
        dropped: 0,
      },
    ]);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ excluded: [], linesPerS: 200 });
    await t.ctx.logs.writer.flushNow();

    const dir = '@ubuntu-acs/acs.api';
    expect(readStored(dir, t.clock.t)).toEqual([
      { ts: t.clock.t - 1000, svc: `@${hostId}/acs/api`, pm: -1, s: 'out', msg: 'GET /devices 200' },
      { ts: t.clock.t - 500, svc: `@${hostId}/acs/api`, pm: -1, s: 'err', msg: 'warn: slow inform' },
    ]);
    expect((await listLogFiles(t.ctx.config.logRoot)).map((f) => f.dir)).toEqual([dir]);

    const key = `@${hostId}/acs/api`;
    const found = await search({ services: [key], query: 'slow' });
    expect(found.statusCode).toBe(200);
    expect(found.json().lines.map((l: { svc: string; msg: string }) => [l.svc, l.msg])).toEqual([[key, 'warn: slow inform']]);
    // Not a PM2 name on host 1, an unknown host, or a service that host does not have.
    expect((await search({ services: ['acs/api'] })).json().error).toBe('unknown_service');
    expect((await search({ services: ['@9/acs/api'] })).json().error).toBe('unknown_service');
    expect((await search({ services: [`@${hostId}/acs/nope`] })).json().error).toBe('unknown_service');

    // The live tail reads the same stream.
    expect(t.ctx.logs.pipeline.tail(key, 10).map((l) => l.msg)).toEqual(['GET /devices 200', 'warn: slow inform']);
    const dto = (await t.app.inject({ method: 'GET', url: `/api/v1/services/${service('acs/api').id}`, headers: authed(admin) })).json();
    expect(dto.service).toMatchObject({ logKey: key, logExcluded: false });
    expect(dto.logs).toMatchObject({ lines: 2, dropped: 0 });
  });

  it('counts lines dropped over the limit and says so in the service’s log', async () => {
    await setup();
    await logs([{ service: 'acs/api', lines: [{ ts: t.clock.t, s: 'out', msg: 'burst' }], dropped: 340 }]);
    await t.ctx.logs.writer.flushNow();
    const stored = readStored('@ubuntu-acs/acs.api', t.clock.t);
    expect(stored.map((l) => [l.s, l.msg])).toEqual([
      ['out', 'burst'],
      ['err', '[monitor] 340 lines dropped by the agent on ubuntu-acs (over the limit of 200 lines/s, or its buffer was full)'],
    ]);
    expect(t.ctx.hosts.countsOf(hostId)).toMatchObject({ logs: 1, logLines: 1, logDropped: 340, logIgnored: 0 });
    expect(t.ctx.remoteLogs.statsOf(service('acs/api').id)).toMatchObject({ lines: 1, dropped: 340 });
  });

  it('files lines the agent held back under the hour they were written', async () => {
    await setup();
    const earlier = t.clock.t - H;
    await logs([{ service: 'acs/api', lines: [{ ts: earlier, s: 'out', msg: 'from the buffer' }, { ts: t.clock.t, s: 'out', msg: 'now' }], dropped: 0 }]);
    await t.ctx.logs.writer.flushNow();
    expect(readStored('@ubuntu-acs/acs.api', earlier).map((l) => l.msg)).toEqual(['from the buffer']);
    expect(readStored('@ubuntu-acs/acs.api', t.clock.t).map((l) => l.msg)).toEqual(['now']);
    // A line stamped in the future goes to the current hour.
    await logs([{ service: 'acs/api', lines: [{ ts: t.clock.t + 2 * H, s: 'out', msg: 'ahead' }], dropped: 0 }]);
    await t.ctx.logs.writer.flushNow();
    expect(readStored('@ubuntu-acs/acs.api', t.clock.t).map((l) => l.msg)).toEqual(['now', 'ahead']);
  });

  it('switching a service off stops storing its lines and tells the agent; only for containers and admins', async () => {
    await setup();
    const id = service('acs/caddy').id;
    const patch = (cookie: string, sid: number, body: unknown) =>
      t.app.inject({ method: 'PATCH', url: `/api/v1/services/${sid}`, headers: authed(cookie), payload: body as object });

    const off = await patch(admin, id, { logExcluded: true });
    expect(off.statusCode).toBe(200);
    expect(off.json().service.logExcluded).toBe(true);
    const audit = t.db.prepare("SELECT detail FROM audit_log WHERE event = 'service_updated' ORDER BY id DESC LIMIT 1").get() as { detail: string };
    expect(JSON.parse(audit.detail)).toMatchObject({ serviceId: id, changed: ['logExcluded'], hostId, logExcluded: true });

    const r = await logs([
      { service: 'acs/caddy', lines: [{ ts: t.clock.t, s: 'out', msg: 'still in flight' }], dropped: 0 },
      { service: 'acs/unknown', lines: [{ ts: t.clock.t, s: 'out', msg: 'x' }], dropped: 0 },
    ]);
    expect(r.json()).toEqual({ excluded: ['acs/caddy'], linesPerS: 200 });
    await t.ctx.logs.writer.flushNow();
    expect(await listLogFiles(t.ctx.config.logRoot)).toEqual([]);
    expect(t.ctx.hosts.countsOf(hostId)).toMatchObject({ logLines: 2, logIgnored: 2 });

    t.ctx.settings.setMany({ 'hosts.log_lines_per_s': 50 }, null);
    expect((await patch(admin, id, { logExcluded: false })).statusCode).toBe(200);
    expect((await logs([])).json()).toEqual({ excluded: [], linesPerS: 50 });

    // PM2 services on host 1 have no agent to tell.
    const pm2 = t.ctx.services.discover('api');
    expect((await patch(admin, pm2.id, { logExcluded: true })).statusCode).toBe(400);
    await addUser(t, { username: 'eng', role: 'engineer' });
    const eng = (await login(t, 'eng')).cookie!;
    expect((await patch(eng, id, { logExcluded: true })).statusCode).toBe(403);
  });

  it('retention and the disk guard reach the other hosts’ folders', async () => {
    await setup();
    const root = t.ctx.config.logRoot;
    const old = t.clock.t - 30 * H;
    fs.mkdirSync(path.join(root, '@ubuntu-acs', 'acs.api'), { recursive: true });
    fs.writeFileSync(path.join(root, '@ubuntu-acs', 'acs.api', `${hourKey(old)}.jsonl.gz`), '');
    fs.writeFileSync(path.join(root, '@ubuntu-acs', 'acs.api', `${hourKey(t.clock.t)}.jsonl`), '');
    expect(await deleteExpired(root, t.clock.t, 24)).toBe(1);
    expect((await listLogFiles(root)).map((f) => f.name)).toEqual([`${hourKey(t.clock.t)}.jsonl`]);
  });
});
