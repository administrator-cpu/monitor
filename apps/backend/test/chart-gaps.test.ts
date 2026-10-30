import { describe, expect, it } from 'vitest';
import { breakGaps } from '@cc/shared';

/** The chart helper the dashboard uses so a stretch without samples is a gap, not a line (V28). */
describe('breakGaps', () => {
  it('leaves data without a gap as it is', () => {
    const d = [
      [0, 10, 20, 30],
      [1, 2, 3, 4],
    ];
    expect(breakGaps(d)).toBe(d);
    expect(breakGaps([[0, 100], [1, 2]])).toEqual([[0, 100], [1, 2]]); // too few points to judge
  });

  it('puts one null point in each gap longer than three usual steps, in every series', () => {
    // 10 s steps, then the agent was off for 11 minutes, then 10 s steps again.
    const ts = [0, 10, 20, 30, 690, 700, 710];
    const out = breakGaps([ts, [1, 2, 3, 4, 5, 6, 7], [7, 6, 5, 4, 3, 2, 1]]);
    expect(out).toEqual([
      [0, 10, 20, 30, 40, 690, 700, 710],
      [1, 2, 3, 4, null, 5, 6, 7],
      [7, 6, 5, 4, null, 3, 2, 1],
    ]);
  });

  it('ignores short jitter and respects the minimum gap', () => {
    // 2 s live samples with one 8 s hiccup: below the 30 s minimum, so no gap.
    const ts = [0, 2, 4, 6, 14, 16, 18];
    const d = [ts, ts.map(() => 1)];
    expect(breakGaps(d)).toBe(d);
    // History at one point per 3 minutes: a missing point (6 min) is a gap only past 3 steps.
    const h = [0, 180, 360, 540, 720, 1440, 1620];
    expect((breakGaps([h, h.map(() => 1)]) as number[][])[1]).toEqual([1, 1, 1, 1, 1, null, 1, 1]);
    const once = [0, 180, 360, 720, 900, 1080];
    expect(breakGaps([once, once.map(() => 1)])[0]).toBe(once);
  });
});
