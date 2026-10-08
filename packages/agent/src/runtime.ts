import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

export interface RuntimeReading {
  event_loop_lag_ms: { mean: number; p95: number; max: number };
  heap_used_bytes: number;
  heap_total_bytes: number;
  rss_bytes: number;
  active_handles: number;
}

const NS_PER_MS = 1e6;
/** Timer period of the histogram. Node records the whole gap between ticks, so this much is baseline, not lag. */
const RESOLUTION_MS = 10;
const round = (n: number): number => Math.round(n * 100) / 100;

/** Event-loop delay histogram (reset after each reading) plus process memory. */
export class RuntimeProbe {
  private h: IntervalHistogram | null = null;

  start(): void {
    if (this.h) return;
    this.h = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    this.h.enable();
  }

  stop(): void {
    this.h?.disable();
    this.h = null;
  }

  read(): RuntimeReading {
    const h = this.h;
    const empty = !h || h.count === 0 || !Number.isFinite(h.mean);
    const lag = empty
      ? { mean: 0, p95: 0, max: 0 }
      : {
          mean: Math.max(0, h.mean / NS_PER_MS - RESOLUTION_MS),
          p95: Math.max(0, h.percentile(95) / NS_PER_MS - RESOLUTION_MS),
          max: Math.max(0, h.max / NS_PER_MS - RESOLUTION_MS),
        };
    h?.reset();
    const mem = process.memoryUsage();
    // process._getActiveHandles is undocumented and may disappear; absence is not an error.
    const getHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
    let handles = 0;
    try {
      handles = getHandles ? getHandles.call(process).length : 0;
    } catch {
      handles = 0;
    }
    return {
      event_loop_lag_ms: { mean: round(lag.mean), p95: round(lag.p95), max: round(lag.max) },
      heap_used_bytes: mem.heapUsed,
      heap_total_bytes: mem.heapTotal,
      rss_bytes: mem.rss,
      active_handles: handles,
    };
  }
}
