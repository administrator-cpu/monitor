import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Host figures read from /proc and statfs (TRD 14.5). Inside a container /proc/stat, /proc/meminfo,
 * /proc/uptime and /proc/diskstats are host-wide; network counters come from /proc/1/net/dev, which
 * is the host's network namespace when the container runs with `pid: host` (checked as V21), and
 * mount points from /proc/1/mountinfo for the same reason.
 */

export interface CpuTimes {
  total: number;
  idle: number;
}

/** `cpu` and `cpuN` lines: user nice system idle iowait irq softirq steal (guest is inside user). */
export function parseStat(text: string): { all: CpuTimes; cores: CpuTimes[] } {
  let all: CpuTimes | null = null;
  const cores: CpuTimes[] = [];
  for (const line of text.split('\n')) {
    const m = /^cpu(\d*)\s+(.*)$/.exec(line);
    if (!m) continue;
    const f = m[2]!.trim().split(/\s+/).map(Number);
    const total = f.slice(0, 8).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    const idle = (f[3] ?? 0) + (f[4] ?? 0);
    if (m[1] === '') all = { total, idle };
    else cores[Number(m[1])] = { total, idle };
  }
  if (!all) throw new Error('no cpu line in /proc/stat');
  return { all, cores: cores.filter(Boolean) };
}

/** Busy share between two readings, 0 to 100. */
export function cpuPct(prev: CpuTimes, cur: CpuTimes): number {
  const dt = cur.total - prev.total;
  const di = cur.idle - prev.idle;
  if (dt <= 0) return 0;
  return Math.min(100, Math.max(0, ((dt - di) / dt) * 100));
}

export interface MemInfo {
  memTotalBytes: number;
  memUsedBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

/** Used = total minus MemAvailable, the figure `free` shows as "used" plus cache that cannot be reclaimed. */
export function parseMeminfo(text: string): MemInfo {
  const kb = (name: string): number | null => {
    const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb('MemTotal');
  if (total === null) throw new Error('no MemTotal in /proc/meminfo');
  const avail = kb('MemAvailable') ?? (kb('MemFree') ?? 0) + (kb('Buffers') ?? 0) + (kb('Cached') ?? 0);
  const swapTotal = kb('SwapTotal') ?? 0;
  const swapFree = kb('SwapFree') ?? swapTotal;
  return {
    memTotalBytes: total,
    memUsedBytes: Math.max(0, total - avail),
    swapTotalBytes: swapTotal,
    swapUsedBytes: Math.max(0, swapTotal - swapFree),
  };
}

export function parseUptime(text: string): number {
  const s = Number(text.trim().split(/\s+/)[0]);
  if (!Number.isFinite(s)) throw new Error('unreadable /proc/uptime');
  return s;
}

/** Interfaces that are not the host's own traffic: loopback, Docker's bridges and container ends. */
export function excludedInterface(name: string): boolean {
  return name === 'lo' || name === 'docker0' || name.startsWith('br-') || name.startsWith('veth');
}

/** Received and sent bytes summed over the counted interfaces. */
export function parseNetDev(text: string): { rx: number; tx: number; interfaces: string[] } {
  let rx = 0;
  let tx = 0;
  const interfaces: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1]!;
    if (excludedInterface(name)) continue;
    const f = m[2]!.trim().split(/\s+/).map(Number);
    rx += f[0] ?? 0;
    tx += f[8] ?? 0;
    interfaces.push(name);
  }
  return { rx, tx, interfaces };
}

/** `major:minor` of each mount point (fields 3 and 5 of mountinfo; spaces arrive as \040). */
export function parseMountinfo(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const f = line.split(' ');
    if (f.length < 5) continue;
    const mount = f[4]!.replace(/\\(\d{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
    // The first entry for a mount point wins; later ones are mounts stacked on top inside it.
    if (!out.has(mount)) out.set(mount, f[2]!);
  }
  return out;
}

/** Sectors read and written per device, keyed `major:minor`. A sector is 512 bytes here. */
export function parseDiskstats(text: string): Map<string, { read: number; written: number }> {
  const out = new Map<string, { read: number; written: number }>();
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    out.set(`${f[0]}:${f[1]}`, { read: Number(f[5]) * 512, written: Number(f[9]) * 512 });
  }
  return out;
}

export interface DiskUsage {
  volume: string;
  usedBytes: number;
  totalBytes: number;
}

/**
 * Usage of a mount point through the host's root mounted read-only at `hostRoot`. Total is used
 * plus what an unprivileged user may still write, so the share matches `df` (the blocks reserved
 * for root count as neither).
 */
export async function diskUsage(hostRoot: string, mount: string): Promise<DiskUsage> {
  const st = await fs.statfs(path.join(hostRoot, mount));
  const used = (st.blocks - st.bfree) * st.bsize;
  return { volume: mount, usedBytes: used, totalBytes: used + st.bavail * st.bsize };
}

export interface HostReading {
  cpuPct: number;
  cpuPerCore: number[];
  memUsedBytes: number;
  memTotalBytes: number;
  swapUsedBytes: number;
  swapTotalBytes: number;
  netRxBps: number;
  netTxBps: number;
  uptimeS: number;
  pendingReboot: boolean;
  /** Read and write rates per mount point, when its device is found in /proc/diskstats. */
  io: Map<string, { readBps: number; writeBps: number }>;
}

interface Counters {
  at: number;
  cpu: { all: CpuTimes; cores: CpuTimes[] };
  net: { rx: number; tx: number };
  disk: Map<string, { read: number; written: number }>;
}

/**
 * Reads the counters and turns them into averages since the previous call: CPU, network and disk
 * rates over the whole push interval, not one instant (the monitor stores one row per 10 s).
 */
export class HostReader {
  private prev: Counters | null = null;
  private mounts = new Map<string, string>();

  constructor(
    private readonly o: { procRoot: string; hostRun: string; disks: string[]; now?: () => number },
  ) {}

  private read(p: string): Promise<string> {
    return fs.readFile(path.join(this.o.procRoot, p), 'utf8');
  }

  private async counters(): Promise<Counters> {
    const [stat, net, disk] = await Promise.all([
      this.read('stat'),
      this.read('1/net/dev').catch(() => this.read('net/dev')),
      this.read('diskstats').catch(() => ''),
    ]);
    return { at: (this.o.now ?? Date.now)(), cpu: parseStat(stat), net: parseNetDev(net), disk: parseDiskstats(disk) };
  }

  /** Reads the baseline; the first `sample()` after it reports averages over the time between. */
  async prime(): Promise<void> {
    const info = await this.read('1/mountinfo').catch(() => this.read('self/mountinfo').catch(() => ''));
    this.mounts = parseMountinfo(info);
    this.prev = await this.counters();
  }

  async sample(): Promise<HostReading> {
    if (!this.prev) await this.prime();
    const prev = this.prev!;
    const cur = await this.counters();
    const [mem, up, reboot] = await Promise.all([
      this.read('meminfo').then(parseMeminfo),
      this.read('uptime').then(parseUptime),
      fs.access(path.join(this.o.hostRun, 'reboot-required')).then(
        () => true,
        () => false,
      ),
    ]);
    const secs = Math.max(0.001, (cur.at - prev.at) / 1000);
    const rate = (a: number, b: number): number => Math.max(0, (b - a) / secs);
    const io = new Map<string, { readBps: number; writeBps: number }>();
    for (const mount of this.o.disks) {
      const dev = this.mounts.get(mount);
      const a = dev ? prev.disk.get(dev) : undefined;
      const b = dev ? cur.disk.get(dev) : undefined;
      if (a && b) io.set(mount, { readBps: rate(a.read, b.read), writeBps: rate(a.written, b.written) });
    }
    this.prev = cur;
    return {
      cpuPct: round1(cpuPct(prev.cpu.all, cur.cpu.all)),
      cpuPerCore: cur.cpu.cores.map((c, i) => round1(prev.cpu.cores[i] ? cpuPct(prev.cpu.cores[i]!, c) : 0)),
      ...mem,
      netRxBps: rate(prev.net.rx, cur.net.rx),
      netTxBps: rate(prev.net.tx, cur.net.tx),
      uptimeS: Math.floor(up),
      pendingReboot: reboot,
      io,
    };
  }
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
