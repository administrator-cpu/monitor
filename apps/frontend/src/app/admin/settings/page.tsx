'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { groupSettings, type SettingEntry } from '@cc/shared';
import { PageHead, Shell } from '@/components/Shell';
import { api, errorMessage, fetcher } from '@/lib/api';
import { dateTime } from '@/lib/format';

const HELP: Record<string, string> = {
  'alert.from': 'Sender shown on alert emails: name@your-domain.com or Name <name@your-domain.com>. The domain must be verified in Resend.',
  'alert.dashboard_url': 'Address of this dashboard, used for links inside emails.',
  'alert.reminder_minutes': 'How often a still-firing alert is repeated (a rule can override this).',
  'logs.retention_hours': 'How long log files are kept.',
  'logs.volume_threshold_pct': 'Above this usage the oldest hour of logs is deleted early.',
  'logs.ring_buffer_lines': 'Recent lines per service kept in memory for the live tail.',
  'pm2.stale_hours': 'A service not seen in PM2 for this long is flagged as not seen lately.',
  'pm2.auto_archive_minutes': 'A service that PM2 no longer lists (for example after pm2 delete) is archived after this many minutes. 0 turns it off. A stopped service is still listed by PM2, so it is never archived.',
  'github.poll_minutes': 'How often GitHub is asked about each service that has a repository set. Needs GITHUB_TOKEN in the server .env.',
  'actions.stop_mute_minutes': 'Stopping a service from the dashboard silences its "service down" alert for this long (lifted when you start it). 0 turns it off.',
  'retention.email_days': 'Resend delivery counts (per sender domain) are kept this many days.',
  'backup.keep': 'Nightly database backups (written at 02:30 server time to BACKUP_DIR) kept on the server. Older ones are deleted after each new backup.',
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
      {data && groupSettings(data.settings).map(({ prefix, title, rows }) => (
        <section className="card" key={prefix} style={{ marginBottom: 14 }} aria-label={title}>
          <h2>{title}</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Setting</th><th>Value</th><th>Default</th><th /></tr></thead>
              <tbody>{rows.map((s) => <Row key={s.key + String(s.updatedAt)} s={s} onSaved={() => void mutate()} />)}</tbody>
            </table>
          </div>
        </section>
      ))}
      <p className="muted">
        Emptying a field and saving restores the default. Settings the server does not use yet (MongoDB,
        agent) are not shown.
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
