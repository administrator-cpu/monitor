import { describe, expect, it } from 'vitest';
import { agentContainerSchema, agentEventsSchema } from '@cc/shared';
import {
  aggregate,
  containerKeyOf,
  type DockerContainer,
  EventTracker,
  healthOf,
  statsFigures,
  upForSeconds,
  upRange,
} from '../src/docker';

const labels = (project: string, service: string) => ({
  'com.docker.compose.project': project,
  'com.docker.compose.service': service,
  'com.docker.compose.container-number': '1',
});

/** The nine `acs` containers of V20 plus the agent's own two and one container without labels. */
export const ACS: DockerContainer[] = [
  { Id: 'a1', State: 'running', Status: 'Up 6 days', Labels: labels('acs', 'api') },
  { Id: 'a2', State: 'running', Status: 'Up 6 days (healthy)', Labels: labels('acs', 'dashboard') },
  { Id: 'a3', State: 'running', Status: 'Up 6 days', Labels: labels('acs', 'caddy') },
  { Id: 'a4', State: 'running', Status: 'Up 6 days (healthy)', Labels: labels('acs', 'mongo') },
  { Id: 'a5', State: 'running', Status: 'Up 2 hours', Labels: labels('acs', 'genieacs-nbi') },
  { Id: 'a6', State: 'running', Status: 'Up About an hour', Labels: labels('acs', 'genieacs-cwmp') },
  { Id: 'a7', State: 'running', Status: 'Up 5 minutes', Labels: labels('acs', 'genieacs-fs') },
  { Id: 'a8', State: 'running', Status: 'Up 30 seconds', Labels: labels('acs', 'genieacs-ui') },
  { Id: 'a9', State: 'exited', Status: 'Exited (137) 2 minutes ago', Labels: labels('acs', 'cpe-sim') },
  { Id: 'c1abcdef0123', State: 'running', Status: 'Up 1 minute', Labels: labels('cc-agent', 'cc-node-agent') },
  { Id: 'c2', State: 'running', Status: 'Up 1 minute', Labels: labels('cc-agent', 'cc-docker-proxy') },
  { Id: 'x1', State: 'running', Status: 'Up 3 weeks', Labels: { maintainer: 'someone' } },
  { Id: 'o1', State: 'running', Status: 'Up 3 weeks', Labels: labels('other', 'thing') },
];

describe('Docker parsing', () => {
  it('reads the uptime and health out of the status text', () => {
    expect(
      ['Up Less than a second', 'Up 30 seconds', 'Up About a minute', 'Up 5 minutes (healthy)', 'Up About an hour', 'Up 6 days', 'Up 2 weeks (Paused)', 'Up 1 year', 'Exited (0) 1 minute ago', 'Created'].map(upForSeconds),
    ).toEqual([0, 30, 60, 300, 3600, 518_400, 1_209_600, 31_536_000, null, null]);
    expect(['Up 1 hour (healthy)', 'Up 1 hour (unhealthy)', 'Up 2 seconds (health: starting)', 'Up 1 hour'].map(healthOf)).toEqual([
      'healthy',
      'unhealthy',
      'starting',
      null,
    ]);
  });

  it('keys containers by compose project and service, and ignores the rest', () => {
    expect(containerKeyOf(labels('acs', 'genieacs-cwmp'))).toBe('acs/genieacs-cwmp');
    expect(containerKeyOf({ maintainer: 'x' })).toBeNull();
    expect(containerKeyOf(labels('ACS', 'x'))).toBeNull(); // compose project names are lower case
    expect(containerKeyOf(null)).toBeNull();
  });

  it('computes CPU and memory like docker stats', () => {
    expect(
      statsFigures({
        cpu_stats: { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 20_000_000_000, online_cpus: 2 },
        precpu_stats: { cpu_usage: { total_usage: 1_000_000_000 }, system_cpu_usage: 10_000_000_000 },
        memory_stats: { usage: 300_000_000, stats: { inactive_file: 100_000_000 } },
      }),
    ).toEqual({ cpuPct: 20, memBytes: 200_000_000 });
    // cgroup v1 names the cache total_inactive_file; a first reading has no previous CPU sample.
    expect(
      statsFigures({
        cpu_stats: { cpu_usage: { total_usage: 5, percpu_usage: [1, 2, 3, 4] }, system_cpu_usage: 0 },
        memory_stats: { usage: 50, stats: { total_inactive_file: 10 } },
      }),
    ).toEqual({ cpuPct: 0, memBytes: 40 });
    expect(statsFigures({})).toBeNull();
  });

  it('groups the watched projects into services, marks the agent’s own and matches the monitor’s schema', () => {
    const now = 1_800_000_000_000;
    const out = aggregate(ACS, {
      projects: new Set(['acs']),
      ownProject: 'cc-agent',
      now,
      startedAt: new Map([['a1', now - 1000]]),
      stats: new Map([
        ['a1', { cpuPct: 2.5, memBytes: 100 }],
        ['a9', { cpuPct: 99, memBytes: 99 }], // not running: ignored
      ]),
      restarts: new Map([['acs/cpe-sim', 3]]),
    });
    expect(out.map((c) => c.key)).toEqual([
      'acs/api',
      'acs/caddy',
      'acs/cpe-sim',
      'acs/dashboard',
      'acs/genieacs-cwmp',
      'acs/genieacs-fs',
      'acs/genieacs-nbi',
      'acs/genieacs-ui',
      'acs/mongo',
      'cc-agent/cc-docker-proxy',
      'cc-agent/cc-node-agent',
    ]);
    for (const c of out) expect(agentContainerSchema.safeParse(c).success).toBe(true);
    const by = new Map(out.map((c) => [c.key, c]));
    expect(by.get('acs/api')).toEqual({
      key: 'acs/api',
      name: 'api',
      instances: 1,
      instancesRunning: 1,
      state: 'running',
      health: null,
      restartsTotal: 0,
      cpuPct: 2.5,
      memBytes: 100,
      startedAt: now - 1000, // seen in an event: exact
    });
    expect(by.get('acs/genieacs-cwmp')!.startedAt).toBe(now - 3_600_000); // from "Up About an hour"
    expect(by.get('acs/genieacs-cwmp')!.startedApprox).toBe(true);
    expect(by.get('acs/api')!.startedApprox).toBeUndefined(); // from an event
    expect(by.get('acs/cpe-sim')).toMatchObject({ state: 'exited', instancesRunning: 0, startedAt: null, restartsTotal: 3, cpuPct: 0 });
    expect(by.get('acs/mongo')!.health).toBe('healthy');
    expect(by.get('cc-agent/cc-node-agent')!.own).toBe(true);
    expect(by.get('acs/api')!.own).toBeUndefined();
  });

  it('takes the worst state and health of scaled replicas, the youngest uptime and summed load', () => {
    const now = 1_000_000_000;
    const out = aggregate(
      [
        { Id: 'r1', State: 'running', Status: 'Up 2 hours (healthy)', Labels: labels('acs', 'worker') },
        { Id: 'r2', State: 'running', Status: 'Up 5 minutes (unhealthy)', Labels: labels('acs', 'worker') },
        { Id: 'r3', State: 'restarting', Status: 'Restarting (1) 3 seconds ago', Labels: labels('acs', 'worker') },
      ],
      {
        projects: new Set(['acs']),
        ownProject: null,
        now,
        startedAt: new Map(),
        stats: new Map([
          ['r1', { cpuPct: 1.25, memBytes: 10 }],
          ['r2', { cpuPct: 2.5, memBytes: 20 }],
        ]),
        restarts: new Map(),
      },
    );
    expect(out).toEqual([
      expect.objectContaining({ instances: 3, instancesRunning: 2, state: 'restarting', health: 'unhealthy', cpuPct: 3.8, memBytes: 30, startedAt: now - 300_000 }),
    ]);
  });
});

describe('EventTracker', () => {
  const ev = (id: string, action: string, attrs: Record<string, string> = {}, t = 1_800_000_000) => ({
    Type: 'container',
    Action: action,
    Actor: { ID: id, Attributes: { ...labels('acs', 'cpe-sim'), name: 'acs-cpe-sim-1', image: 'sha256:abc', ...attrs } },
    time: t,
    timeNano: t * 1e9 + 123_000_000,
  });

  it('forwards the six container events with only exit code or health status, and counts a start after a die as a restart', () => {
    const t = new EventTracker((p) => p === 'acs');
    const out = [
      t.handle(ev('a9', 'kill', { signal: '15' }), 0),
      t.handle(ev('a9', 'die', { exitCode: '137' }), 0),
      t.handle(ev('a9', 'stop'), 0),
      t.handle(ev('a9', 'start'), 0),
      t.handle(ev('a9', 'restart'), 0),
      t.handle(ev('a9', 'health_status: unhealthy'), 0),
      t.handle(ev('a9', 'exec_start: sh -c echo secret'), 0),
      t.handle(ev('a9', 'oom'), 0),
      t.handle(ev('a9', 'die', { exitCode: '1' }), 0),
      t.handle(ev('a9', 'start'), 0),
    ].filter(Boolean);
    expect(out.map((e) => [e!.event, e!.detail ?? null])).toEqual([
      ['die', { exitCode: 137 }],
      ['stop', null],
      ['start', null],
      ['restart', null],
      ['health_status', { status: 'unhealthy' }],
      ['oom', null],
      ['die', { exitCode: 1 }],
      ['start', null],
    ]);
    expect(out[0]).toMatchObject({ service: 'acs/cpe-sim', ts: 1_800_000_000_123 });
    expect(agentEventsSchema.safeParse({ v: 1, events: out }).success).toBe(true);
    // Neither the image, the name nor any other label goes out.
    expect(JSON.stringify(out)).not.toMatch(/sha256|acs-cpe-sim-1|secret/);
    expect(t.restarts.get('acs/cpe-sim')).toBe(2);
    expect(t.startedAt.get('a9')).toBe(1_800_000_000_123);
  });

  it('ignores other projects, non-container events and containers without labels', () => {
    const t = new EventTracker((p) => p === 'acs');
    expect(t.handle({ ...ev('o1', 'start'), Actor: { ID: 'o1', Attributes: labels('other', 'x') } }, 0)).toBeNull();
    expect(t.handle({ Type: 'network', Action: 'connect', Actor: { ID: 'n' } }, 0)).toBeNull();
    expect(t.handle({ Type: 'container', Action: 'start', Actor: { ID: 'z', Attributes: {} } }, 0)).toBeNull();
    // A destroyed container's pending die is forgotten: its successor's start is not a restart.
    t.handle(ev('a9', 'die', { exitCode: '0' }), 0);
    t.handle(ev('a9', 'destroy'), 0);
    t.handle(ev('a9', 'start'), 0);
    expect(t.restarts.get('acs/cpe-sim')).toBeUndefined();
  });
});

describe('upRange', () => {
  it('gives the seconds each "Up …" text stands for, as go-units rounds them', () => {
    const H = 3600;
    expect(upRange('Up Less than a second')).toEqual([0, 1]);
    expect(upRange('Up 30 seconds')).toEqual([30, 31]);
    expect(upRange('Up About a minute')).toEqual([60, 120]);
    expect(upRange('Up 5 minutes (healthy)')).toEqual([300, 360]);
    expect(upRange('Up About an hour')).toEqual([H, 1.5 * H]);
    expect(upRange('Up 3 hours')).toEqual([2.5 * H, 3.5 * H]);
    expect(upRange('Up 6 days')).toEqual([143.5 * H, 167.5 * H]);
    expect(upRange('Up 2 weeks')).toEqual([335.5 * H, 503.5 * H]);
    expect(upRange('Up 1 year')).toEqual([8760 * H, 17_520 * H]);
    expect(upRange('Exited (0) 1 minute ago')).toBeNull();
  });
});

describe('EventTracker state across a restart of the agent', () => {
  const lbl = { 'com.docker.compose.project': 'acs', 'com.docker.compose.service': 'cpe-sim' };
  const now = 1_800_000_000_000;
  const tracker = () => new EventTracker((p) => p === 'acs');
  const run = (t: EventTracker, action: string, id: string, at: number) =>
    t.handle({ Type: 'container', Action: action, Actor: { ID: id, Attributes: lbl }, timeNano: at * 1e6 }, at);

  it('saves and restores counts, start times and dead containers; ignores malformed files', () => {
    const a = tracker();
    run(a, 'die', 'a9', now - 120_000);
    run(a, 'start', 'a9', now - 105_000);
    run(a, 'die', 'b1', now - 50_000);
    expect(a.dirty).toBe(true);
    const snap = JSON.parse(JSON.stringify(a.snapshot()));
    expect(snap).toEqual({ v: 1, startedAt: { a9: now - 105_000 }, restarts: { 'acs/cpe-sim': 1 }, died: ['b1'] });
    const b = tracker();
    expect(b.restore(snap)).toBe(true);
    expect(b.startedAt.get('a9')).toBe(now - 105_000);
    expect(b.restarts.get('acs/cpe-sim')).toBe(1);
    // A start of the container that was dead counts, as before the restart.
    run(b, 'start', 'b1', now);
    expect(b.restarts.get('acs/cpe-sim')).toBe(2);
    for (const bad of [null, 'x', { v: 2 }, { v: 1, startedAt: {}, restarts: {} }]) expect(tracker().restore(bad)).toBe(false);
    const c = tracker();
    c.restore({ v: 1, startedAt: { a: 'soon', b: -1, c: now }, restarts: { k: 1.5, j: 2 }, died: [3, 'd'] });
    expect([...c.startedAt]).toEqual([['c', now]]);
    expect([...c.restarts]).toEqual([['j', 2]]);
  });

  it('works out what happened while it was away from the first container list', () => {
    const t = tracker();
    t.restore({
      v: 1,
      startedAt: { kept: now - 125_000, restarted: now - 3 * 86_400_000, stopped: now - 600_000, gone: now - 60_000 },
      restarts: {},
      died: ['revived', 'stilldead', 'removed'],
    });
    const c = (Id: string, State: string, Status: string): DockerContainer => ({ Id, State, Status, Labels: lbl });
    t.dirty = false;
    t.reconcile(
      [
        c('kept', 'running', 'Up 2 minutes'), // fits: exact start kept
        c('restarted', 'running', 'Up 4 minutes'), // saved 3 days ago: restarted meanwhile
        c('stopped', 'exited', 'Exited (0) 1 minute ago'),
        c('revived', 'running', 'Up 30 seconds'),
        c('stilldead', 'exited', 'Exited (1) 2 hours ago'),
      ],
      now,
    );
    expect([...t.startedAt]).toEqual([['kept', now - 125_000]]);
    expect(t.restarts.get('acs/cpe-sim')).toBe(2); // "restarted" and "revived"
    expect(t.snapshot().died.sort()).toEqual(['stilldead', 'stopped']);
    expect(t.dirty).toBe(true);
  });
});
