'use client';

import { useState, type FormEvent } from 'react';
import useSWR from 'swr';
import type { EnrollTokenResponse, HostDto, HostStatus, HostsResponse } from '@cc/shared';
import { PageHead, Shell } from '@/components/Shell';
import { api, errorMessage, fetcher } from '@/lib/api';
import { API_BASE } from '@/lib/config';
import { bytes, dateTime, duration, pct, timeAgo } from '@/lib/format';

const STATUS: Record<HostStatus, { label: string; cls: string; hint: string }> = {
  local: { label: 'this server', cls: 'ok', hint: 'Monitored directly by the backend.' },
  waiting: { label: 'waiting for agent', cls: 'warn', hint: 'Created; no agent has enrolled yet.' },
  online: { label: 'online', cls: 'ok', hint: 'The agent reported in the last minute.' },
  silent: { label: 'silent', cls: 'crit', hint: 'Enrolled, but no report for over a minute.' },
  revoked: { label: 'revoked', cls: 'crit', hint: 'Its token no longer works. History is kept.' },
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Shown once, right after a token is made. The token is never shown again. */
function TokenPanel({ t, onClose }: { t: EnrollTokenResponse; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const env = [
    '# /etc/cc-agent/agent.env  (owner root, mode 600)',
    `CC_MONITOR_URL=${API_BASE}`,
    `CC_HOST_NAME=${t.host.name}`,
    `CC_ENROLL_TOKEN=${t.enrollToken}`,
    'CC_PROJECTS=acs',
    'CC_DISKS=/',
    'CC_ACTIONS=off',
  ].join('\n');
  return (
    <section
      className="card"
      aria-label="Enrollment token"
      data-testid="enroll-token"
      style={{ marginBottom: 14 }}
    >
      <h2>Enrollment token for {t.host.name}</h2>
      <p>
        Put these lines in the agent&apos;s env file on that server. The token works{' '}
        <strong>once</strong>, until {dateTime(t.enrollExpiresAt)}, and{' '}
        <strong>is not shown again</strong>: if you lose it, make a new one.
      </p>
      <pre className="detail" style={{ maxWidth: 'none' }} data-testid="enroll-env">
        {env}
      </pre>
      <p className="muted">
        The agent exchanges it for its own host token on first start and keeps that on its state
        volume. Then start the agent with the compose file in <code>deploy/cc-agent</code> (runbook
        &ldquo;Adding a host&rdquo; in <code>docs/runbook-hosts.md</code>); the host shows as online
        within a minute.
      </p>
      <div className="row">
        <button
          className="btn small"
          onClick={() => {
            void navigator.clipboard?.writeText(env).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button className="btn small primary" onClick={onClose}>
          Done, I have saved it
        </button>
      </div>
    </section>
  );
}

/** The add form. It sits below the page header, so opening it does not stretch the header row. */
function CreateHost({
  onCreated,
  onClose,
}: {
  onCreated: (t: EnrollTokenResponse) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const t = await api<EnrollTokenResponse>('/hosts', {
        method: 'POST',
        body: { name: name.trim(), os: 'linux', notes: notes.trim() || null },
      });
      setName('');
      setNotes('');
      onCreated(t);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit} aria-label="Add host" style={{ marginBottom: 14 }}>
      <h2>Add a Linux host</h2>
      <div
        className="grid tiles"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}
      >
        <div className="field">
          <label htmlFor="nh-name">Name (lower case, digits, dashes)</label>
          <input
            id="nh-name"
            required
            minLength={2}
            maxLength={40}
            pattern="[a-z0-9][a-z0-9\-]*[a-z0-9]"
            placeholder="ubuntu-acs"
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="nh-notes">Notes (optional)</label>
          <input
            id="nh-notes"
            maxLength={500}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button className="btn primary" disabled={busy}>
          {busy ? 'Adding…' : 'Add host and make a token'}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function HostRow({
  h,
  onChanged,
  onToken,
  say,
}: {
  h: HostDto;
  onChanged: () => void;
  onToken: (t: EnrollTokenResponse) => void;
  say: (m: string, isError?: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState({ name: h.name, notes: h.notes ?? '' });
  const st = STATUS[h.status];
  const local = h.kind === 'local';

  async function run(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      say(`${label}: ${h.name}`);
      setEditing(false);
      onChanged();
    } catch (err) {
      say(errorMessage(err), true);
    }
  }

  return (
    <>
      <tr data-testid={`host-${h.name}`}>
        <td>
          <strong>{h.name}</strong>
          <div className="muted">
            #{h.id} · {h.os === 'windows' ? 'Windows' : 'Linux'}
            {h.notes ? ` · ${h.notes}` : ''}
          </div>
        </td>
        <td>
          <span className={`tag ${st.cls}`} title={st.hint} data-testid={`host-status-${h.name}`}>
            {st.label}
          </span>
          {h.enrollExpiresAt !== null && (
            <div className="muted">token open until {dateTime(h.enrollExpiresAt)}</div>
          )}
          {h.clockSkewMs !== null && (
            <div>
              <span className="tag warn" title="Its timestamps are replaced by the arrival time">
                clock off by {duration(Math.abs(h.clockSkewMs) / 1000)}
              </span>
            </div>
          )}
        </td>
        <td className="muted">
          {local ? (
            '—'
          ) : (
            <>
              {timeAgo(h.lastSeenAt)}
              {h.agentVersion && <div className="num">agent {h.agentVersion}</div>}
              {h.actionsEnabled !== null && <div>actions {h.actionsEnabled ? 'on' : 'off'}</div>}
            </>
          )}
        </td>
        <td className="muted">
          {local ? (
            'See the Host page'
          ) : h.latest ? (
            <>
              CPU {pct(h.latest.cpuPct)} · memory {bytes(h.latest.memUsedBytes)} of{' '}
              {bytes(h.latest.memTotalBytes)}
              <div>
                {h.latest.disks} disk{h.latest.disks === 1 ? '' : 's'} · {h.latest.containers}{' '}
                container
                {h.latest.containers === 1 ? '' : 's'}
              </div>
              {h.counts && (
                <div
                  className="num"
                  title="Since the monitor started. Logs and events are stored from later steps."
                >
                  {plural(h.counts.metrics, 'report')} · {plural(h.counts.logLines, 'log line')} ·{' '}
                  {plural(h.counts.eventCount, 'event')}
                  {h.counts.rejected > 0 ? ` · ${h.counts.rejected} refused` : ''}
                </div>
              )}
            </>
          ) : (
            'No report yet'
          )}
        </td>
        <td className="actions">
          <div className="row">
            <button className="btn small" onClick={() => setEditing(!editing)}>
              Edit
            </button>
            {!local && (
              <button
                className="btn small"
                onClick={() => {
                  const msg = h.enrolled
                    ? `Make a new enrollment token for ${h.name}? The agent keeps its current token until it is restarted with the new one.`
                    : `Make a new enrollment token for ${h.name}? Any older unused token stops working.`;
                  if (confirm(msg))
                    void (async () => {
                      try {
                        onToken(
                          await api<EnrollTokenResponse>(`/hosts/${h.id}/enroll-token`, {
                            method: 'POST',
                          }),
                        );
                        onChanged();
                      } catch (err) {
                        say(errorMessage(err), true);
                      }
                    })();
                }}
              >
                New token
              </button>
            )}
            {!local && h.status !== 'revoked' && (
              <button
                className="btn small danger"
                onClick={() => {
                  if (
                    confirm(
                      `Revoke ${h.name}? Its agent is refused from the next request on. History is kept.`,
                    )
                  )
                    void run('Revoked', () => api(`/hosts/${h.id}/revoke`, { method: 'POST' }));
                }}
              >
                Revoke
              </button>
            )}
          </div>
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={5}>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void run('Updated', () =>
                  api(`/hosts/${h.id}`, {
                    method: 'PATCH',
                    body: {
                      ...(local ? {} : { name: edit.name.trim() }),
                      notes: edit.notes.trim() || null,
                    },
                  }),
                );
              }}
            >
              {!local && (
                <input
                  aria-label="Host name"
                  value={edit.name}
                  onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                  style={{ maxWidth: 220 }}
                  required
                />
              )}
              <input
                aria-label="Notes"
                value={edit.notes}
                maxLength={500}
                onChange={(e) => setEdit({ ...edit, notes: e.target.value })}
                style={{ maxWidth: 360 }}
                placeholder="Notes"
              />
              <button className="btn primary small">Save</button>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}

function Hosts() {
  const { data, error, mutate } = useSWR<HostsResponse>('/hosts', fetcher, {
    refreshInterval: 10_000,
  });
  const [token, setToken] = useState<EnrollTokenResponse | null>(null);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const say = (text: string, isError = false) => setMsg({ text, error: isError });

  return (
    <>
      <PageHead title="Hosts">
        <button className="btn primary" onClick={() => setAdding(true)} disabled={adding}>
          Add host
        </button>
      </PageHead>
      {adding && (
        <CreateHost
          onClose={() => setAdding(false)}
          onCreated={(t) => {
            setAdding(false);
            setToken(t);
            say(`Host added: ${t.host.name}`);
            void mutate();
          }}
        />
      )}
      <div aria-live="polite" style={{ minHeight: 22, marginBottom: 8 }}>
        {msg && (
          <span className={msg.error ? 'error' : 'notice'} role={msg.error ? 'alert' : 'status'}>
            {msg.text}
          </span>
        )}
      </div>
      {token && <TokenPanel t={token} onClose={() => setToken(null)} />}
      {error && (
        <div className="banner crit" role="alert">
          {errorMessage(error)}
        </div>
      )}
      <section className="card" aria-label="Hosts">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Host</th>
                <th>Status</th>
                <th>Last contact</th>
                <th>Latest report</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data?.hosts.map((h) => (
                <HostRow
                  key={h.id}
                  h={h}
                  onChanged={() => void mutate()}
                  onToken={setToken}
                  say={say}
                />
              ))}
            </tbody>
          </table>
        </div>
        {!data && !error && <div className="empty">Loading…</div>}
      </section>
      <p className="muted">
        Other servers report through an agent that only connects out to this monitor. A host that
        stops reporting raises &ldquo;Host silent&rdquo;, which holds back that host&apos;s other
        alert emails until it is back.
      </p>
    </>
  );
}

export default function HostsPage() {
  return (
    <Shell adminOnly>
      <Hosts />
    </Shell>
  );
}
