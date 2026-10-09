import type { GitBadge, GitState, GitStatusDto, GitSync } from '@cc/shared';
import type { CollectorDef } from '../scheduler';
import type { Db } from '../db';
import type { ServiceRow, ServicesRepo } from '../pm2/services';
import { GitHubClient, GitHubError } from './client';
import type { LocalRead } from './local';

export interface GitMonitorDeps {
  db: Db;
  services: ServicesRepo;
  /** Null when `GITHUB_TOKEN` is not set. */
  client: GitHubClient | null;
  readLocal: LocalRead;
  pollMinutes: () => number;
  now: () => number;
}

/** Reads GitHub and the server folder for every service that has a repository set. */
export class GitMonitor {
  constructor(private readonly d: GitMonitorDeps) {}

  get tokenSet(): boolean {
    return this.d.client !== null;
  }

  get(serviceId: number): GitStatusDto | null {
    const r = this.d.db.prepare('SELECT data FROM service_git WHERE service_id = ?').get(serviceId) as { data: string } | undefined;
    if (!r) return null;
    try {
      return JSON.parse(r.data) as GitStatusDto;
    } catch {
      return null;
    }
  }

  badge(serviceId: number): GitBadge | null {
    const g = this.get(serviceId);
    return g ? { state: g.state, sync: g.sync, behindBy: g.behindBy, dirty: g.dirty } : null;
  }

  forget(serviceId: number): void {
    this.d.db.prepare('DELETE FROM service_git WHERE service_id = ?').run(serviceId);
  }

  private save(g: GitStatusDto): GitStatusDto {
    this.d.db
      .prepare(
        `INSERT INTO service_git (service_id, checked_at, state, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(service_id) DO UPDATE SET checked_at = excluded.checked_at, state = excluded.state, data = excluded.data`,
      )
      .run(g.serviceId, g.checkedAt, g.state, JSON.stringify(g));
    return g;
  }

  /** Checks one service now and stores the result. Never throws. */
  async check(svc: ServiceRow): Promise<GitStatusDto | null> {
    if (!svc.git_repo) {
      this.forget(svc.id);
      return null;
    }
    const base: GitStatusDto = {
      serviceId: svc.id,
      state: 'ok',
      message: null,
      checkedAt: this.d.now(),
      repo: svc.git_repo,
      branch: svc.git_branch,
      serverSha: null,
      serverBranch: null,
      dirty: false,
      branchSha: null,
      behindBy: 0,
      aheadBy: 0,
      sync: 'unknown',
      runs: [],
      prs: [],
      lastDeployAt: null,
    };
    const fail = (state: GitState, message: string, extra: Partial<GitStatusDto> = {}) =>
      this.save({ ...base, ...extra, state, message });

    // What runs on this server (cheap and local, so it is shown even when GitHub is unreachable).
    let local: Partial<GitStatusDto> = {};
    if (svc.git_path) {
      const r = await this.d.readLocal(svc.git_path);
      if ('error' in r) return fail('no_server_commit', r.error);
      local = { serverSha: r.sha, serverBranch: r.branch, dirty: r.dirty };
    } else {
      return fail('no_server_commit', 'No folder is set for this service, so the commit on the server is unknown.');
    }

    const gh = this.d.client;
    if (!gh) return fail('no_token', 'GITHUB_TOKEN is not set on the server.', local);

    try {
      const head = await gh.branchHead(svc.git_repo, svc.git_branch);
      const out: GitStatusDto = { ...base, ...local, branchSha: head };
      const serverSha = local.serverSha as string;
      if (serverSha === head) {
        out.sync = 'in_sync';
      } else {
        try {
          const c = await gh.compare(svc.git_repo, serverSha, head);
          out.behindBy = c.aheadBy; // the branch has these commits that the server lacks
          out.aheadBy = c.behindBy;
          const map: Record<string, GitSync> = { identical: 'in_sync', ahead: 'behind', behind: 'ahead', diverged: 'diverged' };
          out.sync = map[c.status] ?? 'unknown';
        } catch (e) {
          if (e instanceof GitHubError && e.kind === 'not_found') {
            return fail('sha_unknown', 'The commit on the server is not on GitHub (was it pushed?).', { ...local, branchSha: head });
          }
          throw e;
        }
      }
      // Runs and pull requests are extras: if the token cannot read them, the rest still shows.
      const [runs, prs] = await Promise.allSettled([gh.runs(svc.git_repo, svc.git_branch), gh.openPulls(svc.git_repo)]);
      if (runs.status === 'fulfilled') {
        out.runs = runs.value;
        const deploy = runs.value.find((r) => /deploy/i.test(r.name) && r.conclusion === 'success');
        out.lastDeployAt = deploy?.at ?? null;
      }
      if (prs.status === 'fulfilled') out.prs = prs.value;
      return this.save(out);
    } catch (e) {
      if (e instanceof GitHubError) {
        const state: GitState = e.kind === 'not_found' ? 'repo_not_found' : e.kind;
        return fail(state, e.message, local);
      }
      return fail('error', 'The check failed unexpectedly.', local);
    }
  }

  /** Scheduler job: wakes every minute, checks the services whose last check is older than the interval. */
  collector(): CollectorDef {
    return {
      name: 'github',
      intervalMs: 60_000,
      timeoutMs: 55_000,
      run: async () => {
        const every = Math.max(1, this.d.pollMinutes()) * 60_000;
        for (const svc of this.d.services.list(false)) {
          if (!svc.git_repo) continue;
          const g = this.get(svc.id);
          if (g && this.d.now() - g.checkedAt < every && g.repo === svc.git_repo && g.branch === svc.git_branch) continue;
          await this.check(svc);
        }
      },
    };
  }
}
