import { execFile } from 'node:child_process';

/**
 * Starts one PowerShell run and calls `done` once when the process has exited. Returns a handle to
 * stop it. The real one is `execFile('powershell.exe', …)`; tests pass a fake.
 */
export type PsExec = (script: string, done: (err: Error | null, stdout: string) => void) => { pid?: number; kill: () => void };

export interface PowerShellRunnerDeps {
  exec: PsExec;
  /** Ends the process and every child it started; called after a timeout. */
  killTree: (pid: number) => void;
  now?: () => number;
  /**
   * Timed-out processes that have not exited yet. While this many are still around, no new
   * script is started, so a WMI that hangs every call cannot pile up PowerShell processes.
   */
  maxStuck?: number;
}

/** A script that cannot get at least this long to run is not started. */
export const MIN_RUN_MS = 1_000;
const DEFAULT_MAX_STUCK = 2;

/**
 * Runs FIXED PowerShell scripts one at a time (TRD section 3.1), each within its own deadline
 * (F5, 2026-10-30).
 *
 * The deadline counts from the call, including the time spent waiting behind other scripts: a
 * call that cannot start in time is refused without running ("busy"), and one that starts late
 * gets only what is left. The promise settles from its own timer, whether or not the process
 * has exited. Before F5 a call's time started only when its turn came and its promise waited for
 * `execFile`'s callback, which comes only once the process is gone; with five collectors sharing
 * the queue, slow WMI answers made the queue grow faster than it drained, and one process that
 * would not die held it outright. Every PowerShell collector behind it (disk, disk_io, system,
 * swapnet, eventlog) then stayed "in flight" (54 minutes on 2026-10-30). Each caller's timeout
 * is shorter than its collector's, so a run now always ends within its collector's timeout.
 *
 * After a timeout the process tree is killed (`taskkill /T /F`). Until such a process has
 * actually exited it counts as stuck; with `maxStuck` of them still around, new scripts are
 * refused until one exits.
 */
export class PowerShellRunner {
  private tail: Promise<unknown> = Promise.resolve();
  private stuck = 0;
  private readonly now: () => number;
  private readonly maxStuck: number;

  constructor(private readonly d: PowerShellRunnerDeps) {
    this.now = d.now ?? Date.now;
    this.maxStuck = d.maxStuck ?? DEFAULT_MAX_STUCK;
  }

  /** Timed-out processes that have not exited yet. */
  get stuckCount(): number {
    return this.stuck;
  }

  run(script: string, timeoutMs = 15_000): Promise<string> {
    const deadline = this.now() + timeoutMs;
    const job = this.tail.then(() => this.start(script, deadline, timeoutMs));
    this.tail = job.catch(() => undefined);
    return job;
  }

  private start(script: string, deadline: number, timeoutMs: number): Promise<string> {
    const left = deadline - this.now();
    if (left < MIN_RUN_MS) {
      return Promise.reject(new Error(`PowerShell busy: earlier scripts used the ${timeoutMs} ms`));
    }
    if (this.stuck >= this.maxStuck) {
      return Promise.reject(new Error(`PowerShell not started: ${this.stuck} timed-out processes have not exited yet`));
    }
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let exited = false;
      let counted = false;
      let timer: NodeJS.Timeout | undefined;
      const child = this.d.exec(script, (err, stdout) => {
        exited = true;
        if (counted) this.stuck -= 1;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(stdout);
      });
      if (settled) return; // a fake that answers at once
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (!exited) {
          counted = true;
          this.stuck += 1;
          try {
            child.kill();
          } catch {
            // already gone
          }
          if (child.pid) this.d.killTree(child.pid);
        }
        reject(new Error(`PowerShell timed out after ${Math.round(left)} ms`));
      }, left);
    });
  }
}

const realExec: PsExec = (script, done) =>
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script],
    { windowsHide: true, maxBuffer: 1024 * 1024 },
    (err, stdout) => done(err, String(stdout)),
  );

/** `taskkill` with fixed arguments and a numeric pid; its result is not needed. */
const realKillTree = (pid: number): void => {
  execFile('taskkill', ['/PID', String(Math.trunc(pid)), '/T', '/F'], { windowsHide: true }, () => undefined);
};

const shared = new PowerShellRunner({ exec: realExec, killTree: realKillTree });

/**
 * Runs a FIXED script in Windows PowerShell. Callers pass constant strings only: there is no
 * user-supplied argument, so there is no injection surface. One at a time, each within
 * `timeoutMs` counted from the call (see PowerShellRunner).
 */
export function runPowerShell(script: string, timeoutMs = 15_000): Promise<string> {
  return shared.run(script, timeoutMs);
}
