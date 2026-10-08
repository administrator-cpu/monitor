import { MongoClient } from 'mongodb';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const OP_KINDS = ['insert', 'query', 'update', 'delete', 'getmore', 'command'] as const;
export type OpKind = (typeof OP_KINDS)[number];

export interface RawServerStatus {
  version?: string;
  connections: { current: number; available: number };
  opcounters: Record<OpKind, number>;
  residentMb: number;
}

export interface RawReplMember {
  self?: boolean;
  stateStr: string;
  optimeDate?: Date | number | string | null;
}

export interface RawOp {
  opid: number;
  ns: string;
  op: string;
  secsRunning: number;
  planSummary?: string;
  appName?: string;
}

export interface RawProfile {
  ts: Date | number;
  ns: string;
  op?: string;
  millis: number;
  planSummary?: string;
  docsExamined?: number;
  keysExamined?: number;
  nreturned?: number;
  appName?: string;
  command?: unknown;
}

/**
 * Read-only view of MongoDB. Every method is a read; there is deliberately no way to write,
 * change the profiler or run an arbitrary command from here.
 */
export interface MongoSource {
  ping(): Promise<number>;
  serverStatus(): Promise<RawServerStatus>;
  /** Null for a standalone server. */
  replSetStatus(): Promise<RawReplMember[] | null>;
  /** Total storage size of all databases, in bytes. */
  storageSize(): Promise<number>;
  currentOps(minSecs: number): Promise<RawOp[]>;
  slowQueries(db: string, sinceMs: number, limit: number): Promise<RawProfile[]>;
  close(): Promise<void>;
}

export const MONITOR_APP_NAME = 'command-center-monitor';

/** True for "not authorized" style errors, which are reported as a missing permission, not an outage. */
export function isPermissionError(e: unknown): boolean {
  const code = (e as { code?: number })?.code;
  const msg = e instanceof Error ? e.message : String(e);
  return code === 13 || code === 8000 || /not authorized|unauthorized|requires authentication|not allowed/i.test(msg);
}

/** Removes credentials from anything that might carry a connection string. */
export function redact(text: string): string {
  return text
    .replace(/(mongodb(?:\+srv)?:\/\/)[^@\s/]*@/gi, '$1***@')
    .replace(/(password|pwd|passwd)=[^&\s]+/gi, '$1=***')
    .slice(0, 300);
}

// --- pure helpers (unit tested) ----------------------------------------------

/** Per-second operation rates from two counter readings; a restart (counters go down) gives zeros. */
export class OpRates {
  private prev: { at: number; c: Record<OpKind, number> } | null = null;

  next(at: number, c: Record<OpKind, number>): Record<OpKind, number> {
    const zero = { insert: 0, query: 0, update: 0, delete: 0, getmore: 0, command: 0 };
    const p = this.prev;
    this.prev = { at, c: { ...c } };
    if (!p) return zero;
    const dt = (at - p.at) / 1000;
    if (dt <= 0) return zero;
    const out = { ...zero };
    for (const k of OP_KINDS) {
      const d = c[k] - p.c[k];
      if (d < 0) return zero; // the server restarted: this interval is not meaningful
      out[k] = d / dt;
    }
    return out;
  }
}

const ms = (d: Date | number | string | null | undefined): number | null => {
  if (d === null || d === undefined) return null;
  const t = d instanceof Date ? d.getTime() : typeof d === 'number' ? d : Date.parse(d);
  return Number.isFinite(t) ? t : null;
};

/**
 * Replication lag in seconds. On a secondary: how far this member is behind the primary. On the
 * primary: the largest lag among secondaries. Null when it cannot be worked out.
 */
export function computeReplLag(members: RawReplMember[]): { state: string; lagS: number | null } | null {
  const me = members.find((m) => m.self);
  if (!me) return null;
  const primary = members.find((m) => m.stateStr === 'PRIMARY');
  const pT = ms(primary?.optimeDate);
  if (me.stateStr === 'PRIMARY') {
    const lags = members
      .filter((m) => m.stateStr === 'SECONDARY')
      .map((m) => ms(m.optimeDate))
      .filter((t): t is number => t !== null && pT !== null)
      .map((t) => Math.max(0, (pT! - t) / 1000));
    return { state: me.stateStr, lagS: lags.length ? Math.max(...lags) : 0 };
  }
  const mT = ms(me.optimeDate);
  if (me.stateStr === 'SECONDARY' && pT !== null && mT !== null) {
    return { state: me.stateStr, lagS: Math.max(0, (pT - mT) / 1000) };
  }
  return { state: me.stateStr, lagS: null };
}

const DROP_KEYS = new Set(['lsid', '$clusterTime', 'signature', 'txnNumber', '$readPreference']);
const MAX_DEPTH = 6;
const MAX_KEYS = 40;

function isPlain(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function shapeOf(v: unknown, depth: number): unknown {
  if (depth >= MAX_DEPTH) return '?';
  if (Array.isArray(v)) return v.length === 0 ? [] : [shapeOf(v[0], depth + 1)];
  if (v !== null && typeof v === 'object' && isPlain(v)) {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (DROP_KEYS.has(k)) continue;
      if (++n > MAX_KEYS) {
        out['…'] = '?';
        break;
      }
      out[k.slice(0, 80)] = shapeOf(val, depth + 1);
    }
    return out;
  }
  return '?'; // every leaf value, including BSON types, becomes a placeholder
}

/**
 * The command with all values replaced by `?`: field names and nesting only. Raw filter values are
 * never stored (TRD 4.5). The output is a JSON string cut at 2,000 characters.
 */
export function commandShape(command: unknown): string | null {
  if (command === null || command === undefined) return null;
  const s = JSON.stringify(shapeOf(command, 0));
  return s.length > 2_000 ? `${s.slice(0, 1_999)}…` : s;
}

// --- the real driver ----------------------------------------------------------

interface CollLike {
  find(filter: object, options?: object): { sort(s: object): { limit(n: number): { toArray(): Promise<any[]> } } };
}
interface DbLike {
  command(cmd: object, options?: object): Promise<any>;
  collection(name: string): CollLike;
}
export interface MongoClientLike {
  connect(): Promise<unknown>;
  db(name: string): DbLike;
  close(): Promise<void>;
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : typeof (v as any)?.toNumber === 'function' ? (v as any).toNumber() : d);

/**
 * The official driver with a small pool, short timeouts and `secondaryPreferred` reads, so
 * monitoring never adds load to the primary. The URI is a secret and is never logged.
 */
export class DriverMongoSource implements MongoSource {
  private client: MongoClientLike | null = null;
  private connecting: Promise<MongoClientLike> | null = null;

  constructor(
    private readonly uri: string,
    private readonly makeClient: (uri: string) => MongoClientLike = (u) =>
      new MongoClient(u, {
        maxPoolSize: 2,
        minPoolSize: 0,
        serverSelectionTimeoutMS: 5_000,
        connectTimeoutMS: 5_000,
        socketTimeoutMS: 8_000,
        readPreference: 'secondaryPreferred',
        appName: MONITOR_APP_NAME,
      }) as unknown as MongoClientLike,
  ) {}

  private async db(name = 'admin'): Promise<DbLike> {
    if (!this.client) {
      this.connecting ??= (async () => {
        const c = this.makeClient(this.uri);
        try {
          await c.connect();
        } catch (e) {
          await c.close().catch(() => undefined);
          throw e;
        } finally {
          this.connecting = null;
        }
        this.client = c;
        return c;
      })();
      await this.connecting;
    }
    return (this.client as MongoClientLike).db(name);
  }

  /** After a failure the connection is dropped so the next attempt starts clean. */
  private async guard<T>(fn: (admin: DbLike) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.db('admin'));
    } catch (e) {
      if (!isPermissionError(e)) await this.reset();
      throw e;
    }
  }

  private async reset(): Promise<void> {
    const c = this.client;
    this.client = null;
    await c?.close().catch(() => undefined);
  }

  async ping(): Promise<number> {
    const t0 = Date.now();
    await this.guard((a) => a.command({ ping: 1 }, { maxTimeMS: 4_000 }));
    return Date.now() - t0;
  }

  async serverStatus(): Promise<RawServerStatus> {
    const r = await this.guard((a) =>
      a.command({ serverStatus: 1, metrics: 0, locks: 0, wiredTiger: 0, repl: 0, tcmalloc: 0, storageEngine: 0, transportSecurity: 0 }, { maxTimeMS: 5_000 }),
    );
    const oc = r.opcounters ?? {};
    return {
      version: typeof r.version === 'string' ? r.version : undefined,
      connections: { current: num(r.connections?.current), available: num(r.connections?.available) },
      opcounters: {
        insert: num(oc.insert),
        query: num(oc.query),
        update: num(oc.update),
        delete: num(oc.delete),
        getmore: num(oc.getmore),
        command: num(oc.command),
      },
      residentMb: num(r.mem?.resident),
    };
  }

  async replSetStatus(): Promise<RawReplMember[] | null> {
    try {
      const r = await this.guard((a) => a.command({ replSetGetStatus: 1 }, { maxTimeMS: 5_000 }));
      return (Array.isArray(r.members) ? r.members : []).map((m: any) => ({
        self: m.self === true,
        stateStr: String(m.stateStr ?? 'UNKNOWN'),
        optimeDate: m.optimeDate ?? null,
      }));
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code === 76 || /not running with --replSet|NoReplicationEnabled/i.test((e as Error).message)) return null;
      throw e;
    }
  }

  async storageSize(): Promise<number> {
    const r = await this.guard((a) => a.command({ listDatabases: 1, nameOnly: false }, { maxTimeMS: 5_000 }));
    return (Array.isArray(r.databases) ? r.databases : []).reduce((s: number, d: any) => s + num(d.sizeOnDisk), 0);
  }

  async currentOps(minSecs: number): Promise<RawOp[]> {
    const r = await this.guard((a) =>
      a.command({ currentOp: 1, active: true, secs_running: { $gte: minSecs } }, { maxTimeMS: 5_000 }),
    );
    return (Array.isArray(r.inprog) ? r.inprog : [])
      .filter((o: any) => typeof o.ns === 'string' && o.ns !== '' && Number.isFinite(Number(o.opid)))
      .map((o: any) => ({
        opid: Number(o.opid),
        ns: String(o.ns),
        op: String(o.op ?? 'unknown'),
        secsRunning: num(o.secs_running),
        planSummary: typeof o.planSummary === 'string' ? o.planSummary : undefined,
        appName: typeof o.appName === 'string' ? o.appName : undefined,
      }));
  }

  async slowQueries(db: string, sinceMs: number, limit: number): Promise<RawProfile[]> {
    const database = await this.db(db);
    try {
      const rows = await database
        .collection('system.profile')
        .find(
          { ts: { $gt: new Date(sinceMs) }, ns: { $not: /\.system\.profile$/ } },
          { projection: { ts: 1, ns: 1, op: 1, millis: 1, planSummary: 1, docsExamined: 1, keysExamined: 1, nreturned: 1, appName: 1, command: 1 }, maxTimeMS: 5_000 },
        )
        .sort({ ts: 1 })
        .limit(limit)
        .toArray();
      return rows.map((r: any) => ({
        ts: r.ts instanceof Date ? r.ts : num(r.ts),
        ns: String(r.ns ?? ''),
        op: typeof r.op === 'string' ? r.op : undefined,
        millis: num(r.millis),
        planSummary: typeof r.planSummary === 'string' ? r.planSummary : undefined,
        docsExamined: r.docsExamined === undefined ? undefined : num(r.docsExamined),
        keysExamined: r.keysExamined === undefined ? undefined : num(r.keysExamined),
        nreturned: r.nreturned === undefined ? undefined : num(r.nreturned),
        appName: typeof r.appName === 'string' ? r.appName : undefined,
        command: r.command,
      }));
    } catch (e) {
      if (!isPermissionError(e)) await this.reset();
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.reset();
  }
}
