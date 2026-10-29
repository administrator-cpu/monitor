import type { AccessRecord } from './parse';

export const WINDOW_MS = 10_000;
/** Response-time samples kept per service per window (a uniform sample when there are more). */
const MAX_SAMPLES = 2_000;

export interface ServiceWindow {
  serviceId: number;
  requests: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  p50Ms: number;
  p95Ms: number;
  bytesOut: number;
}

export interface NginxWindow {
  /** Start of the 10 s window, ms. */
  ts: number;
  services: ServiceWindow[];
  requests: number;
}

interface Acc {
  requests: number;
  c: [number, number, number, number]; // 2xx 3xx 4xx 5xx
  bytes: number;
  rts: number[];
  seen: number;
}

/** Nearest-rank percentile of a sorted array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}

/**
 * Turns access-log records into 10 s windows per service. Windows are keyed by the time the line
 * was read (the tailer polls every second), so a wrong clock in the log cannot misplace data.
 * Paths and client addresses are not counted: the privacy log format carries neither.
 */
export class NginxAggregator {
  private open = new Map<number, Map<number, Acc>>();
  malformedLines = 0;
  linesTotal = 0;
  lastLineAt: number | null = null;

  malformed(n = 1): void {
    this.malformedLines += n;
  }

  add(rec: AccessRecord, serviceId: number, at: number): void {
    this.linesTotal += 1;
    this.lastLineAt = at;

    const bucket = Math.floor(at / WINDOW_MS) * WINDOW_MS;
    let w = this.open.get(bucket);
    if (!w) this.open.set(bucket, (w = new Map()));
    let a = w.get(serviceId);
    if (!a) w.set(serviceId, (a = { requests: 0, c: [0, 0, 0, 0], bytes: 0, rts: [], seen: 0 }));
    a.requests += 1;
    a.bytes += rec.bytes;
    const cls = Math.floor(rec.status / 100);
    if (cls >= 2 && cls <= 5) a.c[cls - 2] = (a.c[cls - 2] as number) + 1;
    if (rec.rt !== null) {
      a.seen += 1;
      if (a.rts.length < MAX_SAMPLES) a.rts.push(rec.rt * 1000);
      else {
        const j = Math.floor(Math.random() * a.seen);
        if (j < MAX_SAMPLES) a.rts[j] = rec.rt * 1000;
      }
    }
  }

  /** Windows that are complete at `now`, oldest first. */
  advance(now: number): NginxWindow[] {
    const limit = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    const out: NginxWindow[] = [];
    for (const ts of [...this.open.keys()].sort((a, b) => a - b)) {
      if (ts >= limit) continue;
      const w = this.open.get(ts) as Map<number, Acc>;
      this.open.delete(ts);
      const services: ServiceWindow[] = [];
      let requests = 0;
      for (const [serviceId, a] of w) {
        const sorted = a.rts.slice().sort((x, y) => x - y);
        services.push({
          serviceId,
          requests: a.requests,
          s2xx: a.c[0],
          s3xx: a.c[1],
          s4xx: a.c[2],
          s5xx: a.c[3],
          p50Ms: percentile(sorted, 50),
          p95Ms: percentile(sorted, 95),
          bytesOut: a.bytes,
        });
        requests += a.requests;
      }
      services.sort((x, y) => x.serviceId - y.serviceId);
      out.push({ ts, services, requests });
    }
    return out;
  }
}
