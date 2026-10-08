import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckResult } from '../src/check';
import { createApp, tokenMatches } from '../src/server';

const TOKEN = 't'.repeat(40);
const config = {
  cronToken: TOKEN, targetUrl: new URL('https://api.example.com/health'), attempts: 3, attemptDelayMs: 0,
  attemptTimeoutMs: 1000, reminderAfterMs: 3_600_000, flapWindowMs: 1_800_000, recoverySuccesses: 2,
};

let server: http.Server | null = null;
afterEach(async () => {
  await new Promise((r) => (server ? server.close(r) : r(null)));
  server = null;
});

async function start(check: () => Promise<CheckResult>) {
  const sent: string[] = [];
  const app = createApp({ config, send: async (e) => (sent.push(e.kind), true), check });
  server = http.createServer(app.handler);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { app, base, sent };
}

describe('HTTP surface', () => {
  it('GET / answers ok for the platform health check, without a token', async () => {
    const { base } = await start(async () => ({ ok: true, attempts: 1 }));
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('ok');
  });

  it('/ping needs the token and leaks nothing without it', async () => {
    const { base, app } = await start(async () => ({ ok: true, attempts: 1 }));
    const bad: Record<string, string>[] = [{},{ 'x-cron-token': 'wrong' }, { 'x-cron-token': TOKEN.slice(0, -1) }, { authorization: `Bearer ${TOKEN}` }];
    for (const headers of bad) {
      const r = await fetch(`${base}/ping`, { headers });
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: 'unauthorized' });
    }
    expect(app.machine.state().lastCheckAt).toBeNull(); // no check was started by an unauthorised call
    expect((await fetch(`${base}/ping?token=${TOKEN}`)).status).toBe(401); // not accepted in the URL
  });

  it('only GET is allowed on /ping, and other paths are 404', async () => {
    const { base } = await start(async () => ({ ok: true, attempts: 1 }));
    expect((await fetch(`${base}/ping`, { method: 'POST', headers: { 'x-cron-token': TOKEN } })).status).toBe(405);
    expect((await fetch(`${base}/admin`)).status).toBe(404);
  });

  it('returns immediately while the check runs in the background', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { base, app } = await start(async () => (await gate, { ok: true, attempts: 1 }));
    const t0 = Date.now();
    const r = await fetch(`${base}/ping`, { headers: { 'x-cron-token': TOKEN } });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(await r.json()).toMatchObject({ phase: 'UP', checking: true, checkStarted: true });
    release();
    await app.idle();
    expect(app.machine.state().lastCheck).toEqual({ ok: true });
  });

  it('never runs two checks at once', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { base, app } = await start(async () => (calls++, await gate, { ok: true, attempts: 1 }));
    const h = { 'x-cron-token': TOKEN };
    await fetch(`${base}/ping`, { headers: h });
    const second = (await (await fetch(`${base}/ping`, { headers: h })).json()) as { checkStarted: boolean };
    expect(second.checkStarted).toBe(false);
    release();
    await app.idle();
    expect(calls).toBe(1);
  });

  it('a failed check sends the down email, and the next ping reports the state', async () => {
    const { base, app, sent } = await start(async () => ({ ok: false, kind: 'unreachable', detail: 'connection refused', attempts: 3 }));
    const h = { 'x-cron-token': TOKEN };
    await fetch(`${base}/ping`, { headers: h });
    await app.idle();
    expect(sent).toEqual(['down']);
    const state = await (await fetch(`${base}/ping`, { headers: h })).json();
    expect(state).toMatchObject({ phase: 'DOWN', emails: { down: true } });
    await app.idle();
    expect(sent).toEqual(['down']);
  });

  it('survives a check that throws', async () => {
    const { base, app } = await start(async () => {
      throw new Error('boom');
    });
    await fetch(`${base}/ping`, { headers: { 'x-cron-token': TOKEN } });
    await app.idle();
    expect((await fetch(`${base}/`)).status).toBe(200);
  });
});

describe('tokenMatches', () => {
  it('is exact', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN + 'x', TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
    expect(tokenMatches('', TOKEN)).toBe(false);
  });
});
