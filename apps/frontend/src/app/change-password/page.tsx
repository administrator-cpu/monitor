'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { PASSWORD_MIN_LENGTH, type MeResponse } from '@cc/shared';
import { Shell } from '@/components/Shell';
import { useAuth } from '@/lib/auth';
import { api, errorMessage } from '@/lib/api';

function ChangePassword() {
  const auth = useAuth();
  const router = useRouter();
  const forced = auth.state.status === 'authed' && auth.state.me.mustChangePassword;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < PASSWORD_MIN_LENGTH)
      return setError(`The new password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
    if (next !== confirm) return setError('The new passwords do not match.');
    setBusy(true);
    try {
      const me = await api<MeResponse>('/auth/change-password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      });
      auth.setMe(me);
      router.replace('/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <form className="card auth-card" onSubmit={onSubmit} aria-labelledby="pw-title">
        <h1 id="pw-title">{forced ? 'Choose a new password' : 'Change password'}</h1>
        <p className="muted" style={{ marginTop: 4 }}>
          {forced
            ? 'An administrator set a temporary password. Choose your own to continue.'
            : 'Other devices are signed out when you change it.'}
        </p>
        <div className="field" style={{ marginTop: 16 }}>
          <label htmlFor="current">Current password</label>
          <input
            id="current"
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="new">New password (min {PASSWORD_MIN_LENGTH} characters)</label>
          <input
            id="new"
            type="password"
            autoComplete="new-password"
            required
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="confirm">Repeat new password</label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save password'}
          </button>
          {forced ? (
            <button type="button" className="btn" onClick={() => void auth.logout()}>
              Sign out
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => router.back()}>
              Cancel
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

export default function Page() {
  return (
    <Shell bare>
      <ChangePassword />
    </Shell>
  );
}
