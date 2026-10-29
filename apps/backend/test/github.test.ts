import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubClient } from '../src/github/client';
import { gitArgs, readLocalCommit } from '../src/github/local';
import { addUser, authed, login, makeApp, type TestApp } from './helpers';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

interface Call {
  url: string;
  headers: Record<string, string>;
  method?: string;
}

/** A fake GitHub: routes by path suffix. */
function fakeGithub(routes: Record<string, () => { status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, method: init.method });
    const u = new URL(url);
    const key = Object.keys(routes).find((k) => u.pathname.includes(k));
    if (!key) return new Response('{}', { status: 404 });
    const r = routes[key]!();
    const h = new Headers(r.headers);
    if (r.status === 304) return new Response(null, { status: 304, headers: h });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: h });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const okRoutes = (serverBehind = true) => ({
  '/branches/main': () => ({ body: { commit: { sha: serverBehind ? B : A } } }),
  '/compare/': () => ({ body: { status: 'ahead', ahead_by: 3, behind_by: 0 } }),
  '/actions/runs': () => ({
    body: {
      workflow_runs: [
        { id: 1, name: 'Deploy backend', status: 'completed', conclusion: 'success', head_sha: B, html_url: 'https://github.com/o/r/actions/runs/1', updated_at: '2026-10-01T10:00:00Z', event: 'push' },
        { id: 2, name: 'CI', status: 'completed', conclusion: 'failure', head_sha: B, html_url: 'https://evil.example/x', updated_at: '2026-10-01T09:00:00Z', event: 'push' },
      ],
    },
  }),
  '/pulls': () => ({ body: [{ number: 7, title: 'Fix', user: { login: 'dev' }, draft: false, html_url: 'https://github.com/o/r/pull/7', updated_at: '2026-10-02T00:00:00Z' }] }),
});

describe('GitHubClient', () => {
  it('sends the token only as a header, GET only, and reuses answers through ETag', async () => {
    let n = 0;
    const g = fakeGithub({
      '/branches/main': () => (++n === 1 ? { body: { commit: { sha: A } }, headers: { etag: '"x"' } } : { status: 304 }),
    });
    const c = new GitHubClient({ token: 'tok_secret_value', fetchImpl: g.fetchImpl });
    expect(await c.branchHead('o/r', 'main')).toBe(A);
    expect(await c.branchHead('o/r', 'main')).toBe(A);
    expect(g.calls.every((x) => x.method === 'GET' && !x.url.includes('tok_secret_value'))).toBe(true);
    expect(g.calls[0]!.headers.Authorization).toBe('Bearer tok_secret_value');
    expect(g.calls[1]!.headers['If-None-Match']).toBe('"x"');
    expect(g.calls[0]!.url.startsWith('https://api.github.com/')).toBe(true);
  });

  it('maps failures to plain errors that never contain the token', async () => {
    const mk = (status: number, headers: Record<string, string> = {}) =>
      new GitHubClient({ token: 'tok_secret_value', fetchImpl: fakeGithub({ '/branches': () => ({ status, headers }) }).fetchImpl });
    await expect(mk(401).branchHead('o/r', 'main')).rejects.toMatchObject({ kind: 'token_rejected' });
    await expect(mk(404).branchHead('o/r', 'main')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(mk(403, { 'x-ratelimit-remaining': '0' }).branchHead('o/r', 'main')).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(mk(500).branchHead('o/r', 'main')).rejects.toMatchObject({ kind: 'error' });
  });

  it('refuses names that could change the request path', async () => {
    const c = new GitHubClient({ token: 'tok_secret_value', fetchImpl: fakeGithub({}).fetchImpl });
    await expect(c.branchHead('o/r/../../x', 'main')).rejects.toMatchObject({ kind: 'error' });
    await expect(c.branchHead('o/r', '../x?y')).rejects.toMatchObject({ kind: 'error' });
  });

  it('drops links that do not point at github.com', async () => {
    const g = fakeGithub(okRoutes());
    const c = new GitHubClient({ token: 'tok_secret_value', fetchImpl: g.fetchImpl });
    const runs = await c.runs('o/r', 'main');
    expect(runs[0]!.url).toBe('https://github.com/o/r/actions/runs/1');
    expect(runs[1]!.url).toBe('');
  });
});

describe('readLocalCommit', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-git-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  it('reads .deploy-sha for a deploy folder without git', async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, '.deploy-sha'), `${A}\r\n`);
    expect(await readLocalCommit(d)).toMatchObject({ sha: A, source: 'deploy-marker', dirty: false });
  });

  it('explains an empty or invalid marker, and a missing folder', async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, '.deploy-sha'), '');
    expect(await readLocalCommit(d)).toHaveProperty('error');
    expect(await readLocalCommit(path.join(d, 'nope'))).toMatchObject({ error: expect.stringContaining('does not exist') });
  });

  it('turns off core.fsmonitor and trusts the folder on every call, before -C', () => {
    const args = gitArgs('C:\\repo', ['status', '--porcelain']);
    expect(args).toEqual(['-c', 'safe.directory=*', '-c', 'core.fsmonitor=false', '-C', 'C:\\repo', 'status', '--porcelain']);
  });

  const hasGit = (() => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasGit || process.platform === 'win32')('does not start a program named in the repository\'s core.fsmonitor', async () => {
    const d = tmp();
    const run = (...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    run('init', '-q');
    fs.writeFileSync(path.join(d, 'f.txt'), 'x');
    run('add', 'f.txt');
    run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'c');
    const marker = path.join(d, 'ran');
    const hook = path.join(d, 'hook.sh');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    run('config', 'core.fsmonitor', hook);

    // The planted program does run for a plain `git status`, so the check below means something.
    execFileSync('git', ['-C', d, 'status', '--porcelain'], { stdio: 'ignore' });
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);

    const r = await readLocalCommit(d);
    expect(r).toMatchObject({ source: 'git', dirty: false });
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('git status API', () => {
  let t: TestApp;
  afterEach(async () => t.close());

  async function setup(routes: ReturnType<typeof okRoutes> | null, local: { sha: string } | { error: string }, token = true) {
    const g = routes ? fakeGithub(routes) : null;
    t = await makeApp({
      overrides: {
        github: {
          client: token && g ? new GitHubClient({ token: 'tok_secret_value', fetchImpl: g.fetchImpl }) : null,
          readLocal: async () => ('error' in local ? local : { sha: local.sha, branch: 'main', dirty: false, source: 'git' }),
        },
      },
    });
    await addUser(t);
    await addUser(t, { username: 'eng', role: 'engineer' });
    const admin = (await login(t)).cookie!;
    const eng = (await login(t, 'eng')).cookie!;
    const svc = t.ctx.services.discover('shop');
    return { admin, eng, id: svc.id };
  }
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string, payload?: object) =>
    t.app.inject({ method, url: `/api/v1${url}`, headers: authed(cookie), payload });

  it('is empty until an admin maps the service, and mapping is admin-only', async () => {
    const { admin, eng, id } = await setup(okRoutes(), { sha: A });
    expect((await call('GET', `/services/${id}/git`, eng)).json()).toMatchObject({ configured: false, git: null, tokenSet: true });
    const body = { gitRepo: 'o/r', gitPath: 'C:\\Apps\\shop' };
    expect((await call('PATCH', `/services/${id}`, eng, body)).statusCode).toBe(403);
    expect((await call('PATCH', `/services/${id}`, admin, body)).statusCode).toBe(200);
    expect(t.ctx.services.get(id)).toMatchObject({ git_repo: 'o/r', git_branch: 'main', git_path: 'C:\\Apps\\shop' });
    const audit = t.db.prepare("SELECT detail FROM audit_log WHERE event = 'service_updated'").all() as { detail: string }[];
    expect(audit.some((a) => a.detail.includes('gitRepo'))).toBe(true);
  });

  it('rejects odd repository, branch and path values', async () => {
    const { admin, id } = await setup(okRoutes(), { sha: A });
    for (const bad of [{ gitRepo: 'no-slash' }, { gitRepo: 'a/b/c' }, { gitBranch: '-x' }, { gitBranch: 'a b' }, { gitPath: 'relative/dir' }]) {
      expect((await call('PATCH', `/services/${id}`, admin, bad)).statusCode).toBe(400);
    }
  });

  it('reports behind, with counts, runs and pull requests', async () => {
    const { admin, id } = await setup(okRoutes(), { sha: A });
    await call('PATCH', `/services/${id}`, admin, { gitRepo: 'o/r', gitPath: 'C:\\Apps\\shop' });
    const r = await call('POST', `/services/${id}/git/refresh`, admin);
    const g = r.json().git;
    expect(g).toMatchObject({ state: 'ok', sync: 'behind', behindBy: 3, serverSha: A, branchSha: B });
    expect(g.prs).toHaveLength(1);
    expect(g.lastDeployAt).toBe(Date.parse('2026-10-01T10:00:00Z'));
    const list = (await call('GET', '/services', admin)).json().services[0];
    expect(list.git).toMatchObject({ sync: 'behind', behindBy: 3 });
    expect(JSON.stringify(r.json())).not.toContain('tok_secret_value');
  });

  it('says in sync when the server has the branch head', async () => {
    const { admin, id } = await setup(okRoutes(false), { sha: A });
    await call('PATCH', `/services/${id}`, admin, { gitRepo: 'o/r', gitPath: 'C:\\Apps\\shop' });
    expect((await call('POST', `/services/${id}/git/refresh`, admin)).json().git).toMatchObject({ sync: 'in_sync', behindBy: 0 });
  });

  it('explains each failure in plain words', async () => {
    const mapped = async (routes: ReturnType<typeof okRoutes> | null, local: { sha: string } | { error: string }, token = true) => {
      const { admin, id } = await setup(routes, local, token);
      await call('PATCH', `/services/${id}`, admin, { gitRepo: 'o/r', gitPath: 'C:\\Apps\\shop' });
      const out = (await call('POST', `/services/${id}/git/refresh`, admin)).json().git;
      await t.close();
      return out;
    };
    expect(await mapped(null, { sha: A }, false)).toMatchObject({ state: 'no_token', serverSha: A });
    expect(await mapped(okRoutes(), { error: 'The folder does not exist on this server.' })).toMatchObject({ state: 'no_server_commit' });
    expect(await mapped({ ...okRoutes(), '/branches/main': () => ({ status: 401 }) }, { sha: A })).toMatchObject({ state: 'token_rejected' });
    expect(await mapped({ ...okRoutes(), '/branches/main': () => ({ status: 404 }) }, { sha: A })).toMatchObject({ state: 'repo_not_found' });
    expect(await mapped({ ...okRoutes(), '/compare/': () => ({ status: 404 }) }, { sha: A })).toMatchObject({ state: 'sha_unknown' });
    t = await makeApp(); // so afterEach has something to close
  });

  it('keeps showing the result when runs or pull requests cannot be read', async () => {
    const { admin, id } = await setup({ ...okRoutes(), '/actions/runs': () => ({ status: 403 }), '/pulls': () => ({ status: 403 }) }, { sha: A });
    await call('PATCH', `/services/${id}`, admin, { gitRepo: 'o/r', gitPath: 'C:\\Apps\\shop' });
    expect((await call('POST', `/services/${id}/git/refresh`, admin)).json().git).toMatchObject({ state: 'ok', sync: 'behind', runs: [], prs: [] });
  });

  it('the scheduled job skips recent checks and clears the result when the mapping changes', async () => {
    const { admin, id } = await setup(okRoutes(), { sha: A });
    await call('PATCH', `/services/${id}`, admin, { gitRepo: 'o/r', gitPath: 'C:\\Apps\\shop' });
    const job = t.ctx.git.collector();
    await job.run();
    const first = t.ctx.git.get(id)!.checkedAt;
    t.clock.t += 60_000;
    await job.run();
    expect(t.ctx.git.get(id)!.checkedAt).toBe(first);
    t.clock.t += 5 * 60_000;
    await job.run();
    expect(t.ctx.git.get(id)!.checkedAt).toBeGreaterThan(first);
    await call('PATCH', `/services/${id}`, admin, { gitBranch: 'develop' });
    expect(t.ctx.git.get(id)).toBeNull();
  });
});
