import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cpuPct,
  diskUsage,
  excludedInterface,
  HostReader,
  parseDiskstats,
  parseMeminfo,
  parseMountinfo,
  parseNetDev,
  parseStat,
  parseUptime,
} from '../src/proc';
import { diskText, netText, procFixture, statText } from './fixtures';

describe('/proc parsing', () => {
  it('reads total and per-core CPU times, idle including iowait', () => {
    const s = parseStat('cpu  10 1 4 80 5 0 0 0 7 0\ncpu0 5 0 2 40 3 0 0 0 0 0\ncpu1 5 1 2 40 2 0 0 0 0 0\nintr 1');
    expect(s.all).toEqual({ total: 100, idle: 85 });
    expect(s.cores).toEqual([{ total: 50, idle: 43 }, { total: 50, idle: 42 }]);
    expect(cpuPct({ total: 100, idle: 85 }, { total: 200, idle: 160 })).toBe(25);
    expect(cpuPct({ total: 100, idle: 85 }, { total: 100, idle: 85 })).toBe(0);
    expect(() => parseStat('intr 1')).toThrow();
  });

  it('takes memory used as total minus MemAvailable, and swap from SwapFree', () => {
    expect(parseMeminfo('MemTotal: 1000 kB\nMemAvailable: 600 kB\nSwapTotal: 100 kB\nSwapFree: 25 kB')).toEqual({
      memTotalBytes: 1000 * 1024,
      memUsedBytes: 400 * 1024,
      swapTotalBytes: 100 * 1024,
      swapUsedBytes: 75 * 1024,
    });
    // Old kernels without MemAvailable: free + buffers + cache.
    expect(parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 100 kB\nCached: 300 kB').memUsedBytes).toBe(500 * 1024);
    expect(parseUptime('86400.55 1.0\n')).toBe(86400.55);
  });

  it('counts only the host interfaces: not lo, docker0, br-* or veth*', () => {
    expect(['lo', 'docker0', 'br-abc', 'veth1', 'ens3', 'eth0', 'wg0'].map(excludedInterface)).toEqual([true, true, true, true, false, false, false]);
    expect(parseNetDev(netText(10, 20))).toEqual({ rx: 10, tx: 20, interfaces: ['ens3'] });
  });

  it('maps mount points to devices and reads their sectors', () => {
    const m = parseMountinfo('22 1 252:1 / / rw - ext4 /dev/vda1 rw\n30 22 252:16 / /mnt/data\\040disk rw - ext4 /dev/vdb rw\n31 22 0:5 / / rw - overlay x rw');
    expect([...m]).toEqual([
      ['/', '252:1'],
      ['/mnt/data disk', '252:16'],
    ]);
    expect(parseDiskstats(diskText(10, 20)).get('252:1')).toEqual({ read: 5120, written: 10240 });
  });

  it('reports disk usage like df: total is used plus what users may still write', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-statfs-'));
    const st = await fs.promises.statfs(dir);
    const u = await diskUsage(dir, '/');
    expect(u.volume).toBe('/');
    expect(u.usedBytes).toBe((st.blocks - st.bfree) * st.bsize);
    expect(u.totalBytes).toBe(u.usedBytes + st.bavail * st.bsize);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('HostReader', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  it('averages CPU, network and disk I/O over the time since the previous reading', async () => {
    const f = procFixture();
    dirs.push(f.dir);
    let t = 1_000_000;
    const r = new HostReader({ procRoot: f.procRoot, hostRun: f.hostRun, disks: ['/', '/srv'], now: () => t });
    await r.prime();

    // 10 s later: 300 of 1000 jiffies busy, 1 MB in and 2 MB out on ens3 only, 1000 sectors each way on vda1.
    t += 10_000;
    fs.writeFileSync(path.join(f.procRoot, 'stat'), statText(1300, 4700));
    fs.writeFileSync(path.join(f.procRoot, '1/net/dev'), netText(2_000_000, 4_000_000));
    fs.writeFileSync(path.join(f.procRoot, 'diskstats'), diskText(2000, 3000));
    const s = await r.sample();
    expect(s.cpuPct).toBe(30);
    expect(s.cpuPerCore).toEqual([30, 30]);
    expect(s.netRxBps).toBe(100_000);
    expect(s.netTxBps).toBe(200_000);
    expect(s.memTotalBytes).toBe(8_000_000 * 1024);
    expect(s.memUsedBytes).toBe(2_000_000 * 1024);
    expect(s.swapUsedBytes).toBe(250_000 * 1024);
    expect(s.uptimeS).toBe(86400);
    expect(s.pendingReboot).toBe(false);
    expect(s.io.get('/')).toEqual({ readBps: 51_200, writeBps: 51_200 });
    expect(s.io.has('/srv')).toBe(false); // not a mount point on this host

    fs.writeFileSync(path.join(f.hostRun, 'reboot-required'), '');
    t += 10_000;
    expect((await r.sample()).pendingReboot).toBe(true);
  });

  it('falls back to this namespace’s net/dev when /proc/1 is not readable', async () => {
    const f = procFixture();
    dirs.push(f.dir);
    fs.rmSync(path.join(f.procRoot, '1'), { recursive: true });
    fs.mkdirSync(path.join(f.procRoot, 'net'));
    fs.writeFileSync(path.join(f.procRoot, 'net/dev'), netText(5, 5));
    const r = new HostReader({ procRoot: f.procRoot, hostRun: f.hostRun, disks: ['/'] });
    await r.prime();
    expect((await r.sample()).io.size).toBe(0);
  });
});
