export type Agg = 'avg' | 'max' | 'min' | 'last' | 'sum';

export interface Column<T> {
  pick: (row: T) => number | null | undefined;
  agg: Agg;
}

/** A fixed time grid shared by every series of one response, so charts line up. */
export interface Grid {
  from: number;
  to: number;
  stepMs: number;
  /** Start of the first bucket (a multiple of `stepMs`). */
  anchor: number;
  size: number;
}

export const RAW_STEP_MS = 10_000;

/**
 * The bucket size is the smallest multiple of 10 s that keeps the response within `maxPoints`.
 * A range that already fits is returned at its stored resolution.
 */
export function makeGrid(from: number, to: number, maxPoints = 600): Grid {
  const span = to - from;
  const stepMs = Math.max(RAW_STEP_MS, Math.ceil(span / maxPoints / RAW_STEP_MS) * RAW_STEP_MS);
  const anchor = Math.floor(from / stepMs) * stepMs;
  const size = Math.max(1, Math.ceil((to - anchor) / stepMs));
  return { from, to, stepMs, anchor, size };
}

function reduce(values: number[], agg: Agg): number | null {
  if (values.length === 0) return null;
  switch (agg) {
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'max':
      return Math.max(...values);
    case 'min':
      return Math.min(...values);
    case 'last':
      return values[values.length - 1]!;
  }
}

/** Bucket start times in seconds, the layout uPlot consumes. */
export const gridTimes = (g: Grid): number[] => Array.from({ length: g.size }, (_, i) => Math.round((g.anchor + i * g.stepMs) / 1000));

/**
 * Puts time-ordered rows on the grid, each column with its own aggregation (peaks stay peaks, counts
 * add up). A bucket with no data is null, so a gap in the data is a gap in the chart.
 */
export function fill<T, K extends string>(
  g: Grid,
  rows: T[],
  tsOf: (row: T) => number,
  columns: Record<K, Column<T>>,
): Record<K, (number | null)[]> {
  const keys = Object.keys(columns) as K[];
  const buckets: Record<string, number[][]> = Object.fromEntries(keys.map((k) => [k, Array.from({ length: g.size }, () => [] as number[])]));
  for (const r of rows) {
    const i = Math.floor((tsOf(r) - g.anchor) / g.stepMs);
    if (i < 0 || i >= g.size) continue;
    for (const k of keys) {
      const v = columns[k].pick(r);
      if (v !== null && v !== undefined && Number.isFinite(v)) buckets[k]![i]!.push(v);
    }
  }
  return Object.fromEntries(keys.map((k) => [k, buckets[k]!.map((b) => reduce(b, columns[k].agg))])) as Record<K, (number | null)[]>;
}

/**
 * Parses `from` / `to` (epoch ms). Returns null for a range that is empty, reversed or longer than
 * `maxMs` (the metrics retention, see `rangeLimits`). A missing `from` falls back to `defaultMs`
 * before `to`, never more than `maxMs`.
 */
export function parseRange(
  q: { from?: string; to?: string },
  now: number,
  maxMs: number,
  defaultMs = 3_600_000,
): { from: number; to: number } | null {
  const num = (s: string | undefined): number | null => (s !== undefined && s !== '' && Number.isFinite(Number(s)) ? Number(s) : null);
  const to = num(q.to) ?? now;
  const from = num(q.from) ?? to - Math.min(defaultMs, maxMs);
  if (!(from < to) || to - from > maxMs || from < 0) return null;
  return { from, to };
}
