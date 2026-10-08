import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../src/config';
import {
  cpuMemCollector,
  diskCollector,
  selectDisks,
  systemCollector,
  type HostSource,
} from '../src/collectors/host';
import { migrate, openDb } from '../src/db';
import { passwordPolicyError } from '../src/auth/password';
import { SlidingWindowLimiter } from '../src/auth/throttle';
import { RingBuffer, StateStore } from '../src/state';
import { Settings } from '../src/settings';

describe('RingBuffer', () => {
  it('keeps the newest N items in order', () => {
    const r = new RingBuffer<number>(3);
    [1, 2].forEach((n) => r.push(n));
    expect(r.toArray()).toEqual([1, 2]);
    [3, 4, 5].forEach((n) => r.push(n));
    expect(r.toArray()).toEqual([3, 4, 5]);
    expect(r.length).toBe(3);
  });
});

describe('StateStore', () => {
  it('returns null host until the first sample, then series in seconds', () => {
    const s = new StateStore();
    expect(s.getHost()).toBeNull();
    s.setCpuMem({
      at: 1_700_000_000_500,
      cpuPct: 50,
      cpuPerCore: [50],
      memUsedBytes: 25,
      memTotalBytes: 100,
      swapUsedBytes: 0,
      swapTotalBytes: 0,
      netRxBps: 1,
      netTxBps: 2,
    });
    expect(s.getHost()!.disks).toEqual([]);
    const series = s.getHostSeries();
    expect(series.ts).toEqual([1_700_000_001]);
    expect(series.memPct).toEqual([25]);
  });

  it('holds 30 minutes of 2 s samples', () => {
    const s = new StateStore();
    for (let i = 0; i < 1000; i++) {
      s.setCpuMem({
        at: i * 2000,
        cpuPct: i,
        cpuPerCore: [],
        memUsedBytes: 0,
        memTotalBytes: 1,
        swapUsedBytes: 0,
        swapTotalBytes: 0,
        netRxBps: 0,
        netTxBps: 0,
      });
    }
    expect(s.getHostSeries().ts).toHaveLength(900);
    expect(s.getHostSeries().cpuPct[899]).toBe(999);
  });
});

describe('SlidingWindowLimiter', () => {
  it('allows max hits per window and recovers afterwards', () => {
    let t = 0;
    const l = new SlidingWindowLimiter(3, 1000, () => t);
    expect([l.hit('a'), l.hit('a'), l.hit('a'), l.hit('a')]).toEqual([true, true, true, false]);
    expect(l.hit('b')).toBe(true);
    t = 1001;
    expect(l.hit('a')).toBe(true);
  });
});

describe('passwordPolicyError', () => {
  it('enforces length, common list, repeats and username', () => {
    expect(passwordPolicyError('short')).toMatch(/at least 12/);
    expect(passwordPolicyError('Password1234')).toMatch(/common/);
    expect(passwordPolicyError('aaaaaaaaaaaaaa')).toMatch(/repeated/);
    expect(passwordPolicyError('longusername123', { username: 'LongUsername123' })).toMatch(
      /username/,
    );
    expect(passwordPolicyError('a perfectly fine passphrase')).toBeNull();
  });
});

describe('migrations', () => {
  it('apply once, are idempotent and seed the reserved service row', () => {
    const db = openDb(':memory:');
    expect(migrate(db).applied).toEqual(['001_init.sql', '002_pm2.sql', '003_alerts.sql', '004_nginx.sql', '005_mongo.sql', '006_agent.sql', '007_events.sql']);
    expect(migrate(db).applied).toEqual([]);
    const svc = db.prepare('SELECT id, name FROM services WHERE id = 0').get();
    expect(svc).toEqual({ id: 0, name: '_unattributed' });
    expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }]);
    const mode = db.pragma('foreign_keys', { simple: true });
    expect(mode).toBe(1);
  });

  it('rolls a failing migration back and stops', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    fs.writeFileSync(path.join(dir, '001_ok.sql'), 'CREATE TABLE a (x INTEGER);');
    fs.writeFileSync(path.join(dir, '002_bad.sql'), 'CREATE TABLE b (x INTEGER); NOT VALID SQL;');
    const db = openDb(':memory:');
    expect(() => migrate(db, dir)).toThrow();
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'b'`).get()).toBeUndefined();
    expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('enforces the schema constraints', () => {
    const db = openDb(':memory:');
    migrate(db);
    const insert = (role: string) =>
      db
        .prepare(
          `INSERT INTO users (username, display_name, email, role, password_hash, password_changed_at, created_at, updated_at)
         VALUES (?, 'x', ?, ?, 'h', 0, 0, 0)`,
        )
        .run(`u${Math.random()}`, `e${Math.random()}@x`, role);
    expect(() => insert('root')).toThrow(/CHECK/);
    expect(() => insert('admin')).not.toThrow();
  });
});

describe('Settings', () => {
  it('returns defaults, persists edits and reloads them', () => {
    const db = openDb(':memory:');
    migrate(db);
    const s = new Settings(db);
    expect(s.get('session.idle_hours')).toBe(2);
    s.setMany({ 'session.idle_hours': 4 }, null);
    expect(new Settings(db).get('session.idle_hours')).toBe(4);
    expect(() => s.setMany({ 'login.max_failures': 0 }, null)).toThrow();
    expect(() => s.setMany({ bogus: 1 }, null)).toThrow();
  });

  it('applies nothing when one value in a batch is invalid', () => {
    const db = openDb(':memory:');
    migrate(db);
    const s = new Settings(db);
    expect(() => s.setMany({ 'session.idle_hours': 4, 'login.max_failures': 0 }, null)).toThrow();
    expect(s.get('session.idle_hours')).toBe(2);
  });
});

describe('config', () => {
  const base = { ALLOWED_ORIGINS: 'http://localhost:3000/' };
  it('normalises origins and applies defaults', () => {
    const c = loadConfig({ ...base });
    expect(c.allowedOrigins).toEqual(['http://localhost:3000']);
    expect(c.portApi).toBe(4000);
    expect(c.bindHost).toBe('127.0.0.1');
    expect(c.cookieName).toBe('cc_session');
  });

  it('uses the Secure __Host- cookie in production', () => {
    const c = loadConfig({ ...base, NODE_ENV: 'production' });
    expect(c.cookieSecure).toBe(true);
    expect(c.cookieName).toBe('__Host-session');
  });

  it('refuses an insecure cookie in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(
      ConfigError,
    );
  });

  it('fails clearly without leaking values', () => {
    try {
      loadConfig({ ALLOWED_ORIGINS: 'not a url', COOKIE_SECRET: 'tooshort-secret-value' });
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('ALLOWED_ORIGINS');
      expect(msg).toContain('COOKIE_SECRET');
      expect(msg).not.toContain('tooshort-secret-value');
    }
  });
});

describe('host collectors', () => {
  const src: HostSource = {
    currentLoad: async () => ({ currentLoad: 140, cpus: [{ load: 20 }, { load: -5 }] }),
    mem: async () => ({ total: 1000, available: 400, swaptotal: 50, swapused: 10 }),
    networkStats: async () => [
      { iface: 'Ethernet', rx_sec: 100, tx_sec: 50 },
      { iface: 'Loopback Pseudo-Interface 1', rx_sec: 999, tx_sec: 999 },
      { iface: 'lo', rx_sec: 999, tx_sec: 999 },
      { iface: 'Wi-Fi', rx_sec: null, tx_sec: -1 },
    ],
    fsSize: async () => [
      { fs: 'C:', type: 'NTFS', size: 100, used: 40, mount: 'C:' },
      { fs: 'E:', type: 'NTFS', size: 200, used: 20, mount: 'E:' },
      { fs: 'D:', type: 'NTFS', size: 0, used: 0, mount: 'D:' },
    ],
    time: () => ({ uptime: 3600.9 }),
  };

  it('computes clamped CPU, used memory, and network without loopback or negatives', async () => {
    const state = new StateStore();
    await cpuMemCollector(state, () => 5000, src).run();
    const h = state.getHost()!;
    expect(h.cpuPct).toBe(100);
    expect(h.cpuPerCore).toEqual([20, 0]);
    expect(h.memUsedBytes).toBe(600);
    expect(h.netRxBps).toBe(100);
    expect(h.netTxBps).toBe(50);
    expect(h.swapUsedBytes).toBe(10);
  });

  it('selects Windows volumes and leaves disk I/O unmeasured (null) until phase 3', async () => {
    expect(selectDisks(await src.fsSize(), 'win32').map((d) => d.volume)).toEqual(['C:', 'E:']);
    const state = new StateStore();
    await cpuMemCollector(state, () => 1, src).run();
    await diskCollector(state, () => 1, src).run();
    const d = state.getHost()!.disks[0]!;
    expect(d.readBps).toBeNull();
    expect(d.writeBps).toBeNull();
  });

  it('filters pseudo filesystems on Linux', () => {
    const out = selectDisks(
      [
        { fs: 'tmpfs', type: 'tmpfs', size: 10, used: 1, mount: '/run' },
        { fs: '/dev/sda1', type: 'ext4', size: 10, used: 1, mount: '/' },
      ],
      'linux',
    );
    expect(out.map((d) => d.volume)).toEqual(['/']);
  });

  it('reads uptime and uses the fixed PowerShell script only on Windows', async () => {
    const state = new StateStore();
    await cpuMemCollector(state, () => 1, src).run();
    let calls = 0;
    const ps = async () => {
      calls += 1;
      return '1\r\n';
    };
    await systemCollector(state, () => 2, src, 'linux', ps).run();
    expect(calls).toBe(0);
    expect(state.getHost()!.pendingReboot).toBe(false);
    await systemCollector(state, () => 3, src, 'win32', ps).run();
    expect(calls).toBe(1);
    expect(state.getHost()!.pendingReboot).toBe(true);
    expect(state.getHost()!.uptimeS).toBe(3600);
  });
});
