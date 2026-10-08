import si from 'systeminformation';
import type { DiskState } from '@cc/shared';
import type { CollectorDef } from '../scheduler';
import type { StateStore } from '../state';
import { runPowerShell } from './powershell';

/** The slice of `systeminformation` used here, injectable so tests need no real host. */
export interface HostSource {
  currentLoad(): Promise<{ currentLoad: number; cpus: { load: number }[] }>;
  mem(): Promise<{ total: number; available: number; swaptotal: number; swapused: number }>;
  networkStats(): Promise<{ iface: string; rx_sec: number | null; tx_sec: number | null }[]>;
  fsSize(): Promise<{ fs: string; type: string; size: number; used: number; mount: string }[]>;
  time(): { uptime: number };
}

const realSource: HostSource = {
  currentLoad: () => si.currentLoad(),
  mem: () => si.mem(),
  networkStats: () => si.networkStats('*'),
  fsSize: () => si.fsSize(),
  time: () => si.time(),
};

const nonNeg = (n: number | null | undefined): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;

const clampPct = (n: number): number => Math.min(100, Math.max(0, Number.isFinite(n) ? n : 0));

const isLoopback = (iface: string): boolean => {
  const n = iface.toLowerCase();
  return n === 'lo' || n.startsWith('lo:') || n.includes('loopback');
};

/** CPU (overall and per core), RAM, swap and network every 2 s (live; TRD section 4.1). */
export function cpuMemCollector(
  state: StateStore,
  now: () => number = Date.now,
  src: HostSource = realSource,
): CollectorDef {
  return {
    name: 'host',
    intervalMs: 2_000,
    timeoutMs: 8_000,
    async run() {
      const [load, mem, net] = await Promise.all([
        src.currentLoad(),
        src.mem(),
        src.networkStats(),
      ]);
      let rx = 0;
      let tx = 0;
      for (const n of net) {
        if (isLoopback(n.iface)) continue;
        // rx_sec/tx_sec are null (or -1) on the first sample; counters use deltas, so guard negatives.
        rx += nonNeg(n.rx_sec);
        tx += nonNeg(n.tx_sec);
      }
      state.setCpuMem({
        at: now(),
        cpuPct: clampPct(load.currentLoad),
        cpuPerCore: load.cpus.map((c) => clampPct(c.load)),
        memTotalBytes: mem.total,
        memUsedBytes: Math.max(0, mem.total - mem.available),
        swapTotalBytes: mem.swaptotal,
        swapUsedBytes: mem.swapused,
        netRxBps: rx,
        netTxBps: tx,
      });
    },
  };
}

const EXCLUDED_FS_TYPES = new Set(['tmpfs', 'devtmpfs', 'squashfs', 'efivarfs', 'proc', 'sysfs']);

export function selectDisks(
  raw: { fs: string; type: string; size: number; used: number; mount: string }[],
  platform: NodeJS.Platform = process.platform,
): DiskState[] {
  const seen = new Set<string>();
  const out: DiskState[] = [];
  for (const d of raw) {
    if (!(d.size > 0)) continue;
    if (platform !== 'win32' && EXCLUDED_FS_TYPES.has(d.type)) continue;
    const volume = platform === 'win32' ? d.mount.replace(/[\\/]+$/, '').toUpperCase() : d.mount;
    if (platform === 'win32' && !/^[A-Z]:$/.test(volume)) continue;
    if (seen.has(volume)) continue;
    seen.add(volume);
    // I/O rates come with the disk-I/O collector in phase 3; null means "not measured".
    out.push({ volume, usedBytes: d.used, totalBytes: d.size, readBps: null, writeBps: null });
    if (out.length >= 8) break;
  }
  return out;
}

/** Disk usage every 10 s. C: and E: are the volumes that matter on the VPS. */
export function diskCollector(
  state: StateStore,
  now: () => number = Date.now,
  src: HostSource = realSource,
): CollectorDef {
  return {
    name: 'disk',
    intervalMs: 10_000,
    timeoutMs: 15_000,
    async run() {
      state.setDisks(selectDisks(await src.fsSize()), now());
    },
  };
}

/** Fixed script: three well-known reboot-pending indicators. No arguments are interpolated. */
const PENDING_REBOOT_SCRIPT = [
  `$p = $false;`,
  `foreach ($k in @(`,
  `'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired',`,
  `'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending'`,
  `)) { if (Test-Path $k) { $p = $true } };`,
  `$v = (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager'`,
  `-Name PendingFileRenameOperations -ErrorAction SilentlyContinue).PendingFileRenameOperations;`,
  `if ($v) { $p = $true };`,
  `if ($p) { '1' } else { '0' }`,
].join(' ');

/** Uptime and pending-reboot state every 60 s. */
export function systemCollector(
  state: StateStore,
  now: () => number = Date.now,
  src: HostSource = realSource,
  platform: NodeJS.Platform = process.platform,
  ps: (script: string) => Promise<string> = runPowerShell,
): CollectorDef {
  return {
    name: 'system',
    intervalMs: 60_000,
    timeoutMs: 20_000,
    async run() {
      let pendingReboot = false;
      if (platform === 'win32') {
        pendingReboot = (await ps(PENDING_REBOOT_SCRIPT)).trim() === '1';
      }
      state.setSystem({ at: now(), uptimeS: Math.floor(src.time().uptime), pendingReboot });
    },
  };
}
