import type { MongoCurrentOp, MongoState } from '@cc/shared';
import type { Db } from '../db';
import type { CollectorDef } from '../scheduler';
import type { StateStore } from '../state';
import {
  commandShape,
  computeReplLag,
  isPermissionError,
  MONITOR_APP_NAME,
  OpRates,
  redact,
  type MongoSource,
  type RawProfile,
} from './source';

const STORAGE_EVERY_MS = 60_000;
const SLOW_BATCH = 200;
const FIVE_MIN = 300_000;
/** Operations running at least this long are listed; the alert rule has its own, higher threshold. */
const LIST_OPS_FROM_S = 1;

const toMs = (t: Date | number): number => (t instanceof Date ? t.getTime() : t);

const explain = (what: string, e: unknown): string =>
  isPermissionError(e)
    ? `The monitoring user is not allowed to read ${what}.`
    : `Could not read ${what}: ${redact(e instanceof Error ? e.message : String(e))}`;

export interface MongoCollector extends CollectorDef {
  close(): Promise<void>;
}

/**
 * MongoDB every 10 s. An unreachable server is recorded as data (`up: false` with the reason), so
 * the rest of the monitor and this collector's own freshness are unaffected. Parts the monitoring
 * user may not read (replication, current operations, the profiler) become warnings, not outages.
 * Slow queries are stored as shapes only: field names, never filter values.
 */
export function mongoCollector(d: {
  source: MongoSource;
  db: Db;
  state: StateStore;
  profileDbs: string[];
  now?: () => number;
}): MongoCollector {
  const now = d.now ?? Date.now;
  const rates = new OpRates();
  let storage: { at: number; bytes: number | null } = { at: 0, bytes: null };

  const lastSeen = new Map<string, number>();
  const cursorFor = (db: string, at: number): number => {
    let c = lastSeen.get(db);
    if (c === undefined) {
      const row = d.db
        .prepare(`SELECT MAX(ts) AS m FROM mongo_slow_queries WHERE namespace LIKE ? ESCAPE '\\'`)
        .get(`${db.replace(/[\\%_]/g, '\\$&')}.%`) as { m: number | null };
      c = row.m ?? at - FIVE_MIN; // after a restart, carry on from the last stored query
      lastSeen.set(db, c);
    }
    return c;
  };

  const insert = d.db.prepare(
    `INSERT INTO mongo_slow_queries (ts, namespace, op, millis, plan_summary, docs_examined, keys_examined, n_returned, app_name, command_shape)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  async function readSlow(at: number, warnings: string[]): Promise<void> {
    for (const db of d.profileDbs) {
      try {
        const since = cursorFor(db, at);
        const rows: RawProfile[] = await d.source.slowQueries(db, since, SLOW_BATCH);
        let max = since;
        d.db.transaction(() => {
          for (const r of rows) {
            const ts = toMs(r.ts);
            max = Math.max(max, ts);
            if (r.appName === MONITOR_APP_NAME || /\.system\.profile$/.test(r.ns)) continue;
            insert.run(
              ts,
              r.ns.slice(0, 200),
              r.op ?? null,
              Math.round(r.millis),
              r.planSummary?.slice(0, 200) ?? null,
              r.docsExamined ?? null,
              r.keysExamined ?? null,
              r.nreturned ?? null,
              r.appName?.slice(0, 100) ?? null,
              commandShape(r.command),
            );
          }
        })();
        lastSeen.set(db, max);
      } catch (e) {
        warnings.push(explain(`the slow query profile of database "${db}"`, e));
      }
    }
  }

  const down = (at: number, error: string, version?: string): MongoState => ({
    updatedAt: at,
    up: false,
    error,
    ...(version ? { version } : {}),
    pingMs: null,
    connCurrent: 0,
    connAvailable: 0,
    opsPerS: { insert: 0, query: 0, update: 0, delete: 0, getmore: 0, command: 0 },
    memResidentMb: 0,
    dataSizeBytes: storage.bytes,
    currentOps: [],
    slowQueries5m: d.profileDbs.length ? slowCount(at) : null,
    warnings: [],
  });

  const slowCount = (at: number): number =>
    (d.db.prepare('SELECT COUNT(*) AS n FROM mongo_slow_queries WHERE ts >= ?').get(at - FIVE_MIN) as { n: number }).n;

  return {
    name: 'mongo',
    intervalMs: 10_000,
    timeoutMs: 28_000,
    async close() {
      await d.source.close();
    },
    async run() {
      const at = now();
      let pingMs: number;
      let ss;
      try {
        pingMs = await d.source.ping();
        ss = await d.source.serverStatus();
      } catch (e) {
        d.state.setMongo(down(at, explain('the server status', e)));
        return;
      }

      const warnings: string[] = [];
      let repl: MongoState['repl'];
      try {
        const members = await d.source.replSetStatus();
        if (members) repl = computeReplLag(members) ?? undefined;
      } catch (e) {
        warnings.push(explain('the replica set status', e));
      }

      let ops: MongoCurrentOp[] = [];
      try {
        ops = (await d.source.currentOps(LIST_OPS_FROM_S))
          .filter((o) => o.appName !== MONITOR_APP_NAME && !o.ns.startsWith('local.') && !o.ns.endsWith('.$cmd'))
          .map((o) => ({ opid: o.opid, ns: o.ns, op: o.op, secsRunning: o.secsRunning, ...(o.planSummary ? { plan: o.planSummary } : {}) }))
          .sort((a, b) => b.secsRunning - a.secsRunning)
          .slice(0, 50);
      } catch (e) {
        warnings.push(explain('the current operations', e));
      }

      if (at - storage.at >= STORAGE_EVERY_MS) {
        try {
          storage = { at, bytes: await d.source.storageSize() };
        } catch (e) {
          storage = { at, bytes: storage.bytes };
          warnings.push(explain('the database sizes', e));
        }
      }

      if (d.profileDbs.length > 0) await readSlow(at, warnings);

      d.state.setMongo({
        updatedAt: at,
        up: true,
        ...(ss.version ? { version: ss.version } : {}),
        pingMs,
        connCurrent: ss.connections.current,
        connAvailable: ss.connections.available,
        opsPerS: rates.next(at, ss.opcounters),
        memResidentMb: ss.residentMb,
        dataSizeBytes: storage.bytes,
        ...(repl ? { repl } : {}),
        currentOps: ops,
        slowQueries5m: d.profileDbs.length ? slowCount(at) : null,
        warnings,
      });
    },
  };
}
