'use client';

import { useState } from 'react';
import useSWR from 'swr';
import type { AlertRuleDto, MuteDto, ServicesResponse } from '@cc/shared';
import { api, errorMessage, fetcher } from '@/lib/api';
import { dateTime } from '@/lib/format';

const DURATIONS: [string, number][] = [
  ['30 minutes', 30 * 60_000], ['1 hour', 3_600_000], ['4 hours', 4 * 3_600_000], ['24 hours', 24 * 3_600_000], ['7 days', 7 * 24 * 3_600_000],
];

export function MutesTab({ isAdmin }: { isAdmin: boolean }) {
  const { data, mutate } = useSWR<{ mutes: MuteDto[] }>('/alerts/mutes', fetcher, { refreshInterval: 30_000 });
  const services = useSWR<ServicesResponse>(isAdmin ? '/services' : null, fetcher);
  const rules = useSWR<{ rules: AlertRuleDto[] }>(isAdmin ? '/alerts/rules' : null, fetcher);
  const [category, setCategory] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [ruleId, setRuleId] = useState('');
  const [dur, setDur] = useState(String(DURATIONS[1]![1]));
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await api('/alerts/mutes', {
        method: 'POST',
        body: {
          endsAt: Date.now() + Number(dur),
          category: category || null,
          serviceId: serviceId ? Number(serviceId) : null,
          ruleId: ruleId ? Number(ruleId) : null,
          reason: reason.trim() || null,
        },
      });
      setReason('');
      void mutate();
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    try {
      await api(`/alerts/mutes/${id}`, { method: 'DELETE' });
      void mutate();
    } catch (x) {
      setErr(errorMessage(x));
    }
  }

  const scope = (m: MuteDto): string => {
    const parts = [m.category && `category ${m.category}`, m.serviceName && `service ${m.serviceName}`, m.ruleName && `rule ${m.ruleName}`].filter(Boolean);
    return parts.length ? parts.join(' · ') : 'everything';
  };

  return (
    <>
      {isAdmin && (
        <section className="card" style={{ marginBottom: 14 }} aria-label="New mute">
          <h2>Silence emails for a while</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Alerts are still recorded and shown on the dashboard; only the emails wait. If something is still firing
            when the mute ends, you are emailed then.
          </p>
          <form onSubmit={create}>
            <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
              <div>
                <label htmlFor="m-cat">Category</label>
                <select id="m-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">Any</option>
                  {['host', 'pm2', 'nginx', 'mongo', 'app', 'monitor'].map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="m-svc">Service</label>
                <select id="m-svc" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
                  <option value="">Any</option>
                  {(services.data?.services ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="m-rule">Rule</label>
                <select id="m-rule" value={ruleId} onChange={(e) => setRuleId(e.target.value)}>
                  <option value="">Any</option>
                  {(rules.data?.rules ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="m-dur">For</label>
                <select id="m-dur" value={dur} onChange={(e) => setDur(e.target.value)}>
                  {DURATIONS.map(([l, v]) => <option key={l} value={v}>{l}</option>)}
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label htmlFor="m-reason">Reason</label>
                <input id="m-reason" value={reason} maxLength={300} placeholder="e.g. planned deploy" onChange={(e) => setReason(e.target.value)} />
              </div>
              <button className="btn primary" disabled={busy}>Mute</button>
            </div>
            {err && <div className="error" role="alert">{err}</div>}
          </form>
        </section>
      )}

      <section className="card" aria-label="Mutes">
        <h2>Mutes</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Applies to</th><th>From</th><th>Until</th><th>Reason</th><th /></tr></thead>
            <tbody>
              {(data?.mutes ?? []).map((m) => (
                <tr key={m.id}>
                  <td>{scope(m)} {m.active && <span className="tag warn">active</span>}</td>
                  <td className="num">{dateTime(m.startsAt)}</td>
                  <td className="num">{dateTime(m.endsAt)}</td>
                  <td>{m.reason ?? <span className="muted">—</span>}</td>
                  <td className="actions">{isAdmin && <button className="btn small danger" onClick={() => void remove(m.id)}>Remove</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && data.mutes.length === 0 && <div className="empty">No mutes.</div>}
      </section>
    </>
  );
}
