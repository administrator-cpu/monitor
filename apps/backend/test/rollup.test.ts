import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../src/db';
import { runRetention } from '../src/retention';
import { ROLLUP_TABLES, rollupSql, runRollup } from '../src/rollup';
import { Settings } from '../src/settings';

const NOW = Math.floor(1_800_000_000_000 / 3_600_000) * 3_600_000; // on the hour
const OLD = NOW - 30 * 3_600_000; // 30 h ago, older than the 24 h of raw data
const MIN = Math.floor(OLD / 60_000) * 60_000;

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  const settings = new Settings(db, () => NOW);
  return { db, settings };
}

describe('rollup', () => {
  it('turns six 10 s host rows into one 60 s row with the right aggregates', () => {
    const { db, settings } = setup();
    const ins = db.prepare(
      `INSERT INTO metrics_host (res_s, ts, cpu_pct, cpu_max_core_pct, mem_used_bytes, mem_total_bytes, swap_used_bytes,
        swap_total_bytes, net_rx_bps, net_tx_bps, uptime_s, pending_reboot) VALUES (10, ?, ?, ?, ?, 1000, 0, 0, ?, 0, ?, ?)`,
    );
    for (let i = 0; i < 6; i++) ins.run(MIN + i * 10_000, 10 * (i + 1), 20 + i * 10, 100 + i, 60 * i, 1000 + i, i === 3 ? 1 : 0);
    const out = runRollup(db, settings, NOW);
    expect(out.rolled.metrics_host).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM metrics_host WHERE res_s = 10').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT * FROM metrics_host WHERE res_s = 60').get()).toEqual({
      host_id: 1, res_s: 60, ts: MIN,
      cpu_pct: 35, // avg of 10..60
      cpu_max_core_pct: 70, // peak survives
      mem_used_bytes: 103, // avg 102.5 rounded
      mem_total_bytes: 1000, swap_used_bytes: 0, swap_total_bytes: 0,
      net_rx_bps: 150, net_tx_bps: 0,
      uptime_s: 1005, // last
      pending_reboot: 1, // max
    });
  });

  it('keeps recent raw rows and never splits a minute', () => {
    const { db, settings } = setup();
    const ins = db.prepare('INSERT INTO metrics_host (res_s, ts, cpu_pct) VALUES (10, ?, 1)');
    ins.run(NOW - 3_600_000); // an hour ago: raw
    ins.run(OLD);
    ins.run(NOW - 24 * 3_600_000 + 30_000); // inside the last minute before the cut? no: after it
    runRollup(db, settings, NOW);
    const raw = db.prepare('SELECT ts FROM metrics_host WHERE res_s = 10 ORDER BY ts').all() as { ts: number }[];
    expect(raw.map((r) => r.ts)).toEqual([NOW - 24 * 3_600_000 + 30_000, NOW - 3_600_000]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM metrics_host WHERE res_s = 60').get()).toEqual({ n: 1 });
  });

  it('is idempotent', () => {
    const { db, settings } = setup();
    db.prepare('INSERT INTO metrics_host (res_s, ts, cpu_pct) VALUES (10, ?, 40)').run(OLD);
    runRollup(db, settings, NOW);
    const before = db.prepare('SELECT * FROM metrics_host').all();
    expect(runRollup(db, settings, NOW).rolled.metrics_host).toBe(0);
    expect(db.prepare('SELECT * FROM metrics_host').all()).toEqual(before);
  });

  it('process rows: worst status wins, counters take the last value, series stay separate', () => {
    const { db, settings } = setup();
    const ins = db.prepare(
      `INSERT INTO metrics_process (service_id, res_s, ts, status, instances, cpu_pct, mem_bytes, restarts, uptime_s)
       VALUES (?, 10, ?, ?, 1, ?, ?, ?, ?)`,
    );
    const seq: [string, number, number][] = [['online', 3, 100], ['launching', 4, 5], ['errored', 5, 6], ['online', 6, 7]];
    seq.forEach(([st, restarts, up], i) => ins.run(1, MIN + i * 10_000, st, 10 * (i + 1), 1000 + i, restarts, up));
    ins.run(2, MIN, 'stopped', 5, 50, 0, 1);
    runRollup(db, settings, NOW);
    const rows = db.prepare('SELECT service_id, status, cpu_pct, mem_bytes, restarts, uptime_s FROM metrics_process WHERE res_s = 60 ORDER BY service_id').all();
    expect(rows).toEqual([
      { service_id: 1, status: 'errored', cpu_pct: 25, mem_bytes: 1002, restarts: 6, uptime_s: 7 },
      { service_id: 2, status: 'stopped', cpu_pct: 5, mem_bytes: 50, restarts: 0, uptime_s: 1 },
    ]);
  });

  it('request counts are summed, p95 keeps its peak, mongo up is the minimum', () => {
    const { db, settings } = setup();
    const n = db.prepare('INSERT INTO metrics_nginx_service (service_id, res_s, ts, requests, s2xx, s3xx, s4xx, s5xx, p50_ms, p95_ms, bytes_out) VALUES (1, 10, ?, ?, ?, 0, 0, ?, 10, ?, 100)');
    n.run(MIN, 10, 9, 1, 50);
    n.run(MIN + 10_000, 20, 20, 0, 900);
    n.run(MIN + 20_000, 5, 5, 0, 60);
    const m = db.prepare('INSERT INTO metrics_mongo (res_s, ts, up, repl_state, repl_lag_s) VALUES (10, ?, ?, ?, ?)');
    m.run(MIN, 1, 'PRIMARY', 1);
    m.run(MIN + 10_000, 0, null, null);
    m.run(MIN + 20_000, 1, 'SECONDARY', 9);
    runRollup(db, settings, NOW);
    expect(db.prepare('SELECT requests, s2xx, s5xx, p95_ms, bytes_out FROM metrics_nginx_service WHERE res_s = 60').get()).toEqual({ requests: 35, s2xx: 34, s5xx: 1, p95_ms: 900, bytes_out: 300 });
    expect(db.prepare('SELECT up, repl_state, repl_lag_s FROM metrics_mongo WHERE res_s = 60').get()).toEqual({ up: 0, repl_state: 'SECONDARY', repl_lag_s: 9 });
  });

  it('agent rows are rolled up per service', () => {
    const { db, settings } = setup();
    const a = db.prepare('INSERT INTO metrics_app_service (service_id, res_s, ts, sockets, active_users, req_per_s, p95_ms, event_loop_lag_ms, event_loop_lag_max) VALUES (7, 10, ?, ?, ?, ?, ?, ?, ?)');
    a.run(MIN, 10, 5, 2, 100, 4, 20);
    a.run(MIN + 10_000, 20, 5, 4, 300, 6, 150);
    runRollup(db, settings, NOW);
    expect(db.prepare('SELECT sockets, req_per_s, p95_ms, event_loop_lag_ms, event_loop_lag_max FROM metrics_app_service WHERE res_s = 60').get()).toEqual({ sockets: 15, req_per_s: 3, p95_ms: 300, event_loop_lag_ms: 5, event_loop_lag_max: 150 });
  });

  it('one failing table does not stop the others, and the failure is recorded', () => {
    const { db, settings } = setup();
    db.prepare('INSERT INTO metrics_host (res_s, ts, cpu_pct) VALUES (10, ?, 40)').run(OLD);
    db.exec('DROP TABLE metrics_nginx');
    expect(() => runRollup(db, settings, NOW)).toThrow(/metrics_nginx/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM metrics_host WHERE res_s = 60').get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT last_status FROM maintenance_runs WHERE job = 'rollup'").get()).toEqual({ last_status: 'error' });
  });

  it('covers every table that has a 10 s resolution, with a valid statement for each', () => {
    const { db } = setup();
    for (const spec of ROLLUP_TABLES) {
      expect(() => db.prepare(rollupSql(spec))).not.toThrow();
      const cols = (db.prepare(`PRAGMA table_info(${spec.table})`).all() as { name: string }[]).map((c) => c.name);
      const handled = new Set([...spec.keys, 'res_s', 'ts', ...Object.keys(spec.cols)]);
      expect(cols.filter((c) => !handled.has(c))).toEqual([]); // a new column must get an aggregation
    }
  });
});

describe('retention', () => {
  it('deletes metric rows of every resolution, events and slow queries by age', () => {
    const { db, settings } = setup();
    const old = NOW - 8 * 86_400_000;
    db.prepare('INSERT INTO metrics_host (res_s, ts) VALUES (60, ?), (10, ?), (60, ?)').run(old, old, NOW);
    db.prepare('INSERT INTO metrics_app_tenant (service_id, tenant_id, res_s, ts) VALUES (1, 1, 60, ?), (1, 1, 60, ?)').run(old, NOW);
    db.prepare('INSERT INTO metrics_mongo (res_s, ts, up) VALUES (60, ?, 1)').run(old);
    db.prepare('INSERT INTO windows_events (log_name, record_id, ts, level) VALUES (?, 1, ?, ?), (?, 2, ?, ?)').run('System', old, 'error', 'System', NOW, 'error');
    db.prepare('INSERT INTO mongo_slow_queries (ts, namespace, millis) VALUES (?, ?, 1), (?, ?, 1)').run(old, 'a.b', NOW, 'a.b');
    const removed = runRetention(db, settings, NOW);
    expect(removed).toMatchObject({ metrics_host: 2, metrics_app_tenant: 1, metrics_mongo: 1, windows_events: 1, mongo_slow_queries: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM metrics_host').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM windows_events').get()).toEqual({ n: 1 });
  });
});
