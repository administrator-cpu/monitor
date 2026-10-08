import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { addUser, login, makeApp, ORIGIN, type TestApp } from './helpers';

let t: TestApp;
let base: string;
let cookie: string;

beforeEach(async () => {
  t = await makeApp();
  await addUser(t);
  cookie = (await login(t)).cookie!;
  t.ctx.hub.start();
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  base = `ws://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/api/v1/ws`;
  for (const n of ['api', 'w1', 'w2', 'w3', 'w4', 'w5']) t.ctx.services.discover(n);
});
afterEach(async () => {
  await t.ctx.logs.writer.stop();
  await t.close();
});

function open(): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(base, { headers: { origin: ORIGIN, cookie: `cc_session=${cookie}` } });
    const messages: any[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, messages }));
  });
}
const waitFor = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const sub = (ws: WebSocket, service: string, extra = {}) =>
  ws.send(JSON.stringify({ type: 'subscribe', channel: 'logs', service, ...extra }));

describe('log tail over WebSocket', () => {
  it('sends the backfill first and then new lines in batches', async () => {
    for (let i = 0; i < 5; i++) t.ctx.logs.pipeline.ingest('api', 0, 'out', `old ${i}`);
    const c = await open();
    sub(c.ws, 'api', { backfill: 3 });
    await waitFor(() => c.messages.some((m) => m.type === 'log_batch'));
    const first = c.messages.filter((m) => m.type === 'log_batch').flatMap((m) => m.lines.map((l: any) => l.msg));
    expect(first).toEqual(['old 2', 'old 3', 'old 4']);

    t.ctx.logs.pipeline.ingest('api', 0, 'err', 'fresh');
    await waitFor(() => c.messages.some((m) => m.type === 'log_batch' && m.lines.some((l: any) => l.msg === 'fresh')));
    c.ws.close();
  });

  it('filters by stream', async () => {
    const c = await open();
    sub(c.ws, 'api', { stream: 'err' });
    await waitFor(() => c.messages.length > 0);
    t.ctx.logs.pipeline.ingest('api', 0, 'out', 'noise');
    t.ctx.logs.pipeline.ingest('api', 0, 'err', 'problem');
    await waitFor(() => c.messages.some((m) => m.lines?.some((l: any) => l.msg === 'problem')));
    expect(c.messages.some((m) => m.lines?.some((l: any) => l.msg === 'noise'))).toBe(false);
    c.ws.close();
  });

  it('rejects unknown services and limits one connection to 5 subscriptions', async () => {
    const c = await open();
    sub(c.ws, 'nope');
    await waitFor(() => c.messages.some((m) => m.type === 'error'));
    expect(c.messages.find((m) => m.type === 'error').code).toBe('unknown_service');

    for (const s of ['api', 'w1', 'w2', 'w3', 'w4']) sub(c.ws, s);
    sub(c.ws, 'w5');
    await waitFor(() => c.messages.some((m) => m.code === 'subscription_limit'));
    // re-subscribing to one that exists replaces it and is not counted twice
    sub(c.ws, 'api', { stream: 'err' });
    await new Promise((r) => setTimeout(r, 100));
    expect(c.messages.filter((m) => m.code === 'subscription_limit')).toHaveLength(1);
    c.ws.close();
  });

  it('stops delivery after unsubscribe and when the socket closes', async () => {
    const c = await open();
    sub(c.ws, 'api');
    await waitFor(() => c.messages.length > 0);
    c.ws.send(JSON.stringify({ type: 'unsubscribe', channel: 'logs', service: 'api' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(t.ctx.logs.pipeline.subscriberCount()).toBe(0);
    sub(c.ws, 'api');
    await new Promise((r) => setTimeout(r, 100));
    expect(t.ctx.logs.pipeline.subscriberCount()).toBe(1);
    c.ws.close();
    await waitFor(() => t.ctx.logs.pipeline.subscriberCount() === 0);
  });

  it('audits opening a tail once per user and service within 5 minutes', async () => {
    const c = await open();
    sub(c.ws, 'api');
    sub(c.ws, 'api', { stream: 'err' });
    sub(c.ws, 'w1');
    await new Promise((r) => setTimeout(r, 150));
    let entries = t.ctx.audit.list({ event: 'log_tail_opened', limit: 50 } as never);
    expect(entries).toHaveLength(2);
    t.clock.t += 6 * 60_000;
    sub(c.ws, 'api');
    await new Promise((r) => setTimeout(r, 150));
    entries = t.ctx.audit.list({ event: 'log_tail_opened', limit: 50 } as never);
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.username === 'owner')).toBe(true);
    c.ws.close();
  });

  it('a slow reader loses old lines but is told how many', async () => {
    const c = await open();
    sub(c.ws, 'api', { backfill: 0 });
    await waitFor(() => c.messages.length > 0);
    // Far more than the 2,000-line queue arrive within one flush interval.
    for (let i = 0; i < 6000; i++) t.ctx.logs.pipeline.ingest('api', 0, 'out', `l${i}`);
    await waitFor(() => c.messages.some((m) => m.type === 'log_batch' && m.dropped > 0));
    const dropped = c.messages.filter((m) => m.type === 'log_batch').reduce((n, m) => n + m.dropped, 0);
    expect(dropped).toBe(4000);
    c.ws.close();
  });
});

describe('alert events over WebSocket', () => {
  it('broadcasts opened and resolved incidents to live subscribers', async () => {
    const c = await open();
    c.ws.send(JSON.stringify({ type: 'subscribe', channel: 'live' }));
    await waitFor(() => c.messages.some((m) => m.type === 'live'));
    const rule = t.ctx.alertRepo.listRules().find((r) => r.key === 'host.cpu_high')!;
    t.ctx.alertRepo.updateRule(rule.id, { durationS: 0 }, null);
    t.ctx.state.setCpuMem({ at: t.clock.t, cpuPct: 99, cpuPerCore: [99], memUsedBytes: 1, memTotalBytes: 100, swapUsedBytes: 0, swapTotalBytes: 0, netRxBps: 0, netTxBps: 0 });
    t.ctx.alerts.evaluate();
    await waitFor(() => c.messages.some((m) => m.type === 'event' && m.kind === 'alert_opened'));
    const ev = c.messages.find((m) => m.kind === 'alert_opened');
    expect(ev.incident).toMatchObject({ ruleKey: 'host.cpu_high', state: 'firing' });
    expect(t.ctx.alerts.openCount()).toBe(1);
    c.ws.close();
  });
});
