import { execFile } from 'node:child_process';

let tail: Promise<unknown> = Promise.resolve();

/**
 * Runs a FIXED script in Windows PowerShell. Callers pass constant strings only:
 * there is no user-supplied argument, so there is no injection surface.
 * Calls are serialised (concurrency limit 1) and time out (TRD section 3.1).
 */
export function runPowerShell(script: string, timeoutMs = 15_000): Promise<string> {
  const job = tail.then(
    () =>
      new Promise<string>((resolve, reject) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script],
          { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
          (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
        );
      }),
  );
  tail = job.catch(() => undefined);
  return job;
}
