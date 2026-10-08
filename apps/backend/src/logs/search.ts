import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import { createGunzip } from 'node:zlib';
import type { LogSearchLine } from '@cc/shared';
import { HOUR_MS, listLogFiles, type LogFile } from './files';

export interface SearchJob {
  root: string;
  /** Folder names (already mapped through `safeDirName`) to search. */
  dirs: string[];
  from: number;
  to: number;
  stream: 'all' | 'out' | 'err' | 'access' | 'error';
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  limit: number;
  context: number;
  order: 'asc' | 'desc';
  /** Absolute time (epoch ms) after which the worker stops and returns what it has. */
  deadline: number;
}

export interface SearchOutput {
  lines: LogSearchLine[];
  matched: number;
  truncated: boolean;
  timedOut: boolean;
  filesScanned: number;
  linesScanned: number;
}

/** Extra surrounding lines are bounded so a broad query with context cannot build a huge answer. */
const MAX_CONTEXT_LINES = 2000;

/**
 * Rejects patterns known to make a backtracking engine run for ages (nested or alternating
 * quantifiers, back-references). It is a guard, not a proof: the hard 30 s limit and the worker
 * thread are what actually protect the monitor.
 */
export function regexProblem(pattern: string): string | null {
  if (pattern.length > 200) return 'The pattern is longer than 200 characters.';
  try {
    new RegExp(pattern);
  } catch (e) {
    return `Not a valid regular expression: ${(e as Error).message.replace(/^Invalid regular expression: /, '')}`;
  }
  if (/\\[1-9]|\\k</.test(pattern)) return 'Back-references are not allowed.';
  // (a+)+  (a*)*  (a+){2,}  (.*)+  ... a group that contains a quantifier and is itself quantified
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d*,?\d*\})/.test(pattern)) {
    return 'A repeated group that itself contains a repeat can take far too long. Simplify the pattern.';
  }
  // (a|a)*  (ab|a)+ ... an alternation inside a quantified group
  if (/\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d*,?\d*\})/.test(pattern)) {
    return 'A repeated group with alternatives can take far too long. Simplify the pattern.';
  }
  return null;
}

export function selectFiles(all: LogFile[], dirs: string[], from: number, to: number): LogFile[] {
  const want = new Set(dirs);
  // The hour is decided from the file name alone (backend-schema.md section 4).
  return all
    .filter((f) => want.has(f.dir) && f.start < to && f.start + HOUR_MS > from)
    .sort((a, b) => a.start - b.start || a.dir.localeCompare(b.dir));
}

interface Parsed {
  ts: number;
  svc: string;
  pm: number;
  s: string;
  msg: string;
}

function parseLine(raw: string): Parsed | null {
  if (raw.length === 0 || raw.charCodeAt(0) !== 123) return null; // '{'
  try {
    const o = JSON.parse(raw) as Partial<Parsed>;
    if (typeof o.ts !== 'number' || typeof o.msg !== 'string') return null;
    return { ts: o.ts, svc: String(o.svc ?? ''), pm: typeof o.pm === 'number' ? o.pm : -1, s: String(o.s ?? ''), msg: o.msg };
  } catch {
    return null; // a half-written last line, or something that is not ours
  }
}

export function makeMatcher(job: Pick<SearchJob, 'query' | 'regex' | 'caseSensitive'>): (msg: string) => boolean {
  if (job.query === '') return () => true;
  if (job.regex) {
    const re = new RegExp(job.query, job.caseSensitive ? '' : 'i');
    return (m) => re.test(m);
  }
  if (job.caseSensitive) return (m) => m.includes(job.query);
  const q = job.query.toLowerCase();
  return (m) => m.toLowerCase().includes(q);
}

async function* linesOf(f: LogFile): AsyncGenerator<string> {
  const input = createReadStream(f.path);
  const stream = f.gz ? input.pipe(createGunzip()) : input;
  // A truncated or still-being-compressed file ends in an error: what was read before it still counts.
  input.on('error', () => stream.destroy());
  stream.on('error', () => undefined);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const l of rl) yield l;
  } catch {
    /* keep what we have */
  } finally {
    rl.close();
    input.destroy();
  }
}

/** Core of the search: pure file reading, no thread or HTTP concerns, so it can be tested directly. */
export async function runSearch(job: SearchJob, nowFn: () => number = Date.now): Promise<SearchOutput> {
  const out: SearchOutput = { lines: [], matched: 0, truncated: false, timedOut: false, filesScanned: 0, linesScanned: 0 };
  const matches = makeMatcher(job);
  const files = selectFiles(await listLogFiles(job.root), job.dirs, job.from, job.to);
  if (job.order === 'desc') files.reverse();
  let contextBudget = MAX_CONTEXT_LINES;

  for (const f of files) {
    if (nowFn() > job.deadline) {
      out.timedOut = true;
      break;
    }
    out.filesScanned += 1;
    const remaining = job.limit - out.matched;
    const buf: LogSearchLine[] = [];
    let bufMatches = 0;
    let before: LogSearchLine[] = [];
    let after = 0;
    let stop = false;
    let tick = 0;

    for await (const raw of linesOf(f)) {
      out.linesScanned += 1;
      if (++tick % 500 === 0 && nowFn() > job.deadline) {
        out.timedOut = true;
        break;
      }
      const p = parseLine(raw);
      if (!p) continue;
      const line: LogSearchLine = { ts: p.ts, svc: p.svc, pm: p.pm, s: p.s, msg: p.msg };
      const inRange = p.ts >= job.from && p.ts < job.to;
      const streamOk = job.stream === 'all' || p.s === job.stream;
      if (inRange && streamOk && matches(p.msg)) {
        if (job.order === 'asc' && bufMatches >= remaining) {
          out.truncated = true;
          stop = true;
          break;
        }
        for (const b of before) buf.push({ ...b, ctx: true });
        before = [];
        buf.push(line);
        bufMatches += 1;
        after = job.context;
        if (job.order === 'desc' && bufMatches > remaining) {
          // Keep the newest matches of this file: drop from the front up to and including the oldest match.
          out.truncated = true;
          while (buf.length > 0) {
            const dropped = buf.shift()!;
            if (!dropped.ctx) {
              bufMatches -= 1;
              break;
            }
          }
        }
      } else if (job.context > 0) {
        if (after > 0 && contextBudget > 0) {
          buf.push({ ...line, ctx: true });
          contextBudget -= 1;
          after -= 1;
        } else {
          before.push(line);
          if (before.length > job.context) before.shift();
        }
      }
    }
    out.matched += bufMatches;
    if (job.order === 'desc') buf.reverse();
    out.lines.push(...buf);
    if (stop || out.timedOut) break;
  }
  // desc: files were visited newest first and each file's lines were reversed, so the result is newest first.
  // Context lines come out of the per-file buffer in the order they were read, which after reversal is mirrored
  // around their match; tidy that by sorting each result by time in the requested direction.
  out.lines.sort((a, b) => (job.order === 'asc' ? a.ts - b.ts : b.ts - a.ts));
  return out;
}
