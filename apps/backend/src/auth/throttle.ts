/**
 * Sliding-window limiter, used per client IP for login attempts
 * (20 attempts per 10 minutes, TRD section 5).
 */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /** Records an attempt. Returns false when the key is over its limit. */
  hit(key: string): boolean {
    const ts = this.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => ts - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(ts);
    this.hits.set(key, arr);
    if (this.hits.size > this.maxKeys) this.prune(ts);
    return true;
  }

  private prune(ts: number): void {
    for (const [k, arr] of this.hits) {
      if (arr.length === 0 || ts - (arr[arr.length - 1] as number) >= this.windowMs) {
        this.hits.delete(k);
      }
    }
  }
}

/**
 * Failure tracker for usernames that do not exist. Existing users are tracked in
 * the database (`failed_attempts`, `locked_until`) so lockout survives restarts;
 * mirroring the behaviour in memory for unknown names means a lock response never
 * reveals whether a username exists.
 */
export class UnknownUserTracker {
  private state = new Map<string, { fails: number; lockedUntil: number | null }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  lockedUntil(key: string): number | null {
    const s = this.state.get(key);
    if (!s || s.lockedUntil === null) return null;
    if (s.lockedUntil <= this.now()) {
      this.state.delete(key);
      return null;
    }
    return s.lockedUntil;
  }

  recordFailure(key: string, maxFailures: number, lockMs: number): number | null {
    const s = this.state.get(key) ?? { fails: 0, lockedUntil: null };
    s.fails += 1;
    let locked: number | null = null;
    if (s.fails >= maxFailures) {
      s.fails = 0;
      s.lockedUntil = this.now() + lockMs;
      locked = s.lockedUntil;
    }
    this.state.set(key, s);
    if (this.state.size > this.maxKeys) {
      const first = this.state.keys().next().value;
      if (first !== undefined) this.state.delete(first);
    }
    return locked;
  }
}
