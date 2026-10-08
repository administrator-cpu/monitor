import type { LogStatus } from '@cc/shared';
import { LogPipeline } from './pipeline';
import { VolumeGuard, type VolumeGuardOptions } from './volume';
import { LogWriter, type WriterOptions } from './writer';

export interface LogSystemOptions {
  root: string;
  requireSeparateVolume: boolean;
  now?: () => number;
  ringLines: () => number;
  thresholdPct: () => number;
  retentionHours: () => number;
  warn?: WriterOptions['warn'];
  probe?: VolumeGuardOptions['probe'];
  fallbackUsedPct?: VolumeGuardOptions['fallbackUsedPct'];
  onWarning?: VolumeGuardOptions['onWarning'];
  maxQueue?: number;
}

/** The log writer, the live pipeline and the volume guard, wired together. */
export class LogSystem {
  readonly writer: LogWriter;
  readonly pipeline: LogPipeline;
  readonly volume: VolumeGuard;

  constructor(o: LogSystemOptions) {
    this.writer = new LogWriter({
      root: o.root,
      now: o.now,
      warn: o.warn,
      maxQueue: o.maxQueue,
    });
    this.pipeline = new LogPipeline({ writer: this.writer, ringLines: o.ringLines, now: o.now });
    this.volume = new VolumeGuard({
      root: o.root,
      requireSeparateVolume: o.requireSeparateVolume,
      thresholdPct: o.thresholdPct,
      retentionHours: o.retentionHours,
      writer: this.writer,
      now: o.now,
      probe: o.probe,
      fallbackUsedPct: o.fallbackUsedPct,
      warn: o.warn,
      onWarning: o.onWarning,
    });
  }

  status(): LogStatus {
    const s = this.volume.status();
    // Lines refused because too many distinct streams exist are lost too, so they count as dropped.
    return { ...s, droppedLines: s.droppedLines + this.pipeline.rejectedLines };
  }
}

export { LogPipeline } from './pipeline';
export { LogWriter } from './writer';
export { VolumeGuard } from './volume';
