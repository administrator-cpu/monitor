/**
 * Phase 9 sizing check: fills a throw-away database with a week of synthetic metrics (10 services,
 * 20 tenants each) in the shape the monitor leaves them after rollup, then compares the real sizes
 * with the estimates in backend-schema.md section 9.3 and times the hourly rollup and a history query.
 *
 *   pnpm --filter @cc/backend size:check
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate, openDb } from '../src/db';
import { runRollup } from '../src/rollup';
import { Settings } from '../src/settings';

const SERVICES = 10;
const TENANTS = 20;
const DAYS = 7;
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const RAW_FROM = NOW - 24 * 3_600_000;
const FROM = NOW - DAYS * 86_400_000;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-size-'));
const file = path.join(dir, 'monitor.db');
const db = openDb(file);
migrate(db);

const t0 = Date.now();
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const counts: Record<string, number> = {};
const count = (t: string, n: number) => (counts[t] = (counts[t] ?? 0) + n);

/** Calls `fn(ts, res)` for every stored row time: 60 s rows for the older six days, 10 s rows for the last day. */
function times(fn: (ts: number, res: number) => void): void {
  for (let ts = FROM; ts < RAW_FROM; ts += 60_000) fn(ts, 60);
  for (let ts = RAW_FROM; ts < NOW; ts += 10_000) fn(ts, 10);
}

db.transaction(() => {
  const host = db.prepare('INSERT INTO metrics_host (res_s, ts, cpu_pct, cpu_max_core_pct, mem_used_bytes, mem_total_bytes, swap_used_bytes, swap_total_bytes, net_rx_bps, net_tx_bps, uptime_s, pending_reboot) VALUES (?, ?, ?, ?, ?, 17179869184, ?, 4294967296, ?, ?, ?, 0)');
  const disk = db.prepare('INSERT INTO metrics_disk (volume, res_s, ts, used_bytes, total_bytes, read_bps, write_bps) VALUES (?, ?, ?, ?, 107374182400, ?, ?)');
  const nginx = db.prepare('INSERT INTO metrics_nginx (res_s, ts, active_conn, reading, writing, waiting, req_per_s) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const mongo = db.prepare('INSERT INTO metrics_mongo (res_s, ts, up, ping_ms, conn_current, conn_available, op_insert_ps, op_query_ps, op_update_ps, op_delete_ps, op_getmore_ps, op_command_ps, mem_resident_mb, data_size_bytes, repl_state, repl_lag_s) VALUES (?, ?, 1, ?, ?, 800, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  times((ts, res) => {
    host.run(res, ts, rnd(5, 60), rnd(20, 95), rnd(4e9, 12e9), rnd(0, 1e8), rnd(1e4, 1e6), rnd(1e4, 1e6), 86_400 + ts / 1000);
    for (const v of ['C:', 'E:']) disk.run(v, res, ts, rnd(2e10, 6e10), rnd(0, 1e6), rnd(0, 1e6));
    nginx.run(res, ts, 40, 1, 3, 36, rnd(5, 200));
    mongo.run(res, ts, rnd(1, 5), 25, rnd(0, 20), rnd(0, 200), rnd(0, 20), rnd(0, 5), rnd(0, 10), rnd(50, 400), 900, 5e9, 'PRIMARY', 0);
    count('metrics_host', 1); count('metrics_disk', 2); count('metrics_nginx', 1); count('metrics_mongo', 1);
  });

  const proc = db.prepare("INSERT INTO metrics_process (service_id, res_s, ts, status, instances, cpu_pct, mem_bytes, restarts, uptime_s) VALUES (?, ?, ?, 'online', 2, ?, ?, 0, ?)");
  const ngs = db.prepare('INSERT INTO metrics_nginx_service (service_id, res_s, ts, requests, s2xx, s3xx, s4xx, s5xx, p50_ms, p95_ms, bytes_out) VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?)');
  const app = db.prepare('INSERT INTO metrics_app_service (service_id, res_s, ts, sockets, active_users, req_per_s, err5xx_per_s, p95_ms, event_loop_lag_ms, event_loop_lag_max, heap_used_bytes, rss_bytes) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)');
  for (let sid = 1; sid <= SERVICES; sid++) {
    db.prepare("INSERT INTO services (id, name, source_key, first_seen_at, last_seen_at, agent_enabled) VALUES (?, ?, ?, 0, 0, 1)").run(sid, `svc-${sid}`, `svc-${sid}`);
    times((ts, res) => {
      proc.run(sid, res, ts, rnd(1, 80), rnd(1e8, 6e8), 3600 + ts / 1000);
      ngs.run(sid, res, ts, Math.round(rnd(10, 2000)), Math.round(rnd(10, 1900)), Math.round(rnd(0, 50)), rnd(5, 40), rnd(50, 900), Math.round(rnd(1e4, 1e7)));
      app.run(sid, res, ts, Math.round(rnd(0, 300)), Math.round(rnd(0, 200)), rnd(0, 100), rnd(40, 800), rnd(1, 30), rnd(5, 150), rnd(5e7, 3e8), rnd(1e8, 5e8));
      count('metrics_process', 1); count('metrics_nginx_service', 1); count('metrics_app_service', 1);
    });
  }

  const ten = db.prepare('INSERT INTO tenants (tenant_key, first_seen_at, last_seen_at) VALUES (?, 0, 0)');
  const tm = db.prepare('INSERT INTO metrics_app_tenant (service_id, tenant_id, res_s, ts, sockets, active_users, req_per_s, p95_ms) VALUES (?, ?, 60, ?, ?, ?, ?, ?)');
  const ids: number[] = [];
  for (let k = 0; k < TENANTS; k++) ids.push(Number(ten.run(`tenant-${k}`).lastInsertRowid));
  for (let sid = 1; sid <= SERVICES; sid++) {
    for (const tid of ids) {
      for (let ts = FROM; ts < NOW; ts += 60_000) {
        tm.run(sid, tid, ts, Math.round(rnd(0, 40)), Math.round(rnd(0, 30)), rnd(0, 20), rnd(30, 500));
        count('metrics_app_tenant', 1);
      }
    }
  }
})();
db.pragma('wal_checkpoint(TRUNCATE)');
const filled = Date.now() - t0;

type Stat = { name: string; bytes: number };
let stats: Stat[] = [];
try {
  stats = db.prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name').all() as Stat[];
} catch {
  /* dbstat is not compiled into every SQLite build */
}
const sizeOf = (names: string[]): number | null =>
  stats.length === 0 ? null : stats.filter((s) => names.some((n) => s.name === n || s.name.endsWith(n) || s.name.includes(n))).reduce((a, s) => a + s.bytes, 0);
const mb = (b: number | null): string => (b === null ? 'n/a' : `${(b / 1048576).toFixed(1)} MB`);

const groups: { label: string; tables: string[]; estimate: string }[] = [
  { label: 'Host and disk', tables: ['metrics_host', 'metrics_disk'], estimate: 'under 5 MB' },
  { label: 'Process and app service', tables: ['metrics_process', 'metrics_app_service', 'idx_mproc', 'idx_mapp'], estimate: 'about 30 MB' },
  { label: 'Nginx and Nginx per service', tables: ['metrics_nginx', 'metrics_nginx_service'], estimate: 'about 30 MB' },
  { label: 'Tenant metrics (60 s only)', tables: ['metrics_app_tenant', 'idx_mtenant'], estimate: 'about 150 to 200 MB' },
  { label: 'Mongo', tables: ['metrics_mongo'], estimate: 'under 20 MB (with events and slow queries)' },
];
console.log(`\nSynthetic week: ${SERVICES} services, ${TENANTS} tenants each, built in ${(filled / 1000).toFixed(1)} s\n`);
console.log('Group'.padEnd(34) + 'Rows'.padStart(12) + 'Size'.padStart(12) + '   Estimate in backend-schema.md');
for (const g of groups) {
  const rows = g.tables.reduce((a, t) => a + (counts[t] ?? 0), 0);
  console.log(g.label.padEnd(34) + rows.toLocaleString().padStart(12) + mb(sizeOf(g.tables)).padStart(12) + `   ${g.estimate}`);
}
const total = fs.statSync(file).size;
console.log(`\nDatabase file: ${mb(total)}`);

// Cost of the hourly rollup: one more hour of 10 s rows pushed past the 24 h line, then rolled up.
const extra = NOW - 25 * 3_600_000;
const addRaw = db.prepare('INSERT INTO metrics_app_service (service_id, res_s, ts, sockets) VALUES (?, 10, ?, 1)');
db.transaction(() => {
  for (let sid = 1; sid <= SERVICES; sid++) for (let ts = extra; ts < extra + 3_600_000; ts += 10_000) addRaw.run(sid, ts);
})();
const r0 = Date.now();
runRollup(db, new Settings(db, () => NOW), NOW);
console.log(`Hourly rollup of one hour of raw rows: ${Date.now() - r0} ms`);

const q0 = Date.now();
const rows = db.prepare('SELECT ts, active_users FROM metrics_app_service WHERE service_id = 1 AND ts >= ? AND ts < ?').all(FROM, NOW);
console.log(`History query for one service over 7 days: ${rows.length.toLocaleString()} rows in ${Date.now() - q0} ms`);

db.close();
fs.rmSync(dir, { recursive: true, force: true });
