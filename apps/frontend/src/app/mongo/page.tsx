'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import type { AlignedData } from 'uplot';
import type { MongoResponse } from '@cc/shared';
import { HistoryPanel } from '@/components/History';
import { PageHead, Shell } from '@/components/Shell';
import { UPlotChart } from '@/components/UPlotChart';
import { fetcher } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useLive } from '@/lib/live';

const OPS = (v: number) => `${Math.round(v * 10) / 10}/s`;
const MS = (v: number) => `${Math.round(v)} ms`;
const MB = (v: number) => `${Math.round(v)} MB`;
const bytes = (n: number | null): string => {
  if (n === null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${Math.round(v * 10) / 10} ${u[i]}`;
};

function Mongo() {
  const { data, error } = useSWR<MongoResponse>('/mongo', fetcher, { refreshInterval: 10_000 });
  const { live } = useLive();
  const mongo = live?.mongo ?? data?.mongo ?? null;
  const ops = useMemo<AlignedData>(() => [data?.series.ts ?? [], data?.series.opsPerS ?? []], [data]);
  const conn = useMemo<AlignedData>(() => [data?.series.ts ?? [], data?.series.connCurrent ?? []], [data]);
  const ping = useMemo<AlignedData>(() => [data?.series.ts ?? [], data?.series.pingMs ?? []], [data]);
  const mem = useMemo<AlignedData>(() => [data?.series.ts ?? [], data?.series.memResidentMb ?? []], [data]);
  const totalOps = mongo ? Object.values(mongo.opsPerS).reduce((a, b) => a + b, 0) : 0;

  return (
    <>
      <PageHead title="MongoDB" />
      {error && <div className="banner crit" role="alert">Could not load MongoDB data: {error.message}</div>}
      {data && !data.configured && (
        <div className="banner warn" role="status">
          MongoDB monitoring is not configured. Set <code>MONGO_URI</code> (a read-only monitoring user) in the backend
          environment; see the Phase 6–9 runbook.
        </div>
      )}
      {mongo && !mongo.up && (
        <div className="banner crit" role="alert" data-testid="mongo-down">
          MongoDB is not reachable{mongo.error ? `: ${mongo.error}` : ''}.
        </div>
      )}
      {mongo?.warnings.map((w) => (
        <div className="banner warn" role="status" key={w} data-testid="mongo-warning">{w}</div>
      ))}

      <div className="grid tiles">
        <section className="card tile" aria-label="Status">
          <h2>Status</h2>
          <div className="value" data-testid="mongo-status">{mongo ? (mongo.up ? 'Up' : 'Down') : '—'}</div>
          <div className="sub">
            {mongo?.version ? `version ${mongo.version}` : 'no data'}
            {mongo?.up && mongo.pingMs !== null ? ` · ping ${Math.round(mongo.pingMs)} ms` : ''}
          </div>
        </section>
        <section className="card tile" aria-label="Connections">
          <h2>Connections</h2>
          <div className="value num" data-testid="mongo-conn">{mongo?.up ? mongo.connCurrent : '—'}</div>
          <div className="sub num">{mongo?.up ? `${mongo.connAvailable} available` : ''}</div>
        </section>
        <section className="card tile" aria-label="Operations">
          <h2>Operations</h2>
          <div className="value num" data-testid="mongo-ops">{mongo?.up ? OPS(totalOps) : '—'}</div>
          <div className="sub num">
            {mongo?.up
              ? `q ${Math.round(mongo.opsPerS.query)} · i ${Math.round(mongo.opsPerS.insert)} · u ${Math.round(mongo.opsPerS.update)} · d ${Math.round(mongo.opsPerS.delete)}`
              : ''}
          </div>
        </section>
        <section className="card tile" aria-label="Memory and data">
          <h2>Memory · data</h2>
          <div className="value num">{mongo?.up ? `${Math.round(mongo.memResidentMb)} MB` : '—'}</div>
          <div className="sub">data size {bytes(mongo?.dataSizeBytes ?? null)}</div>
        </section>
        <section className="card tile" aria-label="Replication">
          <h2>Replication</h2>
          <div className="value">{mongo?.repl ? mongo.repl.state : 'standalone'}</div>
          <div className="sub">{mongo?.repl?.lagS != null ? `lag ${mongo.repl.lagS} s` : ' '}</div>
        </section>
      </div>

      <div className="grid two" style={{ marginTop: 14 }}>
        <section className="card" aria-label="Operations per second">
          <div className="card-head"><h2>Operations per second · last 30 min</h2></div>
          <UPlotChart data={ops} series={[{ label: 'ops/s', colorVar: '--series-1' }]} format={OPS} ariaLabel="MongoDB operations per second over the last 30 minutes" />
        </section>
        <section className="card" aria-label="Connections over time">
          <div className="card-head"><h2>Connections · last 30 min</h2></div>
          <UPlotChart data={conn} series={[{ label: 'connections', colorVar: '--series-2' }]} ariaLabel="MongoDB connections over the last 30 minutes" />
        </section>
        <section className="card" aria-label="Ping">
          <div className="card-head"><h2>Ping · last 30 min</h2></div>
          <UPlotChart data={ping} series={[{ label: 'ping', colorVar: '--series-1' }]} format={MS} ariaLabel="MongoDB ping over the last 30 minutes" />
        </section>
        <section className="card" aria-label="Resident memory">
          <div className="card-head"><h2>Resident memory · last 30 min</h2></div>
          <UPlotChart data={mem} series={[{ label: 'resident', colorVar: '--series-2' }]} format={MB} ariaLabel="MongoDB resident memory over the last 30 minutes" />
        </section>
      </div>

      <section className="card" aria-label="Current operations" style={{ marginTop: 14 }}>
        <h2>Running operations</h2>
        {mongo && mongo.currentOps.length > 0 ? (
          <div className="table-wrap">
            <table data-testid="mongo-current-ops">
              <thead><tr><th>Namespace</th><th>Op</th><th>Running</th><th>Plan</th></tr></thead>
              <tbody>
                {mongo.currentOps.map((o) => (
                  <tr key={o.opid}>
                    <td className="num">{o.ns}</td>
                    <td>{o.op}</td>
                    <td className="num">{o.secsRunning >= 60 ? <span className="tag warn">{o.secsRunning} s</span> : `${o.secsRunning} s`}</td>
                    <td>{o.plan ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">No operations running longer than a moment.</div>
        )}
      </section>

      <section className="card" aria-label="Slow queries" style={{ marginTop: 14 }}>
        <h2>Slow queries{mongo?.slowQueries5m != null ? ` · ${mongo.slowQueries5m} in the last 5 min` : ''}</h2>
        <p className="sub">Shapes only: field names are kept, every value is replaced by <code>?</code>.</p>
        {data && data.profileDbs.length === 0 ? (
          <div className="empty">Slow queries are off. Name the databases in <code>MONGO_PROFILE_DBS</code> and enable the profiler (see the runbook).</div>
        ) : data && data.slowQueries.length > 0 ? (
          <div className="table-wrap">
            <table data-testid="mongo-slow">
              <thead><tr><th>When</th><th>Namespace</th><th>Op</th><th>Time</th><th>Plan</th><th>Examined / returned</th><th>Shape</th></tr></thead>
              <tbody>
                {data.slowQueries.map((q) => (
                  <tr key={q.id}>
                    <td>{timeAgo(q.ts)}</td>
                    <td className="num">{q.namespace}</td>
                    <td>{q.op ?? '—'}</td>
                    <td className="num">{q.millis} ms</td>
                    <td>{q.planSummary === 'COLLSCAN' ? <span className="tag warn">COLLSCAN</span> : (q.planSummary ?? '—')}</td>
                    <td className="num">{q.docsExamined ?? '—'} / {q.nReturned ?? '—'}</td>
                    <td className="num" style={{ wordBreak: 'break-all', maxWidth: 360 }}>{q.commandShape ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">No slow queries recorded.</div>
        )}
      </section>

      <HistoryPanel
        path="/history/mongo"
        charts={[
          { title: 'Operations per second', keys: [{ key: 'opsPerS', label: 'ops/s', colorVar: '--series-1' }], format: OPS },
          { title: 'Connections', keys: [{ key: 'connCurrent', label: 'connections', colorVar: '--series-2' }] },
          { title: 'Ping (worst per point)', keys: [{ key: 'pingMs', label: 'ping ms', colorVar: '--series-1' }], format: MS },
          { title: 'Replication lag (worst per point)', keys: [{ key: 'replLagS', label: 'lag s', colorVar: '--series-2' }], format: (v) => `${Math.round(v)} s` },
        ]}
      />
    </>
  );
}

export default function Page() {
  return (
    <Shell>
      <Mongo />
    </Shell>
  );
}
