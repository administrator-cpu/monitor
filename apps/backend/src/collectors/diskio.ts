import type { CollectorDef } from '../scheduler';
import type { DiskIo, StateStore } from '../state';
import { runPowerShell } from './powershell';

/** Per-volume throughput. Only Windows is measured (systeminformation has no Windows disk I/O). */
export interface DiskIoSource {
  read(): Promise<Map<string, DiskIo>>;
}

/**
 * Fixed script, no arguments: logical disk throughput from the WMI performance counters, one
 * `C:|read|write` line per drive letter. The class and property names are not localised.
 */
const DISK_IO_SCRIPT = [
  `Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_LogicalDisk |`,
  `Where-Object { $_.Name -match '^[A-Za-z]:$' } |`,
  `ForEach-Object { '{0}|{1}|{2}' -f $_.Name, $_.DiskReadBytesPersec, $_.DiskWriteBytesPersec }`,
].join(' ');

export function parseDiskIo(output: string): Map<string, DiskIo> {
  const out = new Map<string, DiskIo>();
  for (const line of output.split(/\r?\n/)) {
    const m = /^([A-Za-z]:)\|(\d+(?:\.\d+)?)\|(\d+(?:\.\d+)?)$/.exec(line.trim());
    if (!m) continue;
    out.set(m[1]!.toUpperCase(), { readBps: Number(m[2]), writeBps: Number(m[3]) });
  }
  return out;
}

export const windowsDiskIo: DiskIoSource = {
  async read() {
    return parseDiskIo(await runPowerShell(DISK_IO_SCRIPT, 15_000));
  },
};

/** Disk read/write throughput every 10 s; registered on Windows only. */
export function diskIoCollector(
  state: StateStore,
  src: DiskIoSource = windowsDiskIo,
  now: () => number = Date.now,
): CollectorDef {
  return {
    name: 'disk_io',
    intervalMs: 10_000,
    timeoutMs: 20_000,
    async run() {
      const map = await src.read();
      if (map.size === 0) throw new Error('no logical disk counters returned');
      state.setDiskIo(map, now());
    },
  };
}
