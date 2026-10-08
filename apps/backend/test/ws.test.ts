import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { WS_CLOSE } from '@cc/shared';
import { addUser, GOOD_PASSWORD, login, makeApp, ORIGIN, type TestApp } from './helpers';

let t: TestApp;
let base: string;
beforeEach(async () => {
  t = await makeApp();
  await addUser(t);
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  base = `ws://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/api/v1/ws`;
});
afterEach(async () => {
  await t.close();
});

function open(
  headers: Record<string, string>,
): Promise<{ ws: WebSocket; closed: Promise<number>; messages: any[] }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(base, { headers });
    const messages: any[] = [];
    const closed = new Promise<number>((res) => ws.on('close', (code) => res(code)));
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, closed, messages }));
    ws.on('error', () => resolve({ ws, closed, messages }));
  });
}

const waitFor = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('websocket', () => {
  it('closes with 4401 when there is no session cookie', async () => {
    const c = await open({ origin: ORIGIN });
    expect(await c.closed).toBe(WS_CLOSE.UNAUTHENTICATED);
  });

  it('closes with 4403 for an Origin that is not allowlisted', async () => {
    const { cookie } = await login(t);
    const c = await open({ origin: 'https://evil.example', cookie: `cc_session=${cookie}` });
    expect(await c.closed).toBe(WS_CLOSE.ORIGIN_NOT_ALLOWED);
  });

  it('closes with 4403 when no Origin is sent at all', async () => {
    const { cookie } = await login(t);
    const c = await open({ cookie: `cc_session=${cookie}` });
    expect(await c.closed).toBe(WS_CLOSE.ORIGIN_NOT_ALLOWED);
  });

  it('streams a live snapshot after subscribe, and answers ping', async () => {
    t.ctx.state.setCpuMem({
      at: Date.now(),
      cpuPct: 12,
      cpuPerCore: [10, 14],
      memUsedBytes: 1,
      memTotalBytes: 2,
      swapUsedBytes: 0,
      swapTotalBytes: 0,
      netRxBps: 0,
      netTxBps: 0,
    });
    const { cookie } = await login(t);
    const c = await open({ origin: ORIGIN, cookie: `cc_session=${cookie}` });
    c.ws.send(JSON.stringify({ type: 'subscribe', channel: 'live' }));
    await waitFor(() => c.messages.some((m) => m.type === 'live'));
    const live = c.messages.find((m) => m.type === 'live');
    expect(live.host.cpuPct).toBe(12);
    expect(live.services).toEqual([]);
    expect(Array.isArray(live.collectors)).toBe(true);

    c.ws.send(JSON.stringify({ type: 'ping' }));
    await waitFor(() => c.messages.some((m) => m.type === 'pong'));
    c.ws.close();
  });

  it('rejects malformed client messages without closing', async () => {
    const { cookie } = await login(t);
    const c = await open({ origin: ORIGIN, cookie: `cc_session=${cookie}` });
    c.ws.send('not json');
    c.ws.send(JSON.stringify({ type: 'nonsense' }));
    await waitFor(() => c.messages.filter((m) => m.type === 'error').length === 2);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  it('allows at most 5 connections per user (4429)', async () => {
    const { cookie } = await login(t);
    const headers = { origin: ORIGIN, cookie: `cc_session=${cookie}` };
    const open5 = [];
    for (let i = 0; i < 5; i++) open5.push(await open(headers));
    await waitFor(() => t.ctx.hub.size === 5);
    const sixth = await open(headers);
    expect(await sixth.closed).toBe(WS_CLOSE.TOO_MANY_CONNECTIONS);
    open5.forEach((c) => c.ws.close());
  });

  it('closes sockets when an admin revokes the sessions', async () => {
    const { cookie } = await login(t);
    const c = await open({ origin: ORIGIN, cookie: `cc_session=${cookie}` });
    await waitFor(() => t.ctx.hub.size === 1);
    const me = t.ctx.users.getByUsername('owner')!;
    t.ctx.sessions.revokeAllForUser(me.id);
    t.ctx.hub.closeUser(me.id);
    expect(await c.closed).toBe(WS_CLOSE.UNAUTHENTICATED);
  });

  it('re-checks the session every 60 s and closes a revoked one', async () => {
    const { cookie } = await login(t);
    const c = await open({ origin: ORIGIN, cookie: `cc_session=${cookie}` });
    await waitFor(() => t.ctx.hub.size === 1);
    t.ctx.sessions.revokeAllForUser(t.ctx.users.getByUsername('owner')!.id);
    // Advance in two steps so the client's automatic pong keeps it alive between them.
    t.clock.t += 31_000;
    t.ctx.hub.housekeeping(); // sends a ping, too early for the re-check
    await new Promise((r) => setTimeout(r, 100));
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    t.clock.t += 31_000;
    t.ctx.hub.housekeeping(); // 62 s since attach: session re-check runs
    expect(await c.closed).toBe(WS_CLOSE.UNAUTHENTICATED);
  });

  it('refuses sockets for accounts that must change their password', async () => {
    await addUser(t, { username: 'newbie', mustChange: true });
    const { cookie } = await login(t, 'newbie', GOOD_PASSWORD);
    const c = await open({ origin: ORIGIN, cookie: `cc_session=${cookie}` });
    expect(await c.closed).toBe(WS_CLOSE.UNAUTHENTICATED);
  });
});
