import fs from 'node:fs';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import type { MonitorHealth } from '@cc/shared';
import { DeployShaReader, runsAs } from './self-info';

/** The monitor watching itself (TRD section 8). */
export class MonitorHealthReporter {
  private histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: 20 });
  private resetTimer: NodeJS.Timeout | null = null;
  private lastP95Ms = 0;
  private lastMaxMs = 0;
  private lastCpu = process.cpuUsage();
  private lastCpuAt = Date.now();
  private cpuPct = 0;

  private readonly runsAs = runsAs();

  constructor(
    private readonly sqlitePath: string,
    private readonly wsClients: () => number,
    private readonly deploySha: DeployShaReader = new DeployShaReader(),
  ) {}

  start(): void {
    this.histogram.enable();
    // Roll the histogram window every 10 s so the numbers describe recent behaviour.
    this.resetTimer = setInterval(() => this.roll(), 10_000);
    this.resetTimer.unref();
  }

  stop(): void {
    this.histogram.disable();
    if (this.resetTimer) clearInterval(this.resetTimer);
    this.resetTimer = null;
  }

  private roll(): void {
    if (this.histogram.count > 0) {
      this.lastP95Ms = this.histogram.percentile(95) / 1e6;
      this.lastMaxMs = this.histogram.max / 1e6;
    }
    this.histogram.reset();
    const nowMs = Date.now();
    const cpu = process.cpuUsage();
    const usedMicros = cpu.user + cpu.system - (this.lastCpu.user + this.lastCpu.system);
    const elapsedMicros = (nowMs - this.lastCpuAt) * 1000;
    this.cpuPct = elapsedMicros > 0 ? Math.min(100, (usedMicros / elapsedMicros) * 100) : 0;
    this.lastCpu = cpu;
    this.lastCpuAt = nowMs;
  }

  snapshot(): MonitorHealth {
    const mem = process.memoryUsage();
    let sqliteBytes: number | null = null;
    try {
      if (this.sqlitePath !== ':memory:') sqliteBytes = fs.statSync(this.sqlitePath).size;
    } catch {
      sqliteBytes = null;
    }
    return {
      pid: process.pid,
      runsAs: this.runsAs,
      deployedSha: this.deploySha.get(),
      uptimeS: Math.floor(process.uptime()),
      cpuPct: round1(this.cpuPct),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      eventLoopLagP95Ms: round1(this.lastP95Ms),
      eventLoopLagMaxMs: round1(this.lastMaxMs),
      wsClients: this.wsClients(),
      sqliteBytes,
    };
  }
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
