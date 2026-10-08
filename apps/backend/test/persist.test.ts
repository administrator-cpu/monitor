import { describe, expect, it } from 'vitest';
import type { ProcessState } from '@cc/shared';
import { migrate, openDb } from '../src/db';
import { Persistence } from '../src/persist';
import { ProcessEvents } from '../src/pm2/events';
import { ServicesRepo } from '../src/pm2/services';
import { runRetention } from '../src/retention';
import { Settings, SettingsError } from '../src/settings';
import { StateStore } from '../src/state';

const T0 = 1_800_000_000_000 - (1_800_000_000_000 % 10_000); // on a 10 s boundary

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  const clock = { t: T0 };
  const now = () => clock.t;
  const state = new StateStore();
  const services = new ServicesRepo(db, now);
  const events = new ProcessEvents();
  const p = new Persistence(db, state, events, services, now);
  const svc = services.discover('api');
  const ps = (over: Partial<ProcessState> = {}): ProcessState => ({
    serviceId: svc.id, name: 'api', pm2Name: 'api', updatedAt: clock.t, status: 'online', instances: 1, instancesOnline: 1,
    cpuPct: 10, memBytes: 1000, restarts: 0, uptimeS: 5, ...over,
  });
  const sample = (at: number, cpu: number) =>
    state.setCpuMem({ at, cpuPct: cpu, cpuPerCore: [cpu], memUsedBytes: 50, memTotalBytes: 100, swapUsedBytes: 0, swapTotalBytes: 0, netRxBps: 1, netTxBps: 2 });
  return { db, clock, state, services, events, p, svc, ps, sample };
}

describe('Persistence', () => {
  it('writes completed 10 s buckets once, averaged from the 2 s samples', () => {
    const { db, clock, state, p, ps, sample } = setup();
    for (const [dt, cpu] of [[1000, 10], [3000, 20], [5000, 30], [7000, 40], [9000, 50]] as const) {
      sample(T0 + dt, cpu);
      state.setProcesses([ps({ cpuPct: cpu })], T0 + dt);
    }
    clock.t = T0 + 10_500;
    p.flush();
    const h = db.prepare('SELECT ts, cpu_pct, res_s FROM metrics_host').all();
    expect(h).toEqual([{ ts: T0, cpu_pct: 30, res_s: 10 }]);
    expect(db.prepare('SELECT ts, cpu_pct, status FROM metrics_process').all()).toEqual([{ ts: T0, cpu_pct: 30, status: 'online' }]);
    p.flush(); // nothing new is complete
    expect(db.prepare('SELECT COUNT(*) AS n FROM metrics_host').get()).toEqual({ n: 1 });
    expect(p.status()).toMatchObject({ consecutiveFailures: 0, lastOkAt: clock.t });
  });

  it('stores the worst status seen in the bucket', () => {
    const { db, clock, state, p, ps, sample } = setup();
    sample(T0 + 1000, 1);
    state.setProcesses([ps()], T0 + 1000);
    state.setProcesses([ps({ status: 'errored' })], T0 + 6000);
    state.setProcesses([ps()], T0 + 9000);
    clock.t = T0 + 10_500;
    p.flush();
    expect(db.prepare('SELECT status FROM metrics_process').get()).toEqual({ status: 'errored' });
  });

  it('writes queued PM2 events for known services only, and only once', () => {
    const { db, clock, events, p } = setup();
    events.add({ name: 'api', pmId: 0, event: 'exit', at: T0 + 1, exitCode: 1, signal: null, isModule: false });
    events.add({ name: 'stranger', pmId: 0, event: 'start', at: T0 + 2, exitCode: null, signal: null, isModule: false });
    clock.t = T0 + 10_500;
    p.flush();
    p.flush();
    const rows = db.prepare('SELECT event, detail FROM process_events').all();
    expect(rows).toEqual([{ event: 'exit', detail: '{"exitCode":1}' }]);
  });

  it('loses nothing after a failed write: the next run writes every missing bucket', () => {
    const { db, clock, state, p, ps, sample } = setup();
    for (let b = 0; b < 3; b++) {
      sample(T0 + b * 10_000 + 1000, 10 + b);
      state.setProcesses([ps()], T0 + b * 10_000 + 1000);
    }
    clock.t = T0 + 30_500;
    db.exec('ALTER TABLE metrics_host RENAME TO metrics_host_x');
    expect(() => p.flush()).toThrow();
    expect(() => p.flush()).toThrow();
    expect(p.status().consecutiveFailures).toBe(2);
    db.exec('ALTER TABLE metrics_host_x RENAME TO metrics_host');
    p.flush();
    expect(db.prepare('SELECT ts FROM metrics_host ORDER BY ts').all()).toEqual([{ ts: T0 }, { ts: T0 + 10_000 }, { ts: T0 + 20_000 }]);
    expect(p.status().consecutiveFailures).toBe(0);
  });

  it('keeps pending events when the transaction rolls back', () => {
    const { db, clock, events, p } = setup();
    events.add({ name: 'api', pmId: 0, event: 'exit', at: T0 + 1, exitCode: 1, signal: null, isModule: false });
    clock.t = T0 + 10_500;
    db.exec('ALTER TABLE process_events RENAME TO pe_x');
    expect(() => p.flush()).toThrow();
    expect(events.peek()).toHaveLength(1);
    db.exec('ALTER TABLE pe_x RENAME TO process_events');
    p.flush();
    expect(events.peek()).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM process_events').get()).toEqual({ n: 1 });
  });
});

describe('runRetention', () => {
  it('deletes by age with each table using its own setting, and records the run', () => {
    const { db, svc } = setup();
    const settings = new Settings(db, () => T0);
    const day = 86_400_000;
    const old = T0 - 10 * day;
    db.prepare('INSERT INTO metrics_host (res_s, ts, cpu_pct, mem_used_bytes, mem_total_bytes) VALUES (10, ?, 1, 1, 2)').run(old);
    db.prepare('INSERT INTO metrics_host (res_s, ts, cpu_pct, mem_used_bytes, mem_total_bytes) VALUES (10, ?, 1, 1, 2)').run(T0);
    db.prepare("INSERT INTO process_events (ts, service_id, event) VALUES (?, ?, 'exit')").run(old, svc.id);
    const rule = db.prepare("SELECT id FROM alert_rules WHERE key = 'host.disk_high'").get() as { id: number };
    const inc = (state: string, openedAt: number, fp: string) =>
      db.prepare("INSERT INTO alert_incidents (rule_id, fingerprint, state, opened_at, summary) VALUES (?, ?, ?, ?, 's')").run(rule.id, fp, state, openedAt);
    inc('resolved', T0 - 100 * day, 'a');
    inc('firing', T0 - 100 * day, 'b'); // still open: never deleted
    inc('resolved', T0 - 1 * day, 'c');

    const removed = runRetention(db, settings, T0);
    expect(removed).toMatchObject({ metrics_host: 1, process_events: 1, alert_incidents: 1 });
    expect(db.prepare('SELECT fingerprint FROM alert_incidents ORDER BY fingerprint').all()).toEqual([{ fingerprint: 'b' }, { fingerprint: 'c' }]);
    expect(db.prepare("SELECT last_status FROM maintenance_runs WHERE job = 'retention'").get()).toEqual({ last_status: 'ok' });

    settings.setMany({ 'retention.metrics_days': 1 }, null);
    db.prepare('INSERT INTO metrics_host (res_s, ts, cpu_pct, mem_used_bytes, mem_total_bytes) VALUES (10, ?, 1, 1, 2)').run(T0 - 2 * day);
    expect(runRetention(db, settings, T0).metrics_host).toBe(1);
  });
});

describe('Settings', () => {
  const mk = () => {
    const db = openDb(':memory:');
    migrate(db);
    return { db, s: new Settings(db, () => T0) };
  };

  it('returns defaults, stores edits, and restores a default with null', () => {
    const { s, db } = mk();
    expect(s.get('logs.ring_buffer_lines')).toBe(5000);
    s.setMany({ 'logs.ring_buffer_lines': 800 }, null);
    expect(s.get('logs.ring_buffer_lines')).toBe(800);
    expect(new Settings(db, () => T0).get('logs.ring_buffer_lines')).toBe(800); // persisted
    const changes = s.setMany({ 'logs.ring_buffer_lines': null }, null);
    expect(changes['logs.ring_buffer_lines']).toEqual({ from: 800, to: null });
    expect(s.get('logs.ring_buffer_lines')).toBe(5000);
  });

  it('validates range, integers and unknown keys, applying nothing on error', () => {
    const { s } = mk();
    expect(() => s.setMany({ 'logs.ring_buffer_lines': 5 }, null)).toThrow(SettingsError);
    expect(() => s.setMany({ 'logs.ring_buffer_lines': 500.5 }, null)).toThrow(SettingsError);
    expect(() => s.setMany({ 'no.such': 1 }, null)).toThrow(SettingsError);
    expect(() => s.setMany({ 'login.max_failures': 3, 'logs.ring_buffer_lines': 5 }, null)).toThrow(SettingsError);
    expect(s.get('login.max_failures')).toBe(5);
  });

  it('accepts a sender and a dashboard URL, normalised, and refuses header injection and credentials', () => {
    const { s } = mk();
    s.setMany({ 'alert.from': 'Command Center <alerts@example.com>', 'alert.dashboard_url': 'https://mon.example.com/app/' }, null);
    expect(s.getString('alert.from')).toBe('Command Center <alerts@example.com>');
    expect(s.getString('alert.dashboard_url')).toBe('https://mon.example.com/app');
    expect(() => s.setMany({ 'alert.from': 'a@x.io\r\nBcc: evil@x.io' }, null)).toThrow(SettingsError);
    expect(() => s.setMany({ 'alert.from': 'not an address' }, null)).toThrow(SettingsError);
    expect(() => s.setMany({ 'alert.dashboard_url': 'javascript:alert(1)' }, null)).toThrow(SettingsError);
    expect(() => s.setMany({ 'alert.dashboard_url': 'https://u:p@mon.example.com' }, null)).toThrow(SettingsError);
    expect(() => s.setMany({ 'alert.from': 5 }, null)).toThrow(SettingsError);
    s.setMany({ 'alert.from': null }, null);
    expect(s.getString('alert.from')).toBeNull();
  });

  it('lists every setting with its type, default and bounds', () => {
    const { s } = mk();
    const all = s.all();
    expect(all.find((x) => x.key === 'alert.from')).toMatchObject({ type: 'string', value: null, default: null });
    expect(all.find((x) => x.key === 'logs.volume_threshold_pct')).toMatchObject({ type: 'number', min: 50, max: 99, value: 85 });
  });
});
