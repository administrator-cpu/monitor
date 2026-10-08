'use client';

import { useState } from 'react';
import useSWR from 'swr';
import type { SettingEntry } from '@cc/shared';
import { PageHead, Shell } from '@/components/Shell';
import { api, errorMessage, fetcher } from '@/lib/api';
import { dateTime } from '@/lib/format';

const GROUPS: [string, string][] = [
  ['alert.', 'Alert email'],
  ['logs.', 'Logs'],
  ['retention.', 'Retention'],
  ['pm2.', 'Services'],
  ['session.', 'Sessions'],
  ['login.', 'Sign-in protection'],
];

const HELP: Record<string, string> = {
  'alert.from': 'Sender shown on alert emails: name@your-domain.com or Name <name@your-domain.com>. The domain must be verified in Resend.',
  'alert.dashboard_url': 'Address of this dashboard, used for links inside emails.',
  'alert.reminder_minutes': 'How often a still-firing alert is repeated (a rule can override this).',
  'logs.retention_hours': 'How long log files are kept.',
  'logs.volume_threshold_pct': 'Above this usage the oldest hour of logs is deleted early.',
  'logs.ring_buffer_lines': 'Recent lines per service kept in memory for the live tail.',
  'pm2.stale_hours': 'A service not seen in PM2 for this long is flagged as not seen lately.',
};

function Row({ s, onSaved }: { s: SettingEntry; onSaved: () => void }) {
  const [v, setV] = useState(s.value === null ? '' : String(s.value));
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const isNum = s.type === 'number';
  const dirty = v !== (s.value === null ? '' : String(s.value));

  async function save(value: number | string | null) {
    setBusy(true);
    setErr(null);
    setOk(false);
    try {
      await api('/settings', { method: 'PATCH', body: { [s.key]: value } });
      setOk(true);
      onSaved();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr data-testid={`setting-${s.key}`}>
      <td>
        <code>{s.key}</code>
        {HELP[s.key] && <div className="muted" style={{ fontSize: '0.8rem' }}>{HELP[s.key]}</div>}
        {s.updatedAt && <div className="muted" style={{ fontSize: '0.75rem' }}>changed {dateTime(s.updatedAt)}</div>}
      </td>
      <td style={{ minWidth: 220 }}>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void save(v.trim() === '' ? null : isNum ? Number(v) : v.trim());
          }}
        >
          <input
            aria-label={s.key}
            value={v}
            inputMode={isNum ? 'decimal' : 'text'}
            placeholder={s.default === null ? 'not set' : String(s.default)}
            onChange={(e) => { setV(e.target.value); setOk(false); }}
          />
          <button className="btn small primary" disabled={busy || !dirty}>Save</button>
        </form>
        {isNum && (s.min !== undefined || s.max !== undefined) && (
          <div className="muted" style={{ fontSize: '0.75rem' }}>{s.min} to {s.max}{s.integer ? ', whole numbers' : ''}</div>
        )}
        {err && <div className="error" role="alert">{err}</div>}
        {ok && <div className="notice" role="status">Saved.</div>}
      </td>
      <td className="muted num">{s.default === null ? '—' : String(s.default)}</td>
      <td className="actions">
        {s.value !== null && s.value !== s.default && (
          <button className="btn small" disabled={busy} onClick={() => { setV(''); void save(null); }}>Reset</button>
        )}
      </td>
    </tr>
  );
}

function Settings() {
  const { data, error, mutate } = useSWR<{ settings: SettingEntry[] }>('/settings', fetcher);
  return (
    <>
      <PageHead title="Settings" />
      {error && <div className="banner crit" role="alert">Could not load settings: {error.message}</div>}
      {data && GROUPS.map(([prefix, title]) => {
        const rows = data.settings.filter((s) => s.key.startsWith(prefix) && s.type !== 'list');
        if (rows.length === 0) return null;
        return (
          <section className="card" key={prefix} style={{ marginBottom: 14 }} aria-label={title}>
            <h2>{title}</h2>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Setting</th><th>Value</th><th>Default</th><th /></tr></thead>
                <tbody>{rows.map((s) => <Row key={s.key + String(s.updatedAt)} s={s} onSaved={() => void mutate()} />)}</tbody>
              </table>
            </div>
          </section>
        );
      })}
      <p className="muted">
        Emptying a field and saving restores the default. Settings for features that arrive in later phases
        (Nginx, MongoDB, agent) are not shown.
      </p>
    </>
  );
}

export default function Page() {
  return (
    <Shell adminOnly>
      <Settings />
    </Shell>
  );
}
