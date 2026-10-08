'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AuditEntry } from '@cc/shared';
import { PageHead, Shell } from '@/components/Shell';
import { api, errorMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';

const EVENTS = [
  'login_success',
  'login_failed',
  'login_locked',
  'logout',
  'session_expired',
  'session_revoked',
  'user_created',
  'user_updated',
  'user_disabled',
  'user_enabled',
  'password_reset',
  'password_changed',
  'settings_changed',
];
const PAGE = 100;

function tone(event: string): string {
  if (event === 'login_failed' || event === 'login_locked' || event === 'user_disabled')
    return 'crit';
  if (event === 'password_reset' || event === 'session_revoked' || event === 'session_expired')
    return 'warn';
  return '';
}

function Audit() {
  const [event, setEvent] = useState('');
  const [username, setUsername] = useState('');
  const [applied, setApplied] = useState({ event: '', username: '' });
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (before?: number) => {
      setBusy(true);
      setError(null);
      try {
        const q = new URLSearchParams({ limit: String(PAGE) });
        if (before !== undefined) q.set('before', String(before));
        if (applied.event) q.set('event', applied.event);
        if (applied.username) q.set('username', applied.username);
        const res = await api<{ entries: AuditEntry[] }>(`/audit?${q}`);
        setEntries((prev) => (before === undefined ? res.entries : [...prev, ...res.entries]));
        setMore(res.entries.length === PAGE);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [applied],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHead title="Audit log" />
      <form
        className="row card"
        style={{ marginBottom: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          setApplied({ event, username: username.trim() });
        }}
        aria-label="Filters"
      >
        <div style={{ minWidth: 200 }}>
          <label htmlFor="f-event">Event</label>
          <select id="f-event" value={event} onChange={(e) => setEvent(e.target.value)}>
            <option value="">All events</option>
            {EVENTS.map((ev) => (
              <option key={ev} value={ev}>
                {ev}
              </option>
            ))}
          </select>
        </div>
        <div style={{ minWidth: 200 }}>
          <label htmlFor="f-user">Username (as typed)</label>
          <input
            id="f-user"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="any"
          />
        </div>
        <div style={{ alignSelf: 'flex-end' }}>
          <button className="btn primary">Apply</button>{' '}
          <button
            type="button"
            className="btn"
            onClick={() => {
              setEvent('');
              setUsername('');
              setApplied({ event: '', username: '' });
            }}
          >
            Clear
          </button>
        </div>
      </form>

      {error && (
        <div className="banner crit" role="alert">
          {error}
        </div>
      )}

      <section className="card" aria-label="Audit entries">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>User</th>
                <th>IP</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((a) => (
                <tr key={a.id}>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    {dateTime(a.ts)}
                  </td>
                  <td>
                    <span className={`tag ${tone(a.event)}`}>{a.event}</span>
                  </td>
                  <td>{a.username ?? <span className="muted">—</span>}</td>
                  <td className="num">{a.ip ?? '—'}</td>
                  <td>
                    {a.detail != null ? (
                      <details>
                        <summary>view</summary>
                        <pre className="detail">{JSON.stringify(a.detail, null, 2)}</pre>
                      </details>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {entries.length === 0 && !busy && !error && <div className="empty">No entries match.</div>}
        {busy && (
          <div className="muted" role="status" style={{ marginTop: 8 }}>
            Loading…
          </div>
        )}
        {more && !busy && (
          <div style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => void load(entries[entries.length - 1]?.id)}>
              Load older
            </button>
          </div>
        )}
      </section>
    </>
  );
}

export default function Page() {
  return (
    <Shell adminOnly>
      <Audit />
    </Shell>
  );
}
