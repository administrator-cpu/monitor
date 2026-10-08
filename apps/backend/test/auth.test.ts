import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db';
import {
  addUser,
  authed,
  GOOD_PASSWORD,
  login,
  makeApp,
  ORIGIN,
  tempDbFile,
  writeHeaders,
  type TestApp,
} from './helpers';

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  await addUser(t);
});
afterEach(async () => {
  await t.close();
});

const auditEvents = (t: TestApp) =>
  (t.db.prepare('SELECT event FROM audit_log ORDER BY id').all() as { event: string }[]).map(
    (r) => r.event,
  );

describe('login', () => {
  it('succeeds and sets a hardened session cookie', async () => {
    const { res, cookie } = await login(t);
    expect(res.statusCode).toBe(200);
    expect(cookie).toBeTruthy();
    const c = res.cookies.find((x) => x.name === 'cc_session')!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Lax');
    expect(c.path).toBe('/');
    expect(c.domain).toBeUndefined();
    expect(res.json().user.username).toBe('owner');
    expect(res.json().user).not.toHaveProperty('password_hash');
    expect(JSON.stringify(res.json())).not.toContain('$2');
    expect(auditEvents(t)).toContain('login_success');
  });

  it('stores only the SHA-256 hash of the token, never the token', async () => {
    const { cookie } = await login(t);
    const rows = t.db.prepare('SELECT id FROM sessions').all() as { id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(cookie);
    expect(rows[0]!.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses the __Host- cookie with Secure when configured for production', async () => {
    const prod = await makeApp({ config: { cookieSecure: true, cookieName: '__Host-session' } });
    await addUser(prod);
    const res = await prod.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: writeHeaders(),
      payload: { username: 'owner', password: GOOD_PASSWORD },
    });
    const c = res.cookies.find((x) => x.name === '__Host-session')!;
    expect(c.secure).toBe(true);
    expect(c.httpOnly).toBe(true);
    expect(c.domain).toBeUndefined();
    await prod.close();
  });

  it('gives identical responses for unknown user and wrong password', async () => {
    const a = await login(t, 'owner', 'wrong password here');
    const b = await login(t, 'nobody', 'wrong password here');
    expect(a.res.statusCode).toBe(401);
    expect(b.res.statusCode).toBe(401);
    expect(a.res.json()).toEqual(b.res.json());
  });

  it('locks the account after 5 failures, audits each, and refuses even the right password', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await login(t, 'owner', 'wrong password here');
      expect(r.res.statusCode).toBe(401);
    }
    const events = auditEvents(t);
    expect(events.filter((e) => e === 'login_failed')).toHaveLength(5);
    expect(events).toContain('login_locked');

    const locked = await login(t, 'owner', GOOD_PASSWORD);
    expect(locked.res.statusCode).toBe(429);
    expect(locked.cookie).toBeNull();
  });

  it('unlocks after the lock period (15 minutes)', async () => {
    for (let i = 0; i < 5; i++) await login(t, 'owner', 'wrong password here');
    expect((await login(t)).res.statusCode).toBe(429);
    t.clock.t += 15 * 60_000 + 1000;
    expect((await login(t)).res.statusCode).toBe(200);
  });

  it('applies the same lockout to usernames that do not exist', async () => {
    for (let i = 0; i < 5; i++) await login(t, 'ghost', 'wrong password here');
    const r = await login(t, 'ghost', 'wrong password here');
    expect(r.res.statusCode).toBe(429);
  });

  it('rate limits per IP: 20 attempts per 10 minutes', async () => {
    let last = 0;
    for (let i = 0; i < 21; i++) {
      // distinct usernames so the per-username lock does not interfere
      last = (await login(t, `user${i}`, 'wrong password here')).res.statusCode;
    }
    expect(last).toBe(429);
  });

  it('does not let parallel guesses race past the lockout', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => login(t, 'owner', 'wrong password here')),
    );
    const codes = results.map((r) => r.res.statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(7);
  });

  it('rejects a disabled account without revealing why', async () => {
    await addUser(t, { username: 'gone' });
    t.db.prepare(`UPDATE users SET is_active = 0 WHERE username = 'gone'`).run();
    const r = await login(t, 'gone');
    expect(r.res.statusCode).toBe(401);
    expect(r.res.json().message).toBe('Invalid username or password.');
  });

  it('rejects unknown fields and bad input', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: writeHeaders(),
      payload: { username: 'owner', password: GOOD_PASSWORD, admin: true },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('origin and CSRF', () => {
  it('rejects a request from a non-allowlisted Origin', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: writeHeaders({ origin: 'https://evil.example' }),
      payload: { username: 'owner', password: GOOD_PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('origin_not_allowed');
  });

  it('rejects even GET requests from a non-allowlisted Origin', async () => {
    const { cookie } = await login(t);
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { origin: 'https://evil.example', cookie: `cc_session=${cookie}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('requires the custom CSRF header on state-changing requests', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN },
      payload: { username: 'owner', password: GOOD_PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('csrf_header_required');
  });

  it('answers CORS preflight only for allowlisted origins, with credentials', async () => {
    const ok = await t.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/login',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-monitor-client',
      },
    });
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');

    const bad = await t.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/login',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
      },
    });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('sessions', () => {
  it('requires a session for protected routes', async () => {
    for (const url of [
      '/api/v1/auth/me',
      '/api/v1/overview',
      '/api/v1/host',
      '/api/v1/users',
      '/api/v1/audit',
      '/api/v1/settings',
    ]) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('returns /me for a valid session and ends it on logout', async () => {
    const { cookie } = await login(t);
    const me = await t.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authed(cookie!),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe('owner');

    const out = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: authed(cookie!),
    });
    expect(out.statusCode).toBe(204);
    expect(auditEvents(t)).toContain('logout');

    const again = await t.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authed(cookie!),
    });
    expect(again.statusCode).toBe(401);
  });

  it('expires after the 12 h absolute lifetime and audits it', async () => {
    const { cookie } = await login(t);
    // Stay active so the idle timeout is not what ends it.
    for (let i = 0; i < 6; i++) {
      t.clock.t += 110 * 60_000; // 1 h 50 m
      const r = await t.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: authed(cookie!),
      });
      if (t.clock.t - 1_800_000_000_000 < 12 * 3_600_000) expect(r.statusCode).toBe(200);
    }
    t.clock.t = 1_800_000_000_000 + 12 * 3_600_000 + 1000;
    const r = await t.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authed(cookie!),
    });
    expect(r.statusCode).toBe(401);
    expect(auditEvents(t)).toContain('session_expired');
  });

  it('expires after 2 h idle', async () => {
    const { cookie } = await login(t);
    t.clock.t += 2 * 3_600_000 + 1000;
    const r = await t.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authed(cookie!),
    });
    expect(r.statusCode).toBe(401);
    expect(auditEvents(t)).toContain('session_expired');
  });

  it('survives a backend restart (sessions live in SQLite)', async () => {
    const file = tempDbFile();
    const clock = { t: 1_800_000_000_000 };
    const first = await makeApp({ db: openDb(file), clock });
    await addUser(first);
    const { cookie } = await login(first);
    await first.close();
    first.db.close();

    const second = await makeApp({ db: openDb(file), clock });
    const me = await second.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authed(cookie!),
    });
    expect(me.statusCode).toBe(200);
    await second.close();
    second.db.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});

describe('password change', () => {
  it('forces a change when required and blocks other routes until then', async () => {
    await addUser(t, { username: 'newbie', mustChange: true });
    const { cookie } = await login(t, 'newbie');
    const blocked = await t.app.inject({
      method: 'GET',
      url: '/api/v1/overview',
      headers: authed(cookie!),
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe('password_change_required');

    const me = await t.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authed(cookie!),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().mustChangePassword).toBe(true);

    const change = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: authed(cookie!),
      payload: { currentPassword: GOOD_PASSWORD, newPassword: 'a brand new passphrase' },
    });
    expect(change.statusCode).toBe(200);
    expect(change.json().mustChangePassword).toBe(false);

    const ok = await t.app.inject({
      method: 'GET',
      url: '/api/v1/overview',
      headers: authed(cookie!),
    });
    expect(ok.statusCode).toBe(200);
  });

  it('rejects a wrong current password, a weak password and an unchanged one', async () => {
    const { cookie } = await login(t);
    const post = (payload: object) =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/change-password',
        headers: authed(cookie!),
        payload,
      });
    expect(
      (
        await post({ currentPassword: 'nope nope nope!', newPassword: 'a brand new passphrase' })
      ).json().error,
    ).toBe('invalid_current_password');
    expect((await post({ currentPassword: GOOD_PASSWORD, newPassword: 'short' })).statusCode).toBe(
      400,
    );
    expect(
      (await post({ currentPassword: GOOD_PASSWORD, newPassword: 'password1234' })).json().error,
    ).toBe('weak_password');
    expect(
      (await post({ currentPassword: GOOD_PASSWORD, newPassword: GOOD_PASSWORD })).json().error,
    ).toBe('same_password');
  });

  it("revokes the user's other sessions but keeps the current one", async () => {
    const a = await login(t);
    const b = await login(t);
    const change = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: authed(a.cookie!),
      payload: { currentPassword: GOOD_PASSWORD, newPassword: 'a brand new passphrase' },
    });
    expect(change.statusCode).toBe(200);
    expect(auditEvents(t)).toContain('password_changed');
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authed(a.cookie!) }))
        .statusCode,
    ).toBe(200);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authed(b.cookie!) }))
        .statusCode,
    ).toBe(401);
  });
});

describe('health', () => {
  it('returns only {"status":"ok"} without authentication', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('is rate limited', async () => {
    let last = 200;
    for (let i = 0; i < 70; i++)
      last = (await t.app.inject({ method: 'GET', url: '/health' })).statusCode;
    expect(last).toBe(429);
  });

  it('sets security headers on the API', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeTruthy();
  });
});
