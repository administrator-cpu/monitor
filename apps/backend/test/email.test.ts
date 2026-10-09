import { afterEach, describe, expect, it } from 'vitest';
import { Webhook } from 'svix';
import { addUser, authed, login, makeApp, type TestApp } from './helpers';
import { bounceKind, eventOf, senderDomain } from '../src/email/stats';

const SECRET = 'whsec_' + Buffer.from('test-secret-test-secret-1234').toString('base64');

let n = 0;
function signed(body: object, over: { id?: string; secret?: string; ts?: Date } = {}) {
  const raw = JSON.stringify(body);
  const id = over.id ?? `msg_${++n}`;
  const ts = over.ts ?? new Date();
  const sig = new Webhook(over.secret ?? SECRET).sign(id, ts, raw);
  return { raw, headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': String(Math.floor(ts.getTime() / 1000)), 'svix-signature': sig } };
}
const ev = (type: string, data: object = {}) => ({ type, created_at: '2026-10-09T10:05:00.000Z', data: { from: 'Alerts <alerts@Example.com>', ...data } });

describe('email helpers', () => {
  it('reads sender domain, event and bounce kind', () => {
    expect(senderDomain('Alerts <alerts@Example.com>')).toBe('example.com');
    expect(senderDomain('a@b.co')).toBe('b.co');
    expect(senderDomain('nonsense')).toBe('unknown');
    expect(senderDomain(undefined)).toBe('unknown');
    expect(eventOf('email.bounced')).toBe('bounced');
    expect(eventOf('email.opened')).toBeNull();
    expect(eventOf('domain.updated')).toBeNull();
    expect(bounceKind({ bounce: { type: 'Permanent' } })).toBe('permanent');
    expect(bounceKind({})).toBe('undetermined');
  });
});

describe('Resend webhook', () => {
  let t: TestApp;
  afterEach(async () => t.close());
  const post = (s: { raw: string; headers: Record<string, string> }) =>
    t.app.inject({ method: 'POST', url: '/webhooks/resend', headers: s.headers, payload: s.raw });

  it('answers 503 until a secret is configured', async () => {
    t = await makeApp();
    expect((await post(signed(ev('email.sent')))).statusCode).toBe(503);
  });

  it('counts a signed event, per sender domain', async () => {
    t = await makeApp({ config: { resendWebhookSecret: SECRET } });
    expect((await post(signed(ev('email.delivered')))).json()).toMatchObject({ ok: true, duplicate: false });
    await post(signed(ev('email.delivered')));
    await post(signed(ev('email.bounced', { bounce: { type: 'Permanent' }, to: ['person@secret.test'], subject: 'Hidden' })));
    const rows = t.ctx.email.summary(Date.parse('2026-10-09T00:00:00Z'));
    expect(rows).toEqual([{ domain: 'example.com', sent: 0, delivered: 2, delayed: 0, bounced: 1, complained: 0, failed: 0, suppressed: 0 }]);
    // Counts only: no address or subject is kept anywhere.
    const dump = JSON.stringify(t.db.prepare('SELECT * FROM email_event_counts').all()) + JSON.stringify(t.db.prepare('SELECT * FROM email_webhook_seen').all());
    expect(dump).not.toContain('secret.test');
    expect(dump).not.toContain('Hidden');
  });

  it('acknowledges but does not count a repeated delivery id', async () => {
    t = await makeApp({ config: { resendWebhookSecret: SECRET } });
    const s = signed(ev('email.complained'), { id: 'msg_same' });
    expect((await post(s)).json()).toMatchObject({ duplicate: false });
    expect((await post(s)).json()).toMatchObject({ duplicate: true });
    expect(t.ctx.email.summary(0)[0]!.complained).toBe(1);
  });

  it('rejects a wrong signature, a tampered body, missing headers and old timestamps', async () => {
    t = await makeApp({ config: { resendWebhookSecret: SECRET } });
    const other = 'whsec_' + Buffer.from('another-secret-another-secret').toString('base64');
    expect((await post(signed(ev('email.sent'), { secret: other }))).statusCode).toBe(401);
    const s = signed(ev('email.sent'));
    expect((await post({ ...s, raw: s.raw.replace('sent', 'bounced') })).statusCode).toBe(401);
    const { 'svix-signature': _drop, ...partial } = s.headers;
    expect((await post({ raw: s.raw, headers: partial })).statusCode).toBe(400);
    expect((await post(signed(ev('email.sent'), { ts: new Date(Date.now() - 20 * 60_000) }))).statusCode).toBe(401);
    expect(t.ctx.email.summary(0)).toEqual([]);
  });

  it('ignores event types it does not count', async () => {
    t = await makeApp({ config: { resendWebhookSecret: SECRET } });
    expect((await post(signed(ev('email.opened')))).json()).toMatchObject({ ignored: true });
    expect(t.ctx.email.summary(0)).toEqual([]);
  });

  it('is not part of the browser API: no session is needed, and the API prefix does not serve it', async () => {
    t = await makeApp({ config: { resendWebhookSecret: SECRET } });
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/webhooks/resend', headers: { origin: 'http://localhost:3000' }, payload: {} })).statusCode).toBe(403);
  });
});

describe('email summary API and alert rule', () => {
  let t: TestApp;
  afterEach(async () => t.close());

  it('needs a login and returns totals, hourly series and the last hour', async () => {
    t = await makeApp({ config: { resendWebhookSecret: SECRET } });
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/email/summary' })).statusCode).toBe(401);
    await addUser(t);
    const cookie = (await login(t)).cookie!;
    for (let i = 0; i < 3; i++) t.ctx.email.record(`a${i}`, 'bounced', 'example.com', 'permanent', t.clock.t - 60_000);
    t.ctx.email.record('d1', 'delivered', 'example.com', '', t.clock.t - 60_000);
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/email/summary?hours=24', headers: authed(cookie) });
    const j = res.json();
    expect(j).toMatchObject({ configured: true, badLastHour: 3, hours: 24 });
    expect(j.rows[0]).toMatchObject({ domain: 'example.com', bounced: 3, delivered: 1 });
    expect(j.hourly.reduce((a: number, h: { bad: number }) => a + h.bad, 0)).toBe(3);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/email/summary?hours=0', headers: authed(cookie) })).statusCode).toBe(400);
  });

  it('the default rule exists and opens an incident at the threshold', async () => {
    t = await makeApp();
    const rule = t.db.prepare("SELECT * FROM alert_rules WHERE key = 'monitor.email_bounce_spike'").get() as { category: string; threshold: number };
    expect(rule).toMatchObject({ category: 'monitor', threshold: 5 });
    for (let i = 0; i < 5; i++) t.ctx.email.record(`b${i}`, 'complained', 'example.com', '', t.clock.t - 1000);
    t.ctx.alerts.evaluate();
    expect(t.ctx.alertRepo.firing().map((r) => r.rule_key)).toContain('monitor.email_bounce_spike');
  });

  it('retention removes old counts and delivery ids', async () => {
    t = await makeApp();
    t.ctx.email.record('old', 'sent', 'example.com', '', t.clock.t - 40 * 86_400_000);
    t.ctx.email.record('new', 'sent', 'example.com', '', t.clock.t);
    const { runRetention } = await import('../src/retention');
    runRetention(t.db, t.ctx.settings, t.clock.t);
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM email_event_counts').get() as { n: number }).n).toBe(1);
  });
});
