import os from 'node:os';
import si from 'systeminformation';
import type { CollectorDef } from '../scheduler';
import type { HostSource } from './host';
import { runPowerShell } from './powershell';

/**
 * Host figures on Windows without `systeminformation`'s own PowerShell calls.
 *
 * On Windows, `si.mem()` and `si.networkStats()` start several `powershell.exe` processes (page
 * file, adapter statistics, adapter list) and `si.fsSize()` another one, all without a timeout.
 * Run every 2 s they loaded WMI, and now and then one call hung for 30 to 50 minutes; the `host`
 * collector waited on it and CPU, memory, swap and network went stale ("previous run still in
 * flight"). Here:
 * - CPU and memory come from Node (`os.cpus`, `os.totalmem`, `os.freemem`), as `systeminformation`
 *   computes them on Windows anyway, so the 2 s collector starts no process at all;
 * - swap and the network byte counters come from one fixed script every 15 s (`swapnet`);
 * - disk sizes come from one fixed script per disk run;
 * both scripts run through `runPowerShell`, which kills the process after its timeout.
 */

const SWAPNET_SCRIPT = [
  `$p = @(Get-CimInstance -ClassName Win32_PageFileUsage -ErrorAction SilentlyContinue);`,
  `$a = @(Get-NetAdapterStatistics -ErrorAction SilentlyContinue);`,
  `[pscustomobject]@{`,
  `swapTotalMb = ($p | Measure-Object -Property AllocatedBaseSize -Sum).Sum;`,
  `swapUsedMb = ($p | Measure-Object -Property CurrentUsage -Sum).Sum;`,
  `rx = ($a | Measure-Object -Property ReceivedBytes -Sum).Sum;`,
  `tx = ($a | Measure-Object -Property SentBytes -Sum).Sum`,
  `} | ConvertTo-Json -Compress`,
].join(' ');

/** One `C:|NTFS|size|free` line per local drive. */
const DISKS_SCRIPT = [
  `Get-CimInstance -ClassName Win32_LogicalDisk |`,
  `ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.DeviceID, $_.FileSystem, $_.Size, $_.FreeSpace }`,
].join(' ');

export type Ps = (script: string, timeoutMs: number) => Promise<string>;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export interface SwapNetSample {
  swapTotalBytes: number;
  swapUsedBytes: number;
  rxBytes: number;
  txBytes: number;
}

export function parseSwapNet(output: string): SwapNetSample {
  const line = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('{'));
  if (!line) throw new Error('swap and network script returned no data');
  const j = JSON.parse(line) as Record<string, unknown>;
  return {
    swapTotalBytes: num(j.swapTotalMb) * 1024 * 1024,
    swapUsedBytes: num(j.swapUsedMb) * 1024 * 1024,
    rxBytes: num(j.rx),
    txBytes: num(j.tx),
  };
}

export function parseDisks(output: string): { fs: string; type: string; size: number; used: number; mount: string }[] {
  const out: { fs: string; type: string; size: number; used: number; mount: string }[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^([A-Za-z]:)\|([^|]*)\|(\d*)\|(\d*)$/.exec(line.trim());
    if (!m) continue;
    const size = Number(m[3] || 0);
    const free = Number(m[4] || 0);
    if (!(size > 0)) continue;
    out.push({ fs: m[1]!.toUpperCase(), type: m[2]!, size, used: Math.max(0, size - free), mount: m[1]!.toUpperCase() });
  }
  return out;
}

/** Swap and network rates, refreshed by its own collector; read by the 2 s host collector. */
export class SwapNetSampler {
  swapTotalBytes = 0;
  swapUsedBytes = 0;
  rxBps = 0;
  txBps = 0;
  private last: { at: number; rx: number; tx: number } | null = null;

  constructor(
    private readonly ps: Ps = runPowerShell,
    private readonly now: () => number = Date.now,
  ) {}

  async sample(): Promise<void> {
    const s = parseSwapNet(await this.ps(SWAPNET_SCRIPT, 20_000));
    const at = this.now();
    this.swapTotalBytes = s.swapTotalBytes;
    this.swapUsedBytes = s.swapUsedBytes;
    if (this.last && at > this.last.at) {
      const secs = (at - this.last.at) / 1000;
      // A counter that went down (adapter reset or removed) gives no rate for this interval.
      this.rxBps = s.rxBytes >= this.last.rx ? (s.rxBytes - this.last.rx) / secs : 0;
      this.txBps = s.txBytes >= this.last.tx ? (s.txBytes - this.last.tx) / secs : 0;
    }
    this.last = { at, rx: s.rxBytes, tx: s.txBytes };
  }

  /**
   * Every 15 s. The run may wait behind other PowerShell calls (they run one at a time, the event
   * log one for up to 40 s), so it is allowed 60 s; the script itself is killed after 20 s.
   */
  collector(): CollectorDef {
    return { name: 'swapnet', intervalMs: 15_000, timeoutMs: 60_000, run: () => this.sample() };
  }
}

/** The host source for Windows: no process for CPU, memory, swap and network; one for disks. */
export function windowsHostSource(sampler: SwapNetSampler, ps: Ps = runPowerShell): HostSource {
  return {
    currentLoad: () => si.currentLoad(),
    mem: async () => ({
      total: os.totalmem(),
      available: os.freemem(),
      swaptotal: sampler.swapTotalBytes,
      swapused: sampler.swapUsedBytes,
    }),
    networkStats: async () => [{ iface: 'all adapters', rx_sec: sampler.rxBps, tx_sec: sampler.txBps }],
    fsSize: async () => parseDisks(await ps(DISKS_SCRIPT, 10_000)),
    time: () => si.time(),
  };
}
