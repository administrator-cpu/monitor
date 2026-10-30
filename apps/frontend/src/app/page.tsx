'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { CollectorStatus, DiskState, LogStatus, ServiceLive } from '@cc/shared';
import { MonitorTile, SummaryRow } from '@/components/OverviewSummary';
import { processLabel, StatusDot } from '@/components/ServiceStatus';
import { PageHead, Shell } from '@/components/Shell';
import { bytes, duration, pct, rate, usageLevel, volumeReasonText } from '@/lib/format';
import { useIsFresh, useLive } from '@/lib/live';

function Meter({ value, level }: { value: number; level: 'ok' | 'warn' | 'crit' }) {
  return (
    <div className={`meter ${level === 'ok' ? '' : level}`} role="presentation">
      <span style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

function Tile({
  title,
  value,
  sub,
  stale,
  level,
  meter,
  testId,
  compact,
}: {
  title: string;
  value: string;
  sub?: string;
  stale: boolean;
  level?: 'ok' | 'warn' | 'crit';
  meter?: number;
  testId?: string;
  compact?: boolean;
}) {
  return (
    <section className={`card tile ${stale ? 'stale' : ''}`} aria-label={title}>
      <h2>{title}</h2>
      <div className={`value num ${compact ? 'compact' : ''}`} data-testid={testId}>
        {stale ? '—' : value}
        {stale && <span className="tag warn badge-stale">stale</span>}
      </div>
      {meter !== undefined && !stale && <Meter value={meter} level={level ?? 'ok'} />}
      {sub && (
        <div className="sub" style={{ marginTop: 8 }}>
          {sub}
        </div>
      )}
    </section>
  );
}

function DiskRow({ d, stale }: { d: DiskState; stale: boolean }) {
  const p = d.totalBytes > 0 ? (d.usedBytes / d.totalBytes) * 100 : 0;
  const level = usageLevel(p);
  return (
    <div className="disk">
      <span className="name" title={d.volume}>
        {d.volume}
      </span>
      {stale ? <span className="muted">stale</span> : <Meter value={p} level={level} />}
      <span className="usage num muted">
        {stale ? '—' : `${pct(p)} · ${bytes(d.usedBytes, 0)} of ${bytes(d.totalBytes, 0)}`}
        {!stale && d.readBps !== null && d.writeBps !== null && (
          <>
            {' · '}
            <span title="Disk throughput">
              R {rate(d.readBps)} · W {rate(d.writeBps)}
            </span>
          </>
        )}
      </span>
    </div>
  );
}

function Services({ list, stale, monitor }: { list: ServiceLive[]; stale: boolean; monitor: ReactNode }) {
  const sorted = [...list].sort((a, b) => a.process.name.localeCompare(b.process.name));
  return (
    <div className="svc-grid" data-testid="service-grid">
      {monitor}
      {sorted.length === 0 && (
        <div className="empty">
          No PM2 services yet. They appear here by themselves once PM2 lists a process.
        </div>
      )}
      {sorted.map(({ process: p }) => (
        <Link key={p.serviceId} href={`/services/${p.serviceId}`} className="svc" data-testid={`svc-${p.pm2Name}`}>
          <div className="name">
            <StatusDot p={stale ? null : p} />
            {p.name}
          </div>
          <div className="muted" style={{ fontSize: '0.82rem' }}>
            {stale ? 'stale' : processLabel(p)}
          </div>
          {!stale && p.instances > 0 && (
            <div className="facts num">
              <span>CPU {pct(p.cpuPct)}</span>
              <span>{bytes(p.memBytes, 0)}</span>
              <span>up {duration(p.uptimeS)}</span>
              <span>{p.restarts} restarts</span>
            </div>
          )}
        </Link>
      ))}
    </div>
  );
}

function LogsCard({ logs, stale }: { logs: LogStatus | null | undefined; stale: boolean }) {
  if (!logs) return null;
  return (
    <section className="card" aria-label="Log storage">
      <h2>Log storage</h2>
      {stale ? (
        <div className="muted">stale</div>
      ) : (
        <dl className="kv">
          <dt>Volume</dt>
          <dd>
            {logs.volumeOk ? (
              <span className="tag ok">ok · {pct(logs.volumeUsedPct)} used</span>
            ) : (
              <span className="tag crit">unavailable</span>
            )}
          </dd>
          <dt>Waiting to be written</dt>
          <dd className="num">{logs.writerQueue}</dd>
          <dt>Lines dropped</dt>
          <dd className="num">{logs.droppedLines}</dd>
          {logs.skippedLines > 0 && (
            <>
              <dt>Not saved (volume down)</dt>
              <dd className="num">{logs.skippedLines}</dd>
            </>
          )}
        </dl>
      )}
      {!stale && !logs.volumeOk && (
        <div className="banner crit" role="alert" style={{ marginTop: 10 }}>
          Logs are not being saved: {volumeReasonText(logs.volumeReason)}. New lines are still visible live
          but will be lost when they scroll out of memory.
        </div>
      )}
    </section>
  );
}

const isStale = (collectors: CollectorStatus[] | undefined, name: string) =>
  collectors?.find((c) => c.name === name)?.stale ?? false;

function Overview() {
  const { live, status } = useLive();
  const fresh = useIsFresh();
  const host = live?.host ?? null;
  const collectors = live?.collectors;
  // A value is only shown as current when the socket is live AND its collector is healthy.
  const hostStale = !fresh || isStale(collectors, 'host');
  const diskStale = !fresh || isStale(collectors, 'disk');
  const sysStale = !fresh || isStale(collectors, 'system');

  return (
    <>
      <PageHead title="Overview" />

      {status === 'forbidden' && (
        <div className="banner crit" role="alert">
          The API rejected this site&apos;s origin. Add it to <code>ALLOWED_ORIGINS</code> on the
          backend.
        </div>
      )}
      {fresh && (live?.openIncidents ?? 0) > 0 && (
        <div className="banner crit" role="status" data-testid="incident-banner">
          {live?.openIncidents} alert{live?.openIncidents === 1 ? ' is' : 's are'} firing.{' '}
          <Link href="/alerts">View alerts</Link>
        </div>
      )}
      {status !== 'forbidden' && !fresh && (
        <div className="banner warn" role="status">
          Not receiving live data. Values below are hidden until the connection recovers.
        </div>
      )}

      {!host && (
        <div className="empty">{fresh ? 'Waiting for the first host sample…' : 'No data yet.'}</div>
      )}

      {host && (
        <>
          <div className="grid tiles" data-testid="host-strip">
            <Tile
              title="CPU"
              testId="cpu-value"
              value={pct(host.cpuPct)}
              meter={host.cpuPct}
              level={usageLevel(host.cpuPct, 90, 98)}
              stale={hostStale}
              sub={`${host.cpuPerCore.length} cores`}
            />
            <Tile
              title="Memory"
              value={pct((host.memUsedBytes / host.memTotalBytes) * 100)}
              meter={(host.memUsedBytes / host.memTotalBytes) * 100}
              level={usageLevel((host.memUsedBytes / host.memTotalBytes) * 100, 90, 97)}
              stale={hostStale}
              sub={`${bytes(host.memUsedBytes)} of ${bytes(host.memTotalBytes)}`}
            />
            <Tile
              title="Swap"
              value={
                host.swapTotalBytes > 0
                  ? pct((host.swapUsedBytes / host.swapTotalBytes) * 100)
                  : 'none'
              }
              meter={
                host.swapTotalBytes > 0
                  ? (host.swapUsedBytes / host.swapTotalBytes) * 100
                  : undefined
              }
              stale={hostStale}
              sub={
                host.swapTotalBytes > 0
                  ? `${bytes(host.swapUsedBytes)} of ${bytes(host.swapTotalBytes)}`
                  : undefined
              }
            />
            <Tile
              title="Network"
              compact
              value={`↓ ${rate(host.netRxBps)}`}
              stale={hostStale}
              sub={`↑ ${rate(host.netTxBps)}`}
            />
            <Tile
              title="Uptime"
              value={duration(host.uptimeS)}
              stale={sysStale}
              sub={host.pendingReboot ? 'Reboot pending' : 'No reboot pending'}
            />
          </div>

          {(live?.nginx || live?.mongo || live?.app) && (
            <div className="grid tiles" style={{ marginTop: 14 }} data-testid="edge-strip">
              {live?.nginx && (
                <>
                  <Tile
                    title="Nginx requests"
                    testId="ov-nginx-rps"
                    value={`${Math.round(live.nginx.reqPerS * 10) / 10}/s`}
                    stale={!fresh || isStale(collectors, 'nginxlog')}
                    sub={live.nginx.statusOk ? `${live.nginx.activeConn} connections` : 'status page unreachable'}
                  />
                  <Tile
                    title="Nginx 5xx"
                    value={`${live.nginx.perService.reduce((a, s) => a + s.s5xx, 0)}`}
                    stale={!fresh || isStale(collectors, 'nginxlog')}
                    sub="responses in the last 10 s"
                  />
                </>
              )}
              {live?.app && (
                <>
                  <Tile
                    title="Open sockets"
                    testId="ov-sockets"
                    value={`${live.app.sockets}`}
                    stale={!fresh}
                    sub={`across ${live.app.services} service${live.app.services === 1 ? '' : 's'} with an agent`}
                  />
                  <Tile
                    title="Active users"
                    testId="ov-users"
                    value={`${live.app.activeUsers}`}
                    stale={!fresh}
                    sub="last 5 minutes"
                  />
                </>
              )}
              {live?.mongo && (
                <>
                  <Tile
                    title="MongoDB"
                    testId="ov-mongo-status"
                    value={live.mongo.up ? 'Up' : 'Down'}
                    stale={!fresh || isStale(collectors, 'mongo')}
                    sub={live.mongo.up ? `${live.mongo.connCurrent} connections` : live.mongo.error}
                  />
                  <Tile
                    title="Mongo slow queries"
                    value={live.mongo.slowQueries5m === null ? 'off' : `${live.mongo.slowQueries5m}`}
                    stale={!fresh || isStale(collectors, 'mongo')}
                    sub="in the last 5 minutes"
                  />
                </>
              )}
            </div>
          )}

          <SummaryRow openIncidents={live?.openIncidents} />

          <div className="grid two" style={{ marginTop: 14 }}>
            <section className="card" aria-label="Disks">
              <h2>Disks</h2>
              {host.disks.length === 0 ? (
                <div className="muted">{diskStale ? 'stale' : 'No volumes reported yet.'}</div>
              ) : (
                host.disks.map((d) => <DiskRow key={d.volume} d={d} stale={diskStale} />)
              )}
            </section>

            <LogsCard logs={live?.logs} stale={!fresh || isStale(collectors, 'logguard')} />
          </div>

          <section className="card" style={{ marginTop: 14 }} aria-label="Services">
            <div className="card-head">
              <h2>Services</h2>
              <Link href="/services" className="muted">
                All services
              </Link>
            </div>
            <Services
              list={live?.services ?? []}
              stale={!fresh || isStale(collectors, 'pm2')}
              monitor={<MonitorTile m={live?.monitor} stale={!fresh} />}
            />
          </section>
        </>
      )}

      {collectors && collectors.length > 0 && (
        <section className="card" style={{ marginTop: 14 }} aria-label="Collectors">
          <h2>Collectors</h2>
          <div className="row" style={{ gap: 16 }}>
            {collectors.map((c) => (
              <span key={c.name} title={c.lastError ?? undefined}>
                <span
                  className={`dot ${c.stale ? 'warn' : c.lastError ? 'crit' : 'ok'}`}
                  aria-hidden="true"
                />
                {c.name}{' '}
                <span className="muted">{c.stale ? 'stale' : c.lastError ? 'error' : 'ok'}</span>
              </span>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Shell>
      <Overview />
    </Shell>
  );
}
