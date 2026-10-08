import { beforeEach, describe, expect, it } from 'vitest';
import type { CollectorStatus, LogStatus } from '@cc/shared';
import { AlertEngine } from '../src/alerts/engine';
import { Notifier } from '../src/alerts/notifier';
import { AlertRepo } from '../src/alerts/repo';
import { migrate, openDb, type Db } from '../src/db';
import { mongoCollector } from '../src/mongo/collector';
import {
  commandShape,
  computeReplLag,
  DriverMongoSource,
  isPermissionError,
  MONITOR_APP_NAME,
  OpRates,
  redact,
  type MongoClientLike,
  type MongoSource,
  type RawOp,
  type RawProfile,
  type RawReplMember,
  type RawServerStatus,
} from '../src/mongo/source';
import { Persistence } from '../src/persist';
import { ProcessEvents } from '../src/pm2/events';
import { ServicesRepo } from '../src/pm2/services';
import { Settings } from '../src/settings';
import { StateStore } from '../src/state';
import { addUser, authed, login, makeApp } from './helpers';

describe('operation rates', () => {
  const c = (n: number) => ({ insert: n, query: n * 2, update: n, delete: 0, getmore: 0, command: n * 10 });
  it('gives per-second rates and zeros for the first reading and after a restart', () => {
    const r = new OpRates();
    expect(r.next(0, c(100)).query).toBe(0);
    expect(r.next(10_000, c(150))).toMatchObject({ insert: 5, query: 10, command: 50 });
    expect(r.next(20_000, c(10)).insert).toBe(0); // counters went down: restart
    expect(r.next(30_000, c(30)).insert).toBe(2);
    expect(r.next(30_000, c(40)).insert).toBe(0); // no time passed
  });
});

describe('replication lag', () => {
  const t = (s: number) => new Date(1_800_000_000_000 + s * 1000);
  it('secondary: behind the primary; primary: the worst secondary; standalone and unknown: none', () => {
    const members: RawReplMember[] = [
      { stateStr: 'PRIMARY', optimeDate: t(100) },
      { stateStr: 'SECONDARY', self: true, optimeDate: t(88) },
      { stateStr: 'SECONDARY', optimeDate: t(60) },
    ];
    expect(computeReplLag(members)).toEqual({ state: 'SECONDARY', lagS: 12 });
    const asPrimary = members.map((m) => ({ ...m, self: m.stateStr === 'PRIMARY' }));
    expect(computeReplLag(asPrimary)).toEqual({ state: 'PRIMARY', lagS: 40 });
    expect(computeReplLag([{ stateStr: 'PRIMARY', self: true, optimeDate: t(1) }])).toEqual({ state: 'PRIMARY', lagS: 0 });
    expect(computeReplLag([{ stateStr: 'SECONDARY', self: true, optimeDate: null }, { stateStr: 'PRIMARY', optimeDate: t(1) }])).toEqual({ state: 'SECONDARY', lagS: null });
    expect(computeReplLag([{ stateStr: 'STARTUP2', self: true }])).toEqual({ state: 'STARTUP2', lagS: null });
    expect(computeReplLag([])).toBeNull();
    // a clock that makes the secondary look ahead never gives a negative lag
    expect(computeReplLag([{ stateStr: 'PRIMARY', optimeDate: t(1) }, { stateStr: 'SECONDARY', self: true, optimeDate: t(5) }])!.lagS).toBe(0);
  });
});

describe('command shape (no values, ever)', () => {
  class FakeObjectId {
    toHexString() {
      return 'deadbeef';
    }
  }
  const SECRETS = ['alice@example.com', 'hunter2', '4111111111111111', 'deadbeef', 'Bearer abc.def.ghi', '2026-01-01'];

  it('keeps field names and nesting, replaces every value', () => {
    const cmd = {
      find: 'users',
      filter: { email: 'alice@example.com', age: { $gt: 30 }, tags: { $in: ['hunter2', 'x'] }, _id: new FakeObjectId(), created: new Date('2026-01-01') },
      sort: { created: -1 },
      limit: 10,
      $db: 'app',
      lsid: { id: 'session-secret' },
      $clusterTime: { clusterTime: 1, signature: { hash: 'secret' } },
    };
    const shape = commandShape(cmd)!;
    expect(JSON.parse(shape)).toEqual({
      find: '?',
      filter: { email: '?', age: { $gt: '?' }, tags: { $in: ['?'] }, _id: '?', created: '?' },
      sort: { created: '?' },
      limit: '?',
      $db: '?',
    });
    for (const s of [...SECRETS, 'session-secret', 'users', 'app']) expect(shape).not.toContain(s);
  });

  it('handles update documents, aggregation pipelines and odd inputs without leaking', () => {
    const cmd = {
      update: 'orders',
      updates: [{ q: { card: '4111111111111111' }, u: { $set: { token: 'Bearer abc.def.ghi' } }, multi: false }],
      pipeline: [{ $match: { name: 'hunter2' } }, { $group: { _id: '$x', n: { $sum: 1 } } }],
    };
    const shape = commandShape(cmd)!;
    for (const s of SECRETS) expect(shape).not.toContain(s);
    expect(shape).toContain('$set');
    expect(commandShape(null)).toBeNull();
    expect(commandShape(undefined)).toBeNull();
    expect(commandShape('just a string')).toBe('"?"');
    expect(commandShape([])).toBe('[]');
  });

  it('is bounded in depth, keys and length', () => {
    let deep: unknown = 'secret-leaf';
    for (let i = 0; i < 50; i++) deep = { a: deep };
    expect(commandShape(deep)).not.toContain('secret-leaf');
    const wide: Record<string, string> = {};
    for (let i = 0; i < 500; i++) wide[`field${i}`] = 'secret-value';
    const s = commandShape(wide)!;
    expect(s).not.toContain('secret-value');
    expect(Object.keys(JSON.parse(s)).length).toBeLessThanOrEqual(41);
    const huge: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) huge[`k${i}`.repeat(40)] = { x: 1 };
    expect(commandShape(huge)!.length).toBeLessThanOrEqual(2_000);
  });
});

describe('error helpers', () => {
  it('removes credentials from connection strings and messages', () => {
    expect(redact('connect failed mongodb://monitor:s3cret@db1:27017/admin')).toBe('connect failed mongodb://***@db1:27017/admin');
    expect(redact('mongodb+srv://u:p@cluster/x')).not.toContain(':p@');
    expect(redact('bad password=hunter2&x=1')).toBe('bad password=***&x=1');
    expect(redact('x'.repeat(1000)).length).toBe(300);
  });
  it('recognises permission errors', () => {
    expect(isPermissionError(Object.assign(new Error('x'), { code: 13 }))).toBe(true);
    expect(isPermissionError(new Error('not authorized on admin to execute command'))).toBe(true);
    expect(isPermissionError(new Error('connect ECONNREFUSED'))).toBe(false);
  });
});

// --- a fake driver client: records every command so "read-only" can be asserted --------------

interface Script {
  [command: string]: unknown | ((cmd: Record<string, unknown>) => unknown);
}

class FakeClient implements MongoClientLike {
  commands: string[] = [];
  finds: { db: string; coll: string; filter: Record<string, unknown> }[] = [];
  connects = 0;
  closes = 0;
  failConnect: Error | null = null;
  script: Script = {};
  profile: Record<string, unknown>[] = [];
  async connect() {
    this.connects += 1;
    if (this.failConnect) throw this.failConnect;
  }
  async close() {
    this.closes += 1;
  }
  db(name: string) {
    return {
      command: async (cmd: Record<string, unknown>) => {
        const k = Object.keys(cmd)[0] as string;
        this.commands.push(k);
        const v = this.script[k];
        const r = typeof v === 'function' ? (v as (c: Record<string, unknown>) => unknown)(cmd) : v;
        if (r instanceof Error) throw r;
        return r ?? {};
      },
      collection: (coll: string) => ({
        find: (filter: Record<string, unknown>) => ({
          sort: () => ({
            limit: (n: number) => ({
              toArray: async () => {
                this.finds.push({ db: name, coll, filter });
                const since = (filter.ts as { $gt: Date }).$gt.getTime();
                return this.profile.filter((p) => (p.ts as Date).getTime() > since).slice(0, n);
              },
            }),
          }),
        }),
      }),
    };
  }
}

const SERVER_STATUS = {
  version: '7.0.5',
  connections: { current: 30, available: 800 },
  opcounters: { insert: 10, query: 20, update: 5, delete: 1, getmore: 0, command: 100 },
  mem: { resident: 2048 },
};

describe('DriverMongoSource (against a fake client)', () => {
  it('maps the answers and issues only read commands', async () => {
    const fc = new FakeClient();
    fc.script = {
      ping: { ok: 1 },
      serverStatus: SERVER_STATUS,
      replSetGetStatus: { members: [{ self: true, stateStr: 'PRIMARY', optimeDate: new Date(5) }] },
      listDatabases: { databases: [{ sizeOnDisk: 1000 }, { sizeOnDisk: 500 }] },
      currentOp: { inprog: [{ opid: 7, ns: 'app.users', op: 'query', secs_running: 75, planSummary: 'COLLSCAN', command: { filter: { email: 'secret@x.com' } } }, { opid: 8, ns: '', op: 'none' }] },
    };
    fc.profile = [{ ts: new Date(2000), ns: 'app.users', op: 'query', millis: 150, planSummary: 'COLLSCAN', docsExamined: 1000, keysExamined: 0, nreturned: 2, appName: 'api', command: { find: 'users', filter: { email: 'x' } } }];
    const src = new DriverMongoSource('mongodb://u:p@h/x', () => fc);

    expect(await src.ping()).toBeGreaterThanOrEqual(0);
    expect(await src.serverStatus()).toMatchObject({ version: '7.0.5', residentMb: 2048, connections: { current: 30, available: 800 } });
    expect(await src.replSetStatus()).toEqual([{ self: true, stateStr: 'PRIMARY', optimeDate: new Date(5) }]);
    expect(await src.storageSize()).toBe(1500);
    const ops = await src.currentOps(1);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ opid: 7, ns: 'app.users', op: 'query', secsRunning: 75, planSummary: 'COLLSCAN', appName: undefined });
    expect(JSON.stringify(ops)).not.toContain('secret@x.com'); // the command never leaves the adapter
    const slow = await src.slowQueries('app', 1000, 10);
    expect(slow).toHaveLength(1);
    expect(slow[0]).toMatchObject({ ns: 'app.users', millis: 150, docsExamined: 1000 });
    expect(fc.finds[0]).toMatchObject({ db: 'app', coll: 'system.profile' });

    // Only these commands were ever sent: nothing that changes data or settings.
    expect(new Set(fc.commands)).toEqual(new Set(['ping', 'serverStatus', 'replSetGetStatus', 'listDatabases', 'currentOp']));
    const proto = Object.getOwnPropertyNames(DriverMongoSource.prototype).filter((n) => n !== 'constructor');
    expect(proto.sort()).toEqual(['close', 'currentOps', 'db', 'guard', 'ping', 'replSetStatus', 'reset', 'serverStatus', 'slowQueries', 'storageSize']);
  });

  it('standalone servers have no replica set status', async () => {
    const fc = new FakeClient();
    fc.script = { replSetGetStatus: Object.assign(new Error('not running with --replSet'), { code: 76 }) };
    expect(await new DriverMongoSource('mongodb://h', () => fc).replSetStatus()).toBeNull();
  });

  it('keeps the connection after a permission error but rebuilds it after any other failure', async () => {
    const clients: FakeClient[] = [];
    const src = new DriverMongoSource('mongodb://h', () => {
      const c = new FakeClient();
      clients.push(c);
      return c;
    });
    clients.length = 0;
    // first call creates client #1
    const first = new FakeClient();
    first.script = { ping: { ok: 1 }, currentOp: Object.assign(new Error('not authorized on admin to execute command'), { code: 13 }), serverStatus: new Error('socket closed') };
    const src2 = new DriverMongoSource('mongodb://h', () => {
      clients.push(first);
      return first;
    });
    await src2.ping();
    await expect(src2.currentOps(1)).rejects.toThrow('not authorized');
    expect(first.closes).toBe(0);
    await expect(src2.serverStatus()).rejects.toThrow('socket closed');
    expect(first.closes).toBe(1);
    await src2.ping(); // a new client is created on the next call
    expect(first.connects).toBe(2);
    void src;
  });

  it('a failed connect closes the half-open client and the next call tries again', async () => {
    const fc = new FakeClient();
    fc.failConnect = new Error('connect ECONNREFUSED');
    const src = new DriverMongoSource('mongodb://h', () => fc);
    await expect(src.ping()).rejects.toThrow('ECONNREFUSED');
    expect(fc.closes).toBe(1);
    fc.failConnect = null;
    fc.script = { ping: { ok: 1 } };
    await src.ping();
    expect(fc.connects).toBe(2);
    await src.close();
  });
});

// --- collector with a scripted source ------------------------------------------------

class FakeSource implements MongoSource {
  down: Error | null = null;
  status: RawServerStatus = { version: '7.0.5', connections: { current: 30, available: 800 }, opcounters: { insert: 0, query: 0, update: 0, delete: 0, getmore: 0, command: 0 }, residentMb: 1024 };
  repl: RawReplMember[] | null | Error = null;
  ops: RawOp[] | Error = [];
  storage: number | Error = 5_000;
  profile: RawProfile[] | Error = [];
  asked: { db: string; since: number }[] = [];
  closed = false;
  async ping() {
    if (this.down) throw this.down;
    return 3;
  }
  async serverStatus() {
    if (this.down) throw this.down;
    return this.status;
  }
  async replSetStatus() {
    if (this.repl instanceof Error) throw this.repl;
    return this.repl;
  }
  async storageSize() {
    if (this.storage instanceof Error) throw this.storage;
    return this.storage;
  }
  async currentOps() {
    if (this.ops instanceof Error) throw this.ops;
    return this.ops;
  }
  async slowQueries(db: string, since: number) {
    this.asked.push({ db, since });
    if (this.profile instanceof Error) throw this.profile;
    return this.profile.filter((p) => (typeof p.ts === 'number' ? p.ts : p.ts.getTime()) > since);
  }
  async close() {
    this.closed = true;
  }
}

describe('mongo collector', () => {
  let db: Db;
  let state: StateStore;
  let src: FakeSource;
  let clock: { t: number };
  const make = (profileDbs: string[] = []) => mongoCollector({ source: src, db, state, profileDbs, now: () => clock.t });
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    state = new StateStore();
    src = new FakeSource();
    clock = { t: 1_800_000_000_000 };
  });

  it('records a healthy server, with rates from the counters', async () => {
    const c = make();
    await c.run();
    clock.t += 10_000;
    src.status = { ...src.status, opcounters: { insert: 100, query: 200, update: 0, delete: 0, getmore: 0, command: 1000 } };
    await c.run();
    const m = state.getMongo()!;
    expect(m).toMatchObject({ up: true, pingMs: 3, connCurrent: 30, connAvailable: 800, memResidentMb: 1024, version: '7.0.5', dataSizeBytes: 5000, slowQueries5m: null });
    expect(m.opsPerS).toMatchObject({ insert: 10, query: 20, command: 100 });
    expect(m.repl).toBeUndefined();
  });

  it('an unreachable server is data (up false, reason without credentials), not a collector failure', async () => {
    const c = make();
    src.down = new Error('connect ECONNREFUSED mongodb://monitor:s3cret@db:27017');
    await expect(c.run()).resolves.toBeUndefined();
    const m = state.getMongo()!;
    expect(m.up).toBe(false);
    expect(m.error).toContain('ECONNREFUSED');
    expect(m.error).not.toContain('s3cret');
    src.down = null;
    clock.t += 10_000;
    await c.run();
    expect(state.getMongo()!.up).toBe(true);
  });

  it('a missing permission on an optional part becomes a warning, not an outage', async () => {
    const denied = Object.assign(new Error('not authorized'), { code: 13 });
    src.repl = denied;
    src.ops = denied;
    src.storage = denied;
    await make().run();
    const m = state.getMongo()!;
    expect(m.up).toBe(true);
    expect(m.warnings).toEqual([
      'The monitoring user is not allowed to read the replica set status.',
      'The monitoring user is not allowed to read the current operations.',
      'The monitoring user is not allowed to read the database sizes.',
    ]);
  });

  it('lists current operations without the monitor itself, replication internals or commands', async () => {
    src.ops = [
      { opid: 1, ns: 'app.orders', op: 'query', secsRunning: 5 },
      { opid: 2, ns: 'app.users', op: 'update', secsRunning: 90, planSummary: 'COLLSCAN' },
      { opid: 3, ns: 'admin.$cmd', op: 'command', secsRunning: 1 },
      { opid: 4, ns: 'local.oplog.rs', op: 'getmore', secsRunning: 3000 },
      { opid: 5, ns: 'app.x', op: 'query', secsRunning: 2, appName: MONITOR_APP_NAME },
    ];
    await make().run();
    expect(state.getMongo()!.currentOps).toEqual([
      { opid: 2, ns: 'app.users', op: 'update', secsRunning: 90, plan: 'COLLSCAN' },
      { opid: 1, ns: 'app.orders', op: 'query', secsRunning: 5 },
    ]);
  });

  it('reports replication state and lag', async () => {
    src.repl = [{ stateStr: 'PRIMARY', optimeDate: new Date(100_000) }, { stateStr: 'SECONDARY', self: true, optimeDate: new Date(70_000) }];
    await make().run();
    expect(state.getMongo()!.repl).toEqual({ state: 'SECONDARY', lagS: 30 });
  });

  it('stores slow queries as shapes only, skips its own and the profile collection, and never stores twice', async () => {
    const c = make(['app']);
    const t0 = clock.t;
    src.profile = [
      { ts: new Date(clock.t - 1000), ns: 'app.users', op: 'query', millis: 250, planSummary: 'COLLSCAN', docsExamined: 5000, keysExamined: 0, nreturned: 1, appName: 'api', command: { find: 'users', filter: { email: 'alice@example.com' } } },
      { ts: new Date(clock.t - 900), ns: 'app.orders', op: 'update', millis: 120, command: { update: 'orders', updates: [{ q: { card: '4111' }, u: { $set: { n: 1 } } }] } },
      { ts: new Date(clock.t - 800), ns: 'app.users', op: 'query', millis: 300, appName: MONITOR_APP_NAME },
      { ts: new Date(clock.t - 700), ns: 'app.system.profile', op: 'query', millis: 400 },
    ];
    await c.run();
    const rows = db.prepare('SELECT namespace, op, millis, plan_summary, docs_examined, command_shape FROM mongo_slow_queries ORDER BY ts').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ namespace: 'app.users', op: 'query', millis: 250, plan_summary: 'COLLSCAN', docs_examined: 5000 });
    const all = JSON.stringify(rows);
    expect(all).not.toContain('alice@example.com');
    expect(all).not.toContain('4111');
    expect(JSON.parse(rows[0]!.command_shape as string)).toEqual({ find: '?', filter: { email: '?' } });
    expect(state.getMongo()!.slowQueries5m).toBe(2);

    clock.t += 10_000;
    await c.run(); // the same profile documents again
    expect((db.prepare('SELECT COUNT(*) AS n FROM mongo_slow_queries').get() as { n: number }).n).toBe(2);

    // A restarted monitor carries on from the last stored query, not from "now - 5 minutes".
    const again = make(['app']);
    src.asked = [];
    await again.run();
    expect(src.asked[0]!.since).toBe(t0 - 900);
    expect((db.prepare('SELECT COUNT(*) AS n FROM mongo_slow_queries').get() as { n: number }).n).toBe(2);
  });

  it('an unreadable profiler is a warning naming the database', async () => {
    src.profile = Object.assign(new Error('not authorized on app to execute command find'), { code: 13 });
    await make(['app']).run();
    expect(state.getMongo()!.warnings).toEqual(['The monitoring user is not allowed to read the slow query profile of database "app".']);
    expect(state.getMongo()!.up).toBe(true);
  });

  it('close() releases the source', async () => {
    const c = make();
    await c.close();
    expect(src.closed).toBe(true);
  });
});

// --- alert rules ------------------------------------------------------------------------------

describe('mongo alert rules', () => {
  let db: Db;
  let clock: { t: number };
  let state: StateStore;
  let repo: AlertRepo;
  let engine: AlertEngine;
  let stale: Set<string>;

  const base = (over: Partial<NonNullable<ReturnType<StateStore['getMongo']>>> = {}) => {
    state.setMongo({
      updatedAt: clock.t, up: true, pingMs: 2, connCurrent: 10, connAvailable: 990,
      opsPerS: { insert: 0, query: 0, update: 0, delete: 0, getmore: 0, command: 0 },
      memResidentMb: 1, dataSizeBytes: null, currentOps: [], slowQueries5m: 0, warnings: [], ...over,
    });
  };

  beforeEach(() => {
    clock = { t: 1_800_000_000_000 };
    const now = () => clock.t;
    db = openDb(':memory:');
    migrate(db);
    state = new StateStore();
    repo = new AlertRepo(db, now);
    stale = new Set();
    const settings = new Settings(db, now);
    const notifier = new Notifier({ mailer: null, repo, settings, config: { alertFrom: undefined, publicDashboardUrl: undefined, resendApiKey: undefined }, log: { warn: () => undefined, info: () => undefined }, now, sleep: async () => undefined });
    const logs: LogStatus = { volumeOk: true, volumeReason: null, volumeUsedPct: 1, droppedLines: 0, skippedLines: 0, writerQueue: 0 };
    engine = new AlertEngine({
      repo, state, settings, notifier,
      collectors: (): CollectorStatus[] => ['host', 'disk', 'system', 'pm2', 'mongo'].map((name) => ({ name, intervalMs: 1000, lastOkAt: clock.t, stale: stale.has(name) })),
      logs: () => logs, persistence: () => ({ consecutiveFailures: 0 }), log: { warn: () => undefined, info: () => undefined }, now,
    });
  });

  const run = async (seconds: number, set?: () => void): Promise<void> => {
    for (let i = 0; i < seconds / 5; i++) {
      clock.t += 5_000;
      set?.();
      await engine.tick();
    }
  };
  const keys = () => repo.firing().map((x) => x.rule_key);

  it('is silent when MongoDB monitoring is not configured', async () => {
    await run(300);
    expect(keys()).toEqual([]);
  });

  it('down opens after 60 s, names the reason, and resolves after recovery', async () => {
    await run(30, () => base());
    await run(55, () => base({ up: false, error: 'connect ECONNREFUSED' }));
    expect(keys()).toEqual([]);
    await run(20, () => base({ up: false, error: 'connect ECONNREFUSED' }));
    expect(keys()).toEqual(['mongo.down']);
    expect(repo.firing()[0]!.summary).toContain('ECONNREFUSED');
    await run(200, () => base());
    expect(keys()).toEqual([]);
  });

  it('the other rules stay quiet while the server is down (no evidence)', async () => {
    await run(400, () => base({ up: false, connCurrent: 0, slowQueries5m: 999 }));
    expect(keys()).toEqual(['mongo.down']);
  });

  it('connections high needs 300 s above 80 %', async () => {
    await run(250, () => base({ connCurrent: 900, connAvailable: 100 }));
    expect(keys()).toEqual([]);
    await run(100, () => base({ connCurrent: 900, connAvailable: 100 }));
    expect(keys()).toEqual(['mongo.connections_high']);
  });

  it('long operation fires at once when one runs longer than 60 s', async () => {
    await run(10, () => base({ currentOps: [{ opid: 1, ns: 'app.users', op: 'query', secsRunning: 30 }] }));
    expect(keys()).toEqual([]);
    await run(10, () => base({ currentOps: [{ opid: 1, ns: 'app.users', op: 'query', secsRunning: 75 }] }));
    expect(keys()).toEqual(['mongo.long_op']);
    expect(repo.firing()[0]!.summary).toContain('app.users');
    expect(repo.firing()[0]!.summary).not.toMatch(/filter|email/i);
  });

  it('slow query burst fires above 20 in five minutes, and not when the profiler is not configured', async () => {
    await run(20, () => base({ slowQueries5m: null }));
    expect(keys()).toEqual([]);
    await run(20, () => base({ slowQueries5m: 25 }));
    expect(keys()).toEqual(['mongo.slow_query_burst']);
  });

  it('replication lag needs 120 s above 30 s, and standalone servers have none', async () => {
    await run(200, () => base());
    expect(keys()).toEqual([]);
    await run(100, () => base({ repl: { state: 'SECONDARY', lagS: 45 } }));
    expect(keys()).not.toContain('mongo.repl_lag');
    await run(60, () => base({ repl: { state: 'SECONDARY', lagS: 45 } }));
    expect(keys()).toContain('mongo.repl_lag');
  });

  it('is paused while the mongo collector is stale', async () => {
    stale.add('mongo');
    await run(300, () => base({ up: false }));
    expect(keys().filter((k) => k.startsWith('mongo.'))).toEqual([]);
  });
});

// --- persistence and API -----------------------------------------------------------------------

describe('mongo persistence and API', () => {
  it('writes one row per 10 s bucket, with nulls while the server is down', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const clock = { t: Math.floor(1_800_000_000_000 / 10_000) * 10_000 };
    const now = () => clock.t;
    const state = new StateStore();
    const p = new Persistence(db, state, new ProcessEvents(), new ServicesRepo(db, now), now);
    const sample = (up: boolean) =>
      state.setMongo({
        updatedAt: clock.t + 2_000, up, pingMs: up ? 4 : null, connCurrent: up ? 12 : 0, connAvailable: up ? 800 : 0,
        opsPerS: { insert: 1, query: 2, update: 3, delete: 4, getmore: 5, command: 6 }, memResidentMb: up ? 900 : 0,
        dataSizeBytes: 12345, repl: up ? { state: 'PRIMARY', lagS: 0 } : undefined, currentOps: [], slowQueries5m: null, warnings: [],
      });
    sample(true);
    clock.t += 10_000;
    sample(false);
    clock.t += 10_000;
    p.flush();
    const rows = db.prepare('SELECT up, ping_ms, conn_current, op_query_ps, mem_resident_mb, repl_state, data_size_bytes FROM metrics_mongo ORDER BY ts').all();
    expect(rows).toEqual([
      { up: 1, ping_ms: 4, conn_current: 12, op_query_ps: 2, mem_resident_mb: 900, repl_state: 'PRIMARY', data_size_bytes: 12345 },
      { up: 0, ping_ms: null, conn_current: null, op_query_ps: null, mem_resident_mb: null, repl_state: null, data_size_bytes: 12345 },
    ]);
  });

  it('serves state, series and slow queries to any logged-in user, and nothing without a session', async () => {
    const t = await makeApp({ config: { mongoUri: 'mongodb://monitor:s3cret@h/admin', mongoProfileDbs: ['app'] } });
    try {
      expect((await t.app.inject({ method: 'GET', url: '/api/v1/mongo' })).statusCode).toBe(401);
      await addUser(t, { role: 'engineer' });
      const { cookie } = await login(t);
      const ins = t.db.prepare('INSERT INTO mongo_slow_queries (ts, namespace, op, millis, command_shape) VALUES (?, ?, ?, ?, ?)');
      for (let i = 0; i < 30; i++) ins.run(t.clock.t - i * 1000, 'app.users', 'query', 100 + i, '{"find":"?"}');
      t.ctx.state.setMongo({ updatedAt: t.clock.t, up: true, pingMs: 1, connCurrent: 5, connAvailable: 95, opsPerS: { insert: 0, query: 1, update: 0, delete: 0, getmore: 0, command: 0 }, memResidentMb: 10, dataSizeBytes: null, currentOps: [], slowQueries5m: 30, warnings: [] });

      const res = await t.app.inject({ method: 'GET', url: '/api/v1/mongo', headers: authed(cookie!) });
      const body = res.json();
      expect(body.configured).toBe(true);
      expect(body.profileDbs).toEqual(['app']);
      expect(body.mongo).toMatchObject({ up: true, connCurrent: 5 });
      expect(body.slowQueries).toHaveLength(25);
      expect(JSON.stringify(body)).not.toContain('s3cret'); // the URI never leaves the server

      const page1 = (await t.app.inject({ method: 'GET', url: '/api/v1/mongo/slow-queries?limit=10', headers: authed(cookie!) })).json().slowQueries;
      expect(page1).toHaveLength(10);
      const page2 = (await t.app.inject({ method: 'GET', url: `/api/v1/mongo/slow-queries?limit=10&before=${page1[9].id}`, headers: authed(cookie!) })).json().slowQueries;
      expect(page2[0].id).toBeLessThan(page1[9].id);
      expect((await t.app.inject({ method: 'GET', url: '/api/v1/mongo/slow-queries?before=1;DROP', headers: authed(cookie!) })).statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });
});
