import type { GitPrDto, GitRunDto } from '@cc/shared';

/** Why a GitHub call did not return data. The message is safe to show: it never contains the token. */
export class GitHubError extends Error {
  constructor(
    public readonly kind: 'token_rejected' | 'not_found' | 'rate_limited' | 'error',
    message: string,
  ) {
    super(message);
  }
}

export interface Compare {
  status: 'identical' | 'ahead' | 'behind' | 'diverged';
  /** Commits `head` has that `base` lacks. */
  aheadBy: number;
  behindBy: number;
}

export interface GitHubClientOptions {
  token: string;
  /** Tests only. Production always talks to api.github.com. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface CacheEntry {
  etag: string;
  body: unknown;
}

const SHA = /^[0-9a-f]{40}$/;
const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

/** Only links that point at github.com are passed on to the browser. */
const safeUrl = (u: unknown): string => (typeof u === 'string' && u.startsWith('https://github.com/') ? u : '');

/**
 * Read-only GitHub client. Only GET requests, only to a fixed host, with a fine-grained token that
 * has read permissions. Answers are cached by ETag, and a 304 does not count against the rate limit.
 */
export class GitHubClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly o: GitHubClientOptions) {
    this.base = o.baseUrl ?? 'https://api.github.com';
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 10_000;
  }

  private async get(path: string): Promise<unknown> {
    const url = `${this.base}${path}`;
    const cached = this.cache.get(url);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        signal: ctl.signal,
        headers: {
          Authorization: `Bearer ${this.o.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'command-center-monitor',
          ...(cached ? { 'If-None-Match': cached.etag } : {}),
        },
      });
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      throw new GitHubError('error', aborted ? 'GitHub did not answer in time.' : 'Could not reach GitHub.');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 304 && cached) return cached.body;
    if (res.status === 401) throw new GitHubError('token_rejected', 'GitHub rejected the token. It may have expired or been revoked.');
    if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
      throw new GitHubError('rate_limited', 'GitHub rate limit reached. The next check will try again.');
    }
    if (res.status === 403) throw new GitHubError('token_rejected', 'The token has no permission for this call.');
    if (res.status === 404) throw new GitHubError('not_found', 'GitHub does not show this repository or branch to the token.');
    if (!res.ok) throw new GitHubError('error', `GitHub answered HTTP ${res.status}.`);
    const body: unknown = await res.json().catch(() => null);
    const etag = res.headers.get('etag');
    if (etag) this.cache.set(url, { etag, body });
    return body;
  }

  /** Latest commit on the branch. */
  async branchHead(repo: string, branch: string): Promise<string> {
    if (!OWNER_REPO.test(repo) || !REF.test(branch)) throw new GitHubError('error', 'Repository or branch name is not valid.');
    const b = (await this.get(`/repos/${repo}/branches/${encodeURIComponent(branch)}`)) as { commit?: { sha?: unknown } } | null;
    const sha = b?.commit?.sha;
    if (typeof sha !== 'string' || !SHA.test(sha)) throw new GitHubError('error', 'GitHub returned an unexpected answer.');
    return sha;
  }

  /** How far apart `base` (the server) and `head` (the branch) are. */
  async compare(repo: string, base: string, head: string): Promise<Compare> {
    if (!SHA.test(base) || !SHA.test(head)) throw new GitHubError('error', 'Not a commit id.');
    const c = (await this.get(`/repos/${repo}/compare/${base}...${head}?per_page=1`)) as
      | { status?: string; ahead_by?: unknown; behind_by?: unknown }
      | null;
    const status = c?.status;
    if (status !== 'identical' && status !== 'ahead' && status !== 'behind' && status !== 'diverged') {
      throw new GitHubError('error', 'GitHub returned an unexpected answer.');
    }
    return { status, aheadBy: Number(c?.ahead_by) || 0, behindBy: Number(c?.behind_by) || 0 };
  }

  async runs(repo: string, branch: string, limit = 5): Promise<GitRunDto[]> {
    const r = (await this.get(
      `/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=${Math.min(limit, 30)}`,
    )) as { workflow_runs?: Record<string, unknown>[] } | null;
    return (r?.workflow_runs ?? []).slice(0, limit).map((w) => ({
      id: Number(w.id) || 0,
      name: String(w.name ?? w.display_title ?? 'workflow').slice(0, 120),
      status: String(w.status ?? ''),
      conclusion: typeof w.conclusion === 'string' ? w.conclusion : null,
      sha: String(w.head_sha ?? '').slice(0, 40),
      url: safeUrl(w.html_url),
      at: Date.parse(String(w.updated_at ?? w.created_at ?? '')) || 0,
      event: String(w.event ?? ''),
    }));
  }

  async openPulls(repo: string, limit = 10): Promise<GitPrDto[]> {
    const r = (await this.get(`/repos/${repo}/pulls?state=open&per_page=${Math.min(limit, 30)}`)) as Record<string, unknown>[] | null;
    return (Array.isArray(r) ? r : []).slice(0, limit).map((p) => ({
      number: Number(p.number) || 0,
      title: String(p.title ?? '').slice(0, 200),
      author: String((p.user as { login?: unknown } | undefined)?.login ?? ''),
      draft: p.draft === true,
      url: safeUrl(p.html_url),
      updatedAt: Date.parse(String(p.updated_at ?? '')) || 0,
    }));
  }
}
