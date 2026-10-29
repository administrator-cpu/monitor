import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { cpuMemCollector, diskCollector } from '../src/collectors/host';
import { parseDisks, parseSwapNet, SwapNetSampler, windowsHostSource } from '../src/collectors/winhost';
import { Scheduler } from '../src/scheduler';
import { StateStore } from '../src/state';

const json = (o: Record<string, unknown>) => `${JSON.stringify(o)}\r\n`;

describe('Windows host source', () => {
  it('parses the swap and network script, treating missing sums as 0', () => {
    expect(parseSwapNet(json({ swapTotalMb: 9728, swapUsedMb: 267, rx: 1.2345678901e10, tx: 500 }))).toEqual({
      swapTotalBytes: 9728 * 1024 * 1024,
      swapUsedBytes: 267 * 1024 * 1024,
      rxBytes: 12345678901,
      txBytes: 500,
    });
    expect(parseSwapNet(json({ swapTotalMb: null, swapUsedMb: null, rx: null, tx: null }))).toEqual({ swapTotalBytes: 0, swapUsedBytes: 0, rxBytes: 0, txBytes: 0 });
    expect(() => parseSwapNet('')).toThrow('no data');
  });

  it('computes network rates from counter changes between samples', async () => {
    const outputs = [
      json({ swapTotalMb: 100, swapUsedMb: 10, rx: 1_000, tx: 2_000 }),
      json({ swapTotalMb: 100, swapUsedMb: 20, rx: 151_000, tx: 32_000 }),
      json({ swapTotalMb: 100, swapUsedMb: 20, rx: 50, tx: 33_500 }), // rx counter reset
    ];
    const timeouts: number[] = [];
    const clock = { t: 0 };
    const s = new SwapNetSampler(async (_script, timeoutMs) => {
      timeouts.push(timeoutMs);
      return outputs.shift()!;
    }, () => clock.t);

    await s.sample();
    expect([s.rxBps, s.txBps]).toEqual([0, 0]); // no rate from a single sample
    expect(s.swapUsedBytes).toBe(10 * 1024 * 1024);
    clock.t = 15_000;
    await s.sample();
    expect([s.rxBps, s.txBps]).toEqual([10_000, 2_000]);
    expect(s.swapUsedBytes).toBe(20 * 1024 * 1024);
    clock.t = 30_000;
    await s.sample();
    expect([s.rxBps, s.txBps]).toEqual([0, 100]);
    expect(timeouts).toEqual([20_000, 20_000, 20_000]);
  });

  it('keeps the last values when the script fails, and the failure shows on its own collector', async () => {
    let fail = false;
    const clock = { t: 0 };
    const s = new SwapNetSampler(async () => {
      if (fail) throw new Error('powershell timed out');
      return json({ swapTotalMb: 100, swapUsedMb: 10, rx: 0, tx: 0 });
    }, () => clock.t);
    await s.sample();
    fail = true;
    const sched = new Scheduler({ warn: () => undefined, debug: () => undefined }, () => clock.t);
    sched.register(s.collector());
    await sched.runOnce('swapnet');
    expect(s.swapUsedBytes).toBe(10 * 1024 * 1024);
    expect(sched.status()[0]).toMatchObject({ name: 'swapnet', lastError: 'powershell timed out' });
  });

  it('feeds the 2 s collector from Node and the sampler, starting no PowerShell for it', async () => {
    const calls: string[] = [];
    const ps = async (script: string) => {
      calls.push(script);
      return script.includes('Win32_LogicalDisk') ? 'C:|NTFS|1000|400\r\nD:|CDFS|5|0\r\nZ:|||\r\n' : json({ swapTotalMb: 1, swapUsedMb: 1, rx: 0, tx: 0 });
    };
    const sampler = new SwapNetSampler(ps, () => 0);
    await sampler.sample();
    calls.length = 0;
    sampler.rxBps = 300;
    sampler.txBps = 40;

    const src = windowsHostSource(sampler, ps);
    const state = new StateStore();
    await cpuMemCollector(state, () => 1, src).run();
    expect(calls).toEqual([]);
    const h = state.getHost()!;
    expect(h.memTotalBytes).toBe(os.totalmem());
    expect(h.memUsedBytes).toBeGreaterThan(0);
    expect(h.swapUsedBytes).toBe(1024 * 1024);
    expect([h.netRxBps, h.netTxBps]).toEqual([300, 40]);
    expect(h.cpuPerCore.length).toBe(os.cpus().length);

    await diskCollector(state, () => 2, src).run();
    expect(calls).toHaveLength(1);
    // Disk sizes come from one script; the optical drive and a drive without a size are left out.
    expect(state.getHost()!.disks.map((d) => [d.volume, d.usedBytes, d.totalBytes])).toEqual([['C:', 600, 1000]]);
  });

  it('parses the disk script', () => {
    expect(parseDisks('C:|NTFS|1000|400\r\ne:|ReFS|50|50\r\nnoise\r\nX:|NTFS||\r\n')).toEqual([
      { fs: 'C:', type: 'NTFS', size: 1000, used: 600, mount: 'C:' },
      { fs: 'E:', type: 'ReFS', size: 50, used: 0, mount: 'E:' },
    ]);
  });
});
