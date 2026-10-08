'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { ApiError, errorMessage, NetworkError } from '@/lib/api';

export default function LoginPage() {
  const auth = useAuth();
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Already signed in (or just became so): leave the login screen.
  useEffect(() => {
    if (auth.state.status === 'authed') {
      router.replace(auth.state.me.mustChangePassword ? '/change-password' : '/');
    }
  }, [auth.state, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await auth.login({ username: username.trim(), password });
    } catch (err) {
      if (err instanceof NetworkError)
        setError('Cannot reach the monitor API. Check your connection.');
      else if (err instanceof ApiError && err.status === 400)
        setError('Enter your username and password.');
      else setError(errorMessage(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  if (auth.state.status === 'loading') {
    return (
      <div className="center-screen">
        <span className="muted" role="status">
          Loading…
        </span>
      </div>
    );
  }

  return (
    <div className="center-screen">
      <form className="card auth-card" onSubmit={onSubmit} aria-labelledby="login-title">
        <div className="brand" style={{ padding: 0, marginBottom: 14 }}>
          <span className="brand-mark" aria-hidden="true" />
          Command Center
        </div>
        <h1 id="login-title">Sign in</h1>
        <p className="muted" style={{ marginTop: 4 }}>
          Accounts are created by an administrator.
        </p>

        {auth.state.status === 'error' && (
          <div className="banner crit" role="alert">
            {auth.state.message}{' '}
            <button type="button" className="btn small" onClick={() => void auth.refresh()}>
              Retry
            </button>
          </div>
        )}

        <div className="field" style={{ marginTop: 16 }}>
          <label htmlFor="username">Username</label>
          <input
            id="username"
            name="username"
            autoComplete="username"
            autoFocus
            required
            maxLength={64}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={200}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <p className="error" role="alert" data-testid="login-error">
            {error}
          </p>
        )}
        <button
          className="btn primary"
          type="submit"
          disabled={busy || !username || !password}
          style={{ width: '100%', marginTop: 12 }}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
