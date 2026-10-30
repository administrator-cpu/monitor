'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import type { AlignedData } from 'uplot';
import type { ServiceDetailResponse, TenantHistoryResponse, TenantsResponse } from '@cc/shared';
import { ActionsCard } from '@/components/ActionsCard';
import { GitCard } from '@/components/GitCard';
import { HistoryPanel, IncidentTimeline } from '@/components/History';
import { LogViewer } from '@/components/LogViewer';
import { hasFigures, processLabel, StatusDot, uptimeText } from '@/components/ServiceStatus';
import { PageHead, Shell } from '@/components/Shell';
import { UPlotChart } from '@/components/UPlotChart';
import { api, ApiError, errorMessage, fetcher } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { bytes, dateTime, pct } from '@/lib/format';
import { useIsFresh, useLive } from '@/lib/live';

const PCT = (v: number) => `${Math.round(v)}%`;
const BYTES = (v: number) => bytes(v, 0);

function eventText(e: { event: string; detail: unknown }): string {
  const d = (e.detail ?? {}) as { exitCode?: number; signal?: string; message?: string };
  const parts: string[] = [];
  if (d.exitCode !== undefined) parts.push(`exit code ${d.exitCode}`);
  if (d.signal) parts.push(`signal ${d.signal}`);
  if (d.message) parts.push(d.message);
  return parts.join(' · ');
}

function EditForm({ detail, onDone }: { detail: ServiceDetailResponse; onDone: () => void }) {
  const s = detail.service;
  const [name, setName] = useState(s.name);
  const [publicUrl, setPublicUrl] = useState(s.publicUrl ?? '');
  const [notes, setNotes] = useState(s.notes ?? '');
  const [nginxMatch, setNginxMatch] = useState(s.nginxMatch ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(s.name);
    setPublicUrl(s.publicUrl ?? '');
    setNotes(s.notes ?? '');
    setNginxMatch(s.nginxMatch ?? '');
  }, [s.name, s.publicUrl, s.notes, s.nginxMatch]);

  async function patch(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await api(`/services/${s.id}`, { method: 'PATCH', body });
      setMsg(done);
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'service_active') {
        setErr(
          s.kind === 'container'
            ? 'The host’s agent still lists this container. Remove it on that host (docker compose down or rm) first; otherwise it would reappear.'
            : 'PM2 still lists this process. Stop and delete it in PM2 first; otherwise it would reappear.',
        );
      } else if (e instanceof ApiError && e.code === 'name_taken') {
        setErr('Another service already uses that name.');
      } else setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-label="Edit service">
      <h2>Details</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void patch(
            { name: name.trim(), publicUrl: publicUrl.trim() || null, nginxMatch: nginxMatch.trim() || null, notes: notes.trim() || null },
            'Saved.',
          );
        }}
      >
        <div className="field">
          <label htmlFor="svc-name">Display name</label>
          <input id="svc-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="svc-url">Public URL</label>
          <input id="svc-url" value={publicUrl} placeholder="https://app.example.com" onChange={(e) => setPublicUrl(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="svc-nginx">Nginx host or upstream</label>
          <input id="svc-nginx" value={nginxMatch} placeholder="api.example.com, *.example.com or 127.0.0.1:3001" onChange={(e) => setNginxMatch(e.target.value)} />
          <div className="muted" style={{ fontSize: '0.8rem' }}>Requests with this host name, or sent to this upstream address, are counted for this service.</div>
        </div>
        <div className="field">
          <label htmlFor="svc-notes">Notes</label>
          <textarea id="svc-notes" rows={3} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
        </div>
        {err && <div className="error" role="alert">{err}</div>}
        {msg && <div className="notice" role="status">{msg}</div>}
        <div className="row">
          <button className="btn primary" disabled={busy}>Save</button>
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Archive ${s.name}? It will disappear from the dashboard and its alerts will close.`)) {
                void patch({ isArchived: !s.isArchived }, s.isArchived ? 'Restored.' : 'Archived.');
              }
            }}
          >
            {s.isArchived ? 'Restore' : 'Archive'}
          </button>
        </div>
      </form>
    </section>
  );
}

const MS = (v: number) => `${Math.round(v)} ms`;
const RATE = (v: number) => `${Math.round(v * 10) / 10}/s`;

function TenantHistory({ serviceId, tenantKey }: { serviceId: string; tenantKey: string }) {
  const { data, error } = useSWR<TenantHistoryResponse>(
    `/services/${serviceId}/tenants/history?key=${encodeURIComponent(tenantKey)}`,
    fetcher,
    { refreshInterval: 60_000 },
  );
  const users = useMemo<AlignedData>(() => [data?.ts ?? [], data?.activeUsers ?? []], [data]);
  const rps = useMemo<AlignedData>(() => [data?.ts ?? [], data?.reqPerS ?? []], [data]);
  if (error) return <div className="banner crit" role="alert">Could not load history: {error.message}</div>;
  if (data && data.ts.length === 0) return <div className="empty">No history stored for this tenant yet. Tenant rows are written once a minute.</div>;
  return (
    <div className="grid two" data-testid="tenant-history">
      <UPlotChart data={users} series={[{ label: 'active users', colorVar: '--series-1' }]} ariaLabel={`Active users of ${tenantKey}, last 24 hours`} />
      <UPlotChart data={rps} series={[{ label: 'req/s', colorVar: '--series-2' }]} format={RATE} ariaLabel={`Requests per second of ${tenantKey}, last 24 hours`} />
    </div>
  );
}

function Runtime({ data, id }: { data: ServiceDetailResponse; id: string }) {
  const a = data.app;
  const { data: tenants } = useSWR<TenantsResponse>(a ? `/services/${id}/tenants` : null, fetcher, { refreshInterval: 5_000 });
  const [open, setOpen] = useState<string | null>(null);
  const s = data.appSeries;
  const cpu = useMemo<AlignedData>(() => [s.ts, s.cpuPct], [s]);
  const users = useMemo<AlignedData>(() => [s.ts, s.activeUsers, s.sockets], [s]);
  const lag = useMemo<AlignedData>(() => [s.ts, s.eventLoopLagP95Ms], [s]);
  const lat = useMemo<AlignedData>(() => [s.ts, s.p95Ms], [s]);

  if (!data.service.agentEnabled) {
    return (
      <section className="card" style={{ marginTop: 14 }} aria-label="Application agent">
        <h2>Application layer</h2>
        <div className="empty" data-testid="agent-none">
          This service has no agent yet, so event-loop lag, sockets and active users are not measured. See the runbook,
          “Adding the agent to a service”.
        </div>
      </section>
    );
  }
  return (
    <>
      <section className="card" style={{ marginTop: 14 }} aria-label="Application runtime">
        <div className="card-head">
          <h2>Application runtime</h2>
          <span className="now num">{a ? `${a.instances} instance${a.instances === 1 ? '' : 's'} reporting` : ''}</span>
        </div>
        {!a ? (
          <div className="banner warn" role="status" data-testid="agent-silent">
            The agent has not reported in the last 15 seconds. If PM2 shows the service online, its event loop may be blocked.
          </div>
        ) : (
          <div className="grid tiles" data-testid="agent-tiles">
            <div className="tile"><h3>Event loop lag</h3><div className="value num" data-testid="app-lag">{Math.round(a.eventLoopLagP95Ms)} ms</div><div className="sub">p95 · worst {Math.round(a.eventLoopLagMaxMs)} ms</div></div>
            <div className="tile"><h3>Requests</h3><div className="value num" data-testid="app-rps">{RATE(a.reqPerS)}</div><div className="sub">p95 {MS(a.p95Ms)} · 5xx {RATE(a.err5xxPerS)}</div></div>
            <div className="tile"><h3>Sockets</h3><div className="value num" data-testid="app-sockets">{a.sockets}</div><div className="sub">open connections</div></div>
            <div className="tile" title={a.instances > 1 ? 'Summed over instances: a user connected to two of them is counted twice.' : undefined}>
              <h3>Active users</h3><div className="value num" data-testid="app-users">{a.activeUsers}</div><div className="sub">last 5 minutes{a.instances > 1 ? ' · summed' : ''}</div>
            </div>
            <div className="tile"><h3>Heap · RSS</h3><div className="value num">{bytes(a.heapUsedBytes, 0)}</div><div className="sub">RSS {bytes(a.rssBytes, 0)}{a.activeHandles !== null ? ` · ${a.activeHandles} handles` : ''}</div></div>
          </div>
        )}
      </section>

      <section className="card" style={{ marginTop: 14 }} aria-label="Load against users">
        <div className="card-head"><h2>Load against users · last 30 min</h2></div>
        <p className="sub">Both charts share the same time axis: look for CPU rising while users and sockets stay flat.</p>
        <UPlotChart data={cpu} series={[{ label: 'CPU %', colorVar: '--series-2' }]} format={PCT} ariaLabel="Service CPU over the last 30 minutes, aligned with active users" />
        <UPlotChart
          data={users}
          series={[{ label: 'active users', colorVar: '--series-1' }, { label: 'sockets', colorVar: '--series-3', fill: false }]}
          ariaLabel="Active users and open sockets over the last 30 minutes"
        />
        <div className="grid two">
          <div><div className="sub">Event loop lag p95</div><UPlotChart data={lag} series={[{ label: 'lag', colorVar: '--series-2' }]} format={MS} ariaLabel="Event loop lag over the last 30 minutes" /></div>
          <div><div className="sub">Request p95</div><UPlotChart data={lat} series={[{ label: 'p95', colorVar: '--series-1' }]} format={MS} ariaLabel="Request latency p95 over the last 30 minutes" /></div>
        </div>
      </section>

      <section className="card" style={{ marginTop: 14 }} aria-label="Tenants">
        <h2>Tenants</h2>
        {!tenants || tenants.tenants.length === 0 ? (
          <div className="empty">No tenant data. Without a <code>tenantResolver</code> all traffic is reported as <code>_unknown</code>.</div>
        ) : (
          <div className="table-wrap">
            <table data-testid="tenant-table">
              <thead><tr><th>Tenant</th><th>Sockets</th><th>Active users</th><th>Req/s</th><th>p95</th><th /></tr></thead>
              <tbody>
                {tenants.tenants.map((t) => (
                  <>
                    <tr key={t.key}>
                      <td>{t.displayName ?? t.key}{t.displayName && <span className="muted"> ({t.key})</span>}</td>
                      <td className="num">{t.sockets}</td>
                      <td className="num">{t.activeUsers}</td>
                      <td className="num">{Math.round(t.reqPerS * 10) / 10}</td>
                      <td className="num">{Math.round(t.p95Ms)} ms</td>
                      <td>
                        {t.key !== '_other' && (
                          <button type="button" className="btn small" aria-expanded={open === t.key} onClick={() => setOpen(open === t.key ? null : t.key)}>
                            {open === t.key ? 'Hide history' : '24 h history'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {open === t.key && (
                      <tr key={`${t.key}-h`}><td colSpan={6}><TenantHistory serviceId={id} tenantKey={t.key} /></td></tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {tenants?.truncated && <p className="sub">More than 50 tenants: the smallest are summed under <code>_other</code>.</p>}
      </section>
    </>
  );
}

function Detail() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const auth = useAuth();
  const isAdmin = auth.state.status === 'authed' && auth.state.me.user.role === 'admin';
  const canOperate = auth.state.status === 'authed' && auth.state.me.user.canOperate;
  const { data, error, mutate } = useSWR<ServiceDetailResponse>(`/services/${id}`, fetcher, {
    refreshInterval: 5_000,
  });
  const { live, subscribeEvents } = useLive();
  const fresh = useIsFresh();

  useEffect(() => subscribeEvents((e) => { if (e.kind.startsWith('alert_')) void mutate(); }), [subscribeEvents, mutate]);

  const liveProc = live?.services.find((s) => String(s.process.serviceId) === id)?.process ?? null;
  const p = fresh ? (liveProc ?? data?.process ?? null) : (data?.process ?? null);

  const cpu = useMemo<AlignedData>(() => [data?.series.ts ?? [], data?.series.cpuPct ?? []], [data]);
  const mem = useMemo<AlignedData>(() => [data?.series.ts ?? [], data?.series.memBytes ?? []], [data]);
  const trafficRps = useMemo<AlignedData>(() => [data?.traffic?.series.ts ?? [], data?.traffic?.series.reqPerS ?? []], [data]);
  const trafficErr = useMemo<AlignedData>(() => [data?.traffic?.series.ts ?? [], data?.traffic?.series.err5xxPct ?? []], [data]);

  if (error instanceof ApiError && error.status === 404) {
    return (
      <>
        <PageHead title="Service" />
        <div className="empty">This service does not exist. <Link href="/services">Back to services</Link></div>
      </>
    );
  }
  if (!data) {
    return (
      <>
        <PageHead title="Service" />
        {error ? <div className="banner crit" role="alert">Could not load: {error.message}</div> : <div className="muted">Loading…</div>}
      </>
    );
  }
  const s = data.service;

  return (
    <>
      <PageHead title={s.name} />
      <p className="muted" style={{ marginTop: -8 }}>
        {s.kind === 'container' ? (
          <>
            <Link href={`/services?host=${s.hostId}`}>Services</Link> · container <code>{s.sourceKey}</code>
          </>
        ) : (
          <>
            <Link href="/services">Services</Link> · PM2 name <code>{s.pm2Name}</code>
          </>
        )}
        {s.isArchived && <span className="tag" style={{ marginLeft: 8 }}>archived</span>}
        {s.publicUrl && (
          <>
            {' · '}
            <a href={s.publicUrl} target="_blank" rel="noopener noreferrer">{s.publicUrl}</a>
          </>
        )}
      </p>

      {data.openIncidents > 0 && (
        <div className="banner crit" role="status">
          {data.openIncidents} alert{data.openIncidents === 1 ? '' : 's'} firing for this service.{' '}
          <Link href={`/alerts?service=${s.id}`}>View</Link>
        </div>
      )}

      <div className="grid tiles">
        <section className="card tile" aria-label="Status">
          <h2>Status</h2>
          <div className="value" data-testid="svc-status"><StatusDot p={p} /> {processLabel(p)}</div>
          {p?.lastExit && (
            <div className="sub" style={{ marginTop: 8 }}>
              Last exit {dateTime(p.lastExit.at)}
              {p.lastExit.code !== null ? ` · code ${p.lastExit.code}` : ''}
              {p.lastExit.signal ? ` · ${p.lastExit.signal}` : ''}
            </div>
          )}
        </section>
        <section className="card tile" aria-label="CPU"><h2>CPU</h2><div className="value num">{hasFigures(p) ? pct(p.cpuPct) : '—'}</div></section>
        <section className="card tile" aria-label="Memory"><h2>Memory</h2><div className="value num">{hasFigures(p) ? bytes(p.memBytes) : '—'}</div></section>
        <section className="card tile" aria-label="Uptime"><h2>Uptime</h2><div className="value num">{uptimeText(p)}</div></section>
        <section className="card tile" aria-label="Restarts"><h2>Restarts</h2><div className="value num">{p ? p.restarts : '—'}</div></section>
      </div>

      <div className="grid two" style={{ marginTop: 14 }}>
        <section className="card" aria-label="CPU history">
          <div className="card-head"><h2>CPU · last 30 min</h2></div>
          <UPlotChart data={cpu} series={[{ label: 'CPU %', colorVar: '--series-1' }]} format={PCT} ariaLabel="Service CPU over the last 30 minutes" />
        </section>
        <section className="card" aria-label="Memory history">
          <div className="card-head"><h2>Memory · last 30 min</h2></div>
          <UPlotChart data={mem} series={[{ label: 'Memory', colorVar: '--series-1' }]} format={BYTES} ariaLabel="Service memory over the last 30 minutes" />
        </section>
      </div>

      <Runtime data={data} id={id} />

      {data.traffic && (
        <section className="card" style={{ marginTop: 14 }} aria-label="Gateway traffic">
          <div className="card-head">
            <h2>Gateway traffic · last 30 min</h2>
            <span className="now num" data-testid="svc-traffic-now">
              {data.traffic.now
                ? `${Math.round(data.traffic.now.reqPerS * 10) / 10}/s · p95 ${Math.round(data.traffic.now.p95Ms)} ms · 5xx ${data.traffic.now.s5xx}`
                : 'no requests in the last minute'}
            </span>
          </div>
          {!s.nginxMatch && (
            <div className="muted" style={{ marginBottom: 8 }}>
              No Nginx host is set for this service, so its requests are counted as unattributed. Set it with Edit below.
            </div>
          )}
          <div className="grid two">
            <UPlotChart data={trafficRps} series={[{ label: 'req/s', colorVar: '--series-1' }]} format={(v) => `${Math.round(v * 10) / 10}/s`} ariaLabel="Requests per second for this service" />
            <UPlotChart data={trafficErr} series={[{ label: '5xx %', colorVar: '--series-2' }]} format={PCT} ariaLabel="5xx share for this service" />
          </div>
        </section>
      )}

      <HistoryPanel
        path={`/history/services/${id}`}
        charts={[
          { title: 'CPU', keys: [{ key: 'cpuPct', label: 'CPU %', colorVar: '--series-1' }], format: PCT },
          { title: 'Memory', keys: [{ key: 'memBytes', label: 'Memory', colorVar: '--series-1' }], format: BYTES },
          ...(s.agentEnabled
            ? [
                { title: 'Active users and sockets', keys: [{ key: 'activeUsers', label: 'active users', colorVar: '--series-1' }, { key: 'sockets', label: 'sockets', colorVar: '--series-3', fill: false }] },
                { title: 'Event loop lag (p95, worst)', keys: [{ key: 'lagP95Ms', label: 'p95', colorVar: '--series-2' }, { key: 'lagMaxMs', label: 'worst', colorVar: '--series-3', fill: false }], format: MS },
              ]
            : []),
          { title: 'Gateway requests', keys: [{ key: 'gwReqPerS', label: 'req/s', colorVar: '--series-1' }], format: RATE },
          { title: 'Gateway 5xx share', keys: [{ key: 'gw5xxPct', label: '5xx %', colorVar: '--series-2' }], format: PCT },
        ]}
      >
        {(r, range) => (
          <>
            <IncidentTimeline from={range.from} to={range.to} serviceId={Number(id)} />
            {r.events && r.events.length > 0 && (
              <section className="card" style={{ marginTop: 14 }} aria-label="Restarts in this range">
                <h2>Starts, stops and crashes in this range</h2>
                <div className="table-wrap">
                  <table>
                    <tbody>
                      {r.events.map((e) => (
                        <tr key={e.id}>
                          <td className="num" style={{ whiteSpace: 'nowrap' }}>{dateTime(e.ts)}</td>
                          <td><span className={`tag ${e.event === 'exit' || e.event === 'exception' || e.event === 'restart overlimit' ? 'crit' : ''}`}>{e.event}</span></td>
                          <td>{eventText(e)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}
      </HistoryPanel>

      <div style={{ marginTop: 14 }}>
        {s.kind === 'container' ? (
          <section className="card" aria-label="Logs">
            <h2>Logs</h2>
            <div className="empty">Container logs arrive with phase 11 step M3.</div>
          </section>
        ) : (
          <LogViewer service={s.pm2Name} />
        )}
      </div>

      <section className="card" style={{ marginTop: 14 }} aria-label="Process events">
        <h2>Recent process events</h2>
        {data.events.length === 0 ? (
          <div className="empty">No starts, stops or crashes recorded yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Time</th><th>Event</th><th>Instance</th><th>Detail</th></tr></thead>
              <tbody>
                {data.events.map((e) => (
                  <tr key={e.id}>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{dateTime(e.ts)}</td>
                    <td><span className={`tag ${e.event === 'exit' || e.event === 'exception' || e.event === 'restart overlimit' ? 'crit' : ''}`}>{e.event}</span></td>
                    <td className="num">{e.pm ?? '—'}</td>
                    <td>{eventText(e) || <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canOperate && (
        <ActionsCard service={data.service} status={data.process?.status ?? null} operable={data.operable} onDone={() => void mutate()} />
      )}

      <GitCard service={data.service} isAdmin={isAdmin} onChanged={() => void mutate()} />

      {isAdmin && (
        <div style={{ marginTop: 14 }}>
          <EditForm detail={data} onDone={() => void mutate()} />
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Shell>
      <Detail />
    </Shell>
  );
}
