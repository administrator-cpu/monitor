import type { Db } from './db';
import type { Settings } from './settings';

/**
 * How each column is reduced when sixty seconds of 10 s rows become one 60 s row
 * (backend-schema.md section 9.2).
 *  avg / avg_int   gauges and rates (the integer form rounds, because the column holds integers)
 *  max / min       peaks (and `up`, where one down sample makes the minute down)
 *  last            counters, totals and text
 *  sum             request counts
 *  worst_status    process status, errored beats stopped beats launching beats online
 */
export type Agg = 'avg' | 'avg_int' | 'max' | 'min' | 'last' | 'sum' | 'worst_status';

export interface TableSpec {
  table: string;
  /** Columns that identify a series inside the table, besides res_s and ts. */
  keys: string[];
  cols: Record<string, Agg>;
}

export const ROLLUP_TABLES: TableSpec[] = [
  {
    table: 'metrics_host',
    keys: [],
    cols: {
      cpu_pct: 'avg', cpu_max_core_pct: 'max', mem_used_bytes: 'avg_int', mem_total_bytes: 'last',
      swap_used_bytes: 'avg_int', swap_total_bytes: 'last', net_rx_bps: 'avg', net_tx_bps: 'avg',
      uptime_s: 'last', pending_reboot: 'max',
    },
  },
  {
    table: 'metrics_disk',
    keys: ['volume'],
    cols: { used_bytes: 'avg_int', total_bytes: 'last', read_bps: 'avg', write_bps: 'avg' },
  },
  {
    table: 'metrics_process',
    keys: ['service_id'],
    cols: { status: 'worst_status', instances: 'last', cpu_pct: 'avg', mem_bytes: 'avg_int', restarts: 'last', uptime_s: 'last' },
  },
  {
    table: 'metrics_nginx',
    keys: [],
    cols: { active_conn: 'avg_int', reading: 'avg_int', writing: 'avg_int', waiting: 'avg_int', req_per_s: 'avg' },
  },
  {
    table: 'metrics_nginx_service',
    keys: ['service_id'],
    cols: { requests: 'sum', s2xx: 'sum', s3xx: 'sum', s4xx: 'sum', s5xx: 'sum', p50_ms: 'avg', p95_ms: 'max', bytes_out: 'sum' },
  },
  {
    table: 'metrics_mongo',
    keys: [],
    cols: {
      up: 'min', ping_ms: 'avg', conn_current: 'avg_int', conn_available: 'avg_int', op_insert_ps: 'avg',
      op_query_ps: 'avg', op_update_ps: 'avg', op_delete_ps: 'avg', op_getmore_ps: 'avg', op_command_ps: 'avg',
      mem_resident_mb: 'avg_int', data_size_bytes: 'last', repl_state: 'last',
      // Deviation: the schema says gauges are averaged, but a replication-lag spike is exactly what a
      // reader of the history is looking for, so the minute keeps its worst value.
      repl_lag_s: 'max',
    },
  },
  {
    table: 'metrics_app_service',
    keys: ['service_id'],
    cols: {
      sockets: 'avg_int', active_users: 'avg_int', req_per_s: 'avg', err5xx_per_s: 'avg', p95_ms: 'max',
      event_loop_lag_ms: 'avg', event_loop_lag_max: 'max', heap_used_bytes: 'avg_int', rss_bytes: 'avg_int',
    },
  },
];

/** Tables whose rows are all deleted by age. `metrics_app_tenant` has only 60 s rows, so no rollup. */
export const METRIC_TABLES = [...ROLLUP_TABLES.map((t) => t.table), 'metrics_app_tenant'];

const STATUS_RANK =
  `CASE status WHEN 'errored' THEN 5 WHEN 'stopped' THEN 4 WHEN 'stopping' THEN 3 WHEN 'launching' THEN 2 ELSE 1 END`;

/** The statement that turns the 10 s rows older than `:cut` into 60 s rows. Exported for tests. */
export function rollupSql(spec: TableSpec): string {
  const cols = Object.entries(spec.cols);
  const part = [...spec.keys, '(ts / 60000)'].join(', ');
  const inner: string[] = [...spec.keys, '(ts / 60000) * 60000 AS b', 'ts'];
  const outer: string[] = [];
  for (const [c, agg] of cols) {
    if (agg === 'last') {
      inner.push(
        `last_value(${c}) OVER (PARTITION BY ${part} ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS ${c}__v`,
      );
      outer.push(`MAX(${c}__v)`);
    } else if (agg === 'worst_status') {
      inner.push(`${STATUS_RANK} AS ${c}__v`);
      outer.push(`CASE MAX(${c}__v) WHEN 5 THEN 'errored' WHEN 4 THEN 'stopped' WHEN 3 THEN 'stopping' WHEN 2 THEN 'launching' ELSE 'online' END`);
    } else {
      inner.push(c);
      outer.push(agg === 'avg_int' ? `CAST(ROUND(AVG(${c})) AS INTEGER)` : `${agg.toUpperCase()}(${c})`);
    }
  }
  const groupBy = [...spec.keys, 'b'].join(', ');
  return `INSERT OR REPLACE INTO ${spec.table} (${[...spec.keys, 'res_s', 'ts', ...cols.map(([c]) => c)].join(', ')})
SELECT ${[...spec.keys, '60', 'b', ...outer].join(', ')}
FROM (SELECT ${inner.join(', ')} FROM ${spec.table} WHERE res_s = 10 AND ts < @cut)
GROUP BY ${groupBy}`;
}

const record = (db: Db, job: string, now: number, status: string, detail: unknown): void => {
  db.prepare(
    `INSERT INTO maintenance_runs (job, last_run_at, last_status, last_detail) VALUES (?, ?, ?, ?)
     ON CONFLICT(job) DO UPDATE SET last_run_at = excluded.last_run_at,
       last_status = excluded.last_status, last_detail = excluded.last_detail`,
  ).run(job, now, status, JSON.stringify(detail));
};

/**
 * Rolls 10 s rows older than `retention.metrics_raw_hours` up to 60 s rows and deletes them, one
 * transaction per table, so a failure in one table leaves that table exactly as it was and the
 * others done. The cut is floored to a whole minute, so a minute is never split between a rolled-up
 * row and leftover raw rows. Safe to run twice: the second run finds nothing to do.
 */
export function runRollup(db: Db, settings: Settings, now: number): { rolled: Record<string, number>; failed: string[] } {
  const cut = Math.floor((now - settings.get('retention.metrics_raw_hours') * 3_600_000) / 60_000) * 60_000;
  const rolled: Record<string, number> = {};
  const failed: string[] = [];
  for (const spec of ROLLUP_TABLES) {
    try {
      db.transaction(() => {
        const info = db.prepare(rollupSql(spec)).run({ cut });
        db.prepare(`DELETE FROM ${spec.table} WHERE res_s = 10 AND ts < ?`).run(cut);
        rolled[spec.table] = info.changes;
      })();
    } catch (e) {
      failed.push(`${spec.table}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  record(db, 'rollup', now, failed.length === 0 ? 'ok' : 'error', { rolled, failed });
  if (failed.length > 0) throw new Error(`rollup failed for ${failed.length} table(s): ${failed.join('; ').slice(0, 300)}`);
  return { rolled, failed };
}
