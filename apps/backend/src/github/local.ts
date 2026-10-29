import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface LocalCommit {
  sha: string;
  branch: string | null;
  dirty: boolean;
  source: 'git' | 'deploy-marker';
}

export type LocalRead = (dir: string) => Promise<LocalCommit | { error: string }>;

const SHA = /^[0-9a-f]{40}$/;

/**
 * The full argument list for one git call. Both `-c` options override the repository's own config:
 * - safe.directory: the monitor may run as a different Windows user than the folder's owner.
 * - core.fsmonitor=false: a repository could otherwise name a program in `core.fsmonitor` that
 *   `git status` starts as the backend's account.
 */
export function gitArgs(dir: string, args: readonly string[]): string[] {
  return ['-c', 'safe.directory=*', '-c', 'core.fsmonitor=false', '-C', dir, ...args];
}

function git(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      gitArgs(dir, args),
      { timeout: 10_000, windowsHide: true, maxBuffer: 1_000_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout) => (err ? reject(err) : resolve(stdout.toString())),
    );
  });
}

/**
 * The commit that is running in a folder. A git checkout is asked with fixed read-only commands
 * (no shell, no user text in the arguments). A deploy folder without `.git` (how monitor-api is
 * deployed) is read from the `.deploy-sha` file the deploy script writes.
 */
export const readLocalCommit: LocalRead = async (dir) => {
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) return { error: 'The folder path is not a folder.' };
  } catch {
    return { error: 'The folder does not exist on this server.' };
  }
  const hasGit = await fs.stat(path.join(dir, '.git')).then(() => true, () => false);
  if (hasGit) {
    try {
      const sha = (await git(dir, ['rev-parse', 'HEAD'])).trim();
      if (!SHA.test(sha)) return { error: 'git did not return a commit id.' };
      const branch = (await git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim() || null;
      const dirty = (await git(dir, ['status', '--porcelain', '--untracked-files=no']).catch(() => '')).trim().length > 0;
      return { sha, branch, dirty, source: 'git' };
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
      return { error: missing ? 'git is not installed or not on the PATH of the monitor service.' : 'git could not read the folder.' };
    }
  }
  try {
    const sha = (await fs.readFile(path.join(dir, '.deploy-sha'), 'utf8')).trim();
    if (!SHA.test(sha)) return { error: 'The folder has no git checkout and no valid .deploy-sha file.' };
    return { sha, branch: null, dirty: false, source: 'deploy-marker' };
  } catch {
    return { error: 'The folder has no git checkout and no .deploy-sha file.' };
  }
};
