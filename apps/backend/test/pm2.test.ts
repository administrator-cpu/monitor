import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ProcessState } from '@cc/shared';
import { aggregate, liveNames, normalizeStatus, pm2Collector } from '../src/pm2/collector';
import { ProcessEvents } from '../src/pm2/events';
import { toProc } from '../src/pm2/inproc';
import { Pm2Link } from '../src/pm2/link';
import { ServiceConflictError, ServicesRepo } from '../src/pm2/services';
import type { Pm2Handlers, Pm2Proc, Pm2Source } from '../src/pm2/types';
import { parseDiskIo } from '../src/collectors/diskio';
import { migrate, openDb } from '../src/db';
import { StateStore } from '../src/state';

const proc = (over: Partial<Pm2Proc> = {}): Pm2Proc => ({
  name: 'api', pmId: 0, status: 'online', restarts: 0, pmUptime: 1_000_000 - 60_000, cpu: 1, memory: 100, isModule: false, ...over,
});

describe('status and aggregation', () => {
  it('maps PM2 statuses and flags unknown ones as errored', () => {
    expect(normalizeStatus('online')).toBe('online');
    expect(normalizeStatus('one-launch-status')).toBe('online');
    expect(normalizeStatus('stopped')).toBe('stopped');
    expect(normalizeStatus('waiting restart')).toBe('errored');
    expect(normalizeStatus('')).toBe('errored');
  });

  it('groups cluster instances: worst status, summed load, newest uptime of online instances', () => {
    const now = 1_000_000;
    const [g] = aggregate(
      [
        proc({ pmId: 0, cpu: 10.04, memory: 100, restarts: 2, pmUptime: now - 300_000 }),
        proc({ pmId: 1, cpu: 5, memory: 50, restarts: 1, pmUptime: now - 60_000 }),
        proc({ pmId: 2, status: 'errored', cpu: 0, memory: 0, restarts: 9, pmUptime: now - 1_000 }),
      ],
      now,
    );
    expect(g).toMatchObject({ name: 'api', status: 'errored', instances: 3, instancesOnline: 2, memBytes: 150, restarts: 12, uptimeS: 60, cpuPct: 15 });
  });

  it('leaves PM2 modules out and keeps different names apart', () => {
    const list = aggregate([proc(), proc({ name: 'pm2-logrotate', isModule: true }), proc({ name: 'web', pmId: 3 })], 1_000_000);
    expect(list.map((g) => g.name).sort()).toEqual(['api', 'web']);
  });

  it('copies only whitelisted fields from a PM2 record (never the environment)', () => {
    const rec = {
      name: 'api',
      pm_id: 4,
      monit: { cpu: 3, memory: 1234 },
      pm2_env: { status: 'online', restart_time: 2, pm_uptime: 5, SECRET_TOKEN: 'hunter2', env: { DB_PASSWORD: 'pw' }, pmx_module: false },
    };
    const p = toProc(rec)!;
    expect(p).toEqual({ name: 'api', pmId: 4, status: 'online', restarts: 2, pmUptime: 5, cpu: 3, memory: 1234, isModule: false, outLog: null, errLog: null });
    expect(JSON.stringify(p)).not.toMatch(/hunter2|pw/);
    expect(toProc({ pm2_env: {} })).toBeNull();
    expect(toProc({ name: 'x', pm2_env: { pmx_module: true } })?.isModule).toBe(true);
  });
});

describe('ProcessEvents', () => {
  const pkt = (over = {}) => ({ name: 'api', pmId: 0, event: 'exit', at: 1, exitCode: 1, signal: null, isModule: false, ...over });

  it('records the last exit and ignores module events', () => {
    const e = new ProcessEvents();
    e.add(pkt({ at: 5, exitCode: 137, signal: 'SIGKILL' }));
    e.add(pkt({ name: 'pm2-logrotate', isModule: true }));
    expect(e.lastExit('api')).toEqual({ at: 5, code: 137, signal: 'SIGKILL' });
    expect(e.peek()).toHaveLength(1);
    expect(e.peek()[0]?.detail).toEqual({ exitCode: 137, signal: 'SIGKILL' });
  });

  it('keeps events until acknowledged and bounds a restart storm', () => {
    const e = new ProcessEvents();
    for (let i = 0; i < 2_500; i++) e.add(pkt({ at: i }));
    expect(e.peek()).toHaveLength(2_000);
    expect(e.dropped).toBe(500);
    expect(e.peek()[0]?.ts).toBe(500);
    e.ack(1_000);
    expect(e.peek()).toHaveLength(1_000);
  });
});

describe('Pm2Link', () => {
  class FakeSource implements Pm2Source {
    connects = 0;
    buses = 0;
    disposed = false;
    failConnect: Error | null = null;
    failList: Error | null = null;
    handlers: Pm2Handlers | null = null;
    async connect() {
      this.connects += 1;
      if (this.failConnect) throw this.failConnect;
    }
    async list() {
      if (this.failList) throw this.failList;
      return [proc()];
    }
    async startBus(h: Pm2Handlers) {
      this.buses += 1;
      this.handlers = h;
    }
    async stopBus() {}
    async dispose() {
      this.disposed = true;
    }
  }

  function make() {
    const clock = { t: 0 };
    const sources: FakeSource[] = [];
    const logs: unknown[] = [];
    const link = new Pm2Link({
      createSource: () => {
        const s = new FakeSource();
        sources.push(s);
        return s;
      },
      onLogs: (i) => logs.push(...i),
      onEvents: () => undefined,
      now: () => clock.t,
    });
    return { clock, sources, link, logs };
  }

  it('connects once, starts the bus once, and delivers bus packets to the callbacks', async () => {
    const { link, sources, logs } = make();
    await link.list();
    await link.list();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ connects: 1, buses: 1 });
    sources[0]!.handlers!.onLogs([{ name: 'api', pmId: 0, stream: 'out', data: 'hi', at: 1 }]);
    expect(logs).toHaveLength(1);
    expect(link.state).toBe('connected');
  });

  it('backs off exponentially while the daemon is down and recovers without a restart', async () => {
    const { link, sources, clock } = make();
    await link.list();
    sources[0]!.failConnect = null;
    // simulate the daemon going away after having worked
    sources[0]!.failList = new Error('daemon gone');
    await expect(link.list()).rejects.toThrow('daemon gone');
    expect(sources[0]!.disposed).toBe(true); // a source that failed after connecting is discarded
    await expect(link.list()).rejects.toThrow(/retrying in/); // no call during the back-off window
    expect(sources).toHaveLength(1);

    clock.t += 1_001;
    await link.list(); // a fresh source is built and works
    expect(sources).toHaveLength(2);
    expect(link.lastError).toBeNull();
  });

  it('doubles the wait after each failure up to the cap', async () => {
    const clock = { t: 0 };
    const link = new Pm2Link({
      createSource: () => {
        const src = new FakeSource();
        src.failConnect = new Error('no daemon');
        return src;
      },
      onLogs: () => undefined,
      onEvents: () => undefined,
      now: () => clock.t,
    });
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      await link.list().catch(() => undefined); // a real attempt
      const msg = await link.list().then(() => '', (e: Error) => e.message); // inside the wait window
      waits.push(Number(/retrying in (\d+)s/.exec(msg)?.[1]));
      clock.t += 60_000;
    }
    expect(waits.slice(0, 5)).toEqual([1, 2, 4, 8, 16]);
    expect(Math.max(...waits)).toBe(30);
  });

  it('close releases the source', async () => {
    const { link, sources } = make();
    await link.list();
    await link.close();
    expect(sources[0]!.disposed).toBe(true);
    expect(link.state).toBe('disconnected');
  });
});

describe('ServicesRepo and the pm2 collector', () => {
  function setup() {
    const db = openDb(':memory:');
    migrate(db);
    const clock = { t: 1_000_000 };
    const services = new ServicesRepo(db, () => clock.t, () => 24);
    return { db, clock, services };
  }

  it('discovers a service on first sight, keeps it, and un-archives a reappearing one', () => {
    const { services, clock } = setup();
    const a = services.discover('api');
    expect(a).toMatchObject({ name: 'api', pm2_name: 'api', is_archived: 0 });
    expect(services.discover('api').id).toBe(a.id);
    services.update(a.id, { isArchived: true }, new Set());
    expect(services.list()).toHaveLength(0);
    clock.t += 5;
    expect(services.discover('api').is_archived).toBe(0);
    expect(services.list()).toHaveLength(1);
  });

  it('refuses to archive a running service, duplicate names, and the reserved name', () => {
    const { services } = setup();
    const a = services.discover('api');
    const b = services.discover('web');
    expect(() => services.update(a.id, { isArchived: true }, new Set(['api']))).toThrow(ServiceConflictError);
    expect(() => services.update(b.id, { name: 'API' }, new Set())).toThrow(ServiceConflictError);
    expect(() => services.update(b.id, { name: '_unattributed' }, new Set())).toThrow(ServiceConflictError);
    expect(services.update(b.id, { name: 'Storefront' }, new Set()).name).toBe('Storefront');
  });

  it('gives a new process a free display name when an admin already used it', () => {
    const { services } = setup();
    const a = services.discover('api');
    services.update(a.id, { name: 'worker' }, new Set());
    const w = services.discover('worker');
    expect(w.name).toBe('worker (2)');
    expect(w.pm2_name).toBe('worker');
  });

  it('marks a service stale after the configured hours', () => {
    const { services, clock } = setup();
    const a = services.discover('api');
    expect(services.toDto(a).stale).toBe(false);
    clock.t += 25 * 3_600_000;
    expect(services.toDto(a).stale).toBe(true);
  });

  it('collector: aggregates, keeps vanished services as stopped, and excludes archived ones', async () => {
    const { services, clock } = setup();
    const state = new StateStore();
    const events = new ProcessEvents();
    events.add({ name: 'gone', pmId: 0, event: 'exit', at: 5, exitCode: 2, signal: null, isModule: false });
    services.discover('gone');
    const arch = services.discover('old');
    services.update(arch.id, { isArchived: true }, new Set());
    const link = { list: vi.fn(async () => [proc({ name: 'api', pmUptime: clock.t - 30_000 }), proc({ name: 'api', pmId: 1 }), proc({ name: 'pm2-logrotate', isModule: true })]) };
    const c = pm2Collector({ link: link as never, services, state, events, now: () => clock.t });
    await c.run();
    const states = state.getProcessStates();
    expect(states.map((s) => s.pm2Name).sort()).toEqual(['api', 'gone']);
    const gone = states.find((s) => s.pm2Name === 'gone') as ProcessState;
    expect(gone).toMatchObject({ status: 'stopped', instances: 0, lastExit: { at: 5, code: 2, signal: null } });
    expect(states.find((s) => s.pm2Name === 'api')).toMatchObject({ instances: 2, status: 'online' });
    expect(liveNames(states)).toEqual(new Set(['api']));
  });

  it('collector: a failing link leaves the previous view in place and the scheduler marks it failed', async () => {
    const { services, clock } = setup();
    const state = new StateStore();
    const link = { list: vi.fn().mockResolvedValueOnce([proc()]).mockRejectedValueOnce(new Error('PM2 is not running')) };
    const c = pm2Collector({ link: link as never, services, state, events: new ProcessEvents(), now: () => clock.t });
    await c.run();
    await expect(c.run()).rejects.toThrow('PM2 is not running');
    expect(state.getProcessStates()).toHaveLength(1);
  });
});

describe('disk I/O parsing', () => {
  it('reads C:|read|write lines and ignores everything else', () => {
    const m = parseDiskIo('C:|1024|2048\r\nd:|0|0.5\r\nHARDDISK1|1|2\r\nnoise\r\nE:|x|1\r\n');
    expect([...m.keys()]).toEqual(['C:', 'D:']);
    expect(m.get('C:')).toEqual({ readBps: 1024, writeBps: 2048 });
    expect(m.get('D:')).toEqual({ readBps: 0, writeBps: 0.5 });
  });
});

describe('read-only guarantee', () => {
  it('the pm2 adapter source contains no call that changes a process', () => {
    const dir = path.join(__dirname, '../src/pm2');
    const mutating = /\bpm2\s*\.\s*(start|stop|restart|reload|delete|kill|killDaemon|flush|reloadLogs|scale|sendSignalToProcessName|sendDataToProcessId|trigger|reset|dump|resurrect)\s*\(/;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(mutating.test(src), f).toBe(false);
    }
  });
});
