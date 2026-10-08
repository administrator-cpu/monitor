'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { IncidentDetailResponse, IncidentDto } from '@cc/shared';
import { api, errorMessage } from '@/lib/api';
import { dateTime, duration, timeAgo } from '@/lib/format';
import { useLive } from '@/lib/live';

const PAGE = 50;
const sevTone = (s: string) => (s === 'critical' ? 'crit' : s === 'warning' ? 'warn' : '');

function Notifications({ id }: { id: number }) {
  const [d, setD] = useState<IncidentDetailResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<IncidentDetailResponse>(`/alerts/incidents/${id}`).then(setD, (e) => setErr(errorMessage(e)));
  }, [id]);
  if (err) return <div className="error">{err}</div>;
  if (!d) return <div className="muted">Loading…</div>;
  if (d.notifications.length === 0) return <div className="muted">No emails recorded for this incident.</div>;
  return (
    <table>
      <thead><tr><th>Time</th><th>Kind</th><th>To</th><th>Result</th></tr></thead>
      <tbody>
        {d.notifications.map((n) => (
          <tr key={n.id}>
            <td className="num">{dateTime(n.ts)}</td>
            <td>{n.kind}</td>
            <td>{n.toEmail}</td>
            <td>
              <span className={`tag ${n.status === 'failed' ? 'crit' : n.status === 'muted' ? 'warn' : 'ok'}`}>{n.status}</span>
              {n.attempts > 1 && <span className="muted"> · {n.attempts} attempts</span>}
              {n.error && <span className="muted"> · {n.error}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function IncidentsTab({ isAdmin, serviceId, focus }: { isAdmin: boolean; serviceId?: number; focus?: number }) {
  const [state, setState] = useState<'firing' | 'all'>('all');
  const [rows, setRows] = useState<IncidentDto[]>([]);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { subscribeEvents } = useLive();

  const load = useCallback(
    async (before?: number) => {
      setBusy(true);
      setErr(null);
      try {
        const q = new URLSearchParams({ state, limit: String(PAGE) });
        if (before !== undefined) q.set('before', String(before));
        if (serviceId !== undefined) q.set('serviceId', String(serviceId));
        const r = await api<{ incidents: IncidentDto[] }>(`/alerts/incidents?${q}`);
        setRows((prev) => (before === undefined ? r.incidents : [...prev, ...r.incidents]));
        setMore(r.incidents.length === PAGE);
      } catch (e) {
        setErr(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [state, serviceId],
  );

  useEffect(() => void load(), [load]);
  useEffect(() => subscribeEvents((e) => { if (e.kind.startsWith('alert_')) void load(); }), [subscribeEvents, load]);

  return (
    <section className="card" aria-label="Incidents">
      <div className="row" style={{ marginBottom: 10 }}>
        <label htmlFor="inc-state" style={{ margin: 0 }}>Show</label>
        <select id="inc-state" value={state} onChange={(e) => setState(e.target.value as 'firing' | 'all')} style={{ width: 'auto' }}>
          <option value="all">All incidents</option>
          <option value="firing">Firing now</option>
        </select>
        {serviceId !== undefined && (
          <span className="tag">one service · <Link href="/alerts">clear</Link></span>
        )}
      </div>
      {err && <div className="banner crit" role="alert">{err}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>State</th><th>Alert</th><th>Service</th><th>Details</th><th>Opened</th><th>Emails</th></tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id} data-testid={`incident-${i.id}`} style={focus === i.id ? { outline: '2px solid var(--accent)' } : undefined}>
                <td>
                  <span className={`tag ${i.state === 'firing' ? sevTone(i.severity) : 'ok'}`}>
                    {i.state === 'firing' ? i.severity : 'resolved'}
                  </span>
                  {i.suppressedBy !== null && i.state === 'firing' && (
                    <div className="muted" style={{ fontSize: '0.75rem' }} title="A related, more serious alert is already firing">grouped</div>
                  )}
                </td>
                <td>{i.ruleName}</td>
                <td>{i.serviceId ? <Link href={`/services/${i.serviceId}`}>{i.serviceName}</Link> : <span className="muted">host</span>}</td>
                <td>
                  {i.summary}
                  {isAdmin && (
                    <details>
                      <summary>delivery log</summary>
                      <Notifications id={i.id} />
                    </details>
                  )}
                </td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  {dateTime(i.openedAt)}
                  <div className="muted">
                    {i.state === 'firing' ? `${timeAgo(i.openedAt)}` : `lasted ${duration(((i.resolvedAt ?? i.openedAt) - i.openedAt) / 1000)}`}
                  </div>
                </td>
                <td className="num">{i.notifyCount > 0 ? `${i.notifyCount} · ${timeAgo(i.lastNotifiedAt)}` : <span className="muted">none</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && !busy && !err && (
        <div className="empty">{state === 'firing' ? 'Nothing is firing.' : 'No incidents yet.'}</div>
      )}
      {more && !busy && (
        <div style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => void load(rows[rows.length - 1]?.id)}>Load older</button>
        </div>
      )}
    </section>
  );
}
