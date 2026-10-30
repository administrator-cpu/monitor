import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMetrics } from '@cc/shared';
import { hostTarget } from '../src/alerts/evaluators';
import { migrate, MIGRATIONS_DIR, openDb } from '../src/db';
import { addUser, authed, login, makeApp, ORIGIN, type TestApp } from './helpers';

const VERSION = '0.1.0';

function metrics(over: Partial<AgentMetrics> = {}, ts = 1_800_000_000_000): AgentMetrics {
  return {
    v: 1,
    ts,
    actions: 'on',
    host: {
      cpuPct: 12.5,
      cpuPerCore: [10, 15],
      memUsedBytes: 2e9,
      memTotalBytes: 8e9,
      swapUsedBytes: 0,
      swapTotalBytes: 1e9,
      netRxBps: 100,
      netTxBps: 200,
      uptimeS: 3600,
      pendingReboot: false,
      disks: [{ volume: '/', usedBytes: 30, totalBytes: 100, readBps: 1, writeBps: 2 }],
    },
    containers: [
      {
        key: 'acs/cpe-sim',
        name: 'acs-cpe-sim-1',
        instances: 1,
        instancesRunning: 1,
        state: 'running',
        health: null,
        restartsTotal: 0,
        cpuPct: 1,
        memBytes: 1e6,
        startedAt: 1_799_999_000_000,
      },
    ],
    ...over,
  };
}

/** Admin creates a host and an agent enrolls with the token. */
async function enrolledHost(t: TestApp, admin: string, name = 'ubuntu-acs') {
  const created = await t.app.inject({
    method: 'POST',
    url: '/api/v1/hosts',
    headers: authed(admin),
    payload: { name },
  });
  expect(created.statusCode).toBe(201);
  const { host, enrollToken } = created.json();
  const res = await enroll(t, enrollToken);
  expect(res.statusCode).toBe(200);
  return {
    hostId: host.id as number,
    token: res.json().token as string,
    enrollToken: enrollToken as string,
  };
}

const enroll = (t: TestApp, enrollToken: string, over: Record<string, unknown> = {}) =>
  t.app.inject({
    method: 'POST',
    url: '/agent/v1/enroll',
    headers: { 'content-type': 'application/json' },
    payload: { enrollToken, hostname: 'acs-prod', os: 'linux', agentVersion: VERSION, ...over },
  });

const push = (
  t: TestApp,
  token: string,
  route: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  t.app.inject({
    method: 'POST',
    url: `/agent/v1/${route}`,
    headers: {
      authorization: `Bearer ${token}`,
      'x-agent-version': VERSION,
      'content-type': 'application/json',
      ...headers,
    },
    payload: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });

describe('migration 010 on a database that already has data', () => {
  it('keeps ids, keys, metrics and open incidents, all as host 1', () => {
    // A database at 009, as production is today.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mig-'));
    for (const f of fs.readdirSync(MIGRATIONS_DIR))
      if (f < '010') fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    const db = openDb(':memory:');
    migrate(db, dir);
    db.prepare(
      "INSERT INTO services (id, name, pm2_name, first_seen_at, last_seen_at, git_repo) VALUES (7, 'Shop', 'shop', 1, 2, 'o/r')",
    ).run();
    db.prepare(
      "INSERT INTO services (id, name, pm2_name, first_seen_at, last_seen_at, is_archived) VALUES (9, 'old', 'old', 1, 2, 1)",
    ).run();
    db.prepare(
      'INSERT INTO metrics_host (res_s, ts, cpu_pct, mem_used_bytes, mem_total_bytes) VALUES (10, 1000, 5, 1, 2), (60, 60000, 6, 1, 2)',
    ).run();
    db.prepare(
      "INSERT INTO metrics_disk (volume, res_s, ts, used_bytes, total_bytes) VALUES ('C:', 10, 1000, 1, 2), ('E:', 10, 1000, 1, 2)",
    ).run();
    db.prepare('INSERT INTO metrics_mongo (res_s, ts, up) VALUES (10, 1000, 1)').run();
    db.prepare(
      "INSERT INTO mongo_slow_queries (ts, namespace, millis) VALUES (1000, 'a.b', 5)",
    ).run();
    db.prepare(
      "INSERT INTO tls_certs (host, not_after, checked_at) VALUES ('monitor.thediv.in', 9, 1)",
    ).run();
    const rule = db.prepare("SELECT id FROM alert_rules WHERE key = 'pm2.service_down'").get() as {
      id: number;
    };
    db.prepare(
      "INSERT INTO alert_incidents (rule_id, service_id, fingerprint, state, opened_at, summary) VALUES (?, 7, 'pm2.service_down:7', 'firing', 1, 'down')",
    ).run(rule.id);
    db.prepare(
      "INSERT INTO service_git (service_id, checked_at, state, data) VALUES (7, 1, 'in_sync', '{}')",
    ).run();
    const counts = (): Record<string, number> =>
      Object.fromEntries(
        [
          'services',
          'metrics_host',
          'metrics_disk',
          'metrics_mongo',
          'mongo_slow_queries',
          'tls_certs',
          'alert_incidents',
          'service_git',
        ].map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]),
      );
    const before = counts();

    expect(migrate(db).applied).toEqual(['010_hosts.sql']);

    expect(counts()).toEqual(before);
    expect(
      db
        .prepare(
          'SELECT id, host_id, kind, name, source_key, is_archived, git_repo, log_excluded FROM services ORDER BY id',
        )
        .all(),
    ).toEqual([
      {
        id: 0,
        host_id: 1,
        kind: 'pseudo',
        name: '_unattributed',
        source_key: '_unattributed',
        is_archived: 0,
        git_repo: null,
        log_excluded: 0,
      },
      {
        id: 7,
        host_id: 1,
        kind: 'pm2',
        name: 'Shop',
        source_key: 'shop',
        is_archived: 0,
        git_repo: 'o/r',
        log_excluded: 0,
      },
      {
        id: 9,
        host_id: 1,
        kind: 'pm2',
        name: 'old',
        source_key: 'old',
        is_archived: 1,
        git_repo: null,
        log_excluded: 0,
      },
    ]);
    for (const t of [
      'metrics_host',
      'metrics_disk',
      'metrics_mongo',
      'mongo_slow_queries',
      'tls_certs',
      'alert_incidents',
    ]) {
      expect(db.prepare(`SELECT DISTINCT host_id FROM ${t}`).all(), t).toEqual([{ host_id: 1 }]);
    }
    expect(db.prepare('SELECT fingerprint, state, service_id FROM alert_incidents').get()).toEqual({
      fingerprint: 'pm2.service_down:7',
      state: 'firing',
      service_id: 7,
    });
    expect(db.prepare('SELECT id, name, kind, os FROM hosts').all()).toEqual([
      { id: 1, name: 'windows-vps', kind: 'local', os: 'windows' },
    ]);
    expect(
      db
        .prepare("SELECT severity, duration_s, category FROM alert_rules WHERE key = 'host.silent'")
        .get(),
    ).toEqual({
      severity: 'critical',
      duration_s: 120,
      category: 'monitor',
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });
});

describe('hosts and agent ingest', () => {
  let t: TestApp;
  let admin: string;
  afterEach(async () => t.close());

  async function setup() {
    t = await makeApp();
    await addUser(t);
    await addUser(t, { username: 'eng', role: 'engineer' });
    admin = (await login(t)).cookie!;
  }

  describe('the Hosts API', () => {
    it('lists this server as host 1 and lets only admins add hosts; the token is shown once', async () => {
      await setup();
      const eng = (await login(t, 'eng')).cookie!;
      const list = (
        await t.app.inject({ method: 'GET', url: '/api/v1/hosts', headers: authed(eng) })
      ).json().hosts;
      expect(list).toMatchObject([
        { id: 1, name: 'windows-vps', kind: 'local', status: 'local', counts: null },
      ]);
      expect(
        (
          await t.app.inject({
            method: 'POST',
            url: '/api/v1/hosts',
            headers: authed(eng),
            payload: { name: 'x1' },
          })
        ).statusCode,
      ).toBe(403);

      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/hosts',
        headers: authed(admin),
        payload: { name: 'ubuntu-acs' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.enrollToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.enrollExpiresAt).toBe(t.clock.t + 60 * 60_000);
      expect(body.host).toMatchObject({
        name: 'ubuntu-acs',
        kind: 'agent',
        os: 'linux',
        status: 'waiting',
        enrolled: false,
      });

      // Never stored or shown again: only its hash is in the database.
      const all =
        JSON.stringify(t.db.prepare('SELECT * FROM hosts').all()) +
        JSON.stringify(t.db.prepare('SELECT * FROM audit_log').all());
      expect(all).not.toContain(body.enrollToken);
      expect(
        JSON.stringify(
          (
            await t.app.inject({ method: 'GET', url: '/api/v1/hosts', headers: authed(admin) })
          ).json(),
        ),
      ).not.toContain(body.enrollToken);
      expect(t.db.prepare("SELECT event FROM audit_log WHERE event LIKE 'host_%'").all()).toEqual([
        { event: 'host_created' },
      ]);
    });

    it('refuses a taken name, a bad name and changes to host 1', async () => {
      await setup();
      const add = (name: string) =>
        t.app.inject({
          method: 'POST',
          url: '/api/v1/hosts',
          headers: authed(admin),
          payload: { name },
        });
      expect((await add('ubuntu-acs')).statusCode).toBe(201);
      expect((await add('Ubuntu-ACS')).statusCode).toBe(400); // lower case only
      expect((await add('ubuntu-acs')).json()).toMatchObject({ error: 'name_taken' });
      expect((await add('windows-vps')).statusCode).toBe(409);
      expect((await add('../etc')).statusCode).toBe(400);
      expect(
        (
          await t.app.inject({
            method: 'POST',
            url: '/api/v1/hosts/1/revoke',
            headers: authed(admin),
          })
        ).json(),
      ).toMatchObject({ error: 'local_host' });
      expect(
        (
          await t.app.inject({
            method: 'POST',
            url: '/api/v1/hosts/1/enroll-token',
            headers: authed(admin),
          })
        ).statusCode,
      ).toBe(400);
      const ren = await t.app.inject({
        method: 'PATCH',
        url: '/api/v1/hosts/2',
        headers: authed(admin),
        payload: { name: 'acs-1', notes: 'Hetzner' },
      });
      expect(ren.json().host).toMatchObject({ name: 'acs-1', notes: 'Hetzner' });
      expect(
        t.db.prepare("SELECT detail FROM audit_log WHERE event = 'host_updated'").get(),
      ).toEqual({
        detail: JSON.stringify({
          hostId: 2,
          hostName: 'acs-1',
          changed: ['name', 'notes'],
          from: 'ubuntu-acs',
        }),
      });
    });
  });

  describe('enrollment', () => {
    it('works once, and not after an hour', async () => {
      await setup();
      const created = (
        await t.app.inject({
          method: 'POST',
          url: '/api/v1/hosts',
          headers: authed(admin),
          payload: { name: 'ubuntu-acs' },
        })
      ).json();
      const first = await enroll(t, created.enrollToken);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ hostId: 2, hostName: 'ubuntu-acs' });
      expect(first.json().token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await enroll(t, created.enrollToken)).json()).toEqual({
        error: 'enroll_token_invalid',
      });

      const again = (
        await t.app.inject({
          method: 'POST',
          url: '/api/v1/hosts/2/enroll-token',
          headers: authed(admin),
        })
      ).json();
      t.clock.t += 60 * 60_000; // exactly one hour later
      const late = await enroll(t, again.enrollToken);
      expect(late.statusCode).toBe(401);
      expect(late.json()).toEqual({ error: 'enroll_token_expired' });

      const row = t.db
        .prepare('SELECT token_hash, enroll_hash, notes, agent_version FROM hosts WHERE id = 2')
        .get() as Record<string, string>;
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.notes).toBe('Reported hostname: acs-prod');
      expect(row.agent_version).toBe(VERSION);
      expect(JSON.stringify(t.db.prepare('SELECT * FROM hosts').all())).not.toContain(
        first.json().token,
      );
      expect(
        t.db
          .prepare("SELECT event FROM audit_log WHERE event LIKE 'host_%' ORDER BY id")
          .all()
          .map((r) => (r as { event: string }).event),
      ).toEqual(['host_created', 'host_enrolled', 'host_token_rotated']);
    });

    it('refuses a token for another operating system without using it up', async () => {
      await setup();
      const created = (
        await t.app.inject({
          method: 'POST',
          url: '/api/v1/hosts',
          headers: authed(admin),
          payload: { name: 'ubuntu-acs' },
        })
      ).json();
      expect((await enroll(t, created.enrollToken, { os: 'windows' })).json()).toEqual({
        error: 'os_mismatch',
      });
      expect((await enroll(t, created.enrollToken)).statusCode).toBe(200);
    });

    it('rotates: the old host token works until the agent re-enrolls with the new enrollment token', async () => {
      await setup();
      const { token } = await enrolledHost(t, admin);
      const again = (
        await t.app.inject({
          method: 'POST',
          url: '/api/v1/hosts/2/enroll-token',
          headers: authed(admin),
        })
      ).json();
      expect((await push(t, token, 'metrics', metrics())).statusCode).toBe(204);
      const next = (await enroll(t, again.enrollToken)).json().token as string;
      expect((await push(t, token, 'metrics', metrics())).statusCode).toBe(401);
      expect((await push(t, next, 'metrics', metrics())).statusCode).toBe(204);
    });
  });

  describe('authentication and limits', () => {
    it('gives 401 to a missing, unknown or revoked token, also for re-enrollment after a revoke', async () => {
      await setup();
      const { token } = await enrolledHost(t, admin);
      expect((await push(t, token, 'metrics', metrics())).statusCode).toBe(204);
      expect((await push(t, 'x'.repeat(43), 'metrics', metrics())).statusCode).toBe(401);
      expect(
        (
          await t.app.inject({
            method: 'POST',
            url: '/agent/v1/metrics',
            headers: { 'content-type': 'application/json' },
            payload: '{}',
          })
        ).statusCode,
      ).toBe(401);

      const rev = await t.app.inject({
        method: 'POST',
        url: '/api/v1/hosts/2/revoke',
        headers: authed(admin),
      });
      expect(rev.json().host).toMatchObject({ status: 'revoked', enrolled: false });
      for (const route of ['metrics', 'logs', 'events', 'app'])
        expect((await push(t, token, route, {})).statusCode, route).toBe(401);
      expect(t.ctx.state.host(2)).toBeUndefined(); // gone from the live view

      // A new enrollment token brings it back with a new host token; the old one stays dead.
      const again = (
        await t.app.inject({
          method: 'POST',
          url: '/api/v1/hosts/2/enroll-token',
          headers: authed(admin),
        })
      ).json();
      expect(again.host.status).toBe('revoked');
      const fresh = (await enroll(t, again.enrollToken)).json().token as string;
      expect((await push(t, fresh, 'metrics', metrics())).statusCode).toBe(204);
      expect((await push(t, token, 'metrics', metrics())).statusCode).toBe(401);
    });

    it('refuses any request that carries an Origin header, even with a good token', async () => {
      await setup();
      const { token, enrollToken } = await enrolledHost(t, admin);
      expect((await push(t, token, 'metrics', metrics(), { origin: ORIGIN })).statusCode).toBe(403);
      expect(
        (await push(t, token, 'metrics', metrics(), { origin: 'https://evil.example' })).json(),
      ).toEqual({ error: 'origin_not_allowed' });
      const r = await t.app.inject({
        method: 'POST',
        url: '/agent/v1/enroll',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        payload: { enrollToken, hostname: 'h', os: 'linux', agentVersion: VERSION },
      });
      expect(r.statusCode).toBe(403);
      // And it sets no cookies and allows no browser origin.
      const ok = await push(t, token, 'metrics', metrics());
      expect(ok.headers['set-cookie']).toBeUndefined();
      expect(ok.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('answers 413 for a 100 KB gzip body that inflates past the limit, and accepts a small gzip body', async () => {
      await setup();
      const { token } = await enrolledHost(t, admin);
      // About 100 KB of random text keeps the compressed size up; a long run of one letter makes the
      // inflated body several times the 512 KB metrics limit.
      const noise = Buffer.from(
        Array.from({ length: 100_000 }, () => Math.floor(Math.random() * 256)),
      ).toString('base64');
      const bomb = zlib.gzipSync(
        JSON.stringify({ ...metrics(), pad: noise + 'a'.repeat(3_000_000) }),
      );
      expect(bomb.length).toBeGreaterThan(95_000);
      expect(bomb.length).toBeLessThan(512 * 1024);
      const r = await push(t, token, 'metrics', bomb, { 'content-encoding': 'gzip' });
      expect(r.statusCode).toBe(413);
      expect(r.json().error).toBe('too_large');

      const small = zlib.gzipSync(JSON.stringify(metrics()));
      expect(
        (await push(t, token, 'metrics', small, { 'content-encoding': 'gzip' })).statusCode,
      ).toBe(204);
      // A declared length above the limit is refused before anything is read.
      expect((await push(t, token, 'events', 'x'.repeat(300 * 1024))).statusCode).toBe(413);
      expect(
        (await push(t, token, 'metrics', zlib.deflateSync('{}'), { 'content-encoding': 'deflate' }))
          .statusCode,
      ).toBe(415);
      expect(
        (
          await push(t, token, 'metrics', Buffer.from('not gzip'), { 'content-encoding': 'gzip' })
        ).json().error,
      ).toBe('invalid_gzip');
      // The declared-length refusal comes before authentication, so it is not counted against the host.
      expect(t.ctx.hosts.countsOf(2)).toMatchObject({ metrics: 1, rejected: 3 });
    });

    it('validates strictly: unknown fields, wrong types and other content types are refused', async () => {
      await setup();
      const { token } = await enrolledHost(t, admin);
      expect((await push(t, token, 'metrics', { ...metrics(), extra: 1 })).json()).toMatchObject({
        error: 'invalid_body',
      });
      expect(
        (
          await push(t, token, 'metrics', {
            ...metrics(),
            host: { ...metrics().host, cpuPct: 'high' },
          })
        ).statusCode,
      ).toBe(400);
      expect((await push(t, token, 'metrics', '{not json')).json()).toMatchObject({
        error: 'invalid_json',
      });
      expect(
        (
          await push(t, token, 'metrics', JSON.stringify(metrics()), {
            'content-type': 'text/plain',
          })
        ).statusCode,
      ).toBe(415);
      const badKey = { v: 1, events: [{ ts: t.clock.t, service: '../../etc', event: 'die' }] };
      expect((await push(t, token, 'events', badKey)).statusCode).toBe(400);
      // The refused values are never echoed back, only the field path.
      const r = await push(t, token, 'metrics', {
        ...metrics(),
        host: { ...metrics().host, cpuPct: 'SECRET-VALUE' },
      });
      expect(r.body).not.toContain('SECRET-VALUE');
    });

    it('needs X-Agent-Version and refuses agents below hosts.min_agent_version with 426, audited once an hour', async () => {
      await setup();
      const { token } = await enrolledHost(t, admin);
      expect(
        (await push(t, token, 'metrics', metrics(), { 'x-agent-version': '' })).json(),
      ).toMatchObject({ error: 'agent_version_required' });
      t.ctx.settings.setMany({ 'hosts.min_agent_version': '0.2.0' }, null);
      for (let i = 0; i < 3; i++)
        expect((await push(t, token, 'metrics', metrics())).statusCode).toBe(426);
      expect(
        (await push(t, token, 'metrics', metrics(), { 'x-agent-version': '0.10.0' })).statusCode,
      ).toBe(204);
      expect(
        t.db.prepare("SELECT detail FROM audit_log WHERE event = 'agent_version_rejected'").all(),
      ).toEqual([
        {
          detail: JSON.stringify({
            hostId: 2,
            hostName: 'ubuntu-acs',
            agentVersion: '0.1.0',
            minVersion: '0.2.0',
          }),
        },
      ]);
      // A new enrollment from a too-old agent does not use up the token.
      const again = (
        await t.app.inject({
          method: 'POST',
          url: '/api/v1/hosts/2/enroll-token',
          headers: authed(admin),
        })
      ).json();
      expect((await enroll(t, again.enrollToken)).statusCode).toBe(426);
      expect((await enroll(t, again.enrollToken, { agentVersion: '0.2.0' })).statusCode).toBe(200);
    });

    it('limits each host to 600 requests a minute with Retry-After', async () => {
      await setup();
      const { token } = await enrolledHost(t, admin);
      t.clock.t = Math.floor(t.clock.t / 60_000) * 60_000 + 15_000;
      const body = JSON.stringify({ v: 1, events: [] });
      for (let i = 0; i < 600; i++) {
        const r = await push(t, token, 'events', body);
        if (r.statusCode !== 204) throw new Error(`request ${i}: ${r.statusCode}`);
      }
      const over = await push(t, token, 'events', body);
      expect(over.statusCode).toBe(429);
      expect(over.headers['retry-after']).toBe('45');
      t.clock.t += 45_000;
      expect((await push(t, token, 'events', body)).statusCode).toBe(204);
    });

    it('limits enrollment attempts to 10 a minute per address', async () => {
      await setup();
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) codes.push((await enroll(t, 'z'.repeat(43))).statusCode);
      expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
      expect(codes.slice(10)).toEqual([429, 429]);
    });
  });

  describe('metrics from an agent host', () => {
    it('feed that host only, are stored with its id and can be read back as history', async () => {
      await setup();
      const { token } = await enrolledHost(t, admin);
      t.ctx.state.setCpuMem({
        at: t.clock.t,
        cpuPct: 50,
        cpuPerCore: [50],
        memUsedBytes: 1,
        memTotalBytes: 2,
        swapUsedBytes: 0,
        swapTotalBytes: 0,
        netRxBps: 0,
        netTxBps: 0,
      });
      // The agent's clock is 10 minutes ahead: reported, and the arrival time is used.
      expect((await push(t, token, 'metrics', metrics({}, t.clock.t + 600_000))).statusCode).toBe(
        204,
      );

      expect(t.ctx.state.getHost()?.cpuPct).toBe(50); // host 1 untouched
      expect(t.ctx.state.host(2)?.getHost()).toMatchObject({
        cpuPct: 12.5,
        updatedAt: t.clock.t,
        disks: [{ volume: '/', readBps: 1 }],
      });
      const host = (
        await t.app.inject({ method: 'GET', url: '/api/v1/hosts', headers: authed(admin) })
      ).json().hosts[1];
      expect(host).toMatchObject({
        status: 'online',
        actionsEnabled: true,
        agentVersion: VERSION,
        clockSkewMs: 600_000,
      });
      expect(host.latest).toMatchObject({ cpuPct: 12.5, disks: 1, containers: 1 });
      expect(host.counts).toMatchObject({ metrics: 1, rejected: 0 });

      t.clock.t += 20_000;
      t.ctx.persistence.flush();
      expect(
        t.db.prepare('SELECT host_id, cpu_pct FROM metrics_host ORDER BY host_id').all(),
      ).toEqual([
        { host_id: 1, cpu_pct: 50 },
        { host_id: 2, cpu_pct: 12.5 },
      ]);
      expect(t.db.prepare('SELECT host_id, volume FROM metrics_disk').all()).toEqual([
        { host_id: 2, volume: '/' },
      ]);

      const q = (host?: string) =>
        t.app.inject({
          method: 'GET',
          url: `/api/v1/history/host?from=${t.clock.t - 600_000}&to=${t.clock.t}${host ? `&host=${host}` : ''}`,
          headers: authed(admin),
        });
      const two = (await q('2')).json();
      expect(two.series['disk /'].some((v: number | null) => v === 30)).toBe(true);
      expect(two.series.cpuPct.some((v: number | null) => v === 12.5)).toBe(true);
      const one = (await q()).json();
      expect(one.series.cpuPct.some((v: number | null) => v === 50)).toBe(true);
      expect(one.series['disk /']).toBeUndefined();
      expect((await q('9')).statusCode).toBe(404);
      expect((await q('x')).statusCode).toBe(404);
    });

    it('accepts and counts logs, events and relayed reports (stored from M2 to M4)', async () => {
      await setup();
      const { token } = await enrolledHost(t, admin);
      const logs = {
        v: 1,
        batches: [
          {
            service: 'acs/genieacs-cwmp',
            lines: [
              { ts: t.clock.t, s: 'out', msg: 'hello' },
              { ts: t.clock.t, s: 'err', msg: 'x' },
            ],
            dropped: 0,
          },
        ],
      };
      expect(
        (
          await push(t, token, 'logs', zlib.gzipSync(JSON.stringify(logs)), {
            'content-encoding': 'gzip',
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (
          await push(t, token, 'events', {
            v: 1,
            events: [
              { ts: t.clock.t, service: 'acs/cpe-sim', event: 'die', detail: { exitCode: 137 } },
            ],
          })
        ).statusCode,
      ).toBe(204);
      const app = {
        v: 1,
        service: 'api',
        pm: 0,
        window_s: 10,
        runtime: {
          event_loop_lag_ms: { mean: 1, p95: 2, max: 3 },
          heap_used_bytes: 1,
          rss_bytes: 1,
        },
        http: { req_count: 1, err5xx_count: 0, p50_ms: 1, p95_ms: 2 },
        sockets: { open: 0 },
        tenants: [],
      };
      expect((await push(t, token, 'app', app)).statusCode).toBe(204);
      expect(t.ctx.hosts.countsOf(2)).toEqual({
        metrics: 0,
        logs: 1,
        events: 1,
        app: 1,
        rejected: 0,
        logLines: 2,
        eventCount: 1,
      });
    });
  });

  describe('host.silent', () => {
    const silentRows = (t: TestApp) =>
      t.db
        .prepare(
          "SELECT i.fingerprint, i.host_id, i.state FROM alert_incidents i JOIN alert_rules r ON r.id = i.rule_id WHERE r.key = 'host.silent'",
        )
        .all();

    it('opens for an enrolled host that stops sending, hides that host’s other alerts, and resolves when it is back', async () => {
      await setup();
      const { token } = await enrolledHost(t, admin);
      const tick = (ms: number) => {
        t.clock.t += ms;
        t.ctx.alerts.evaluate();
      };
      tick(0);
      tick(29_000); // within the 30 s grace
      expect(silentRows(t)).toEqual([]);
      tick(2_000); // now silent: the 120 s duration starts
      tick(119_000);
      expect(silentRows(t)).toEqual([]);
      tick(1_000);
      expect(silentRows(t)).toEqual([
        { fingerprint: 'host.silent:@2/', host_id: 2, state: 'firing' },
      ]);

      // Another incident on host 2 is suppressed, a probe failure and host 1's incidents are not.
      const ruleId = (key: string) =>
        (t.db.prepare('SELECT id FROM alert_rules WHERE key = ?').get(key) as { id: number }).id;
      const disk = t.ctx.alertRepo.insertIncident({
        ruleId: ruleId('host.disk_high'),
        serviceId: null,
        hostId: 2,
        fingerprint: 'host.disk_high:@2//',
        openedAt: t.clock.t,
        peak: 90,
        summary: 'x',
      });
      const local = t.ctx.alertRepo.insertIncident({
        ruleId: ruleId('host.disk_high'),
        serviceId: null,
        fingerprint: 'host.disk_high:C:',
        openedAt: t.clock.t,
        peak: 90,
        summary: 'y',
      });
      t.db
        .prepare(
          "INSERT INTO alert_rules (key, category, name, severity, updated_at) VALUES ('host.probe_failed', 'monitor', 'Probe', 'critical', 0)",
        )
        .run();
      const probe = t.ctx.alertRepo.insertIncident({
        ruleId: ruleId('host.probe_failed'),
        serviceId: null,
        hostId: 2,
        fingerprint: 'host.probe_failed:@2/443',
        openedAt: t.clock.t,
        peak: null,
        summary: 'z',
      });
      tick(5_000);
      const supp = (id: number) =>
        (
          t.db.prepare('SELECT suppressed_by FROM alert_incidents WHERE id = ?').get(id) as {
            suppressed_by: number | null;
          }
        ).suppressed_by;
      const silentId = (
        t.db
          .prepare("SELECT id FROM alert_incidents WHERE fingerprint = 'host.silent:@2/'")
          .get() as { id: number }
      ).id;
      expect([supp(disk.id), supp(local.id), supp(probe.id)]).toEqual([silentId, null, null]);

      // Reports resume every 10 s: resolves after max(60 s, 2 x duration) = 240 s without silence.
      const report = async (n: number) => {
        for (let i = 0; i < n; i++) {
          expect((await push(t, token, 'metrics', metrics({}, t.clock.t))).statusCode).toBe(204);
          tick(10_000);
        }
      };
      await report(23); // 230 s
      expect(silentRows(t)).toEqual([
        { fingerprint: 'host.silent:@2/', host_id: 2, state: 'firing' },
      ]);
      await report(2);
      expect(silentRows(t)).toEqual([
        { fingerprint: 'host.silent:@2/', host_id: 2, state: 'resolved' },
      ]);
    });

    it('ignores hosts that never enrolled and ends a revoked host’s incidents without email', async () => {
      await setup();
      await t.app.inject({
        method: 'POST',
        url: '/api/v1/hosts',
        headers: authed(admin),
        payload: { name: 'never-enrolled' },
      });
      await enrolledHost(t, admin, 'ubuntu-acs');
      for (let i = 0; i < 40; i++) {
        t.clock.t += 5_000;
        t.ctx.alerts.evaluate();
      }
      expect(silentRows(t)).toEqual([
        { fingerprint: 'host.silent:@3/', host_id: 3, state: 'firing' },
      ]);
      await t.app.inject({ method: 'POST', url: '/api/v1/hosts/3/revoke', headers: authed(admin) });
      expect(silentRows(t)).toEqual([
        { fingerprint: 'host.silent:@3/', host_id: 3, state: 'resolved' },
      ]);
      t.clock.t += 600_000;
      t.ctx.alerts.evaluate();
      expect(silentRows(t)).toHaveLength(1);
    });
  });

  describe('services and fingerprints on more than one host', () => {
    it('keeps host 1 fingerprints, prefixes other hosts', () => {
      expect(hostTarget(1, 'C:')).toBe('C:');
      expect(hostTarget(1, '')).toBe('');
      expect(hostTarget(2, '/')).toBe('@2//');
      expect(hostTarget(2, '')).toBe('@2/');
    });

    it('keys services by host and source key; host 1 callers see only host 1', async () => {
      await setup();
      await enrolledHost(t, admin);
      const pm2 = t.ctx.services.discover('api');
      const c1 = t.ctx.services.discover('acs/api', { hostId: 2, kind: 'container' });
      const c2 = t.ctx.services.discover('other/api', { hostId: 2, kind: 'container' });
      expect([pm2.name, c1.name, c2.name]).toEqual(['api', 'api', 'api (2)']); // names are unique per host
      expect(c1).toMatchObject({ host_id: 2, kind: 'container', source_key: 'acs/api' });
      expect(t.ctx.services.discover('acs/api', { hostId: 2, kind: 'container' }).id).toBe(c1.id);
      expect(t.ctx.services.getByPm2Name('acs/api')).toBeUndefined();
      expect(t.ctx.services.list().map((s) => s.id)).toEqual([pm2.id]);
      expect(t.ctx.services.list(false, 'all').map((s) => s.id)).toEqual([pm2.id, c1.id, c2.id]);
      expect(t.ctx.services.toDto(c1)).toMatchObject({
        hostId: 2,
        kind: 'container',
        sourceKey: 'acs/api',
        pm2Name: 'acs/api',
      });
      // The HTTP list is host 1, unchanged.
      const listed = (
        await t.app.inject({ method: 'GET', url: '/api/v1/services', headers: authed(admin) })
      ).json().services;
      expect(listed.map((s: { id: number }) => s.id)).toEqual([pm2.id]);
      // PM2 actions never reach a container service.
      expect(t.ctx.actions.blockedReason(c1, null)).toMatch(/other hosts/);
    });

    it('keeps host 1 processes when another host reports its own', async () => {
      await setup();
      const p = (serviceId: number) => ({
        serviceId,
        name: 's',
        pm2Name: 's',
        updatedAt: 0,
        status: 'online' as const,
        instances: 1,
        instancesOnline: 1,
        cpuPct: 0,
        memBytes: 0,
        restarts: 0,
        uptimeS: 0,
      });
      t.ctx.state.setProcesses([p(5)], 1);
      t.ctx.state.setProcesses([p(9)], 1, 2);
      t.ctx.state.setProcesses([p(5)], 2);
      expect(t.ctx.state.getProcessStates().map((x) => x.serviceId)).toEqual([5]);
      expect(t.ctx.state.getProcessStates(2).map((x) => x.serviceId)).toEqual([9]);
      expect(
        t.ctx.state
          .getProcessStates('all')
          .map((x) => x.serviceId)
          .sort(),
      ).toEqual([5, 9]);
      expect(t.ctx.state.getProcessesAt(2)).toBe(1);
      t.ctx.state.dropHost(2);
      expect(t.ctx.state.getProcessStates('all').map((x) => x.serviceId)).toEqual([5]);
    });
  });
});
