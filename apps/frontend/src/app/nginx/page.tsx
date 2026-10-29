'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import useSWR from 'swr';
import type { AlignedData } from 'uplot';
import type { NginxResponse, ServicesResponse } from '@cc/shared';
import { HistoryPanel } from '@/components/History';
import { PageHead, Shell } from '@/components/Shell';
import { UPlotChart } from '@/components/UPlotChart';
import { fetcher } from '@/lib/api';
import { dateTime, timeAgo } from '@/lib/format';
import { useLive } from '@/lib/live';

const PCT = (v: number) => `${Math.round(v * 10) / 10}%`;
const RPS = (v: number) => `${Math.round(v * 10) / 10}/s`;

function certLevel(days: number | null): 'ok' | 'warn' | 'crit' {
  if (days === null) return 'warn';
  if (days < 3) return 'crit';
  if (days < 14) return 'warn';
  return 'ok';
}

function Nginx() {
  const { data, error } = useSWR<NginxResponse>('/nginx', fetcher, { refreshInterval: 5_000 });
  const { data: svcs } = useSWR<ServicesResponse>('/services?archived=1', fetcher);
  const { live } = useLive();
  const names = useMemo(() => new Map((svcs?.services ?? []).map((s) => [s.id, s.name])), [svcs]);
  const nginx = live?.nginx ?? data?.nginx ?? null;
  const cfg = data?.configured;
  const anyConfigured = cfg ? cfg.status || cfg.accessLog || cfg.tls : true;

  const rps = useMemo<AlignedData>(() => [data?.series.ts ?? [], data?.series.reqPerS ?? []], [data]);
  const err = useMemo<AlignedData>(() => [data?.series.ts ?? [], data?.series.err5xxPct ?? []], [data]);
  const conn = useMemo<AlignedData>(() => [data?.series.ts ?? [], data?.series.activeConn ?? []], [data]);

  return (
    <>
      <PageHead title="Nginx" />
      {error && (
        <div className="banner crit" role="alert">
          Could not load Nginx data: {error.message}
        </div>
      )}
      {cfg && !anyConfigured && (
        <div className="banner warn" role="status">
          Nginx monitoring is not configured. Set <code>NGINX_STATUS_URL</code>, <code>NGINX_ACCESS_LOG</code> and
          <code> TLS_CHECK_HOSTS</code> in the backend environment (see the Phase 6–9 runbook).
        </div>
      )}
      {nginx && nginx.statusOk === false && (
        <div className="banner crit" role="alert" data-testid="nginx-status-down">
          Nginx status page is not reachable{nginx.statusError ? `: ${nginx.statusError}` : ''}.
        </div>
      )}
      {cfg?.accessLog && nginx && nginx.lastLineAt === null && (
        <div className="banner warn" role="status">
          No access-log lines have been read yet. If Nginx is receiving traffic, check the log path and that the
          <code> monitor_json</code> log format is in use.
        </div>
      )}

      <div className="grid tiles">
        <section className="card tile" aria-label="Connections">
          <h2>Connections</h2>
          <div className="value num" data-testid="nginx-conn">{nginx && nginx.statusOk ? nginx.activeConn : '—'}</div>
          <div className="sub num">
            {nginx && nginx.statusOk ? `reading ${nginx.reading} · writing ${nginx.writing} · waiting ${nginx.waiting}` : 'no status data'}
          </div>
        </section>
        <section className="card tile" aria-label="Request rate">
          <h2>Requests</h2>
          <div className="value num" data-testid="nginx-rps">{nginx ? RPS(nginx.reqPerS) : '—'}</div>
          <div className="sub">per second, right now</div>
        </section>
        <section className="card tile" aria-label="Access log">
          <h2>Access log</h2>
          <div className="value num">{nginx ? nginx.linesTotal.toLocaleString() : '—'}</div>
          <div className="sub">
            lines read{nginx && nginx.malformedLines > 0 ? ` · ${nginx.malformedLines} skipped as unreadable` : ''}
            {nginx?.lastLineAt ? ` · last ${timeAgo(nginx.lastLineAt)}` : ''}
          </div>
        </section>
      </div>

      <div className="grid two" style={{ marginTop: 14 }}>
        <section className="card" aria-label="Requests per second">
          <div className="card-head"><h2>Requests per second · last 30 min</h2></div>
          <UPlotChart data={rps} series={[{ label: 'req/s', colorVar: '--series-1' }]} format={RPS} ariaLabel="Requests per second over the last 30 minutes" />
        </section>
        <section className="card" aria-label="5xx share">
          <div className="card-head"><h2>5xx share · last 30 min</h2></div>
          <UPlotChart data={err} series={[{ label: '5xx %', colorVar: '--series-2' }]} format={PCT} ariaLabel="Share of 5xx responses over the last 30 minutes" />
        </section>
        <section className="card" aria-label="Active connections">
          <div className="card-head"><h2>Active connections · last 30 min</h2></div>
          <UPlotChart data={conn} series={[{ label: 'connections', colorVar: '--series-1' }]} ariaLabel="Active connections over the last 30 minutes" />
        </section>
      </div>

      <section className="card" aria-label="Traffic by service" style={{ marginTop: 14 }}>
        <h2>Traffic by service · last 10 s window</h2>
        {nginx && nginx.perService.length > 0 ? (
          <div className="table-wrap">
            <table data-testid="nginx-services">
              <thead>
                <tr>
                  <th>Service</th><th>Req/s</th><th>2xx</th><th>3xx</th><th>4xx</th><th>5xx</th><th>p50</th><th>p95</th>
                </tr>
              </thead>
              <tbody>
                {nginx.perService.map((s) => (
                  <tr key={s.serviceId}>
                    <td>
                      {s.serviceId === 0 ? (
                        <span title="Requests that match no service. Set the service's Nginx host in its settings.">Unattributed</span>
                      ) : (
                        <Link href={`/services/${s.serviceId}`}>{names.get(s.serviceId) ?? `Service ${s.serviceId}`}</Link>
                      )}
                    </td>
                    <td className="num">{Math.round(s.reqPerS * 10) / 10}</td>
                    <td className="num">{s.s2xx}</td>
                    <td className="num">{s.s3xx}</td>
                    <td className="num">{s.s4xx}</td>
                    <td className="num">{s.s5xx > 0 ? <span className="tag crit">{s.s5xx}</span> : 0}</td>
                    <td className="num">{Math.round(s.p50Ms)} ms</td>
                    <td className="num">{Math.round(s.p95Ms)} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">No requests in the last minute.</div>
        )}
        <div className="muted" style={{ fontSize: '0.8rem', marginTop: 8 }} data-testid="nginx-privacy-note">
          Request paths and client addresses are not logged, so they are not counted here.
        </div>
      </section>

      <section className="card" aria-label="Certificates" style={{ marginTop: 14 }}>
        <h2>TLS certificates</h2>
        {data && data.certs.length > 0 ? (
          <div className="table-wrap">
            <table data-testid="nginx-certs">
              <thead><tr><th>Host</th><th>Expires</th><th>Days left</th><th>Issuer</th><th>Checked</th></tr></thead>
              <tbody>
                {data.certs.map((c) => (
                  <tr key={c.host}>
                    <td>{c.host}</td>
                    <td>{c.notAfter ? dateTime(c.notAfter) : '—'}</td>
                    <td><span className={`tag ${certLevel(c.daysLeft)}`}>{c.daysLeft === null ? 'unknown' : c.daysLeft < 0 ? 'expired' : `${c.daysLeft} days`}</span></td>
                    <td>{c.issuer ?? '—'}</td>
                    <td>
                      {timeAgo(c.checkedAt)}
                      {c.lastError && <span className="tag warn" style={{ marginLeft: 6 }} title={c.lastError}>last check failed</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">No hosts are checked. Add them to <code>TLS_CHECK_HOSTS</code>, or give a service an https public URL.</div>
        )}
      </section>

      <HistoryPanel
        path="/history/nginx"
        charts={[
          { title: 'Requests per second', keys: [{ key: 'reqPerS', label: 'req/s', colorVar: '--series-1' }], format: RPS },
          { title: '5xx share', keys: [{ key: 'err5xxPct', label: '5xx %', colorVar: '--series-2' }], format: PCT },
          { title: 'Slowest p95', keys: [{ key: 'p95Ms', label: 'p95 ms', colorVar: '--series-1' }], format: (v) => `${Math.round(v)} ms` },
          { title: 'Active connections', keys: [{ key: 'activeConn', label: 'connections', colorVar: '--series-2' }] },
        ]}
      />
    </>
  );
}

export default function Page() {
  return (
    <Shell>
      <Nginx />
    </Shell>
  );
}
