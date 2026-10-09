'use client';

import { useState, type FormEvent } from 'react';
import useSWR from 'swr';
import { PASSWORD_MIN_LENGTH, type Role, type UserDto } from '@cc/shared';
import { PageHead, Shell } from '@/components/Shell';
import { api, errorMessage, fetcher } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime } from '@/lib/format';

interface UsersResponse {
  users: UserDto[];
}

function CreateUser({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    username: '',
    displayName: '',
    email: '',
    role: 'engineer' as Role,
    password: '',
    mustChangePassword: true,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('/users', {
        method: 'POST',
        body: {
          ...f,
          username: f.username.trim(),
          displayName: f.displayName.trim(),
          email: f.email.trim(),
        },
      });
      setF({
        username: '',
        displayName: '',
        email: '',
        role: 'engineer',
        password: '',
        mustChangePassword: true,
      });
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="btn primary" onClick={() => setOpen(true)}>
        New user
      </button>
    );
  }
  return (
    <form className="card" onSubmit={submit} aria-label="Create user" style={{ marginBottom: 14 }}>
      <h2>New user</h2>
      <div
        className="grid tiles"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}
      >
        <div className="field">
          <label htmlFor="nu-username">Username</label>
          <input
            id="nu-username"
            required
            minLength={3}
            maxLength={64}
            autoComplete="off"
            value={f.username}
            onChange={(e) => set('username', e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="nu-name">Display name</label>
          <input
            id="nu-name"
            required
            maxLength={100}
            value={f.displayName}
            onChange={(e) => set('displayName', e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="nu-email">Email</label>
          <input
            id="nu-email"
            type="email"
            required
            maxLength={200}
            value={f.email}
            onChange={(e) => set('email', e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="nu-role">Role</label>
          <select id="nu-role" value={f.role} onChange={(e) => set('role', e.target.value as Role)}>
            <option value="engineer">Engineer (read-only)</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="nu-pw">Temporary password (min {PASSWORD_MIN_LENGTH})</label>
          <input
            id="nu-pw"
            type="password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            autoComplete="new-password"
            value={f.password}
            onChange={(e) => set('password', e.target.value)}
          />
        </div>
      </div>
      <label className="row" style={{ marginBottom: 12 }}>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={f.mustChangePassword}
          onChange={(e) => set('mustChangePassword', e.target.checked)}
        />
        Require a password change at first sign-in
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button className="btn primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create user'}
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function UserRow({
  u,
  selfId,
  onChanged,
  say,
}: {
  u: UserDto;
  selfId: number;
  onChanged: () => void;
  say: (m: string, isError?: boolean) => void;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'reset'>('view');
  const [edit, setEdit] = useState({ displayName: u.displayName, email: u.email, role: u.role, canOperate: u.role === 'admin' ? false : u.canOperate });
  const [pw, setPw] = useState('');
  const isSelf = u.id === selfId;

  async function run(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      say(`${label}: ${u.username}`);
      setMode('view');
      onChanged();
    } catch (err) {
      say(errorMessage(err), true);
    }
  }

  return (
    <>
      <tr data-testid={`user-${u.username}`}>
        <td>
          <strong>{u.username}</strong>
          <div className="muted">{u.displayName}</div>
        </td>
        <td>{u.email}</td>
        <td>
          <span className="tag">{u.role}</span>{' '}
          {u.role === 'engineer' && u.canOperate && <span className="tag ok">can operate</span>}{' '}
          {!u.isActive ? (
            <span className="tag crit">disabled</span>
          ) : u.mustChangePassword ? (
            <span className="tag warn">must change password</span>
          ) : (
            <span className="tag ok">active</span>
          )}
        </td>
        <td className="muted">
          {dateTime(u.lastLoginAt)}
          {u.lastLoginIp && <div className="num">{u.lastLoginIp}</div>}
        </td>
        <td className="actions">
          <div className="row">
            <button
              className="btn small"
              onClick={() => setMode(mode === 'edit' ? 'view' : 'edit')}
            >
              Edit
            </button>
            <button
              className="btn small"
              onClick={() => setMode(mode === 'reset' ? 'view' : 'reset')}
            >
              Reset password
            </button>
            <button
              className="btn small"
              onClick={() => {
                if (confirm(`End all sessions for ${u.username}?`))
                  void run('Sessions ended', () =>
                    api(`/users/${u.id}/revoke-sessions`, { method: 'POST' }),
                  );
              }}
            >
              Revoke sessions
            </button>
            <button
              className={`btn small ${u.isActive ? 'danger' : ''}`}
              disabled={isSelf && u.isActive}
              title={isSelf ? 'You cannot disable your own account' : undefined}
              onClick={() => {
                if (
                  u.isActive &&
                  !confirm(`Disable ${u.username}? They will be signed out immediately.`)
                )
                  return;
                void run(u.isActive ? 'Disabled' : 'Enabled', () =>
                  api(`/users/${u.id}`, { method: 'PATCH', body: { isActive: !u.isActive } }),
                );
              }}
            >
              {u.isActive ? 'Disable' : 'Enable'}
            </button>
          </div>
        </td>
      </tr>
      {mode === 'edit' && (
        <tr>
          <td colSpan={5}>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void run('Updated', () =>
                  api(`/users/${u.id}`, {
                    method: 'PATCH',
                    body: {
                      displayName: edit.displayName.trim(),
                      email: edit.email.trim(),
                      ...(isSelf ? {} : { role: edit.role }),
                      ...(edit.role === 'engineer' ? { canOperate: edit.canOperate } : {}),
                    },
                  }),
                );
              }}
            >
              <input
                aria-label="Display name"
                value={edit.displayName}
                onChange={(e) => setEdit({ ...edit, displayName: e.target.value })}
                style={{ maxWidth: 220 }}
                required
              />
              <input
                aria-label="Email"
                type="email"
                value={edit.email}
                onChange={(e) => setEdit({ ...edit, email: e.target.value })}
                style={{ maxWidth: 260 }}
                required
              />
              <select
                aria-label="Role"
                value={edit.role}
                disabled={isSelf}
                onChange={(e) => setEdit({ ...edit, role: e.target.value as Role })}
                style={{ maxWidth: 160 }}
              >
                <option value="engineer">Engineer</option>
                <option value="admin">Admin</option>
              </select>
              {edit.role === 'engineer' ? (
                <label className="row" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={edit.canOperate}
                    onChange={(e) => setEdit({ ...edit, canOperate: e.target.checked })}
                  />
                  Can operate (start, stop, restart)
                </label>
              ) : (
                <span className="muted">Admins can always operate</span>
              )}
              <button className="btn primary small">Save</button>
            </form>
          </td>
        </tr>
      )}
      {mode === 'reset' && (
        <tr>
          <td colSpan={5}>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void run('Password reset', () =>
                  api(`/users/${u.id}/reset-password`, { method: 'POST', body: { password: pw } }),
                ).then(() => setPw(''));
              }}
            >
              <input
                aria-label={`New temporary password for ${u.username}`}
                type="password"
                autoComplete="new-password"
                minLength={PASSWORD_MIN_LENGTH}
                required
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder={`Temporary password (min ${PASSWORD_MIN_LENGTH})`}
                style={{ maxWidth: 320 }}
              />
              <button className="btn primary small">Set password</button>
              <span className="muted">
                The user must change it at next sign-in and is signed out everywhere.
              </span>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}

function Users() {
  const auth = useAuth();
  const selfId = auth.state.status === 'authed' ? auth.state.me.user.id : -1;
  const { data, error, mutate } = useSWR<UsersResponse>('/users', fetcher);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const say = (text: string, isError = false) => setMsg({ text, error: isError });

  return (
    <>
      <PageHead title="Users">
        <CreateUser
          onCreated={() => {
            say('User created');
            void mutate();
          }}
        />
      </PageHead>
      <div aria-live="polite" style={{ minHeight: 22, marginBottom: 8 }}>
        {msg && (
          <span className={msg.error ? 'error' : 'notice'} role={msg.error ? 'alert' : 'status'}>
            {msg.text}
          </span>
        )}
      </div>
      {error && (
        <div className="banner crit" role="alert">
          {errorMessage(error)}
        </div>
      )}
      <section className="card" aria-label="User accounts">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Email</th>
                <th>Role · status</th>
                <th>Last sign-in</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data?.users.map((u) => (
                <UserRow
                  key={u.id}
                  u={u}
                  selfId={selfId}
                  onChanged={() => void mutate()}
                  say={say}
                />
              ))}
            </tbody>
          </table>
        </div>
        {!data && !error && <div className="empty">Loading…</div>}
      </section>
    </>
  );
}

export default function Page() {
  return (
    <Shell adminOnly>
      <Users />
    </Shell>
  );
}
