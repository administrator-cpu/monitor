import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitStatusDto, OverviewSummary } from '@cc/shared';
import { addUser, authed, login, makeApp, type TestApp } from './helpers';

const DAY = 86_400_000;
let t: TestApp;
let cookie: string;

beforeEach(async () => {
  t = await makeApp({ config: { backupDir: 'E:\\monitor-backups', resendWebhookSecret: 'whsec_test_secret_123' } });
  await addUser(t);
  cookie = (await login(t)).cookie!;
});
afterEach(async () => t.close());

const summary = async (c = cookie) => t.app.inject({ method: 'GET', url: '/api/v1/overview/summary', headers: authed(c) });

function ruleId(key: string): number {
  return (t.db.prepare('SELECT id FROM alert_rules WHERE key = ?').get(key) as { id: number }).id;
}
function incident(key: string, openedAt: number, state: 'firing' | 'resolved' = 'firing', serviceId: number | null = null) {
  t.db
    .prepare('INSERT INTO alert_incidents (rule_id, service_id, fingerprint, state, opened_at, summary) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ruleId(key), serviceId, `${key}:${openedAt}`, state, openedAt, `${key} summary`);
}
function mapGit(pm2: string, g: Partial<GitStatusDto> | null) {
  const svc = t.ctx.services.discover(pm2);
  t.db.prepare("UPDATE services SET git_repo = 'owner/repo' WHERE id = ?").run(svc.id);
  t.ctx.services.reload();
  if (g) {
    const data = { serviceId: svc.id, state: 'ok', sync: 'in_sync', behindBy: 0, dirty: false, ...g };
    t.db.prepare('INSERT INTO service_git (service_id, checked_at, state, data) VALUES (?, ?, ?, ?)').run(svc.id, t.clock.t, data.state, JSON.stringify(data));
  }
  return svc.id;
}

describe('GET /overview/summary', () => {
  it('needs a login', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/overview/summary' })).statusCode).toBe(401);
  });

  it('is empty but complete on a fresh install', async () => {
    const res = await summary();
    expect(res.statusCode).toBe(200);
    const s = res.json() as OverviewSummary;
    expect(s.alerts).toEqual({ critical: 0, warning: 0, info: 0, newest: [] });
    expect(s.backup).toEqual({ enabled: true, lastRunAt: null, status: null, file: null, bytes: null, error: null });
    expect(s.tls).toEqual({ hosts: 0, errors: 0, soonest: null });
    expect(s.github).toEqual({ tokenSet: false, mapped: 0, inSync: 0, behind: [], problems: 0 });
    expect(s.email).toMatchObject({ webhookConfigured: true, sent: 0, delivered: 0, bounced: 0, lastEventAt: null, since: t.clock.t - DAY });
  });

  it('counts firing alerts by severity and lists the newest five, not resolved ones', async () => {
    const sev = (key: string) => (t.db.prepare('SELECT severity FROM alert_rules WHERE key = ?').get(key) as { severity: string }).severity;
    const keys = ['pm2.service_down', 'host.cpu_high', 'host.mem_high', 'host.disk_high', 'host.disk_critical', 'host.pending_reboot'];
    keys.forEach((k, i) => incident(k, t.clock.t - (i + 1) * 60_000));
    incident('pm2.crash_loop', t.clock.t, 'resolved');
    const s = (await summary()).json() as OverviewSummary;
    const expected = { critical: 0, warning: 0, info: 0 } as Record<string, number>;
    for (const k of keys) expected[sev(k)]! += 1;
    expect({ critical: s.alerts.critical, warning: s.alerts.warning, info: s.alerts.info }).toEqual(expected);
    expect(s.alerts.newest.map((i) => i.ruleKey)).toEqual(keys.slice(0, 5));
    expect(s.alerts.newest[0]).toMatchObject({ state: 'firing', summary: 'pm2.service_down summary' });
  });

  it('reports the last backup run, ok or failed', async () => {
    const put = (status: string, detail: unknown) =>
      t.db
        .prepare(
          `INSERT INTO maintenance_runs (job, last_run_at, last_status, last_detail) VALUES ('backup', ?, ?, ?)
           ON CONFLICT(job) DO UPDATE SET last_run_at = excluded.last_run_at, last_status = excluded.last_status, last_detail = excluded.last_detail`,
        )
        .run(t.clock.t - 1000, status, JSON.stringify(detail));
    put('ok', { file: 'monitor-20271015.db', bytes: 27_000_000, ms: 900, removed: [] });
    expect(((await summary()).json() as OverviewSummary).backup).toEqual({
      enabled: true, lastRunAt: t.clock.t - 1000, status: 'ok', file: 'monitor-20271015.db', bytes: 27_000_000, error: null,
    });
    put('error', { file: 'monitor-20271016.db', error: 'disk full' });
    expect(((await summary()).json() as OverviewSummary).backup).toMatchObject({ status: 'error', file: 'monitor-20271016.db', bytes: null, error: 'disk full' });
  });

  it('says when backups are switched off', async () => {
    await t.close();
    t = await makeApp({ config: { backupDir: null } });
    await addUser(t);
    cookie = (await login(t)).cookie!;
    expect(((await summary()).json() as OverviewSummary).backup.enabled).toBe(false);
  });

  it('picks the certificate that expires first and counts failed checks', async () => {
    t.ctx.state.setTlsCerts([
      { host: 'a.example', notAfter: t.clock.t + 60 * DAY, issuer: 'R11', checkedAt: t.clock.t, lastError: null },
      { host: 'b.example', notAfter: t.clock.t + 9 * DAY + 1000, issuer: 'R11', checkedAt: t.clock.t, lastError: null },
      { host: 'c.example', notAfter: null, issuer: null, checkedAt: t.clock.t, lastError: 'timeout' },
    ]);
    const s = (await summary()).json() as OverviewSummary;
    expect(s.tls).toEqual({ hosts: 3, errors: 1, soonest: { host: 'b.example', notAfter: t.clock.t + 9 * DAY + 1000, daysLeft: 9 } });
  });

  it('sorts GitHub into in sync, behind and problems', async () => {
    mapGit('shop', { sync: 'in_sync' });
    const api = mapGit('api', { sync: 'behind', behindBy: 3 });
    mapGit('worker', { state: 'token_rejected', sync: 'unknown' });
    mapGit('fresh', null); // mapped, never checked
    t.ctx.services.discover('unmapped');
    const s = (await summary()).json() as OverviewSummary;
    expect(s.github).toEqual({ tokenSet: false, mapped: 4, inSync: 1, behind: [{ serviceId: api, name: 'api', behindBy: 3 }], problems: 2 });
  });

  it('adds up Resend events of the last 24 hours across sender domains', async () => {
    const at = t.clock.t - 3_600_000;
    t.ctx.email.record('m1', 'sent', 'a.example', '', at);
    t.ctx.email.record('m2', 'delivered', 'a.example', '', at);
    t.ctx.email.record('m3', 'sent', 'b.example', '', at);
    t.ctx.email.record('m4', 'bounced', 'b.example', 'Permanent', at);
    t.ctx.email.record('old', 'sent', 'a.example', '', t.clock.t - 2 * DAY);
    const s = (await summary()).json() as OverviewSummary;
    expect(s.email).toMatchObject({ sent: 2, delivered: 1, bounced: 1, complained: 0, failed: 0 });
    expect(s.email.lastEventAt).toBe(t.clock.t);
  });
});

describe('the live message carries the monitor itself', () => {
  it('has the health snapshot', async () => {
    const live = t.ctx.hub.buildLive();
    expect(live.monitor).toMatchObject({ pid: process.pid });
    expect(live.monitor?.runsAs.kind).toMatch(/^(pm2|service|direct)$/);
  });
});
