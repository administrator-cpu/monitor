import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hourKey, safeDirName } from '../src/logs/files';
import { makeMatcher, regexProblem, runSearch, selectFiles, type SearchJob } from '../src/logs/search';
import { LogSearcher, SearchBusyError } from '../src/logs/searcher';
import { listLogFiles } from '../src/logs/files';
import { addUser, authed, login, makeApp, writeHeaders } from './helpers';

const H = 3_600_000;
const T0 = Math.floor(1_800_000_000_000 / H) * H; // on the hour

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-search-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

type L = { ts: number; msg: string; s?: string; pm?: number };
function writeLog(svc: string, hourMs: number, lines: L[], gz = false): string {
  const dir = path.join(root, safeDirName(svc));
  fs.mkdirSync(dir, { recursive: true });
  const body = lines.map((l) => JSON.stringify({ ts: l.ts, svc, pm: l.pm ?? 0, s: l.s ?? 'out', msg: l.msg })).join('\n') + '\n';
  const file = path.join(dir, `${hourKey(hourMs)}.jsonl${gz ? '.gz' : ''}`);
  fs.writeFileSync(file, gz ? gzipSync(body) : body);
  return file;
}

const job = (over: Partial<SearchJob> = {}): SearchJob => ({
  root, dirs: ['api'], from: T0 - 3 * H, to: T0 + 3 * H, stream: 'all', query: '', regex: false, caseSensitive: false,
  limit: 100, context: 0, order: 'asc', deadline: Date.now() + 20_000, ...over,
});
const msgs = (r: { lines: { msg: string; ctx?: true }[] }) => r.lines.filter((l) => !l.ctx).map((l) => l.msg);

describe('file selection', () => {
  it('uses the file name only: hours outside the range are never opened', async () => {
    writeLog('api', T0 - 2 * H, [{ ts: T0 - 2 * H + 5, msg: 'needle old' }]);
    const inRange = writeLog('api', T0, [{ ts: T0 + 5, msg: 'needle now' }]);
    const future = writeLog('api', T0 + 5 * H, [{ ts: T0 + 5 * H, msg: 'needle future' }]);
    // A file for the future hour is made unreadable; if the search tried to open it the count would show.
    fs.chmodSync(future, 0o000);
    const files = selectFiles(await listLogFiles(root), ['api'], T0, T0 + H);
    expect(files.map((f) => f.path)).toEqual([inRange]);
    const r = await runSearch(job({ from: T0, to: T0 + H, query: 'needle' }));
    expect(r.filesScanned).toBe(1);
    expect(msgs(r)).toEqual(['needle now']);
    fs.chmodSync(future, 0o644);
  });

  it('only searches the requested services', async () => {
    writeLog('api', T0, [{ ts: T0 + 1, msg: 'hello from api' }]);
    writeLog('worker', T0, [{ ts: T0 + 1, msg: 'hello from worker' }]);
    expect(msgs(await runSearch(job({ query: 'hello' })))).toEqual(['hello from api']);
    expect(msgs(await runSearch(job({ query: 'hello', dirs: ['api', 'worker'], order: 'asc' }))).sort()).toEqual(['hello from api', 'hello from worker']);
  });
});

describe('matching', () => {
  const lines: L[] = [
    { ts: T0 + 1, msg: 'user login ok email=a@b.com' },
    { ts: T0 + 2, msg: 'ERROR connection refused', s: 'err' },
    { ts: T0 + 3, msg: 'user logout' },
    { ts: T0 + 4, msg: 'error: disk full', s: 'err' },
  ];
  beforeEach(() => void writeLog('api', T0, lines));

  it('plain text is case-insensitive by default and exact when asked', async () => {
    expect(msgs(await runSearch(job({ query: 'error' })))).toEqual(['ERROR connection refused', 'error: disk full']);
    expect(msgs(await runSearch(job({ query: 'error', caseSensitive: true })))).toEqual(['error: disk full']);
  });

  it('the query is text, not a pattern, unless regex is on', async () => {
    expect(msgs(await runSearch(job({ query: 'user (login|logout)' })))).toEqual([]);
    expect(msgs(await runSearch(job({ query: 'user (login|logout)', regex: true })))).toEqual(['user login ok email=a@b.com', 'user logout']);
  });

  it('filters by stream and by the requested time range', async () => {
    expect(msgs(await runSearch(job({ stream: 'err' })))).toHaveLength(2);
    expect(msgs(await runSearch(job({ from: T0 + 2, to: T0 + 4 })))).toEqual(['ERROR connection refused', 'user logout']);
  });

  it('empty query returns every line in range; lines that are not JSON are skipped', async () => {
    const dir = path.join(root, 'api');
    fs.appendFileSync(path.join(dir, `${hourKey(T0)}.jsonl`), 'not json\n{"ts":1}\n{"ts":' + (T0 + 9) + ',"svc":"api","pm":0,"s":"out","msg":"after junk"}\n');
    const r = await runSearch(job());
    expect(msgs(r)).toHaveLength(5);
    expect(msgs(r)).toContain('after junk');
  });

  it('reads compressed hours', async () => {
    writeLog('api', T0 - H, [{ ts: T0 - H + 1, msg: 'from the gz file' }], true);
    const r = await runSearch(job({ query: 'gz file' }));
    expect(msgs(r)).toEqual(['from the gz file']);
  });

  it('a truncated gz file yields what could be read and does not fail', async () => {
    const f = writeLog('api', T0 - H, Array.from({ length: 2000 }, (_, i) => ({ ts: T0 - H + i, msg: `line ${i} filler filler filler` })), true);
    fs.truncateSync(f, Math.floor(fs.statSync(f).size / 2));
    const r = await runSearch(job({ query: 'line' }));
    expect(r.lines.length).toBeGreaterThan(0);
    expect(r.lines.length).toBeLessThan(2000);
  });
});

describe('limit, order and context', () => {
  beforeEach(() => {
    writeLog('api', T0 - H, Array.from({ length: 5 }, (_, i) => ({ ts: T0 - H + i, msg: `old ${i}` })));
    writeLog('api', T0, Array.from({ length: 5 }, (_, i) => ({ ts: T0 + i, msg: `new ${i}` })));
  });

  it('newest first by default keeps the newest matches when over the limit', async () => {
    const r = await runSearch(job({ order: 'desc', limit: 3 }));
    expect(msgs(r)).toEqual(['new 4', 'new 3', 'new 2']);
    expect(r.truncated).toBe(true);
    expect(r.matched).toBe(3);
  });

  it('oldest first keeps the oldest and says so when more exist', async () => {
    const r = await runSearch(job({ order: 'asc', limit: 3 }));
    expect(msgs(r)).toEqual(['old 0', 'old 1', 'old 2']);
    expect(r.truncated).toBe(true);
  });

  it('a limit that equals the number of matches is not marked truncated', async () => {
    const r = await runSearch(job({ order: 'asc', limit: 10 }));
    expect(r.matched).toBe(10);
    expect(r.truncated).toBe(false);
  });

  it('crosses file boundaries in order', async () => {
    expect(msgs(await runSearch(job({ order: 'asc', limit: 7 })))).toEqual(['old 0', 'old 1', 'old 2', 'old 3', 'old 4', 'new 0', 'new 1']);
  });

  it('context lines surround matches, are flagged, and are not counted as matches', async () => {
    const r = await runSearch(job({ query: 'new 2', context: 1, order: 'asc' }));
    expect(r.lines.map((l) => [l.msg, !!l.ctx])).toEqual([['new 1', true], ['new 2', false], ['new 3', true]]);
    expect(r.matched).toBe(1);
  });
});

describe('limits', () => {
  it('stops at the deadline and says so', async () => {
    writeLog('api', T0, Array.from({ length: 50_000 }, (_, i) => ({ ts: T0 + i, msg: `line ${i}` })));
    const r = await runSearch(job({ query: 'line', deadline: Date.now() - 1 }));
    expect(r.timedOut).toBe(true);
    expect(r.lines).toHaveLength(0);
  });
});

describe('regex guard', () => {
  it.each([
    ['(a+)+$', /repeat/],
    ['(.*)*x', /repeat/],
    ['(a|aa)+', /alternatives/],
    ['(a)\\1', /Back-references/],
    ['(unclosed', /valid regular expression/],
    ['x'.repeat(201), /200/],
  ])('rejects %s', (p, why) => {
    expect(regexProblem(p)).toMatch(why);
  });

  it('accepts ordinary patterns', () => {
    for (const p of ['error \\d+', 'GET /api/(users|orders)/\\d+', '^\\[warn\\]', 'user=\\w+ ip=[0-9.]+']) expect(regexProblem(p)).toBeNull();
  });

  it('makeMatcher escapes nothing for plain text (a dot is just a dot)', () => {
    expect(makeMatcher({ query: 'a.b', regex: false, caseSensitive: false })('axb')).toBe(false);
    expect(makeMatcher({ query: 'a.b', regex: true, caseSensitive: false })('axb')).toBe(true);
  });
});

describe('searcher (worker thread)', () => {
  it('searches in a worker and returns the same answer', async () => {
    writeLog('api', T0, [{ ts: T0 + 1, msg: 'worker needle' }, { ts: T0 + 2, msg: 'hay' }]);
    const s = new LogSearcher();
    const { deadline: _d, ...base } = job({ query: 'needle' });
    const r = await s.search(1, base);
    expect(msgs(r)).toEqual(['worker needle']);
    expect(r.tookMs).toBeGreaterThanOrEqual(0);
    expect(s.running).toBe(0);
  });

  it('allows one search per user and four overall, and frees the slot afterwards', async () => {
    const hang = path.join(root, 'hang.js');
    fs.writeFileSync(hang, `require('node:worker_threads').parentPort.once('message', () => setInterval(() => {}, 1000));`);
    const s = new LogSearcher({ workerFile: hang, limitMs: 400, graceMs: 100 });
    const { deadline: _d, ...base } = job();
    const first = s.search(1, base);
    await expect(s.search(1, base)).rejects.toMatchObject({ scope: 'user' });
    const others = [2, 3, 4].map((u) => s.search(u, base));
    await expect(s.search(5, base)).rejects.toBeInstanceOf(SearchBusyError);
    await expect(s.search(5, base)).rejects.toMatchObject({ scope: 'global' });
    // A worker that never answers is terminated shortly after the limit and reported as timed out.
    const r = await first;
    expect(r.timedOut).toBe(true);
    await Promise.all(others);
    expect(s.running).toBe(0);
    await expect(s.search(1, base)).resolves.toMatchObject({ timedOut: true });
  });
});

describe('POST /logs/search', () => {
  const post = (t: Awaited<ReturnType<typeof makeApp>>, cookie: string, body: unknown) =>
    t.app.inject({ method: 'POST', url: '/api/v1/logs/search', headers: authed(cookie), payload: body as object });

  it('needs a session, validates input, audits the search and never reads outside the log root', async () => {
    const t = await makeApp({ config: { logRoot: root } });
    try {
      writeLog('api', T0, [{ ts: T0 + 1, msg: 'login ok email=a@b.com' }]);
      t.ctx.services.discover('api');
      t.clock.t = T0 + 10;
      const body = { services: ['api'], from: T0, to: T0 + H, query: 'login' };
      expect((await t.app.inject({ method: 'POST', url: '/api/v1/logs/search', payload: body, headers: writeHeaders() })).statusCode).toBe(401);
      await addUser(t, { role: 'engineer' });
      const { cookie } = await login(t);

      const ok = await post(t, cookie!, body);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().lines.map((l: { msg: string }) => l.msg)).toEqual(['login ok email=a@b.com']);

      const audit = t.db.prepare("SELECT detail FROM audit_log WHERE event = 'log_search'").all() as { detail: string }[];
      expect(audit).toHaveLength(1);
      expect(JSON.parse(audit[0]!.detail)).toMatchObject({ services: ['api'], query: 'login', matched: 1 });
      expect(audit[0]!.detail).not.toContain('a@b.com'); // the audit trail records the filter, never the results

      expect((await post(t, cookie!, { ...body, services: ['../../etc'] })).statusCode).toBe(400);
      expect((await post(t, cookie!, { ...body, services: ['nope'] })).json().error).toBe('unknown_service');
      expect((await post(t, cookie!, { ...body, from: T0 + H, to: T0 })).statusCode).toBe(400);
      expect((await post(t, cookie!, { ...body, from: 0, to: 10 * 86_400_000 })).statusCode).toBe(400);
      const re = await post(t, cookie!, { ...body, regex: true, query: '(a+)+$' });
      expect(re.statusCode).toBe(400);
      expect(re.json().error).toBe('invalid_regex');
      expect((await post(t, cookie!, { ...body, context: 99 })).statusCode).toBe(400);
      expect((await post(t, cookie!, { ...body, services: [] })).statusCode).toBe(400);
    } finally {
      await t.close();
    }
  });

  it('caps results at the logs.search_max_results setting', async () => {
    const t = await makeApp({ config: { logRoot: root } });
    try {
      writeLog('api', T0, Array.from({ length: 150 }, (_, i) => ({ ts: T0 + i, msg: `row ${i}` })));
      t.ctx.services.discover('api');
      t.ctx.settings.setMany({ 'logs.search_max_results': 100 }, null);
      await addUser(t, { role: 'engineer' });
      const { cookie } = await login(t);
      const r = (await post(t, cookie!, { services: ['api'], from: T0, to: T0 + H, limit: 50_000 })).json();
      expect(r.lines).toHaveLength(100);
      expect(r.truncated).toBe(true);
    } finally {
      await t.close();
    }
  });
});

describe('search while the monitor is busy', () => {
  it('keeps the event loop responsive while a large search runs and log lines keep arriving', async () => {
    // 200,000 lines (about 20 MB) to scan, with a regex, in the worker thread.
    const big = Array.from({ length: 200_000 }, (_, i) => ({ ts: T0 + i, msg: `GET /api/orders/${i} 200 ${i % 97}ms user=${i % 5000}` }));
    writeLog('api', T0, big);
    const t = await makeApp({ config: { logRoot: root } });
    try {
      t.ctx.logs.writer.start();
      const h = monitorEventLoopDelay({ resolution: 10 });
      h.enable();
      let ingested = 0;
      const feed = setInterval(() => {
        for (let i = 0; i < 100; i++) t.ctx.logs.pipeline.ingest('feeder', 0, 'out', `feeder line ${ingested++}`, Date.now());
      }, 50); // 2,000 lines per second
      const searcher = new LogSearcher();
      const { deadline: _d, ...base } = job({ query: 'orders/(\\d+)5 200 \\d+ms user=1\\d*$', regex: true, limit: 5000 });
      const started = Date.now();
      const r = await searcher.search(1, base);
      clearInterval(feed);
      h.disable();
      await t.ctx.logs.writer.stop();
      expect(r.linesScanned).toBe(200_000);
      expect(r.matched).toBeGreaterThan(0);
      expect(ingested).toBeGreaterThan(500);
      const p99 = h.percentile(99) / 1e6;
      const max = h.max / 1e6;
      console.log(`search took ${Date.now() - started} ms; event loop delay p99 ${p99.toFixed(1)} ms, max ${max.toFixed(1)} ms; ${ingested} lines ingested meanwhile`);
      // Budget: a blocked loop would show seconds here. The thread start-up and gzip-free scan stay far below this.
      expect(p99).toBeLessThan(150);
    } finally {
      await t.close();
    }
  }, 60_000);
});
