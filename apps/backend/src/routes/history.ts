import type { FastifyInstance } from 'fastify';
import type { HistoryRange, HistoryResponse, ProcessEventDto } from '@cc/shared';
import type { AppContext } from '../context';
import type { FastifyReply } from 'fastify';
import { requireUser } from '../guard';
import { LOCAL_HOST_ID, spanLabel } from '@cc/shared';
import { fill, gridTimes, makeGrid, parseRange, type Column, type Grid } from '../history';
import { rangeLimits } from '../limits';

const MAX_POINTS = 600;
const MAX_EVENTS = 200;

const col = (pick: Column<any>['pick'], agg: Column<any>['agg']): Column<any> => ({ pick, agg });

/**
 * Where stored resolution changes inside the range: the first 10 s row, but only when 60 s rows
 * also exist in the range (otherwise there is no change to mark).
 */
function boundaryOf(ctx: AppContext, table: string, g: Grid, where = '', ...args: (string | number)[]): number | null {
  const q = (res: number): number | null =>
    (ctx.db.prepare(`SELECT MIN(ts) AS t FROM ${table} WHERE res_s = ${res} AND ts >= ? AND ts < ? ${where}`).get(g.from, g.to, ...args) as { t: number | null }).t;
  const coarse = q(60);
  const fine = q(10);
  return coarse !== null && fine !== null && fine > coarse ? fine : null;
}

/** Absent means host 1; anything other than a positive integer is refused. */
function parseHostId(v: string | undefined): number | null {
  if (v === undefined || v === '') return LOCAL_HOST_ID;
  return /^[1-9]\d{0,8}$/.test(v) ? Number(v) : null;
}

const rangeOf = (g: Grid, boundary: number | null): HistoryRange => ({ from: g.from, to: g.to, stepS: g.stepMs / 1000, boundary });

/** One table's rows on the grid, under a set of named series. */
function rows<T>(ctx: AppContext, sql: string, ...args: (string | number)[]): T[] {
  return ctx.db.prepare(sql).all(...args) as T[];
}

export function historyRoutes(app: FastifyInstance, ctx: AppContext): void {
  const user = { preHandler: requireUser(ctx) };
  // Metrics older than `retention.metrics_days` are deleted, so a longer range could only show nothing.
  const range = (req: { query: unknown }) =>
    parseRange(req.query as { from?: string; to?: string }, ctx.now(), rangeLimits(ctx.settings).historyMaxMs);
  const bad = (reply: FastifyReply) =>
    reply.code(400).send({
      error: 'invalid_request',
      message: `The range must be positive and at most ${spanLabel(rangeLimits(ctx.settings).historyMaxMs)}.`,
    });

  app.get('/history/host', user, async (req, reply): Promise<HistoryResponse | void> => {
    const r = range(req);
    if (!r) return bad(reply);
    // `host` selects an agent host (phase 11); without it, this server as before.
    const hostId = parseHostId((req.query as { host?: string }).host);
    if (hostId === null || !ctx.hosts.get(hostId)) return reply.code(404).send({ error: 'not_found', message: 'No such host.' });
    const g = makeGrid(r.from, r.to, MAX_POINTS);
    const host = rows<{ ts: number; cpu: number | null; core: number | null; mem: number | null; rx: number | null; tx: number | null }>(
      ctx,
      `SELECT ts, cpu_pct AS cpu, cpu_max_core_pct AS core,
              CASE WHEN mem_total_bytes > 0 THEN mem_used_bytes * 100.0 / mem_total_bytes END AS mem,
              net_rx_bps AS rx, net_tx_bps AS tx
       FROM metrics_host WHERE host_id = ? AND ts >= ? AND ts < ? ORDER BY ts`,
      hostId, g.from, g.to,
    );
    const s: HistoryResponse['series'] = fill(g, host, (x) => x.ts, {
      cpuPct: col((x) => x.cpu, 'avg'), cpuMaxCorePct: col((x) => x.core, 'max'), memPct: col((x) => x.mem, 'avg'),
      netRxBps: col((x) => x.rx, 'avg'), netTxBps: col((x) => x.tx, 'avg'),
    });
    const disks = rows<{ ts: number; volume: string; pct: number | null }>(
      ctx,
      `SELECT ts, volume, CASE WHEN total_bytes > 0 THEN used_bytes * 100.0 / total_bytes END AS pct
       FROM metrics_disk WHERE host_id = ? AND ts >= ? AND ts < ? ORDER BY ts`,
      hostId, g.from, g.to,
    );
    for (const v of [...new Set(disks.map((d) => d.volume))].sort()) {
      s[`disk ${v}`] = fill(g, disks.filter((d) => d.volume === v), (x) => x.ts, { v: col((x) => x.pct, 'max') }).v!;
    }
    return { range: rangeOf(g, boundaryOf(ctx, 'metrics_host', g, 'AND host_id = ?', hostId)), ts: gridTimes(g), series: s };
  });

  app.get('/history/services/:id', user, async (req, reply): Promise<HistoryResponse | void> => {
    const id = Number((req.params as { id: string }).id);
    const svc = Number.isInteger(id) && id > 0 ? ctx.services.get(id) : undefined;
    if (!svc) return reply.code(404).send({ error: 'not_found' });
    const r = range(req);
    if (!r) return bad(reply);
    const g = makeGrid(r.from, r.to, MAX_POINTS);
    const proc = rows<{ ts: number; cpu: number | null; mem: number | null; restarts: number | null }>(
      ctx, 'SELECT ts, cpu_pct AS cpu, mem_bytes AS mem, restarts FROM metrics_process WHERE service_id = ? AND ts >= ? AND ts < ? ORDER BY ts', svc.id, g.from, g.to);
    const appRows = rows<Record<string, number | null> & { ts: number }>(
      ctx,
      `SELECT ts, sockets, active_users AS users, req_per_s AS rps, p95_ms AS p95, event_loop_lag_ms AS lag, event_loop_lag_max AS lagmax
       FROM metrics_app_service WHERE service_id = ? AND ts >= ? AND ts < ? ORDER BY ts`, svc.id, g.from, g.to);
    const gw = rows<{ ts: number; rps: number | null; err: number | null; p95: number | null }>(
      ctx,
      `SELECT ts, requests * 1.0 / res_s AS rps, CASE WHEN requests > 0 THEN s5xx * 100.0 / requests END AS err, p95_ms AS p95
       FROM metrics_nginx_service WHERE service_id = ? AND ts >= ? AND ts < ? ORDER BY ts`, svc.id, g.from, g.to);
    const series: HistoryResponse['series'] = {
      ...fill(g, proc, (x) => x.ts, { cpuPct: col((x) => x.cpu, 'avg'), memBytes: col((x) => x.mem, 'avg'), restarts: col((x) => x.restarts, 'last') }),
      ...fill(g, appRows, (x) => x.ts, {
        sockets: col((x) => x.sockets, 'avg'), activeUsers: col((x) => x.users, 'avg'), appReqPerS: col((x) => x.rps, 'avg'),
        appP95Ms: col((x) => x.p95, 'max'), lagP95Ms: col((x) => x.lag, 'avg'), lagMaxMs: col((x) => x.lagmax, 'max'),
      }),
      ...fill(g, gw, (x) => x.ts, { gwReqPerS: col((x) => x.rps, 'avg'), gw5xxPct: col((x) => x.err, 'max'), gwP95Ms: col((x) => x.p95, 'max') }),
    };
    const events = rows<{ id: number; ts: number; pm_id: number | null; event: string; detail: string | null }>(
      ctx, 'SELECT id, ts, pm_id, event, detail FROM process_events WHERE service_id = ? AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT ?', svc.id, g.from, g.to, MAX_EVENTS,
    ).map((e): ProcessEventDto => ({ id: e.id, ts: e.ts, pm: e.pm_id, event: e.event, detail: e.detail ? (JSON.parse(e.detail) as unknown) : null }));
    return { range: rangeOf(g, boundaryOf(ctx, 'metrics_process', g, 'AND service_id = ?', svc.id)), ts: gridTimes(g), series, events };
  });

  app.get('/history/nginx', user, async (req, reply): Promise<HistoryResponse | void> => {
    const r = range(req);
    if (!r) return bad(reply);
    const g = makeGrid(r.from, r.to, MAX_POINTS);
    const st = rows<{ ts: number; conn: number | null; rps: number | null }>(ctx, 'SELECT ts, active_conn AS conn, req_per_s AS rps FROM metrics_nginx WHERE ts >= ? AND ts < ? ORDER BY ts', g.from, g.to);
    // All services together, per stored row (a 60 s row holds sixty seconds of requests, so divide by res_s).
    const lg = rows<{ ts: number; rps: number; err: number | null; p95: number | null }>(
      ctx,
      `SELECT ts, SUM(requests) * 1.0 / MAX(res_s) AS rps, CASE WHEN SUM(requests) > 0 THEN SUM(s5xx) * 100.0 / SUM(requests) END AS err, MAX(p95_ms) AS p95
       FROM metrics_nginx_service WHERE ts >= ? AND ts < ? GROUP BY ts, res_s ORDER BY ts`, g.from, g.to);
    const series: HistoryResponse['series'] = {
      ...fill(g, st, (x) => x.ts, { activeConn: col((x) => x.conn, 'avg'), statusReqPerS: col((x) => x.rps, 'avg') }),
      ...fill(g, lg, (x) => x.ts, { reqPerS: col((x) => x.rps, 'avg'), err5xxPct: col((x) => x.err, 'max'), p95Ms: col((x) => x.p95, 'max') }),
    };
    return { range: rangeOf(g, boundaryOf(ctx, 'metrics_nginx', g)), ts: gridTimes(g), series };
  });

  app.get('/history/mongo', user, async (req, reply): Promise<HistoryResponse | void> => {
    const r = range(req);
    if (!r) return bad(reply);
    const g = makeGrid(r.from, r.to, MAX_POINTS);
    const m = rows<Record<string, number | null> & { ts: number }>(
      ctx,
      `SELECT ts, up, ping_ms AS ping, conn_current AS conn, mem_resident_mb AS mem, repl_lag_s AS lag,
              COALESCE(op_insert_ps,0) + COALESCE(op_query_ps,0) + COALESCE(op_update_ps,0) + COALESCE(op_delete_ps,0) + COALESCE(op_getmore_ps,0) + COALESCE(op_command_ps,0) AS ops
       FROM metrics_mongo WHERE host_id = ? AND ts >= ? AND ts < ? ORDER BY ts`, LOCAL_HOST_ID, g.from, g.to);
    const series = fill(g, m, (x) => x.ts, {
      up: col((x) => x.up, 'min'), pingMs: col((x) => x.ping, 'max'), connCurrent: col((x) => x.conn, 'avg'),
      memResidentMb: col((x) => x.mem, 'avg'), replLagS: col((x) => x.lag, 'max'), opsPerS: col((x) => x.ops, 'avg'),
    });
    return { range: rangeOf(g, boundaryOf(ctx, 'metrics_mongo', g, 'AND host_id = ?', LOCAL_HOST_ID)), ts: gridTimes(g), series };
  });
}
