import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addUser, authed, GOOD_PASSWORD, login, makeApp, type TestApp } from './helpers';

let t: TestApp;
let adminCookie: string;
beforeEach(async () => {
  t = await makeApp();
  await addUser(t);
  adminCookie = (await login(t)).cookie!;
});
afterEach(async () => {
  await t.close();
});

const req = (method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string, payload?: object) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: authed(cookie), payload });

const newUser = (over: object = {}) => ({
  username: 'alice',
  displayName: 'Alice',
  email: 'alice@example.com',
  role: 'engineer',
  password: 'alice has a long password',
  mustChangePassword: true,
  ...over,
});

describe('role checks', () => {
  it('engineers cannot reach admin routes but can read monitoring data', async () => {
    await addUser(t, { username: 'eng', role: 'engineer' });
    const eng = (await login(t, 'eng')).cookie!;
    for (const [m, u] of [
      ['GET', '/users'],
      ['GET', '/audit'],
      ['GET', '/settings'],
    ] as const) {
      expect((await req(m, u, eng)).statusCode, u).toBe(403);
    }
    expect((await req('POST', '/users', eng, newUser())).statusCode).toBe(403);
    expect((await req('PATCH', '/settings', eng, { 'login.max_failures': 3 })).statusCode).toBe(
      403,
    );
    expect((await req('GET', '/overview', eng)).statusCode).toBe(200);
    expect((await req('GET', '/host', eng)).statusCode).toBe(200);
  });
});

describe('user management', () => {
  it('creates a user, audits it, and never returns the hash', async () => {
    const res = await req('POST', '/users', adminCookie, newUser());
    expect(res.statusCode).toBe(201);
    expect(res.json().user.username).toBe('alice');
    expect(JSON.stringify(res.json())).not.toMatch(/hash|\$2/);
    const list = await req('GET', '/users', adminCookie);
    expect(list.json().users).toHaveLength(2);
    const audit = await req('GET', '/audit?event=user_created', adminCookie);
    expect(audit.json().entries).toHaveLength(1);
  });

  it('enforces the password policy and unique username/email', async () => {
    expect(
      (await req('POST', '/users', adminCookie, newUser({ password: 'short' }))).statusCode,
    ).toBe(400);
    expect(
      (await req('POST', '/users', adminCookie, newUser({ password: 'password1234' }))).json()
        .error,
    ).toBe('weak_password');
    expect((await req('POST', '/users', adminCookie, newUser())).statusCode).toBe(201);
    expect((await req('POST', '/users', adminCookie, newUser())).json().error).toBe(
      'username_taken',
    );
    expect(
      (await req('POST', '/users', adminCookie, newUser({ username: 'ALICE' }))).json().error,
    ).toBe('username_taken');
    expect(
      (await req('POST', '/users', adminCookie, newUser({ username: 'bob' }))).json().error,
    ).toBe('email_taken');
  });

  it('disabling a user ends their sessions immediately', async () => {
    await req('POST', '/users', adminCookie, newUser({ mustChangePassword: false }));
    const alice = (await login(t, 'alice', 'alice has a long password')).cookie!;
    expect((await req('GET', '/overview', alice)).statusCode).toBe(200);

    const id = (await req('GET', '/users', adminCookie))
      .json()
      .users.find((u: { username: string }) => u.username === 'alice').id;
    const res = await req('PATCH', `/users/${id}`, adminCookie, { isActive: false });
    expect(res.statusCode).toBe(200);
    expect((await req('GET', '/overview', alice)).statusCode).toBe(401);
    expect((await login(t, 'alice', 'alice has a long password')).res.statusCode).toBe(401);

    const events = (await req('GET', '/audit', adminCookie))
      .json()
      .entries.map((e: { event: string }) => e.event);
    expect(events).toContain('user_disabled');
  });

  it('refuses to disable or demote yourself, or the last admin', async () => {
    const me = (await req('GET', '/auth/me', adminCookie)).json().user.id;
    expect(
      (await req('PATCH', `/users/${me}`, adminCookie, { isActive: false })).json().error,
    ).toBe('cannot_modify_self');
    expect(
      (await req('PATCH', `/users/${me}`, adminCookie, { role: 'engineer' })).json().error,
    ).toBe('cannot_modify_self');

    // A second admin tries to demote the first, who is then the only other admin: allowed only while one remains.
    await req(
      'POST',
      '/users',
      adminCookie,
      newUser({
        username: 'admin2',
        email: 'a2@example.com',
        role: 'admin',
        mustChangePassword: false,
      }),
    );
    const a2 = (await login(t, 'admin2', 'alice has a long password')).cookie!;
    expect((await req('PATCH', `/users/${me}`, a2, { role: 'engineer' })).statusCode).toBe(200);
  });

  it('reset-password forces a change, clears the lock and revokes sessions', async () => {
    await req('POST', '/users', adminCookie, newUser({ mustChangePassword: false }));
    const id = (await req('GET', '/users', adminCookie))
      .json()
      .users.find((u: { username: string }) => u.username === 'alice').id;
    const alice = (await login(t, 'alice', 'alice has a long password')).cookie!;
    for (let i = 0; i < 5; i++) await login(t, 'alice', 'wrong password here');
    expect((await login(t, 'alice', 'alice has a long password')).res.statusCode).toBe(429);

    const reset = await req('POST', `/users/${id}/reset-password`, adminCookie, {
      password: 'a fresh temporary passphrase',
    });
    expect(reset.statusCode).toBe(204);
    expect((await req('GET', '/overview', alice)).statusCode).toBe(401);

    const again = await login(t, 'alice', 'a fresh temporary passphrase');
    expect(again.res.statusCode).toBe(200);
    expect(again.res.json().mustChangePassword).toBe(true);
    const events = (await req('GET', '/audit', adminCookie))
      .json()
      .entries.map((e: { event: string }) => e.event);
    expect(events).toContain('password_reset');
  });

  it('revoke-sessions ends every session of the target', async () => {
    await req('POST', '/users', adminCookie, newUser({ mustChangePassword: false }));
    const id = (await req('GET', '/users', adminCookie))
      .json()
      .users.find((u: { username: string }) => u.username === 'alice').id;
    const s1 = (await login(t, 'alice', 'alice has a long password')).cookie!;
    const s2 = (await login(t, 'alice', 'alice has a long password')).cookie!;
    const res = await req('POST', `/users/${id}/revoke-sessions`, adminCookie);
    expect(res.json().revoked).toBe(2);
    expect((await req('GET', '/overview', s1)).statusCode).toBe(401);
    expect((await req('GET', '/overview', s2)).statusCode).toBe(401);
  });

  it('returns 404 for an unknown user', async () => {
    expect((await req('PATCH', '/users/9999', adminCookie, { displayName: 'x' })).statusCode).toBe(
      404,
    );
  });
});

describe('audit log and settings', () => {
  it('records failed logins with the typed username', async () => {
    await login(t, 'ghost', 'wrong password here');
    const entries = (await req('GET', '/audit?event=login_failed', adminCookie)).json().entries;
    expect(entries[0].username).toBe('ghost');
    expect(entries[0].userId).toBeNull();
  });

  it('edits numeric settings with validation and audits the change', async () => {
    const list = (await req('GET', '/settings', adminCookie)).json().settings;
    expect(list.find((s: { key: string }) => s.key === 'login.max_failures').value).toBe(5);

    expect(
      (await req('PATCH', '/settings', adminCookie, { 'login.max_failures': 3 })).statusCode,
    ).toBe(200);
    expect(t.ctx.settings.get('login.max_failures')).toBe(3);
    expect((await req('PATCH', '/settings', adminCookie, { 'nope.key': 3 })).statusCode).toBe(400);
    expect(
      (await req('PATCH', '/settings', adminCookie, { 'login.max_failures': 2.5 })).statusCode,
    ).toBe(400);
    expect(
      (await req('PATCH', '/settings', adminCookie, { 'login.max_failures': 0.5 })).statusCode,
    ).toBe(400);

    const events = (await req('GET', '/audit?event=settings_changed', adminCookie)).json().entries;
    expect(events).toHaveLength(1);
    expect(events[0].detail.changes['login.max_failures']).toEqual({ from: 5, to: 3 });
  });

  it('honours an edited lockout threshold', async () => {
    await req('PATCH', '/settings', adminCookie, { 'login.max_failures': 2 });
    await addUser(t, { username: 'victim' });
    await login(t, 'victim', 'wrong password here');
    await login(t, 'victim', 'wrong password here');
    expect((await login(t, 'victim', GOOD_PASSWORD)).res.statusCode).toBe(429);
  });
});
