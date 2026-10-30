import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PowerShellRunner, type PsExec } from '../src/collectors/powershell';

/**
 * F5 (2026-10-30): one hung `powershell.exe` held the shared queue, so disk, disk_io and system
 * stayed "in flight" for 54 minutes. A fake exec stands in for `execFile`: each run is held until
 * the test lets it exit (or never does).
 */
function fakeExec() {
  const runs: { script: string; pid: number; killed: boolean; exit: (out?: string, err?: Error) => void }[] = [];
  let pid = 100;
  const exec: PsExec = (script, done) => {
    const run = { script, pid: ++pid, killed: false, exit: (out = '', err?: Error) => done(err ?? null, out) };
    runs.push(run);
    return { pid: run.pid, kill: () => void (run.killed = true) };
  };
  return { exec, runs };
}

describe('PowerShellRunner (F5)', () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_800_000_000_000 }));
  afterEach(() => vi.useRealTimers());

  const settle = () => vi.advanceTimersByTimeAsync(0);

  it('runs one script at a time and returns its output', async () => {
    const f = fakeExec();
    const r = new PowerShellRunner({ exec: f.exec, killTree: () => undefined });
    const a = r.run('A', 10_000);
    const b = r.run('B', 10_000);
    await settle();
    expect(f.runs.map((x) => x.script)).toEqual(['A']); // B waits its turn
    f.runs[0]!.exit('one');
    await expect(a).resolves.toBe('one');
    await settle();
    f.runs[1]!.exit('two');
    await expect(b).resolves.toBe('two');
  });

  it('gives up on a process that never exits at its timeout, kills its tree, and lets the next one run', async () => {
    const f = fakeExec();
    const killed: number[] = [];
    const r = new PowerShellRunner({ exec: f.exec, killTree: (p) => killed.push(p) });
    const hung = r.run('HUNG', 10_000);
    const next = r.run('NEXT', 30_000);
    const hungDone = expect(hung).rejects.toThrow('PowerShell timed out after 10000 ms');
    await vi.advanceTimersByTimeAsync(10_000);
    await hungDone;
    expect(f.runs[0]!.killed).toBe(true);
    expect(killed).toEqual([f.runs[0]!.pid]);
    expect(r.stuckCount).toBe(1);
    // The queue moved on although the first process has not exited.
    expect(f.runs.map((x) => x.script)).toEqual(['HUNG', 'NEXT']);
    f.runs[1]!.exit('ok');
    await expect(next).resolves.toBe('ok');
    // When the stuck one finally exits, nothing is settled twice and it no longer counts.
    f.runs[0]!.exit('late');
    expect(r.stuckCount).toBe(0);
  });

  it('counts the wait in the queue against the caller’s timeout', async () => {
    const f = fakeExec();
    const r = new PowerShellRunner({ exec: f.exec, killTree: () => undefined });
    const slow = r.run('SLOW', 10_000);
    const short = r.run('SHORT', 5_000); // cannot start before its 5 s are up
    const long = r.run('LONG', 20_000); // starts after 10 s with 10 s left
    const slowDone = expect(slow).rejects.toThrow('timed out');
    const shortDone = expect(short).rejects.toThrow('PowerShell busy');
    await vi.advanceTimersByTimeAsync(10_000);
    await slowDone;
    await shortDone;
    expect(f.runs.map((x) => x.script)).toEqual(['SLOW', 'LONG']); // SHORT never started
    const longDone = expect(long).rejects.toThrow('PowerShell timed out after 10000 ms');
    await vi.advanceTimersByTimeAsync(10_000);
    await longDone;
  });

  it('starts nothing while too many timed-out processes are still alive, and resumes when one exits', async () => {
    const f = fakeExec();
    const r = new PowerShellRunner({ exec: f.exec, killTree: () => undefined, maxStuck: 2 });
    for (const s of ['H1', 'H2']) {
      const p = r.run(s, 2_000);
      const done = expect(p).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(2_000);
      await done;
    }
    expect(r.stuckCount).toBe(2);
    await expect(r.run('THIRD', 5_000)).rejects.toThrow('2 timed-out processes have not exited yet');
    expect(f.runs).toHaveLength(2);
    f.runs[0]!.exit();
    const fourth = r.run('FOURTH', 5_000);
    await settle();
    f.runs[2]!.exit('back');
    await expect(fourth).resolves.toBe('back');
  });

  it('passes on a failing script’s error and keeps going', async () => {
    const f = fakeExec();
    const r = new PowerShellRunner({ exec: f.exec, killTree: () => undefined });
    const bad = r.run('BAD');
    const good = r.run('GOOD');
    await settle();
    f.runs[0]!.exit('', new Error('exit code 1'));
    await expect(bad).rejects.toThrow('exit code 1');
    await settle();
    f.runs[1]!.exit('fine');
    await expect(good).resolves.toBe('fine');
    expect(r.stuckCount).toBe(0);
  });
});
