import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../src/check';
import { Machine, type EmailFacts, type EmailKind } from '../src/machine';

const MIN = 60_000;
const OK: CheckResult = { ok: true, attempts: 1 };
const DOWN: CheckResult = { ok: false, kind: 'unreachable', detail: 'connection refused', attempts: 3 };
const BAD: CheckResult = { ok: false, kind: 'bad_response', detail: 'HTTP 502', attempts: 3 };

function sim(opts: { deliver?: () => boolean } = {}) {
  const clock = { t: 1_800_000_000_000 };
  const sent: EmailFacts[] = [];
  const m = new Machine({
    now: () => clock.t,
    send: async (e) => {
      if (opts.deliver && !opts.deliver()) return false;
      sent.push(e);
      return true;
    },
    reminderAfterMs: 60 * MIN,
    flapWindowMs: 30 * MIN,
    recoverySuccesses: 2,
  });
  /** One ping every 5 minutes, as cron-job.org does. */
  const ping = async (r: CheckResult, advanceMin = 5) => {
    clock.t += advanceMin * MIN;
    await m.onCheck(r);
  };
  const kinds = (): EmailKind[] => sent.map((e) => e.kind);
  return { m, sent, kinds, ping, clock };
}

describe('watchdog state machine', () => {
  it('stays quiet while the target is healthy', async () => {
    const s = sim();
    for (let i = 0; i < 50; i++) await s.ping(OK);
    expect(s.sent).toHaveLength(0);
    expect(s.m.state().phase).toBe('UP');
  });

  it('a simulated outage gives exactly one down email, one reminder after 60 minutes, one back-online after two successes', async () => {
    const s = sim();
    await s.ping(OK);
    await s.ping(DOWN);
    expect(s.kinds()).toEqual(['down']);
    for (let i = 0; i < 11; i++) await s.ping(DOWN); // up to 55 minutes after detection
    expect(s.kinds()).toEqual(['down']);
    await s.ping(DOWN); // 60 minutes
    expect(s.kinds()).toEqual(['down', 'reminder']);
    for (let i = 0; i < 30; i++) await s.ping(DOWN); // hours more of outage: nothing further
    expect(s.kinds()).toEqual(['down', 'reminder']);

    await s.ping(OK);
    expect(s.kinds()).toEqual(['down', 'reminder']); // one success is not recovery
    expect(s.m.state().phase).toBe('DOWN');
    await s.ping(OK);
    expect(s.kinds()).toEqual(['down', 'reminder', 'recovered']);
    expect(s.m.state().phase).toBe('RECOVERING');
    for (let i = 0; i < 10; i++) await s.ping(OK);
    expect(s.kinds()).toHaveLength(3);
    expect(s.m.state().phase).toBe('UP');
  });

  it('a success between failures resets the recovery count', async () => {
    const s = sim();
    await s.ping(DOWN);
    await s.ping(OK);
    await s.ping(DOWN);
    await s.ping(OK);
    expect(s.m.state().phase).toBe('DOWN');
    expect(s.kinds()).toEqual(['down']);
  });

  it('fail, recover, fail again within 30 minutes: no second down email and the reminder clock continues', async () => {
    const s = sim();
    await s.ping(DOWN);
    await s.ping(OK);
    await s.ping(OK); // recovered email
    expect(s.kinds()).toEqual(['down', 'recovered']);
    await s.ping(DOWN); // 5 minutes after recovery
    expect(s.m.state()).toMatchObject({ phase: 'DOWN', incident: 1 });
    expect(s.kinds()).toEqual(['down', 'recovered']); // no new down, no second recovered budget
    for (let i = 0; i < 12; i++) await s.ping(DOWN);
    expect(s.kinds()).toEqual(['down', 'recovered', 'reminder']); // 60 min after the ORIGINAL detection
    await s.ping(OK);
    await s.ping(OK);
    expect(s.sent).toHaveLength(3); // three emails for the whole outage
  });

  it('a failure after the 30-minute window is a new outage with its own emails', async () => {
    const s = sim();
    await s.ping(DOWN);
    await s.ping(OK);
    await s.ping(OK);
    for (let i = 0; i < 7; i++) await s.ping(OK); // 35 minutes of success
    expect(s.m.state().phase).toBe('UP');
    await s.ping(DOWN);
    expect(s.kinds()).toEqual(['down', 'recovered', 'down']);
    expect(s.sent[2]?.incident).toBe(2);
  });

  it('reports which kind of failure it was', async () => {
    const a = sim();
    await a.ping(DOWN);
    expect(a.sent[0]?.failure?.kind).toBe('unreachable');
    const b = sim();
    await b.ping(BAD);
    expect(b.sent[0]?.failure).toMatchObject({ kind: 'bad_response', detail: 'HTTP 502' });
  });

  it('a down email that fails to send is retried on the next check, and sent only once when accepted', async () => {
    let ok = false;
    const s = sim({ deliver: () => ok });
    await s.ping(DOWN);
    await s.ping(DOWN);
    expect(s.sent).toHaveLength(0);
    expect(s.m.state().owed).toEqual(['down']);
    ok = true;
    await s.ping(DOWN);
    expect(s.kinds()).toEqual(['down']);
    for (let i = 0; i < 5; i++) await s.ping(DOWN);
    expect(s.kinds()).toEqual(['down']);
  });

  it('never announces "back online" for an outage whose down email was never delivered', async () => {
    const s = sim({ deliver: () => false });
    await s.ping(DOWN);
    await s.ping(OK);
    await s.ping(OK);
    expect(s.m.state().owed).toEqual([]);
    expect(s.sent).toHaveLength(0);
  });

  it('drops a reminder that became pointless when the target recovered', async () => {
    let ok = true;
    const s = sim({ deliver: () => ok });
    await s.ping(DOWN);
    ok = false;
    for (let i = 0; i < 12; i++) await s.ping(DOWN); // reminder due but undeliverable
    expect(s.m.state().owed).toContain('reminder');
    await s.ping(OK);
    ok = true;
    await s.ping(OK);
    expect(s.kinds()).toEqual(['down', 'recovered']);
  });

  it('never exceeds three emails per outage, whatever the sequence of results', async () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let run = 0; run < 200; run++) {
      const s = sim();
      let upSinceLastFail = 0;
      for (let i = 0; i < 400; i++) {
        const p = i % 80 < 40 ? 0.8 : 0.2; // alternating mostly-down and mostly-up stretches
        await s.ping(rnd() < p ? DOWN : OK, 1 + Math.floor(rnd() * 10));
        upSinceLastFail = s.m.state().phase === 'UP' ? upSinceLastFail + 1 : 0;
      }
      const perIncident = new Map<number, string[]>();
      for (const e of s.sent) perIncident.set(e.incident, [...(perIncident.get(e.incident) ?? []), e.kind]);
      for (const [, kinds] of perIncident) {
        expect(kinds.length).toBeLessThanOrEqual(3);
        expect(new Set(kinds).size).toBe(kinds.length); // no kind twice
        expect(kinds[0]).toBe('down');
      }
    }
  });

  it('a restart during an outage starts in UP and announces the outage again (at most one repeat)', async () => {
    const first = sim();
    await first.ping(DOWN);
    const restarted = sim(); // fresh memory
    await restarted.ping(DOWN);
    expect(first.kinds()).toEqual(['down']);
    expect(restarted.kinds()).toEqual(['down']);
    await restarted.ping(DOWN);
    expect(restarted.kinds()).toEqual(['down']);
  });
});
