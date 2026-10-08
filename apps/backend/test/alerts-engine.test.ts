import { beforeEach, describe, expect, it } from 'vitest';
import type { CollectorStatus, LogStatus, ProcessState } from '@cc/shared';
import { AlertEngine } from '../src/alerts/engine';
import type { MailMessage, MailResult, Mailer } from '../src/alerts/mailer';
import { Notifier } from '../src/alerts/notifier';
import { AlertRepo } from '../src/alerts/repo';
import { Users } from '../src/auth/users';
import { migrate, openDb, type Db } from '../src/db';
import { ServicesRepo } from '../src/pm2/services';
import { Settings } from '../src/settings';
import { StateStore } from '../src/state';

const GIB = 1024 ** 3;

class FakeMailer implements Mailer {
  sent: MailMessage[] = [];
  calls = 0;
  fail = false;
  permanent = false;
  async send(m: MailMessage): Promise<MailResult> {
    this.calls += 1;
    if (this.fail) return { ok: false, permanent: this.permanent, error: 'HTTP 500' };
    this.sent.push(m);
    return { ok: true, id: `msg_${this.sent.length}` };
  }
  subjects(): string[] {
    return this.sent.map((m) => m.subject);
  }
}

interface H {
  db: Db;
  clock: { t: number };
  state: StateStore;
  repo: AlertRepo;
  services: ServicesRepo;
  settings: Settings;
  mailer: FakeMailer;
  notifier: Notifier;
  engine: AlertEngine;
  staleCollectors: Set<string>;
  persistFailures: { n: number };
  logs: LogStatus;
  events: { kind: string }[];
  step(seconds: number): Promise<void>;
  proc(name: string, over?: Partial<ProcessState>): ProcessState;
  rule(key: string): { id: number };
}

function harness(opts: { configured?: boolean } = {}): H {
  const clock = { t: 1_800_000_000_000 };
  const now = () => clock.t;
  const db = openDb(':memory:');
  migrate(db);
  const settings = new Settings(db, now);
  const repo = new AlertRepo(db, now);
  const state = new StateStore();
  const services = new ServicesRepo(db, now);
  new Users(db, now).create({
    username: 'owner',
    displayName: 'Owner',
    email: 'owner@example.com',
    role: 'admin',
    passwordHash: 'x',
    mustChangePassword: false,
  });
  const mailer = new FakeMailer();
  const configured = opts.configured ?? true;
  const notifier = new Notifier({
    mailer: configured ? mailer : null,
    repo,
    settings,
    config: { alertFrom: configured ? 'alerts@example.com' : undefined, publicDashboardUrl: 'https://mon.example.com', resendApiKey: 'k' },
    log: { warn: () => undefined, info: () => undefined },
    now,
    sleep: async () => undefined,
  });
  const staleCollectors = new Set<string>();
  const persistFailures = { n: 0 };
  const logs: LogStatus = { volumeOk: true, volumeReason: null, volumeUsedPct: 10, droppedLines: 0, skippedLines: 0, writerQueue: 0 };
  const events: { kind: string }[] = [];
  const engine = new AlertEngine({
    repo,
    state,
    settings,
    notifier,
    collectors: (): CollectorStatus[] =>
      ['host', 'disk', 'system', 'pm2'].map((name) => ({ name, intervalMs: 5000, lastOkAt: clock.t, stale: staleCollectors.has(name) })),
    logs: () => logs,
    persistence: () => ({ consecutiveFailures: persistFailures.n }),
    log: { warn: () => undefined, info: () => undefined },
    now,
    emit: (kind) => events.push({ kind }),
  });
  const h: H = {
    db, clock, state, repo, services, settings, mailer, notifier, engine, staleCollectors, persistFailures, logs, events,
    async step(seconds) {
      clock.t += seconds * 1000;
      await engine.tick();
    },
    proc(name, over = {}) {
      const svc = services.discover(name);
      return {
        serviceId: svc.id, name: svc.name, pm2Name: name, updatedAt: clock.t, status: 'online', instances: 1,
        instancesOnline: 1, cpuPct: 1, memBytes: 100 * 1024 * 1024, restarts: 0, uptimeS: 100, ...over,
      };
    },
    rule(key) {
      return db.prepare('SELECT id FROM alert_rules WHERE key = ?').get(key) as { id: number };
    },
  };
  return h;
}

const setDisk = (h: H, pct: number): void =>
  h.state.setDisks([{ volume: 'C:', usedBytes: pct, totalBytes: 100, readBps: null, writeBps: null }], h.clock.t);

describe('alert lifecycle', () => {
  let h: H;
  beforeEach(() => {
    h = harness();
  });

  it('opens only after the duration, emails once, reminds after the cooldown, resolves after twice the duration', async () => {
    setDisk(h, 90);
    await h.step(0);
    await h.step(299);
    expect(h.repo.firing()).toHaveLength(0);
    await h.step(2); // 301 s
    expect(h.repo.firing().map((i) => i.rule_key)).toEqual(['host.disk_high']);
    expect(h.mailer.subjects()).toEqual(['[WARNING] Disk usage high']);
    expect(h.mailer.sent[0]?.to).toBe('owner@example.com');
    expect(h.events.map((e) => e.kind)).toEqual(['alert_opened']);

    await h.step(3000); // still inside the 1 h cooldown
    expect(h.mailer.sent).toHaveLength(1);
    await h.step(700);
    expect(h.mailer.subjects()[1]).toBe('[STILL FIRING] Disk usage high');

    setDisk(h, 40);
    await h.step(5);
    await h.step(595); // inactive 595 s < 600 s
    expect(h.repo.firing()).toHaveLength(1);
    await h.step(10);
    expect(h.repo.firing()).toHaveLength(0);
    expect(h.mailer.subjects()[2]).toBe('[RESOLVED] Disk usage high');
    expect(h.events.map((e) => e.kind)).toEqual(['alert_opened', 'alert_resolved']);
    expect(h.engine.openCount()).toBe(0);
  });

  it('does not open when the value flaps inside the duration', async () => {
    for (let i = 0; i < 4; i++) {
      setDisk(h, 90);
      await h.step(0);
      await h.step(200);
      setDisk(h, 50);
      await h.step(5);
    }
    expect(h.repo.firing()).toHaveLength(0);
    expect(h.mailer.sent).toHaveLength(0);
  });

  it('never emails a resolved message for an incident nobody was told about', async () => {
    h.mailer.fail = true;
    h.mailer.permanent = true;
    setDisk(h, 99);
    await h.step(0);
    await h.step(61); // critical rule opens (duration 60)
    expect(h.repo.firing().some((i) => i.rule_key === 'host.disk_critical')).toBe(true);
    setDisk(h, 10);
    await h.step(5);
    await h.step(700);
    expect(h.repo.firing()).toHaveLength(0);
    h.mailer.fail = false;
    await h.step(1000);
    expect(h.mailer.sent).toHaveLength(0);
  });

  it('keeps the peak value of an open incident', async () => {
    setDisk(h, 88);
    await h.step(0);
    await h.step(301);
    setDisk(h, 93);
    await h.step(40);
    expect(h.repo.firing().find((i) => i.rule_key === 'host.disk_high')?.peak_value).toBe(93);
  });

  it('holds state while the data source is stale (no open, no resolve)', async () => {
    h.state.setProcesses([h.proc('api', { status: 'stopped', instances: 0, instancesOnline: 0 })], h.clock.t);
    h.staleCollectors.add('pm2');
    await h.step(0);
    await h.step(300);
    const pm2Open = () => h.repo.firing().map((i) => i.rule_key).filter((k) => k.startsWith('pm2.'));
    expect(pm2Open()).toEqual([]);

    h.staleCollectors.delete('pm2');
    await h.step(5);
    await h.step(61);
    expect(pm2Open()).toEqual(['pm2.service_down']);

    h.state.setProcesses([h.proc('api')], h.clock.t);
    h.staleCollectors.add('pm2');
    await h.step(5);
    await h.step(600);
    expect(pm2Open()).toEqual(['pm2.service_down']); // recovery is not believed while the data is stale
    h.staleCollectors.delete('pm2');
    await h.step(5);
    await h.step(121); // resolves after twice the 60 s duration
    expect(pm2Open()).toEqual([]);
  });

  it('applies a per-service threshold override', async () => {
    const r = h.rule('pm2.memory_high');
    h.repo.updateRule(r.id, { overrides: { api: 3 * GIB } }, null);
    h.state.setProcesses([h.proc('api', { memBytes: 2 * GIB }), h.proc('worker', { memBytes: 2 * GIB })], h.clock.t);
    await h.step(0);
    await h.step(601);
    const open = h.repo.firing();
    expect(open).toHaveLength(1);
    expect(open[0]?.service_name).toBe('worker');
  });

  it('resolves the incidents of a disabled rule', async () => {
    setDisk(h, 90);
    await h.step(0);
    await h.step(301);
    expect(h.repo.firing()).toHaveLength(1);
    h.repo.updateRule(h.rule('host.disk_high').id, { enabled: false }, null);
    await h.step(5);
    await h.step(601);
    expect(h.repo.firing()).toHaveLength(0);
  });

  it('archiving a service resolves its incidents without an email', async () => {
    h.state.setProcesses([h.proc('api', { status: 'errored' })], h.clock.t);
    await h.step(0);
    await h.step(61);
    expect(h.mailer.sent).toHaveLength(1);
    const svcId = h.services.getByPm2Name('api')!.id;
    h.engine.onServiceArchived(svcId);
    await h.engine.tick();
    expect(h.repo.firing()).toHaveLength(0);
    expect(h.mailer.sent).toHaveLength(1);
  });
});

describe('grouping', () => {
  it('a crash loop hides "service down" until the loop ends, then the downtime is reported', async () => {
    const h = harness();
    let restarts = 0;
    for (let i = 0; i < 7; i++) {
      restarts += 1;
      h.state.setProcesses([h.proc('api', { status: 'errored', restarts })], h.clock.t);
      await h.step(10);
    }
    h.state.setProcesses([h.proc('api', { status: 'errored', restarts })], h.clock.t);
    await h.step(10);
    const open = h.repo.firing();
    expect(open.map((i) => i.rule_key).sort()).toEqual(['pm2.crash_loop', 'pm2.service_down']);
    const down = open.find((i) => i.rule_key === 'pm2.service_down')!;
    expect(down.suppressed_by).toBe(open.find((i) => i.rule_key === 'pm2.crash_loop')!.id);
    expect(h.mailer.subjects()).toEqual(['[CRITICAL] Crash loop (api)']);

    for (let i = 0; i < 40; i++) {
      h.state.setProcesses([h.proc('api', { status: 'errored', restarts })], h.clock.t);
      await h.step(20);
    }
    const subjects = h.mailer.subjects();
    expect(subjects).toContain('[RESOLVED] Crash loop (api)');
    expect(subjects).toContain('[CRITICAL] Service down (api)');
    expect(subjects.indexOf('[CRITICAL] Service down (api)')).toBeGreaterThan(0);
  });

  it('critical disk usage hides the warning for the same volume', async () => {
    const h = harness();
    setDisk(h, 99);
    await h.step(0);
    await h.step(301);
    expect(h.repo.firing().map((i) => i.rule_key).sort()).toEqual(['host.disk_critical', 'host.disk_high']);
    expect(h.mailer.subjects()).toEqual(['[CRITICAL] Disk usage critical']);
  });
});

describe('mutes', () => {
  it('blocks the email, records one muted row, and sends after the mute ends', async () => {
    const h = harness();
    h.repo.insertMute({ starts_at: h.clock.t - 1000, ends_at: h.clock.t + 3_600_000, service_id: null, category: 'host', rule_id: null, reason: 'maintenance', created_by: null });
    setDisk(h, 90);
    await h.step(0);
    await h.step(301);
    await h.step(60);
    await h.step(60);
    const inc = h.repo.firing()[0]!;
    expect(h.mailer.sent).toHaveLength(0);
    const rows = h.repo.notificationsFor(inc.id);
    expect(rows.map((r) => r.status)).toEqual(['muted']);
    await h.step(3600);
    expect(h.mailer.subjects()).toEqual(['[WARNING] Disk usage high']);
  });

  it('a mute for another category does not apply', async () => {
    const h = harness();
    h.repo.insertMute({ starts_at: h.clock.t - 1000, ends_at: h.clock.t + 3_600_000, service_id: null, category: 'pm2', rule_id: null, reason: null, created_by: null });
    setDisk(h, 90);
    await h.step(0);
    await h.step(301);
    expect(h.mailer.sent).toHaveLength(1);
  });
});

describe('delivery', () => {
  it('retries a failed send with backoff and counts consecutive failures', async () => {
    const h = harness();
    h.mailer.fail = true;
    setDisk(h, 90);
    await h.step(0);
    await h.step(301);
    expect(h.mailer.calls).toBe(3); // three attempts for the one recipient
    const inc = h.repo.firing()[0]!;
    expect(inc.notify_count).toBe(0);
    expect(h.repo.notificationsFor(inc.id).map((n) => [n.status, n.attempts])).toEqual([['failed', 3]]);
    expect(h.notifier.failures).toBe(3);

    await h.step(10); // inside the first backoff (30 s)
    expect(h.mailer.calls).toBe(3);
    await h.step(30);
    expect(h.mailer.calls).toBe(6);

    // the email problem itself is shown on the dashboard, never emailed
    expect(h.repo.firing().map((i) => i.rule_key)).toContain('monitor.email_failing');

    h.mailer.fail = false;
    await h.step(70); // second backoff is 60 s
    expect(h.mailer.sent).toHaveLength(1);
    expect(h.repo.getIncident(inc.id)?.notify_count).toBe(1);
    expect(h.notifier.failures).toBe(0);
    await h.step(5);
    await h.step(61);
    expect(h.repo.firing().map((i) => i.rule_key)).not.toContain('monitor.email_failing');
  });

  it('does not retry a permanent rejection within a send', async () => {
    const h = harness();
    h.mailer.fail = true;
    h.mailer.permanent = true;
    setDisk(h, 90);
    await h.step(0);
    await h.step(301);
    expect(h.mailer.calls).toBe(1);
  });

  it('without email configured it still opens incidents but creates no notification rows', async () => {
    const h = harness({ configured: false });
    setDisk(h, 90);
    await h.step(0);
    await h.step(301);
    expect(h.repo.firing()).toHaveLength(1);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM alert_notifications').get()).toEqual({ n: 0 });
    expect(h.notifier.status().configured).toBe(false);
  });

  it('sends one email per recipient: admins and subscribed engineers, not unsubscribed ones', async () => {
    const h = harness();
    const users = new Users(h.db, () => h.clock.t);
    const mk = (name: string) =>
      users.create({ username: name, displayName: name, email: `${name}@example.com`, role: 'engineer', passwordHash: 'x', mustChangePassword: false });
    const sub = mk('sub');
    mk('nosub');
    h.repo.putSubscriptions(sub.id, ['host']);
    setDisk(h, 90);
    await h.step(0);
    await h.step(301);
    expect(h.mailer.sent.map((m) => m.to).sort()).toEqual(['owner@example.com', 'sub@example.com']);
    const keys = new Set(h.mailer.sent.map((m) => m.idempotencyKey));
    expect(keys.size).toBe(2);
  });

  it('gives the resolved email up after four failed rounds', async () => {
    const h = harness();
    setDisk(h, 90);
    await h.step(0);
    await h.step(301);
    h.mailer.fail = true;
    h.mailer.permanent = true;
    setDisk(h, 10);
    await h.step(5);
    await h.step(700);
    const before = h.mailer.calls;
    for (let i = 0; i < 40; i++) await h.step(300);
    expect(h.mailer.calls - before).toBeLessThanOrEqual(4);
  });
});

describe('monitor rules', () => {
  it('reports a missing log volume and failing database writes', async () => {
    const h = harness();
    h.logs.volumeOk = false;
    h.logs.volumeReason = 'missing';
    h.persistFailures.n = 5;
    await h.step(0);
    await h.step(61);
    const keys = h.repo.firing().map((i) => i.rule_key).sort();
    expect(keys).toEqual(['monitor.log_volume_missing', 'monitor.sqlite_write_failing']);
    expect(h.repo.firing().find((i) => i.rule_key === 'monitor.log_volume_missing')?.summary).toContain('folder is missing');
  });

  it('flags dropped log lines only while the counter is rising', async () => {
    const h = harness();
    await h.step(0);
    h.logs.droppedLines = 50;
    await h.step(5);
    await h.step(61);
    h.logs.droppedLines = 80;
    await h.step(5);
    h.logs.droppedLines = 120;
    await h.step(61);
    expect(h.repo.firing().map((i) => i.rule_key)).toContain('monitor.log_dropped');
    await h.step(5);
    await h.step(130);
    expect(h.repo.firing().map((i) => i.rule_key)).not.toContain('monitor.log_dropped');
  });

  it('shows rules for later phases as not implemented and never fires them', async () => {
    const h = harness();
    await h.step(0);
    await h.step(10_000);
    expect(h.repo.firing().filter((i) => /^(nginx|mongo|app)\./.test(i.rule_key))).toHaveLength(0);
  });
});
