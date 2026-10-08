import fs from 'node:fs/promises';
import path from 'node:path';
import type { LogStatus } from '@cc/shared';
import { deleteExpired, deleteOldestHour } from './files';
import type { LogWriter } from './writer';

export type VolumeReason = 'missing' | 'same_volume' | 'error';

/** The parts of the operating system the guard needs, injectable so tests need no real disks. */
export interface VolumeProbe {
  /** Creates the root if its volume exists; throws when it cannot be created. */
  ensureDir(root: string): Promise<void>;
  /** Used space of the volume holding `root`, as a percentage. */
  usedPct(root: string): Promise<number>;
  /** True when `root` is on the same volume as the operating system. */
  isSystemVolume(root: string): Promise<boolean>;
}

export const realVolumeProbe: VolumeProbe = {
  async ensureDir(root) {
    await fs.mkdir(root, { recursive: true });
  },
  async usedPct(root) {
    const s = await fs.statfs(root);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    return total > 0 ? ((total - free) / total) * 100 : 0;
  },
  async isSystemVolume(root) {
    if (process.platform === 'win32') {
      const drive = path.parse(path.resolve(root)).root.toUpperCase();
      const system = `${(process.env.SystemDrive ?? 'C:').toUpperCase()}\\`;
      return drive === system;
    }
    const [a, b] = await Promise.all([fs.stat(root), fs.stat('/')]);
    return a.dev === b.dev;
  },
};

export interface VolumeState {
  ok: boolean;
  reason: VolumeReason | null;
  usedPct: number;
  lastCheckAt: number | null;
  /** Hours of logs removed early by the disk guard since start. */
  trimmedHours: number;
}

export interface VolumeGuardOptions {
  root: string;
  requireSeparateVolume: boolean;
  thresholdPct: () => number;
  retentionHours: () => number;
  writer: LogWriter;
  now?: () => number;
  probe?: VolumeProbe;
  /** Usage from another source (the disk collector) when `statfs` is unavailable. */
  fallbackUsedPct?: (root: string) => number | null;
  warn?: (obj: Record<string, unknown>, msg: string) => void;
  /** Called on every ok/reason transition and on threshold crossings. */
  onWarning?: (code: 'log_volume_high' | 'log_volume_missing', detail: Record<string, unknown>) => void;
}

/**
 * Checks every minute that the log root exists, is not on the system volume, and is not filling
 * up. When the volume is unusable the writer stops (lines stay visible live); above the usage
 * threshold the oldest hour across all services is removed until usage falls below it.
 */
export class VolumeGuard {
  private readonly now: () => number;
  private readonly probe: VolumeProbe;
  private st: VolumeState = {
    ok: true,
    reason: null,
    usedPct: 0,
    lastCheckAt: null,
    trimmedHours: 0,
  };
  private warnedHigh = false;

  constructor(private readonly o: VolumeGuardOptions) {
    this.now = o.now ?? Date.now;
    this.probe = o.probe ?? realVolumeProbe;
  }

  state(): VolumeState {
    return { ...this.st };
  }

  async check(): Promise<void> {
    const at = this.now();
    const prevOk = this.st.ok;
    let ok = true;
    let reason: VolumeReason | null = null;

    try {
      await this.probe.ensureDir(this.o.root);
    } catch (e) {
      ok = false;
      reason = 'missing';
      this.o.warn?.({ err: (e as Error).message }, 'log root is not available');
    }

    if (ok && this.o.requireSeparateVolume) {
      try {
        if (await this.probe.isSystemVolume(this.o.root)) {
          ok = false;
          reason = 'same_volume';
        }
      } catch (e) {
        ok = false;
        reason = 'error';
        this.o.warn?.({ err: (e as Error).message }, 'could not compare log volume with system volume');
      }
    }

    let usedPct = this.st.usedPct;
    if (ok) {
      try {
        usedPct = await this.readUsage();
      } catch (e) {
        ok = false;
        reason = 'error';
        this.o.warn?.({ err: (e as Error).message }, 'could not read log volume usage');
      }
    }

    if (ok) {
      try {
        await deleteExpired(this.o.root, at, this.o.retentionHours());
        usedPct = await this.trimIfNeeded(usedPct, at);
      } catch (e) {
        this.o.warn?.({ err: (e as Error).message }, 'log trim failed');
      }
    }

    this.st = { ...this.st, ok, reason, usedPct, lastCheckAt: at };
    this.o.writer.setEnabled(ok);

    if (!ok && prevOk) this.o.onWarning?.('log_volume_missing', { reason });
    const high = ok && usedPct >= this.o.thresholdPct();
    if (high && !this.warnedHigh) this.o.onWarning?.('log_volume_high', { usedPct });
    this.warnedHigh = high;
  }

  private async readUsage(): Promise<number> {
    try {
      return await this.probe.usedPct(this.o.root);
    } catch (e) {
      const fb = this.o.fallbackUsedPct?.(this.o.root);
      if (fb != null) return fb;
      throw e;
    }
  }

  /** Removes the oldest hour (all services) while usage is above the threshold. */
  private async trimIfNeeded(startPct: number, at: number): Promise<number> {
    let pct = startPct;
    for (let i = 0; i < 48 && pct >= this.o.thresholdPct(); i++) {
      const removed = await deleteOldestHour(this.o.root, at);
      if (removed === 0) break; // nothing older than the current hour is left to remove
      this.st.trimmedHours += 1;
      pct = await this.readUsage();
    }
    return pct;
  }

  /** Merges the guard state and the writer counters into the status shown to the UI. */
  status(): LogStatus {
    const w = this.o.writer.stats();
    return {
      volumeOk: this.st.ok,
      volumeReason: this.st.reason,
      volumeUsedPct: Math.round(this.st.usedPct * 10) / 10,
      droppedLines: w.dropped,
      skippedLines: w.skipped,
      writerQueue: w.queue,
    };
  }
}
