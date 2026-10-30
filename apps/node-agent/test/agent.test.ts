import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_INGEST_PREFIX,
  AGENT_VERSION_HEADER,
  agentEnrollSchema,
  agentEventsSchema,
  agentLogsSchema,
  agentMetricsSchema,
  type AgentLogs,
  type AgentMetrics,
} from '@cc/shared';
import { NodeAgent, UNAUTHORIZED_WAIT_MS } from '../src/agent';
import { INGEST_PREFIX, MonitorClient, VERSION_HEADER } from '../src/client';
import { ConfigError, loadConfig, type AgentConfig } from '../src/config';
import { DockerClient } from '../src/docker';
import { silentLog } from '../src/log';
import { HostReader } from '../src/proc';
import { AGENT_VERSION } from '../src/version';
import { ACS } from './docker.test';
import { procFixture, readBody, serve, type FakeServer } from './fixtures';

/** A monitor stand-in: checks every request the way the real ingest does and records it. */
async function fakeMonitor(opts: { status?: (route: string) => number; retryAfter?: string } = {}) {
  const got: { route: string; body: unknown; headers: Record<string, string | string[] | undefined> }[] = [];
  const tokens = new Set<string>();
  const used = new Set<string>();
  const server = await serve(async (req, res) => {
    const route = (req.url ?? '').slice(AGENT_INGEST_PREFIX.length + 1);
    let raw = await readBody(req);
    if (req.headers['content-encoding'] === 'gzip') raw = zlib.gunzipSync(raw);
    const body = JSON.parse(raw.toString('utf8'));
    got.push({ route, body, headers: req.headers });
    const forced = opts.status?.(route);
    if (forced) {
      if (opts.retryAfter) res.setHeader('retry-after', opts.retryAfter);
      res.statusCode = forced;
      return res.end(JSON.stringify({ error: `forced_${forced}` }));
    }
    res.setHeader('content-type', 'application/json');
    if (route === 'enroll') {
      agentEnrollSchema.parse(body);
      if (used.has(body.enrollToken) || body.enrollToken === 'expired-token-xxxxxxxx') {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: used.has(body.enrollToken) ? 'enroll_token_invalid' : 'enroll_token_expired' }));
      }
      used.add(body.enrollToken);
      const token = `host-token-${used.size}-abcdefghijklmnopqrstuvwxyz`;
      tokens.add(token);
      return res.end(JSON.stringify({ hostId: 2, hostName: 'ubuntu-acs', token }));
    }
    const auth = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    if (!auth || !tokens.has(auth)) {
      res.statusCode = 401;
      return res.end('{"error":"unauthorized"}');
    }
    if (route === 'metrics') agentMetricsSchema.parse(body);
    if (route === 'events') agentEventsSchema.parse(body);
    if (route === 'logs') {
      agentLogsSchema.parse(body);
      return res.end(JSON.stringify({ excluded: ['acs/caddy'], linesPerS: 200 }));
    }
    res.statusCode = 204;
    res.end();
  });
  return { ...server, got, tokens, revoke: () => tokens.clear() };
}

/** cc-docker-proxy stand-in: the list, stats and an event stream the test can write to. */
async function fakeDocker(initial = ACS) {
  const list = initial.map((c) => ({ ...c }));
  const streams: import('node:http').ServerResponse[] = [];
  const paths: string[] = [];
  const logQueries: string[] = [];
  const server = await serve((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    paths.push(u.pathname);
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/containers/json') {
      expect(u.searchParams.get('all')).toBe('1');
      return res.end(JSON.stringify(list));
    }
    const s = /^\/containers\/([^/]+)\/stats$/.exec(u.pathname);
    if (s) {
      expect(u.searchParams.get('stream')).toBe('false');
      return res.end(
        JSON.stringify({
          cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 1 },
          precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
          memory_stats: { usage: 1000, stats: { inactive_file: 0 } },
        }),
      );
    }
    if (u.pathname === '/events') {
      res.writeHead(200);
      res.flushHeaders();
      streams.push(res);
      return;
    }
    const l = /^\/containers\/([^/]+)\/logs$/.exec(u.pathname);
    if (l) {
      logQueries.push(`${l[1]} ${u.search}`);
      res.setHeader('content-type', 'application/vnd.docker.multiplexed-stream');
      res.writeHead(200);
      const body = Buffer.from(`2026-10-30T12:00:01.000000001Z hello from ${l[1]}\n`);
      const head = Buffer.alloc(8);
      head[0] = 1;
      head.writeUInt32BE(body.length, 4);
      res.write(Buffer.concat([head, body]));
      streams.push(res);
      return;
    }
    res.statusCode = 403;
    res.end();
  });
  return {
    ...server,
    paths,
    logQueries,
    emit: (e: unknown) => streams.forEach((r) => r.write(JSON.stringify(e) + '\n')),
    setStatus: (id: string, status: string) => void (list.find((c) => c.Id === id)!.Status = status),
    waitForStream: async () => {
      for (let i = 0; i < 100 && streams.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    },
  };
}

const configFor = (f: ReturnType<typeof procFixture>, over: Partial<AgentConfig> = {}): AgentConfig => ({
  monitorUrl: 'http://127.0.0.1',
  enrollToken: 'enroll-token-1-abcdefgh',
  hostName: 'acs-prod',
  dockerUrl: null,
  projects: ['acs'],
  ownProject: null,
  disks: ['/'],
  actions: true,
  procRoot: f.procRoot,
  hostRoot: f.hostRoot,
  hostRun: f.hostRun,
  stateDir: path.join(f.dir, 'state'),
  intervalMs: 10_000,
  logs: false,
  logBufferBytes: 50 * 1024 * 1024,
  logLinesPerS: null,
  ...over,
});

describe('MonitorClient', () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const c of cleanup.splice(0)) await c();
  });

  it('uses the same header and path as the ingest', () => {
    expect(VERSION_HEADER).toBe(AGENT_VERSION_HEADER);
    expect(INGEST_PREFIX).toBe(AGENT_INGEST_PREFIX);
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
    expect(AGENT_VERSION).toBe(pkg.version);
  });

  it('enrolls once, keeps the host token in a 600 file and reuses it after a restart', async () => {
    const m = await fakeMonitor();
    const f = procFixture();
    cleanup.push(m.close, () => fs.rmSync(f.dir, { recursive: true, force: true }));
    const mk = (enrollToken: string | null) =>
      new MonitorClient({ url: m.url, stateDir: path.join(f.dir, 'state'), enrollToken, version: AGENT_VERSION, hostname: 'acs-prod', log: silentLog });

    expect(await mk('enroll-token-1-abcdefgh').init()).toBe('enrolled');
    const tokenFile = path.join(f.dir, 'state', 'token');
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(tokenFile, 'utf8').trim()).toBe('host-token-1-abcdefghijklmnopqrstuvwxyz');
    // The enrollment token is never written down; only a hash that marks it used.
    expect(fs.readdirSync(path.join(f.dir, 'state')).map((n) => fs.readFileSync(path.join(f.dir, 'state', n), 'utf8')).join()).not.toContain('enroll-token-1');

    // Restart with the same env file: no second enrollment.
    expect(await mk('enroll-token-1-abcdefgh').init()).toBe('saved');
    expect(m.got.filter((g) => g.route === 'enroll')).toHaveLength(1);

    // A new token from the Hosts page (rotation): enrolls again and replaces the host token.
    expect(await mk('enroll-token-2-abcdefgh').init()).toBe('enrolled');
    expect(fs.readFileSync(tokenFile, 'utf8').trim()).toBe('host-token-2-abcdefghijklmnopqrstuvwxyz');

    // An expired token with a saved one: keeps the saved token; with none: a clear error.
    expect(await mk('expired-token-xxxxxxxx').init()).toBe('saved');
    fs.rmSync(path.join(f.dir, 'state'), { recursive: true });
    await expect(mk(null).init()).rejects.toMatchObject({ code: 'no_token' });
    await expect(mk('expired-token-xxxxxxxx').init()).rejects.toMatchObject({ code: 'enroll_token_expired' });
  });

  it('sends gzip JSON with the token and version, and reads every answer', async () => {
    let status = 204;
    const m = await fakeMonitor({ status: (r) => (r === 'enroll' || status === 204 ? 0 : status), retryAfter: '17' });
    const f = procFixture();
    cleanup.push(m.close, () => fs.rmSync(f.dir, { recursive: true, force: true }));
    const c = new MonitorClient({ url: m.url, stateDir: path.join(f.dir, 'state'), enrollToken: 'enroll-token-1-abcdefgh', version: AGENT_VERSION, hostname: 'h', log: silentLog });
    await c.init();
    expect(await c.post('events', { v: 1, events: [] })).toEqual({ kind: 'ok' });
    const sent = m.got.at(-1)!;
    expect(sent.headers['content-encoding']).toBe('gzip');
    expect(sent.headers['x-agent-version']).toBe(AGENT_VERSION);
    expect(sent.headers.authorization).toMatch(/^Bearer host-token-1-/);

    const answers: unknown[] = [];
    for (status of [401, 426, 429, 413, 400, 502]) answers.push(await c.post('events', { v: 1, events: [] }));
    expect(answers).toEqual([
      { kind: 'unauthorized' },
      { kind: 'too_old', message: 'agent too old' },
      { kind: 'rate_limited', retryAfterS: 17 },
      { kind: 'rejected', status: 413, error: 'forced_413' },
      { kind: 'rejected', status: 400, error: 'forced_400' },
      { kind: 'unavailable', detail: 'HTTP 502' },
    ]);
    await m.close();
    expect(await c.post('events', { v: 1, events: [] })).toMatchObject({ kind: 'unavailable' });
  });
});

describe('NodeAgent', () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const c of cleanup.splice(0)) await c();
  });

  async function setup(over: Partial<AgentConfig> = {}, monitorOpts: Parameters<typeof fakeMonitor>[0] = {}) {
    const m = await fakeMonitor(monitorOpts);
    const d = await fakeDocker();
    const f = procFixture();
    cleanup.push(m.close, d.close, () => fs.rmSync(f.dir, { recursive: true, force: true }));
    const config = configFor(f, { monitorUrl: m.url, dockerUrl: d.url, ...over });
    const client = new MonitorClient({ url: m.url, stateDir: config.stateDir, enrollToken: config.enrollToken, version: AGENT_VERSION, hostname: 'acs-prod', log: silentLog });
    await client.init();
    const clock = { t: 1_800_000_000_000 };
    const reader = new HostReader({ procRoot: f.procRoot, hostRun: f.hostRun, disks: config.disks, now: () => clock.t });
    await reader.prime();
    const deps: ConstructorParameters<typeof NodeAgent>[0] = {
      config,
      client,
      reader,
      docker: new DockerClient(d.url),
      log: silentLog,
      hostname: 'c1abcdef0123', // the agent's own container id, as Docker sets the hostname
      now: () => clock.t,
      random: () => 0.5,
    };
    const agent = new NodeAgent(deps);
    cleanup.push(() => agent.stop());
    return { m, d, f, agent, clock, deps };
  }

  it('reports the host and the acs services the monitor accepts, finding its own project', async () => {
    const { m, d, agent, clock } = await setup();
    clock.t += 10_000;
    await agent.tick();
    const metrics = m.got.filter((g) => g.route === 'metrics');
    expect(metrics).toHaveLength(1);
    const body = metrics[0]!.body as AgentMetrics;
    expect(agentMetricsSchema.parse(body)).toBeTruthy();
    expect(body.actions).toBe('on');
    expect(body.host).toMatchObject({ cpuPct: 0, memTotalBytes: 8_000_000 * 1024, pendingReboot: false, disks: [{ volume: '/' }] });
    // The nine acs services plus the agent's two (its own project, found from its hostname), not "other".
    expect(body.containers!.map((c) => c.key)).toHaveLength(11);
    expect(body.containers!.filter((c) => c.own).map((c) => c.key)).toEqual(['cc-agent/cc-docker-proxy', 'cc-agent/cc-node-agent']);
    expect(body.containers!.find((c) => c.key === 'acs/api')).toMatchObject({ cpuPct: 10, memBytes: 1000, state: 'running' });
    expect(body.containers!.find((c) => c.key === 'acs/cpe-sim')).toMatchObject({ state: 'exited', cpuPct: 0 });
    expect(body.agent!.collectors.map((c) => [c.name, c.error])).toEqual([
      ['host', null],
      ['disks', null],
      ['docker', null],
      ['events', null],
      ['monitor', null],
    ]);
    // Only allowlisted Docker paths were used; stats only for running containers.
    expect(new Set(d.paths.map((p) => p.replace(/\/containers\/[^/]+\/stats/, '/containers/{id}/stats')))).toEqual(
      new Set(['/containers/json', '/containers/{id}/stats']),
    );
    expect(d.paths.filter((p) => p.endsWith('/stats'))).toHaveLength(12 - 1 - 1); // 13 listed, cpe-sim stopped, "other" and unlabelled not watched
  });

  it('follows the running containers’ logs and ships them; the monitor’s exclusions are honoured', async () => {
    const { m, d, clock, f, deps } = await setup({ logs: true });
    // Docker's clock and the agent's agree: lines are timestamped just after "now".
    clock.t = Date.parse('2026-10-30T12:00:00Z');
    const withLogs = new NodeAgent({ ...deps, logs: { bufferDir: path.join(f.dir, 'log-buffer'), bufferMaxBytes: 1_000_000 } });
    cleanup.push(() => withLogs.stop());
    await withLogs.loadState();
    withLogs.start();
    for (let i = 0; i < 100 && m.got.filter((g) => g.route === 'logs').length === 0; i++) {
      await new Promise((r) => setTimeout(r, 30));
      if (i % 10 === 9) await withLogs.logs!.flush();
    }
    const sent = m.got.filter((g) => g.route === 'logs').flatMap((g) => (g.body as AgentLogs).batches);
    expect(sent.find((b) => b.service === 'acs/api')).toMatchObject({ lines: [{ s: 'out', msg: expect.stringMatching(/^hello from /) }], dropped: 0 });
    // Only running containers of watched projects, through the allowlisted path with the full query.
    expect(d.logQueries.length).toBe(11 - 1);
    expect(d.logQueries[0]).toMatch(/\?follow=1&stdout=1&stderr=1&timestamps=1&since=\d+\.000000000$/);
    // The monitor excluded acs/caddy: it is no longer followed.
    expect(withLogs.logs!.following).toHaveLength(9);
    clock.t += 10_000;
    await withLogs.tick();
    const report = m.got.filter((g) => g.route === 'metrics').at(-1)!.body as AgentMetrics;
    expect(report.agent!.collectors.find((c) => c.name === 'logs')).toMatchObject({ error: null });
    expect(report.agent).toMatchObject({ droppedLogLines: 0, bufferBytes: 0 });
  });

  it('leaves out the containers when Docker cannot be read, and says so', async () => {
    const { m, agent, clock, d } = await setup();
    await d.close();
    clock.t += 10_000;
    await agent.tick();
    const body = m.got.filter((g) => g.route === 'metrics')[0]!.body as AgentMetrics;
    expect(body.containers).toBeUndefined();
    expect(body.agent!.collectors.find((c) => c.name === 'docker')!.error).toMatch(/fetch failed|ECONNREFUSED/);
  });

  it('sends container events within half a second and counts restarts into the next report', async () => {
    const { m, d, agent, clock } = await setup();
    agent.start();
    await d.waitForStream();
    const e = (action: string, attrs: Record<string, string> = {}) => ({
      Type: 'container',
      Action: action,
      Actor: { ID: 'a9', Attributes: { 'com.docker.compose.project': 'acs', 'com.docker.compose.service': 'cpe-sim', ...attrs } },
      time: Math.floor(clock.t / 1000),
    });
    d.emit(e('die', { exitCode: '137' }));
    d.emit(e('start'));
    d.emit({ Type: 'container', Action: 'start', Actor: { ID: 'o1', Attributes: { 'com.docker.compose.project': 'other', 'com.docker.compose.service': 'x' } } });
    for (let i = 0; i < 50 && !m.got.some((g) => g.route === 'events'); i++) await new Promise((r) => setTimeout(r, 50));
    const events = m.got.filter((g) => g.route === 'events');
    expect(events).toHaveLength(1);
    expect((events[0]!.body as { events: unknown[] }).events).toEqual([
      { ts: clock.t - (clock.t % 1000), service: 'acs/cpe-sim', event: 'die', detail: { exitCode: 137 } },
      { ts: clock.t - (clock.t % 1000), service: 'acs/cpe-sim', event: 'start' },
    ]);
    clock.t += 10_000;
    await agent.tick();
    const last = m.got.filter((g) => g.route === 'metrics').at(-1)!.body as AgentMetrics;
    expect(last.containers!.find((c) => c.key === 'acs/cpe-sim')!.restartsTotal).toBe(1);
  });

  it('keeps restart counts and exact start times across a restart of the agent', async () => {
    const saved: { snap: unknown } = { snap: null };
    const store = { load: async () => saved.snap, save: async (x: unknown) => void (saved.snap = JSON.parse(JSON.stringify(x))) };
    const { m, d, deps, clock } = await setup();
    // The first agent, with a store: sees genieacs-nbi die and start, then stops (and saves).
    const first = new NodeAgent({ ...deps, store });
    await first.loadState();
    first.start();
    await d.waitForStream();
    const attrs = { 'com.docker.compose.project': 'acs', 'com.docker.compose.service': 'cpe-sim' };
    const at = Math.floor(clock.t / 1000);
    d.emit({ Type: 'container', Action: 'die', Actor: { ID: 'a5', Attributes: { ...attrs, 'com.docker.compose.service': 'genieacs-nbi' } }, time: at - 60 });
    d.emit({ Type: 'container', Action: 'start', Actor: { ID: 'a5', Attributes: { ...attrs, 'com.docker.compose.service': 'genieacs-nbi' } }, time: at - 50 });
    for (let i = 0; i < 50 && !m.got.some((g) => g.route === 'events'); i++) await new Promise((r) => setTimeout(r, 50));
    await first.stop();
    expect(saved.snap).toMatchObject({ v: 1, restarts: { 'acs/genieacs-nbi': 1 }, startedAt: { a5: (at - 50) * 1000 } });

    // The second agent loads it: the count and the exact start survive ("Up 2 hours" in the fake
    // Docker would not fit a start 50 s ago, so the fake list is told the container is younger).
    d.setStatus('a5', 'Up About a minute');
    const second = new NodeAgent({ ...deps, store });
    await second.loadState();
    clock.t += 10_000;
    await second.tick();
    const nbi = (m.got.filter((g) => g.route === 'metrics').at(-1)!.body as AgentMetrics).containers!.find((c) => c.key === 'acs/genieacs-nbi')!;
    expect(nbi).toMatchObject({ restartsTotal: 1, startedAt: (at - 50) * 1000 });
    expect(nbi.startedApprox).toBeUndefined();
    await second.stop();
  });

  it('waits 10 minutes after a 401 and does not send in between', async () => {
    const { m, agent, clock } = await setup();
    m.revoke();
    clock.t += 10_000;
    await agent.tick();
    expect(agent.blocked()).toBe(true);
    const sent = m.got.length;
    clock.t += UNAUTHORIZED_WAIT_MS - 1_000;
    await agent.tick();
    expect(m.got.length).toBe(sent);
    clock.t += 2_000;
    await agent.tick();
    expect(m.got.length).toBe(sent + 1);
  });

  it('backs off while the monitor is unreachable, up to a minute, and resumes at once when it answers', async () => {
    let down = true;
    const { m, agent, clock } = await setup({}, { status: (r) => (r === 'metrics' && down ? 503 : 0) });
    const attempts: number[] = [];
    for (let i = 0; i < 18; i++) {
      clock.t += 10_000;
      const before = m.got.length;
      await agent.tick();
      if (m.got.length > before) attempts.push(i);
    }
    // 10 s, 20 s, 40 s, then every 60 s (jitter fixed at the middle by the test).
    expect(attempts).toEqual([0, 1, 3, 7, 13]);
    down = false;
    clock.t += 60_000;
    await agent.tick();
    clock.t += 10_000;
    await agent.tick();
    expect(m.got.slice(-2).map((g) => g.route)).toEqual(['metrics', 'metrics']);
    expect(agent.blocked()).toBe(false);
  });

  it('reports actions off when CC_ACTIONS=off', async () => {
    const { m, agent, clock } = await setup({ actions: false });
    clock.t += 10_000;
    await agent.tick();
    expect((m.got.at(-1)!.body as AgentMetrics).actions).toBe('off');
  });
});

describe('loadConfig', () => {
  const base = { CC_MONITOR_URL: 'https://monitor-api.thediv.in/', CC_PROJECTS: 'acs' };

  it('reads the env file with its defaults', () => {
    expect(loadConfig({ ...base, CC_ENROLL_TOKEN: ' tok ', CC_DISKS: '/, /srv' })).toMatchObject({
      monitorUrl: 'https://monitor-api.thediv.in',
      enrollToken: 'tok',
      dockerUrl: 'http://cc-docker-proxy:2375',
      projects: ['acs'],
      disks: ['/', '/srv'],
      actions: true,
      stateDir: '/var/lib/cc-agent',
      intervalMs: 10_000,
    });
    expect(loadConfig(base).disks).toEqual(['/']);
    expect(loadConfig({ ...base, CC_DOCKER_URL: 'off' }).dockerUrl).toBeNull();
  });

  it('refuses plain http to a remote monitor, odd project names and relative disks', () => {
    const bad = [
      { CC_MONITOR_URL: '' },
      { CC_MONITOR_URL: 'http://monitor-api.thediv.in' },
      { CC_MONITOR_URL: 'https://monitor-api.thediv.in/agent' },
      { CC_PROJECTS: 'ACS' },
      { CC_DISKS: 'srv' },
      { CC_DISKS: '/srv/../etc' },
      { CC_ACTIONS: 'maybe' },
      { CC_INTERVAL_S: '1' },
    ];
    for (const b of bad) expect(() => loadConfig({ ...base, ...b }), JSON.stringify(b)).toThrow(ConfigError);
    expect(loadConfig({ ...base, CC_MONITOR_URL: 'http://127.0.0.1:4100' }).monitorUrl).toBe('http://127.0.0.1:4100');
    expect(loadConfig({ ...base, CC_MONITOR_URL: 'http://host.docker.internal:4100', CC_ALLOW_HTTP: '1' }).monitorUrl).toBe('http://host.docker.internal:4100');
  });
});

describe('the built agent', () => {
  it('imports nothing from @cc/shared at run time (the image has no node_modules)', () => {
    const dir = path.resolve(__dirname, '../src');
    for (const f of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const line of src.split('\n').filter((l) => l.includes("from '@cc/shared'"))) {
        expect(line, `${f}: ${line}`).toMatch(/^import type /);
      }
      expect(src, f).not.toMatch(/require\(|from '(?!node:|\.\/|@cc\/shared')/);
    }
  });
});
