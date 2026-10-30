import fs from 'node:fs';
import path from 'node:path';
import type { MonitorRunsAs } from '@cc/shared';

/**
 * How this process was started (H9). PM2 puts `pm_id` in its children's environment;
 * `scripts/install-service.ps1` sets `CC_SERVICE_NAME` for the Windows service.
 */
export function runsAs(env: NodeJS.ProcessEnv = process.env): MonitorRunsAs {
  if (env.pm_id !== undefined && /^\d+$/.test(env.pm_id)) return { kind: 'pm2', name: env.name ?? null };
  const svc = env.CC_SERVICE_NAME?.trim();
  if (svc) return { kind: 'service', name: svc };
  return { kind: 'direct', name: null };
}

const SHA = /^[0-9a-f]{40}$/;
const RECHECK_MS = 30_000;

/**
 * The commit `scripts/deploy.ps1` last deployed, from `.deploy-sha` in the repository root
 * (the folder above `apps/backend` that holds `pnpm-workspace.yaml`). The deploy writes the file
 * after the restart, so it is read again every 30 s rather than once at startup.
 */
export class DeployShaReader {
  private root: string | null | undefined;
  private cached: string | null = null;
  private readAt = -Infinity;

  constructor(
    private readonly startDir: string = process.cwd(),
    private readonly now: () => number = Date.now,
  ) {}

  /** The repository root, found by walking up at most four folders. Null when there is none. */
  private findRoot(): string | null {
    let dir = path.resolve(this.startDir);
    for (let i = 0; i < 5; i++) {
      if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return null;
  }

  get(): string | null {
    const t = this.now();
    if (t - this.readAt < RECHECK_MS) return this.cached;
    this.readAt = t;
    if (this.root === undefined) this.root = this.findRoot();
    if (this.root === null) return (this.cached = null);
    try {
      const sha = fs.readFileSync(path.join(this.root, '.deploy-sha'), 'utf8').trim().toLowerCase();
      this.cached = SHA.test(sha) ? sha : null;
    } catch {
      this.cached = null;
    }
    return this.cached;
  }
}
