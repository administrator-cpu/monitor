import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../src/scheduler';

const log = { warn: vi.fn(), debug: vi.fn() };
let clock: { t: number };
const now = () => clock.t;

beforeEach(() => {
  clock = { t: 1_000_000 };
  vi.useFakeTimers();
  log.warn.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Scheduler', () => {
  it('records success and reports fresh data as not stale', async () => {
    const s = new Scheduler(log, now);
    s.register({ name: 'a', intervalMs: 1000, run: async () => {} });
    await s.runOnce('a');
    const [st] = s.status();
    expect(st!.lastOkAt).toBe(clock.t);
    expect(st!.stale).toBe(false);
    expect(st!.lastError).toBeUndefined();
  });

  it('marks stale after 3 intervals without success', async () => {
    const s = new Scheduler(log, now);
    s.register({ name: 'a', intervalMs: 1000, run: async () => {} });
    await s.runOnce('a');
    clock.t += 3000;
    expect(s.status()[0]!.stale).toBe(false);
    clock.t += 1;
    expect(s.status()[0]!.stale).toBe(true);
  });

  it('counts a never-successful collector as stale 3 intervals after registration', () => {
    const s = new Scheduler(log, now);
    s.register({ name: 'a', intervalMs: 1000, run: async () => {} });
    expect(s.status()[0]!.stale).toBe(false);
    clock.t += 3001;
    expect(s.status()[0]!.stale).toBe(true);
  });

  it('isolates a failing collector from the others', async () => {
    const s = new Scheduler(log, now);
    s.register({
      name: 'bad',
      intervalMs: 1000,
      run: async () => {
        throw new Error('boom');
      },
    });
    s.register({ name: 'good', intervalMs: 1000, run: async () => {} });
    await s.runOnce('bad');
    await s.runOnce('good');
    const by = Object.fromEntries(s.status().map((x) => [x.name, x]));
    expect(by.bad!.lastError).toBe('boom');
    expect(by.bad!.lastOkAt).toBeNull();
    expect(by.good!.lastOkAt).not.toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('clears the error after a later success', async () => {
    const s = new Scheduler(log, now);
    let fail = true;
    s.register({
      name: 'a',
      intervalMs: 1000,
      run: async () => {
        if (fail) throw new Error('x');
      },
    });
    await s.runOnce('a');
    expect(s.status()[0]!.lastError).toBe('x');
    fail = false;
    await s.runOnce('a');
    expect(s.status()[0]!.lastError).toBeUndefined();
  });

  it('times out a hung collector and does not start an overlapping run', async () => {
    const s = new Scheduler(log, now);
    let starts = 0;
    s.register({
      name: 'hang',
      intervalMs: 1000,
      timeoutMs: 500,
      run: () => {
        starts += 1;
        return new Promise(() => {});
      },
    });
    const p = s.runOnce('hang');
    await vi.advanceTimersByTimeAsync(600);
    await p;
    expect(s.status()[0]!.lastError).toMatch(/timeout/);
    await s.runOnce('hang'); // previous run is still in flight
    expect(starts).toBe(1);
    expect(s.status()[0]!.lastError).toMatch(/in flight/);
  });

  it('runs collectors on their interval once started, and stops cleanly', async () => {
    const s = new Scheduler(log, Date.now);
    let runs = 0;
    s.register({
      name: 'tick',
      intervalMs: 1000,
      run: async () => {
        runs += 1;
      },
    });
    s.start();
    await vi.advanceTimersByTimeAsync(3500);
    expect(runs).toBeGreaterThanOrEqual(3);
    s.stop();
    const after = runs;
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toBe(after);
  });

  it('rejects duplicate registration', () => {
    const s = new Scheduler(log, now);
    s.register({ name: 'a', intervalMs: 1, run: async () => {} });
    expect(() => s.register({ name: 'a', intervalMs: 1, run: async () => {} })).toThrow();
  });
});
