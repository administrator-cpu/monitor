/** Nearest-rank percentile of an unsorted list (0 for an empty list). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1]!;
}

/**
 * Keeps at most `cap` samples with every observation equally likely to be present (Algorithm R),
 * so a burst of requests cannot grow memory and percentiles stay representative.
 */
export class Reservoir {
  private items: number[] = [];
  private seen = 0;

  constructor(
    private readonly cap = 2000,
    private readonly random: () => number = Math.random,
  ) {}

  add(v: number): void {
    this.seen += 1;
    if (this.items.length < this.cap) {
      this.items.push(v);
      return;
    }
    const j = Math.floor(this.random() * this.seen);
    if (j < this.cap) this.items[j] = v;
  }

  get count(): number {
    return this.seen;
  }

  percentile(p: number): number {
    return percentile(this.items, p);
  }

  reset(): void {
    this.items = [];
    this.seen = 0;
  }
}
