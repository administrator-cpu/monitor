/**
 * Distinct users seen within a sliding window. The identifiers live only in this process's memory
 * and only the count ever leaves it. A hard cap keeps a flood of unique ids from growing memory;
 * once full, new ids are not added until old ones expire.
 */
export class ActiveUsers {
  private seen = new Map<string, number>();

  constructor(
    private readonly windowMs = 300_000,
    private readonly maxIds = 100_000,
  ) {}

  touch(userId: string, now: number): void {
    if (!this.seen.has(userId) && this.seen.size >= this.maxIds) {
      this.prune(now);
      if (this.seen.size >= this.maxIds) return;
    }
    // delete + set keeps the map ordered by last activity, so pruning only looks at the front
    this.seen.delete(userId);
    this.seen.set(userId, now);
  }

  count(now: number): number {
    this.prune(now);
    return this.seen.size;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [id, at] of this.seen) {
      if (at > cutoff) break;
      this.seen.delete(id);
    }
  }
}
