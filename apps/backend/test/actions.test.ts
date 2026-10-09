import { afterEach, describe, expect, it } from 'vitest';
import type { Pm2Handlers, Pm2Proc, Pm2Source } from '../src/pm2/types';
import { addUser, authed, login, makeApp, type TestApp } from './helpers';

const proc = (over: Partial<Pm2Proc> = {}): Pm2Proc => ({
  name: 'shop',
  pmId: 3,
  status: 'online',
  restarts: 0,
  pmUptime: 1,
  cpu: 0,
  memory: 0,
  isModule: false,
  ...over,
});

class FakePm2 implements Pm2Source {
  procs: Pm2Proc[] = [proc(), proc({ name: 'monitor-api', pmId: 0 }), proc({ name: 'pm2-logrotate', pmId: 9, isModule: true })];
  calls: { action: string; pmId: unknown }[] = [];
  failAct = false;
  /** When true the command is accepted but the state never changes. */
  frozen = false;
  async connect() {}
  async list() {
    return this.procs.map((p) => ({ ...p }));
  }
  async act(action: 'restart' | 'stop', pmId: number) {
    this.calls.push({ action, pmId });
    if (this.failAct) throw new Error('boom');
    if (this.frozen) return;
    for (const p of this.procs) if (p.pmId === pmId) p.status = action === 'stop' ? 'stopped' : 'online';
  }
  async startBus(_h: Pm2Handlers) {}
  async stopBus() {}
  async dispose() {}
}

describe('service actions', () => {
  let t: TestApp;
  let pm2: FakePm2;
  afterEach(async () => t.close());

  async function setup(actions: Record<string, unknown> = {}) {
    pm2 = new FakePm2();
    t = await makeApp({
      config: { pm2Enabled: true },
      overrides: { pm2Source: () => pm2, actions: { verifyMs: 300, pollMs: 10, cooldownMs: 0, ownPmId: () => 0, ...actions } },
    });
    await addUser(t);
    await addUser(t, { username: 'eng', role: 'engineer' });
    await addUser(t, { username: 'op', role: 'engineer' });
    t.db.prepare("UPDATE users SET can_operate = 1 WHERE username = 'op'").run();
    const admin = (await login(t)).cookie!;
    const eng = (await login(t, 'eng')).cookie!;
    const op = (await login(t, 'op')).cookie!;
    const shop = t.ctx.services.discover('shop');
    const self = t.ctx.services.discover('monitor-api');
    const mod = t.ctx.services.discover('pm2-logrotate');
    return { admin, eng, op, shop: shop.id, self: self.id, mod: mod.id };
  }
  const act = (cookie: string, id: number, action: unknown) =>
    t.app.inject({ method: 'POST', url: `/api/v1/services/${id}/actions`, headers: authed(cookie), payload: { action } });
  const events = () =>
    t.db.prepare("SELECT event, username, detail FROM audit_log WHERE event IN ('service_action','service_action_failed') ORDER BY id").all() as { event: string; username: string; detail: string }[];

  it('who may act: admins always, engineers only when allowed, nobody without a login', async () => {
    const s = await setup();
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/services/${s.shop}/actions`, headers: { origin: 'http://localhost:3000', 'x-monitor-client': 'web' }, payload: { action: 'restart' } })).statusCode).toBe(401);
    expect((await act(s.eng, s.shop, 'restart')).statusCode).toBe(403);
    expect(pm2.calls).toHaveLength(0);
    expect((await act(s.op, s.shop, 'restart')).statusCode).toBe(200);
    expect((await act(s.admin, s.shop, 'restart')).statusCode).toBe(200);
    const me = (await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authed(s.op) })).json();
    expect(me.user.canOperate).toBe(true);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authed(s.eng) })).json().user.canOperate).toBe(false);
  });

  it('an admin switches the permission on and off for an engineer', async () => {
    const s = await setup();
    const eng = t.ctx.users.getByUsername('eng')!;
    const res = await t.app.inject({ method: 'PATCH', url: `/api/v1/users/${eng.id}`, headers: authed(s.admin), payload: { canOperate: true } });
    expect(res.json().user.canOperate).toBe(true);
    expect((await act(s.eng, s.shop, 'restart')).statusCode).toBe(200);
  });

  it('accepts only the three words, and never uses text from the request as a PM2 target', async () => {
    const s = await setup();
    for (const bad of ['delete', 'kill', 'all', '', 'restart --update-env', 3]) expect((await act(s.admin, s.shop, bad)).statusCode).toBe(400);
    const extra = await t.app.inject({ method: 'POST', url: `/api/v1/services/${s.shop}/actions`, headers: authed(s.admin), payload: { action: 'restart', name: 'monitor-api' } });
    expect(extra.statusCode).toBe(400);
    expect(pm2.calls).toHaveLength(0);
    expect((await act(s.admin, 99999, 'restart')).statusCode).toBe(404);
    await act(s.admin, s.shop, 'restart');
    expect(pm2.calls).toEqual([{ action: 'restart', pmId: 3 }]); // a number, resolved on the server
  });

  it('never acts on the monitor itself or on a PM2 module', async () => {
    const s = await setup();
    const self = await act(s.admin, s.self, 'restart');
    expect(self.statusCode).toBe(409);
    expect(self.json().error).toBe('not_operable');
    expect((await act(s.admin, s.mod, 'stop')).statusCode).toBe(409);
    expect(pm2.calls).toHaveLength(0);
    // Also when the app runs under another name but with the monitor's own PM2 id.
    pm2.procs.push(proc({ name: 'shop2', pmId: 0 }));
    const s2 = t.ctx.services.discover('shop2');
    expect((await act(s.admin, s2.id, 'restart')).statusCode).toBe(409);
    expect(pm2.calls).toHaveLength(0);
  });

  it('restart works from any state and confirms the new state', async () => {
    const s = await setup();
    pm2.procs[0]!.status = 'errored';
    expect((await act(s.admin, s.shop, 'restart')).json()).toMatchObject({ ok: true, action: 'restart', status: 'online', verified: true, mutedMinutes: 0 });
  });

  it('start only on a stopped service, stop only on a running one', async () => {
    const s = await setup();
    expect((await act(s.admin, s.shop, 'start')).json().error).toBe('already_running');
    expect((await act(s.admin, s.shop, 'stop')).json()).toMatchObject({ status: 'stopped', verified: true });
    expect((await act(s.admin, s.shop, 'stop')).json().error).toBe('already_stopped');
    expect((await act(s.admin, s.shop, 'start')).json()).toMatchObject({ status: 'online', verified: true });
    expect(pm2.calls.map((c) => c.action)).toEqual(['stop', 'restart']);
  });

  it('start leaves a running instance of a multi-instance service alone', async () => {
    const s = await setup();
    pm2.procs = [proc({ pmId: 3 }), proc({ pmId: 4, status: 'stopped' })];
    await act(s.admin, s.shop, 'start');
    expect(pm2.calls).toEqual([{ action: 'restart', pmId: 4 }]);
  });

  it('Stop mutes that service\'s "service down" alert for the set time; starting lifts it', async () => {
    const s = await setup();
    const r = (await act(s.admin, s.shop, 'stop')).json();
    expect(r.mutedMinutes).toBe(30);
    const rule = t.ctx.alertRepo.listRules().find((x) => x.key === 'pm2.service_down')!;
    let mutes = t.ctx.alertRepo.activeMutes(t.clock.t + 1000);
    expect(mutes).toHaveLength(1);
    expect(mutes[0]).toMatchObject({ service_id: s.shop, rule_id: rule.id, ends_at: t.clock.t + 30 * 60_000 });
    await act(s.admin, s.shop, 'start');
    mutes = t.ctx.alertRepo.activeMutes(t.clock.t + 1000);
    expect(mutes).toHaveLength(0);
  });

  it('the stop mute can be switched off with the setting', async () => {
    const s = await setup();
    expect((await t.app.inject({ method: 'PATCH', url: '/api/v1/settings', headers: authed(s.admin), payload: { 'actions.stop_mute_minutes': 0 } })).statusCode).toBe(200);
    expect((await act(s.admin, s.shop, 'stop')).json().mutedMinutes).toBe(0);
    expect(t.ctx.alertRepo.activeMutes(t.clock.t + 1000)).toHaveLength(0);
  });

  it('says so when PM2 accepted the command but the state did not change in time', async () => {
    const s = await setup();
    pm2.frozen = true;
    const r = await act(s.admin, s.shop, 'stop');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ verified: false, status: 'online' });
  });

  it('reports a PM2 failure without changing anything else, and audits it', async () => {
    const s = await setup();
    pm2.failAct = true;
    const r = await act(s.admin, s.shop, 'restart');
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toBe('pm2_failed');
    expect(events().at(-1)).toMatchObject({ event: 'service_action_failed' });
  });

  it('one action at a time per service, and a short wait between actions', async () => {
    const s = await setup({ cooldownMs: 10_000 });
    const slow = pm2.act.bind(pm2);
    pm2.act = async (a, id) => {
      await new Promise((r) => setTimeout(r, 80));
      return slow(a, id);
    };
    const [a, b] = await Promise.all([act(s.admin, s.shop, 'restart'), act(s.admin, s.shop, 'restart')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect((await act(s.admin, s.shop, 'restart')).json().error).toBe('cooldown');
    t.clock.t += 11_000;
    expect((await act(s.admin, s.shop, 'restart')).statusCode).toBe(200);
  });

  it('every action is attributed to a person in the audit log', async () => {
    const s = await setup();
    await act(s.op, s.shop, 'restart');
    await act(s.admin, s.shop, 'stop');
    await act(s.admin, s.self, 'restart');
    const e = events();
    expect(e.map((x) => [x.event, x.username])).toEqual([
      ['service_action', 'op'],
      ['service_action', 'owner'],
      ['service_action_failed', 'owner'],
    ]);
    expect(JSON.parse(e[0]!.detail)).toMatchObject({ pm2Name: 'shop', action: 'restart', before: 'online', after: 'online', verified: true });
  });

  it('the detail page says whether a service can be operated at all', async () => {
    const s = await setup();
    const d = async (id: number) => (await t.app.inject({ method: 'GET', url: `/api/v1/services/${id}`, headers: authed(s.eng) })).json().operable;
    expect(await d(s.shop)).toEqual({ ok: true, reason: null });
    expect((await d(s.self)).ok).toBe(false);
  });

  it('without PM2 the answer is a clear 503', async () => {
    t = await makeApp();
    await addUser(t);
    const cookie = (await login(t)).cookie!;
    const svc = t.ctx.services.discover('shop');
    const r = await act(cookie, svc.id, 'restart');
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe('pm2_disabled');
  });
});
