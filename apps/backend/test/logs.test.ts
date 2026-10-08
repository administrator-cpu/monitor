import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteExpired,
  deleteOldestHour,
  hourKey,
  HOUR_MS,
  listLogFiles,
  parseLogFile,
  safeDirName,
} from '../src/logs/files';
import { LogSystem } from '../src/logs';
import { LogPipeline } from '../src/logs/pipeline';
import { LogRing, LogSubscription, splitChunk, toLiveLine, LIVE_LINE_MAX_CHARS } from '../src/logs/ring';
import { PipelineSink } from '../src/logs/sink';
import { VolumeGuard, type VolumeProbe } from '../src/logs/volume';
import { LogWriter } from '../src/logs/writer';

const T0 = Date.UTC(2026, 5, 1, 10, 30, 0);
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-logs-t-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

describe('file names', () => {
  it('uses UTC hours and parses names back', () => {
    expect(hourKey(T0)).toBe('2026-06-01-10');
    expect(parseLogFile('2026-06-01-10.jsonl')).toEqual({ start: Date.UTC(2026, 5, 1, 10), gz: false });
    expect(parseLogFile('2026-06-01-10.jsonl.gz')?.gz).toBe(true);
    expect(parseLogFile('2026-06-01-10.jsonl.gz.tmp')).toBeNull();
    expect(parseLogFile('notes.txt')).toBeNull();
  });

  it('never lets a service name escape or collide', () => {
    expect(safeDirName('api')).toBe('api');
    for (const bad of ['../../etc', 'a/b', 'a\\b', '..', 'C:\\x', 'con', 'NUL.txt', 'x'.repeat(200), '', '_nginx', '_monitor', 'a.']) {
      const d = safeDirName(bad);
      expect(d).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._~-]*$/);
      expect(d).not.toContain('..');
      expect(d).not.toBe('_nginx');
      expect(d).not.toBe('_monitor');
      expect(path.basename(d)).toBe(d);
    }
    expect(safeDirName('a/b')).not.toBe(safeDirName('a_b'));
    expect(safeDirName('../x')).not.toBe(safeDirName('..\\x'));
  });
});

describe('ring buffer and subscriptions', () => {
  const line = (n: number, msg = `m${n}`) => ({ ts: n, pm: 0, s: 'out' as const, msg });

  it('keeps the last N lines and filters by stream', () => {
    const r = new LogRing(() => 3, 1e6);
    for (let i = 1; i <= 5; i++) r.push({ ...line(i), s: i % 2 ? 'out' : 'err' });
    expect(r.last(10).map((l) => l.ts)).toEqual([3, 4, 5]);
    expect(r.last(10, 'err').map((l) => l.ts)).toEqual([4]);
    expect(r.last(2).map((l) => l.ts)).toEqual([4, 5]);
  });

  it('is also bounded by characters, so long lines cannot grow memory', () => {
    const r = new LogRing(() => 1000, 100);
    for (let i = 0; i < 20; i++) r.push(line(i, 'x'.repeat(30)));
    expect(r.length).toBeLessThanOrEqual(4);
    expect(r.last(1)[0]?.ts).toBe(19);
  });

  it('cuts long live lines without breaking surrogate pairs and reports the cut', () => {
    const s = 'a'.repeat(LIVE_LINE_MAX_CHARS - 1) + '😀' + 'tail';
    const l = toLiveLine(1, 0, 'out', s);
    expect(l.msg.length).toBe(LIVE_LINE_MAX_CHARS - 1);
    expect(l.cut).toBe(s.length - l.msg.length);
    expect(/[\ud800-\udbff]$/.test(l.msg)).toBe(false);
    const parts = splitChunk('😀'.repeat(10), 5);
    expect(parts.join('')).toBe('😀'.repeat(10));
    expect(parts.every((p) => !/^[\udc00-\udfff]/.test(p) && !/[\ud800-\udbff]$/.test(p))).toBe(true);
  });

  it('drops the oldest queued lines of a slow subscriber and says how many', () => {
    const sub = new LogSubscription('api', 'all', 5, 1e6);
    for (let i = 0; i < 12; i++) sub.push(line(i));
    expect(sub.pending).toBe(5);
    const { lines, dropped } = sub.take(100);
    expect(lines.map((l) => l.ts)).toEqual([7, 8, 9, 10, 11]);
    expect(dropped).toBe(7);
    expect(sub.take().dropped).toBe(0);
  });

  it('batches at the requested size and respects the stream filter', () => {
    const sub = new LogSubscription('api', 'err');
    for (let i = 0; i < 300; i++) sub.push({ ts: i, pm: 0, s: i % 2 ? 'out' : 'err', msg: 'x' });
    expect(sub.pending).toBe(150);
    expect(sub.take(100).lines).toHaveLength(100);
    expect(sub.take(100).lines).toHaveLength(50);
  });
});

describe('LogWriter', () => {
  it('appends JSON lines per service and hour', async () => {
    let t = T0;
    const w = new LogWriter({ root, now: () => t });
    w.enqueue('api', '{"a":1}\n');
    w.enqueue('api', '{"a":2}\n');
    w.enqueue('worker', '{"b":1}\n');
    await w.flushNow();
    t = T0 + HOUR_MS;
    w.enqueue('api', '{"a":3}\n');
    await w.flushNow();
    await w.idle(); // the finished hour is compressed in the background
    await w.stop();
    expect(zlib.gunzipSync(fs.readFileSync(path.join(root, 'api/2026-06-01-10.jsonl.gz'))).toString()).toBe('{"a":1}\n{"a":2}\n');
    expect(read('worker/2026-06-01-10.jsonl')).toBe('{"b":1}\n');
    expect(read('api/2026-06-01-11.jsonl')).toBe('{"a":3}\n');
  });

  it('compresses a finished hour and keeps the content intact', async () => {
    let t = T0;
    const w = new LogWriter({ root, now: () => t });
    w.enqueue('api', '{"a":1}\n');
    await w.flushNow();
    t = T0 + HOUR_MS;
    w.enqueue('api', '{"a":2}\n');
    await w.flushNow();
    await w.idle();
    await w.stop();
    expect(fs.existsSync(path.join(root, 'api/2026-06-01-10.jsonl'))).toBe(false);
    expect(zlib.gunzipSync(fs.readFileSync(path.join(root, 'api/2026-06-01-10.jsonl.gz'))).toString()).toBe('{"a":1}\n');
  });

  it('sweeps leftovers from a crash but never the hour being written', async () => {
    fs.mkdirSync(path.join(root, 'api'));
    fs.writeFileSync(path.join(root, 'api/2026-06-01-08.jsonl'), '{"old":1}\n');
    const w = new LogWriter({ root, now: () => T0 });
    w.enqueue('api', '{"cur":1}\n');
    await w.flushNow();
    expect(await w.sweepCompress()).toBe(1);
    await w.idle();
    await w.stop();
    expect(fs.existsSync(path.join(root, 'api/2026-06-01-08.jsonl.gz'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'api/2026-06-01-10.jsonl'))).toBe(true);
  });

  it('sheds the oldest lines of the noisiest service when the queue overflows, and counts them', () => {
    const w = new LogWriter({ root, now: () => T0, maxQueue: 100 });
    for (let i = 0; i < 90; i++) w.enqueue('noisy', `{"n":${i}}\n`);
    for (let i = 0; i < 5; i++) w.enqueue('quiet', `{"q":${i}}\n`);
    for (let i = 90; i < 130; i++) w.enqueue('noisy', `{"n":${i}}\n`);
    const s = w.stats();
    expect(s.queue).toBeLessThanOrEqual(100);
    expect(s.dropped).toBeGreaterThan(0);
    expect(s.droppedByService.noisy).toBe(s.dropped);
    expect(s.droppedByService.quiet).toBeUndefined();
  });

  it('while disabled it skips (and counts) lines instead of writing', async () => {
    const w = new LogWriter({ root, now: () => T0 });
    w.enqueue('api', '{"a":1}\n');
    w.setEnabled(false);
    w.enqueue('api', '{"a":2}\n');
    expect(w.stats().skipped).toBe(2);
    expect(w.stats().queue).toBe(0);
    w.setEnabled(true);
    w.enqueue('api', '{"a":3}\n');
    await w.flushNow();
    await w.stop();
    expect(read('api/2026-06-01-10.jsonl')).toBe('{"a":3}\n');
  });

  it('counts lines lost to a failed write instead of throwing', async () => {
    fs.writeFileSync(path.join(root, 'blocked'), 'a file where a folder is needed');
    const w = new LogWriter({ root: path.join(root, 'blocked'), now: () => T0 });
    w.enqueue('api', '{"a":1}\n');
    await w.flushNow();
    expect(w.stats().dropped).toBe(1);
    expect(w.stats().writeErrors).toBe(1);
    await w.stop();
  });
});

describe('retention helpers', () => {
  const touch = (rel: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), 'x');
  };

  it('deletes expired hours by file name only', async () => {
    touch('api/2026-05-30-10.jsonl.gz');
    touch('api/2026-06-01-09.jsonl.gz');
    touch('api/2026-06-01-10.jsonl');
    touch('api/readme.txt');
    expect(await deleteExpired(root, T0, 24)).toBe(1);
    expect((await listLogFiles(root)).map((f) => f.name).sort()).toEqual(['2026-06-01-09.jsonl.gz', '2026-06-01-10.jsonl']);
    expect(fs.existsSync(path.join(root, 'api/readme.txt'))).toBe(true);
  });

  it('removes the oldest hour across all services and never the current one', async () => {
    touch('api/2026-06-01-08.jsonl.gz');
    touch('worker/2026-06-01-08.jsonl.gz');
    touch('api/2026-06-01-09.jsonl.gz');
    touch('api/2026-06-01-10.jsonl');
    expect(await deleteOldestHour(root, T0)).toBe(2);
    expect(await deleteOldestHour(root, T0)).toBe(1);
    expect(await deleteOldestHour(root, T0)).toBe(0); // only the current hour is left
    expect(fs.existsSync(path.join(root, 'api/2026-06-01-10.jsonl'))).toBe(true);
  });
});

describe('VolumeGuard', () => {
  const probe = (over: Partial<VolumeProbe> = {}, state = { pct: 10 }): VolumeProbe => ({
    ensureDir: async () => undefined,
    usedPct: async () => state.pct,
    isSystemVolume: async () => false,
    ...over,
  });

  function guard(p: VolumeProbe, extra: Partial<ConstructorParameters<typeof VolumeGuard>[0]> = {}) {
    const writer = new LogWriter({ root, now: () => T0 });
    const warnings: string[] = [];
    const g = new VolumeGuard({
      root, requireSeparateVolume: true, thresholdPct: () => 85, retentionHours: () => 24, writer, now: () => T0,
      probe: p, onWarning: (c) => warnings.push(c), ...extra,
    });
    return { g, writer, warnings };
  }

  it('is ok on a separate volume with room', async () => {
    const { g } = guard(probe());
    await g.check();
    expect(g.status()).toMatchObject({ volumeOk: true, volumeReason: null, volumeUsedPct: 10 });
  });

  it('refuses the system volume and stops the writer', async () => {
    const { g, writer, warnings } = guard(probe({ isSystemVolume: async () => true }));
    await g.check();
    expect(g.status().volumeOk).toBe(false);
    expect(g.status().volumeReason).toBe('same_volume');
    writer.enqueue('api', 'x\n');
    expect(writer.stats().skipped).toBe(1);
    expect(warnings).toEqual(['log_volume_missing']);
  });

  it('allows the system volume when the requirement is off', async () => {
    const { g } = guard(probe({ isSystemVolume: async () => true }), { requireSeparateVolume: false });
    await g.check();
    expect(g.status().volumeOk).toBe(true);
  });

  it('reports a missing root, then recovers when it returns', async () => {
    let missing = true;
    const { g, writer } = guard(probe({ ensureDir: async () => { if (missing) throw new Error('ENOENT'); } }));
    await g.check();
    expect(g.status()).toMatchObject({ volumeOk: false, volumeReason: 'missing' });
    missing = false;
    await g.check();
    expect(g.status().volumeOk).toBe(true);
    writer.enqueue('api', 'x\n');
    expect(writer.stats().queue).toBe(1);
  });

  it('trims the oldest hours while usage is above the threshold, but not the current hour', async () => {
    for (const f of ['api/2026-06-01-07.jsonl.gz', 'api/2026-06-01-08.jsonl.gz', 'api/2026-06-01-10.jsonl']) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), 'x');
    }
    const st = { pct: 90 };
    const { g, warnings } = guard(probe({ usedPct: async () => { const v = st.pct; st.pct -= 3; return v; } }, st));
    await g.check();
    expect(g.state().trimmedHours).toBe(2);
    expect((await listLogFiles(root)).map((f) => f.name)).toEqual(['2026-06-01-10.jsonl']);
    expect(warnings).toEqual([]); // back under the threshold after trimming
  });

  it('warns once when usage is high and nothing more can be trimmed', async () => {
    const { g, warnings } = guard(probe({}, { pct: 95 }));
    await g.check();
    await g.check();
    expect(warnings).toEqual(['log_volume_high']);
  });

  it('falls back to another usage source when statfs fails', async () => {
    const { g } = guard(probe({ usedPct: async () => { throw new Error('nope'); } }), { fallbackUsedPct: () => 42 });
    await g.check();
    expect(g.status()).toMatchObject({ volumeOk: true, volumeUsedPct: 42 });
  });
});

describe('LogPipeline and LogSystem', () => {
  function sys() {
    return new LogSystem({
      root, requireSeparateVolume: false, now: () => T0, ringLines: () => 100, thresholdPct: () => 85, retentionHours: () => 24,
    });
  }

  it('keeps lines in memory, writes them to a hashed folder for unsafe names, and delivers to subscribers', async () => {
    const s = sys();
    const sub = new LogSubscription('../evil', 'all');
    const off = s.pipeline.subscribe(sub);
    s.pipeline.ingest('../evil', 0, 'out', 'hello');
    s.pipeline.ingest('api', 1, 'err', 'boom', T0 - 5);
    expect(s.pipeline.tail('../evil', 10).map((l) => l.msg)).toEqual(['hello']);
    expect(s.pipeline.tail('api', 10)[0]).toMatchObject({ ts: T0 - 5, pm: 1, s: 'err' });
    expect(sub.take().lines).toHaveLength(1);
    off();
    await s.writer.flushNow();
    await s.writer.stop();
    const dirs = fs.readdirSync(root).sort();
    expect(dirs).toHaveLength(2);
    expect(dirs.some((d) => d.includes('..') || d.includes('/'))).toBe(false);
    const line = JSON.parse(read('api/2026-06-01-10.jsonl'));
    expect(line).toMatchObject({ svc: 'api', pm: 1, s: 'err', msg: 'boom' });
  });

  it('replaces implausible packet times with the receive time and splits oversize chunks', async () => {
    const s = sys();
    s.pipeline.ingest('api', 0, 'out', 'old', 5);
    expect(s.pipeline.tail('api', 1)[0]?.ts).toBe(T0);
    s.pipeline.ingest('big', 0, 'out', 'z'.repeat(70_000));
    const lines = s.pipeline.tail('big', 10);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.cut).toBeGreaterThan(0);
    await s.writer.stop();
  });

  it('refuses new streams beyond the cap and counts those lines as dropped', () => {
    const s = sys();
    for (let i = 0; i < 205; i++) s.pipeline.ingest(`svc${i}`, 0, 'out', 'x');
    expect(s.pipeline.rejectedLines).toBe(5);
    expect(s.status().droppedLines).toBe(5);
  });

  it('holds the monitor own log lines until the pipeline exists, then replays them', () => {
    const s = sys();
    const sink = new PipelineSink();
    sink.write('early line\n');
    sink.attach(s.pipeline);
    sink.write('later line\n');
    expect(s.pipeline.tail('_monitor', 10).map((l) => l.msg)).toEqual(['early line\n', 'later line\n']);
    expect(fs.readdirSync(root)).toEqual([]); // nothing written until the writer flushes
  });
});

describe('ingest does not wait for the disk', () => {
  it('stays fast and bounded under a 5,000 lines/s burst', async () => {
    const s = new LogSystem({
      root, requireSeparateVolume: false, ringLines: () => 5000, thresholdPct: () => 85, retentionHours: () => 24, maxQueue: 10_000,
    });
    s.writer.start();
    const t0 = performance.now();
    for (let i = 0; i < 50_000; i++) s.pipeline.ingest(`svc${i % 5}`, 0, 'out', `line ${i} ${'x'.repeat(100)}`);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(2000);
    // Waiting lines are capped at maxQueue; lines already handed to a write add at most as many again.
    expect(s.writer.stats().queue).toBeLessThanOrEqual(2 * 10_000);
    await s.writer.stop();
    const st = s.writer.stats();
    expect(st.dropped + countLines(root)).toBe(50_000);
  });
});

function countLines(dir: string): number {
  let n = 0;
  for (const d of fs.readdirSync(dir)) {
    for (const f of fs.readdirSync(path.join(dir, d))) {
      const buf = fs.readFileSync(path.join(dir, d, f));
      const text = f.endsWith('.gz') ? zlib.gunzipSync(buf).toString() : buf.toString();
      n += text.split('\n').filter(Boolean).length;
    }
  }
  return n;
}
