import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MailMessage, MailResult, Mailer } from '../src/alerts/mailer';
import { addUser, authed, login, makeApp, writeHeaders, type TestApp } from './helpers';

class Capture implements Mailer {
  sent: MailMessage[] = [];
  result: MailResult = { ok: true, id: 'm1' };
  async send(m: MailMessage): Promise<MailResult> {
    this.sent.push(m);
    return this.result;
  }
}

describe('alerts and services API', () => {
  let t: TestApp;
  let admin: string;
  let eng: string;
  let mailer: Capture;

  const req = (method: string, url: string, cookie: string | null, payload?: unknown) =>
    t.app.inject({
      method: method as 'GET',
      url: `/api/v1${url}`,
      headers: cookie ? authed(cookie) : writeHeaders(),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  beforeEach(async () => {
    mailer = new Capture();
    t = await makeApp({ overrides: { mailer }, config: { alertFrom: 'alerts@example.com' } });
    await addUser(t, { username: 'owner' });
    await addUser(t, { username: 'eng', role: 'engineer' });
    admin = (await login(t, 'owner')).cookie!;
    eng = (await login(t, 'eng')).cookie!;
  });
  afterEach(() => t.close());

  it('requires a session', async () => {
    expect((await req('GET', '/alerts/rules', null)).statusCode).toBe(401);
    expect((await req('GET', '/services', null)).statusCode).toBe(401);
  });

  describe('rules', () => {
    it('lists the 30 default rules (29 plus host.silent), every one of them implemented', async () => {
      const rules = (await req('GET', '/alerts/rules', eng)).json().rules as { key: string; implemented: boolean }[];
      expect(rules).toHaveLength(30);
      expect(rules.find((r) => r.key === 'host.disk_high')?.implemented).toBe(true);
      expect(rules.find((r) => r.key === 'nginx.5xx_rate')?.implemented).toBe(true);
      expect(rules.filter((r) => !r.implemented).map((r) => r.key)).toEqual([]);
    });

    it('lets only admins edit, validates, and audits', async () => {
      const rules = (await req('GET', '/alerts/rules', admin)).json().rules as { id: number; key: string }[];
      const disk = rules.find((r) => r.key === 'host.disk_high')!;
      const down = rules.find((r) => r.key === 'pm2.service_down')!;
      const mem = rules.find((r) => r.key === 'pm2.memory_high')!;

      expect((await req('PATCH', `/alerts/rules/${disk.id}`, eng, { threshold: 80 })).statusCode).toBe(403);
      const ok = await req('PATCH', `/alerts/rules/${disk.id}`, admin, { threshold: 80, durationS: 120 });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().rule).toMatchObject({ threshold: 80, durationS: 120 });

      expect((await req('PATCH', `/alerts/rules/${disk.id}`, admin, { threshold: -1 })).statusCode).toBe(400);
      expect((await req('PATCH', `/alerts/rules/${disk.id}`, admin, { bogus: 1 })).statusCode).toBe(400);
      expect((await req('PATCH', `/alerts/rules/${disk.id}`, admin, {})).statusCode).toBe(400);
      expect((await req('PATCH', `/alerts/rules/${down.id}`, admin, { threshold: 5 })).statusCode).toBe(400); // no threshold
      expect((await req('PATCH', `/alerts/rules/${disk.id}`, admin, { overrides: { api: 1 } })).statusCode).toBe(400); // not per service
      expect((await req('PATCH', `/alerts/rules/${mem.id}`, admin, { overrides: { api: 2e9 } })).json().rule.overrides).toEqual({ api: 2e9 });
      expect((await req('PATCH', '/alerts/rules/9999', admin, { enabled: false })).statusCode).toBe(404);

      const audit = (await req('GET', '/audit?event=alert_rule_changed', admin)).json().entries;
      expect(audit.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('mutes', () => {
    it('creates, lists and deletes (admin only) with audit entries and sane limits', async () => {
      const now = t.clock.t;
      expect((await req('POST', '/alerts/mutes', eng, { endsAt: now + 60_000, category: 'host' })).statusCode).toBe(403);
      expect((await req('POST', '/alerts/mutes', admin, { endsAt: now - 1 })).statusCode).toBe(400);
      expect((await req('POST', '/alerts/mutes', admin, { endsAt: now + 31 * 86_400_000 })).statusCode).toBe(400);
      expect((await req('POST', '/alerts/mutes', admin, { endsAt: now + 60_000, serviceId: 999 })).statusCode).toBe(400);
      expect((await req('POST', '/alerts/mutes', admin, { endsAt: now + 60_000, category: 'nope' })).statusCode).toBe(400);

      const c = await req('POST', '/alerts/mutes', admin, { endsAt: now + 3_600_000, category: 'host', reason: 'patching' });
      expect(c.statusCode).toBe(201);
      const id = c.json().mute.id;
      const list = (await req('GET', '/alerts/mutes', eng)).json().mutes;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ category: 'host', reason: 'patching', active: true });

      expect((await req('DELETE', `/alerts/mutes/${id}`, eng)).statusCode).toBe(403);
      expect((await req('DELETE', `/alerts/mutes/${id}`, admin)).statusCode).toBe(204);
      expect((await req('DELETE', `/alerts/mutes/${id}`, admin)).statusCode).toBe(404);
      const events = (await req('GET', '/audit', admin)).json().entries.map((e: { event: string }) => e.event);
      expect(events).toContain('alert_mute_created');
      expect(events).toContain('alert_mute_deleted');
    });
  });

  describe('subscriptions', () => {
    it('are per user and replace the previous set', async () => {
      expect((await req('GET', '/alerts/subscriptions/me', eng)).json().categories).toEqual([]);
      const put = await req('PUT', '/alerts/subscriptions/me', eng, { categories: ['pm2', 'host', 'pm2'] });
      expect(put.json().categories.sort()).toEqual(['host', 'pm2']);
      expect((await req('PUT', '/alerts/subscriptions/me', eng, { categories: ['bogus'] })).statusCode).toBe(400);
      expect((await req('PUT', '/alerts/subscriptions/me', eng, { categories: ['app'] })).json().categories).toEqual(['app']);
      expect((await req('GET', '/alerts/subscriptions/me', admin)).json().categories).toEqual([]);
    });
  });

  describe('status and test email', () => {
    it('shows configuration to admins and hides the details from others', async () => {
      const a = (await req('GET', '/alerts/status', admin)).json();
      expect(a.email.from).toBe('alerts@example.com');
      const e = (await req('GET', '/alerts/status', eng)).json();
      expect(e.email.from).toBeNull();
      expect(e.engine.openIncidents).toBe(0);
    });

    it('sends the test only to the calling admin and records it', async () => {
      const r = await req('POST', '/alerts/test-email', admin, { to: 'someone-else@example.com' });
      expect(r.json()).toEqual({ status: 'sent' });
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]!.to).toBe('owner@example.com');
      expect((await req('POST', '/alerts/test-email', eng)).statusCode).toBe(403);
      mailer.result = { ok: false, permanent: true, error: 'HTTP 403: domain not verified' };
      const f = await req('POST', '/alerts/test-email', admin);
      expect(f.json()).toEqual({ status: 'failed', error: 'HTTP 403: domain not verified' });
      const events = (await req('GET', '/audit?event=test_email_sent', admin)).json().entries;
      expect(events).toHaveLength(2);
    });

    it('rate limits the test email', async () => {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await req('POST', '/alerts/test-email', admin)).statusCode);
      expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('incidents', () => {
    it('lists, filters and hides delivery addresses from non-admins', async () => {
      const rule = t.ctx.alertRepo.listRules().find((r) => r.key === 'host.disk_high')!;
      const a = t.ctx.alertRepo.insertIncident({ ruleId: rule.id, serviceId: null, fingerprint: 'host.disk_high:C:', openedAt: t.clock.t, peak: 90, summary: 'Disk C: is 90% full' });
      t.ctx.alertRepo.insertIncident({ ruleId: rule.id, serviceId: null, fingerprint: 'host.disk_high:D:', openedAt: t.clock.t, peak: 91, summary: 'Disk D: is 91% full' });
      t.ctx.alertRepo.resolveIncident(a.id, t.clock.t + 1);
      t.ctx.alertRepo.insertNotification({ incident_id: a.id, kind: 'opened', to_email: 'owner@example.com', provider_msg_id: 'm', status: 'sent', attempts: 1, error: null, ts: t.clock.t });

      expect((await req('GET', '/alerts/incidents?state=firing', eng)).json().incidents).toHaveLength(1);
      expect((await req('GET', '/alerts/incidents', eng)).json().incidents).toHaveLength(2);
      expect((await req('GET', '/alerts/incidents?state=nope', eng)).statusCode).toBe(400);

      const asAdmin = (await req('GET', `/alerts/incidents/${a.id}`, admin)).json();
      expect(asAdmin.notifications[0].toEmail).toBe('owner@example.com');
      const asEng = (await req('GET', `/alerts/incidents/${a.id}`, eng)).json();
      expect(asEng.notifications).toEqual([]);
      expect((await req('GET', '/alerts/incidents/99999', eng)).statusCode).toBe(404);
    });
  });

  describe('services', () => {
    it('lists discovered services with their live state, shows detail, and edits as admin', async () => {
      const svc = t.ctx.services.discover('api');
      t.ctx.state.setProcesses(
        [{ serviceId: svc.id, name: svc.name, pm2Name: 'api', updatedAt: t.clock.t, status: 'online', instances: 1, instancesOnline: 1, cpuPct: 2, memBytes: 1000, restarts: 0, uptimeS: 5 }],
        t.clock.t,
      );
      const list = (await req('GET', '/services', eng)).json().services;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ pm2Name: 'api', process: { status: 'online' } });

      const d = (await req('GET', `/services/${svc.id}`, eng)).json();
      expect(d.series.ts).toHaveLength(1);
      expect(d.openIncidents).toBe(0);
      expect((await req('GET', '/services/12345', eng)).statusCode).toBe(404);

      expect((await req('PATCH', `/services/${svc.id}`, eng, { name: 'x' })).statusCode).toBe(403);
      const p = await req('PATCH', `/services/${svc.id}`, admin, { name: 'API', notes: 'main backend' });
      expect(p.json().service).toMatchObject({ name: 'API', notes: 'main backend' });
      expect((await req('PATCH', `/services/${svc.id}`, admin, { pm2Name: 'x' })).statusCode).toBe(400);
      expect((await req('PATCH', `/services/${svc.id}`, admin, { isArchived: true })).statusCode).toBe(409); // PM2 still runs it
      const events = (await req('GET', '/audit?event=service_updated', admin)).json().entries;
      expect(events).toHaveLength(1);
    });

    it('refuses a name another service already uses and archives a vanished service', async () => {
      const a = t.ctx.services.discover('api');
      const b = t.ctx.services.discover('worker');
      expect((await req('PATCH', `/services/${b.id}`, admin, { name: a.name.toUpperCase() })).statusCode).toBe(409);
      const r = await req('PATCH', `/services/${b.id}`, admin, { isArchived: true });
      expect(r.statusCode).toBe(200);
      expect((await req('GET', '/services', eng)).json().services).toHaveLength(1);
      expect((await req('GET', '/services?archived=1', eng)).json().services).toHaveLength(2);
    });
  });
});
