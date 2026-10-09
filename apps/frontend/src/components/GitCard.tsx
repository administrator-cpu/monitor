'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import type { GitBadge, GitResponse, GitRunDto, ServiceDto } from '@cc/shared';
import { api, errorMessage, fetcher } from '@/lib/api';
import { dateTime, timeAgo } from '@/lib/format';

const STATE_TEXT: Record<string, string> = {
  no_token: 'No GitHub token',
  token_rejected: 'Token rejected',
  repo_not_found: 'Repo not visible',
  rate_limited: 'GitHub busy',
  no_server_commit: 'Server commit unknown',
  sha_unknown: 'Commit not on GitHub',
  error: 'Check failed',
};

/** Small status tag for the services list. */
export function GitBadgeTag({ git }: { git: GitBadge | null | undefined }) {
  if (!git) return null;
  let text: string;
  let cls = '';
  if (git.state !== 'ok') {
    text = STATE_TEXT[git.state] ?? 'Unknown';
    cls = 'warn';
  } else if (git.sync === 'in_sync') {
    text = git.dirty ? 'In sync, local changes' : 'In sync';
    cls = git.dirty ? 'warn' : 'ok';
  } else if (git.sync === 'behind') {
    text = `${git.behindBy} behind main`;
    cls = 'warn';
  } else if (git.sync === 'ahead') {
    text = 'Ahead of main';
    cls = 'warn';
  } else if (git.sync === 'diverged') {
    text = 'Diverged';
    cls = 'crit';
  } else {
    text = 'Unknown';
  }
  return <span className={`tag ${cls}`}>{text}</span>;
}

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : '—');

function runClass(r: GitRunDto): string {
  if (r.status !== 'completed') return 'warn';
  return r.conclusion === 'success' ? 'ok' : r.conclusion === 'failure' ? 'crit' : '';
}

function Mapping({ service, onDone }: { service: ServiceDto; onDone: () => void }) {
  const [repo, setRepo] = useState(service.gitRepo ?? '');
  const [branch, setBranch] = useState(service.gitBranch);
  const [path, setPath] = useState(service.gitPath ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setRepo(service.gitRepo ?? '');
    setBranch(service.gitBranch);
    setPath(service.gitPath ?? '');
  }, [service.gitRepo, service.gitBranch, service.gitPath]);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/services/${service.id}`, {
        method: 'PATCH',
        body: { gitRepo: repo.trim() || null, gitBranch: branch.trim() || 'main', gitPath: path.trim() || null },
      });
      onDone();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      style={{ marginTop: 12 }}
    >
      <div className="field">
        <label htmlFor="git-repo">GitHub repository</label>
        <input id="git-repo" value={repo} placeholder="owner/name" onChange={(e) => setRepo(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="git-branch">Branch</label>
        <input id="git-branch" value={branch} onChange={(e) => setBranch(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="git-path">Folder on the server</label>
        <input id="git-path" value={path} placeholder="C:\Apps\my-app" onChange={(e) => setPath(e.target.value)} />
        <div className="muted" style={{ fontSize: '0.8rem' }}>
          A git checkout, or a deploy folder that contains a <code>.deploy-sha</code> file.
        </div>
      </div>
      {err && <div className="error" role="alert">{err}</div>}
      <button className="btn primary" disabled={busy}>Save</button>
    </form>
  );
}

/** Code and deploys: server commit vs branch, runs and pull requests (read only). */
export function GitCard({ service, isAdmin, onChanged }: { service: ServiceDto; isAdmin: boolean; onChanged: () => void }) {
  const { data, mutate } = useSWR<GitResponse>(`/services/${service.id}/git`, fetcher, { refreshInterval: 30_000 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  if (!data) return null;
  if (!data.configured && !isAdmin) return null;
  const g = data.git;

  async function refresh() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/services/${service.id}/git/refresh`, { method: 'POST' });
      await mutate();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-label="Code and deploys" style={{ marginTop: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>Code and deploys</h2>
        {isAdmin && (
          <div className="row">
            {data.configured && <button className="btn" disabled={busy} onClick={() => void refresh()}>Check now</button>}
            <button className="btn" onClick={() => setEditing((v) => !v)}>{editing ? 'Close' : data.configured ? 'Change' : 'Set up'}</button>
          </div>
        )}
      </div>
      {!data.tokenSet && data.configured && (
        <div className="notice">The server has no GITHUB_TOKEN yet, so GitHub is not asked. Add it to the server .env and restart the monitor.</div>
      )}
      {!data.configured && <div className="muted">No repository is set for this service.</div>}
      {data.configured && !g && <div className="muted">Waiting for the first check (it runs every few minutes).</div>}
      {g && (
        <>
          <p>
            <GitBadgeTag git={{ state: g.state, sync: g.sync, behindBy: g.behindBy, dirty: g.dirty }} />{' '}
            <span className="muted">{g.repo} · {g.branch} · checked {timeAgo(g.checkedAt)}</span>
          </p>
          {g.message && <div className="notice" role="status">{g.message}</div>}
          <dl className="kv">
            <dt>On the server</dt>
            <dd><code>{short(g.serverSha)}</code>{g.serverBranch ? ` (${g.serverBranch})` : ''}{g.dirty ? ' · has uncommitted changes' : ''}</dd>
            <dt>Latest on {g.branch}</dt>
            <dd><code>{short(g.branchSha)}</code>{g.behindBy > 0 ? ` · server is ${g.behindBy} commit${g.behindBy === 1 ? '' : 's'} behind` : ''}{g.aheadBy > 0 ? ` · server has ${g.aheadBy} commit${g.aheadBy === 1 ? '' : 's'} not on ${g.branch}` : ''}</dd>
            <dt>Last successful deploy</dt>
            <dd>{g.lastDeployAt ? dateTime(g.lastDeployAt) : '—'}</dd>
          </dl>
          {g.runs.length > 0 && (
            <>
              <h3>Recent runs</h3>
              <ul className="plain">
                {g.runs.map((r) => (
                  <li key={r.id}>
                    <span className={`tag ${runClass(r)}`}>{r.status === 'completed' ? (r.conclusion ?? 'done') : r.status}</span>{' '}
                    {r.url ? <a href={r.url} target="_blank" rel="noreferrer noopener">{r.name}</a> : r.name}{' '}
                    <span className="muted">{short(r.sha)} · {timeAgo(r.at)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {g.prs.length > 0 && (
            <>
              <h3>Open pull requests</h3>
              <ul className="plain">
                {g.prs.map((p) => (
                  <li key={p.number}>
                    {p.url ? <a href={p.url} target="_blank" rel="noreferrer noopener">#{p.number} {p.title}</a> : `#${p.number} ${p.title}`}{' '}
                    <span className="muted">{p.author}{p.draft ? ' · draft' : ''} · {timeAgo(p.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {err && <div className="error" role="alert">{err}</div>}
      {isAdmin && editing && (
        <Mapping
          service={service}
          onDone={() => {
            setEditing(false);
            onChanged();
            void mutate();
          }}
        />
      )}
    </section>
  );
}
