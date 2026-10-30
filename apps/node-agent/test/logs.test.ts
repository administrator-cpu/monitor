import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_LOG_LINE_MAX, AGENT_LOG_LINES_PER_S, agentLogsSchema, type AgentLogs } from '@cc/shared';
import type { PostResult } from '../src/client';
import { loadConfig } from '../src/config';
import { silentLog } from '../src/log';
import {
  DEFAULT_LINES_PER_S,
  FLUSH_CHARS,
  isCaddyAccessRecord,
  LINE_MAX,
  LogParser,
  LogShipper,
  parseTs,
  type ParsedLine,
} from '../src/logs';

/** One frame of Docker's multiplexed log stream. */
const frame = (stream: 1 | 2, text: string): Buffer => {
  const body = Buffer.from(text, 'utf8');
  const h = Buffer.alloc(8);
  h[0] = stream;
  h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
};
const T = '2026-10-30T12:00:00.123456789Z';
const T0 = Date.parse('2026-10-30T12:00:00Z');

const parse = (chunks: Uint8Array[]): ParsedLine[] => {
  const out: ParsedLine[] = [];
  const p = new LogParser((l) => out.push(l), () => T0 + 5000);
  for (const c of chunks) p.push(c);
  p.end();
  return out;
};

describe('LogParser', () => {
  it('reads Docker timestamps to the nanosecond', () => {
    expect(parseTs(`${T} hello`)).toEqual({ sec: T0 / 1000, nanos: 123_456_789, rest: 'hello' });
    expect(parseTs('2026-10-30T12:00:00Z x')).toEqual({ sec: T0 / 1000, nanos: 0, rest: 'x' });
    expect(parseTs('2026-10-30T17:30:00.5+05:30 x')?.sec).toBe(T0 / 1000);
    expect(parseTs('no timestamp')).toBeNull();
  });

  it('splits the multiplexed stream into stdout and stderr lines, across chunk borders', () => {
    const all = Buffer.concat([frame(1, `${T} GET / 200\n`), frame(2, `${T} warn: slow\r\n`), frame(1, `${T} \n`)]);
    const lines = parse([all.subarray(0, 3), all.subarray(3, 13), all.subarray(13)]);
    expect(lines.map((l) => [l.s, l.msg, l.ts])).toEqual([
      ['out', 'GET / 200', T0 + 123],
      ['err', 'warn: slow', T0 + 123],
      ['out', '', T0 + 123],
    ]);
  });

  it('joins a long message Docker sent in 16 KB pieces, and cuts it at 64 KB', () => {
    const a = 'a'.repeat(16_384);
    const b = 'b'.repeat(16_384);
    const joined = parse([frame(1, `${T} ${a}`), frame(1, `${T} ${b}`), frame(1, `${T} end\n`)]);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.msg).toBe(a + b + 'end');
    const huge = Array.from({ length: 6 }, () => frame(1, `${T} ${'x'.repeat(16_384)}`));
    const cut = parse([...huge, frame(1, `${T} tail\n`), frame(1, `${T} next\n`)]);
    expect(cut.map((l) => l.msg.length)).toEqual([LINE_MAX, 4]);
    expect(LINE_MAX).toBe(AGENT_LOG_LINE_MAX);
  });

  it('reads a TTY container’s raw output as stdout, even with a character split between chunks', () => {
    const text = Buffer.from(`${T} héllo\n${T} wörld\npartial`, 'utf8');
    const at = text.indexOf(0xc3) + 1; // inside "é"
    const lines = parse([text.subarray(0, at), text.subarray(at)]);
    expect(lines.map((l) => [l.s, l.msg])).toEqual([
      ['out', 'héllo'],
      ['out', 'wörld'],
      ['out', 'partial'],
    ]);
  });

  it('recognises Caddy access records only', () => {
    expect(isCaddyAccessRecord('{"level":"info","logger":"http.log.access.log0","request":{"remote_ip":"1.2.3.4","uri":"/x"},"status":200}')).toBe(true);
    expect(isCaddyAccessRecord('{"level":"info","logger":"http.handlers.reverse_proxy","msg":"http.log.access mentioned"}')).toBe(false);
    expect(isCaddyAccessRecord('GET http.log.access')).toBe(false);
    expect(isCaddyAccessRecord('{"logger":"http.log.access" broken')).toBe(false);
  });
});

/** A Docker stand-in whose log streams the test feeds, and a monitor that records batches. */
function harness(over: { post?: (body: AgentLogs) => PostResult; bufferMaxBytes?: number } = {}) {
  const clock = { t: T0 };
  const streams = new Map<string, { since: string; push: (b: Buffer) => void; end: () => void; aborted: boolean }>();
  const docker = {
    logs: async (id: string, since: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> => {
      const queue: Buffer[] = [];
      let wake: (() => void) | null = null;
      let done = false;
      const s = {
        since,
        aborted: false,
        push: (b: Buffer) => {
          queue.push(b);
          wake?.();
        },
        end: () => {
          done = true;
          wake?.();
        },
      };
      streams.set(id, s);
      signal.addEventListener('abort', () => {
        s.aborted = true;
        s.end();
      });
      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (queue.length > 0) yield queue.shift()!;
            if (done) return;
            await new Promise<void>((r) => (wake = r));
            wake = null;
          }
        },
      };
    },
  };
  const sent: AgentLogs[] = [];
  const answers: PostResult['kind'][] = [];
  let blocked = false;
  const bufferDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-logbuf-'));
  const saved: Record<string, string>[] = [];
  const shipper = new LogShipper({
    docker,
    post: async (gz) => {
      const body = JSON.parse(zlib.gunzipSync(gz).toString('utf8')) as AgentLogs;
      agentLogsSchema.parse(body); // what the monitor would accept
      const r = over.post ? over.post(body) : ({ kind: 'ok', body: { excluded: [], linesPerS: 200 } } as PostResult);
      if (r.kind === 'ok') sent.push(body);
      return r;
    },
    blocked: () => blocked,
    answer: (r) => answers.push(r.kind),
    log: silentLog,
    bufferDir,
    bufferMaxBytes: over.bufferMaxBytes ?? 50 * 1024 * 1024,
    cursors: { load: async () => null, save: async (c) => void saved.push(c) },
    now: () => clock.t,
  });
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const lines = (b: AgentLogs[]) => b.flatMap((x) => x.batches.flatMap((y) => y.lines.map((l) => `${y.service}:${l.msg}`)));
  return {
    clock,
    streams,
    shipper,
    sent,
    answers,
    saved,
    bufferDir,
    tick,
    lines,
    setBlocked: (b: boolean) => (blocked = b),
    cleanup: () => fs.rmSync(bufferDir, { recursive: true, force: true }),
  };
}

const ts = (ms: number, n = 0) => `${new Date(ms).toISOString().slice(0, 19)}.${String(n).padStart(9, '0')}Z`;

describe('LogShipper', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });
  afterEach(async () => {
    await h.shipper.stop();
    h.cleanup();
  });

  it('follows running containers from now on, ships their lines per service, and stops with them', async () => {
    await h.shipper.init();
    h.shipper.start();
    h.shipper.sync([
      { id: 'a'.repeat(64), key: 'acs/api', running: true },
      { id: 'b'.repeat(64), key: 'acs/cpe-sim', running: false },
    ]);
    expect(h.shipper.following).toEqual(['a'.repeat(64)]);
    await h.tick();
    const s = h.streams.get('a'.repeat(64))!;
    expect(s.since).toBe(`${T0 / 1000}.000000000`);
    s.push(frame(1, `${ts(T0 + 1000, 1)} one\n`));
    s.push(frame(2, `${ts(T0 + 1000, 2)} two\n`));
    await h.tick();
    await h.shipper.flush();
    expect(h.sent).toEqual([
      {
        v: 1,
        batches: [
          {
            service: 'acs/api',
            lines: [
              { ts: T0 + 1000, s: 'out', msg: 'one' },
              { ts: T0 + 1000, s: 'err', msg: 'two' },
            ],
            dropped: 0,
          },
        ],
      },
    ]);
    // Stopped: no longer followed; the next run picks up after the last line passed on.
    h.shipper.sync([{ id: 'a'.repeat(64), key: 'acs/api', running: false }]);
    expect(h.streams.get('a'.repeat(64))!.aborted).toBe(true);
    h.shipper.sync([{ id: 'a'.repeat(64), key: 'acs/api', running: true }]);
    await h.tick();
    expect(h.streams.get('a'.repeat(64))!.since).toBe(`${T0 / 1000 + 1}.000000002`);
    // A line Docker repeats because `since` includes its own second is not sent twice.
    h.streams.get('a'.repeat(64))!.push(frame(2, `${ts(T0 + 1000, 2)} two\n`));
    h.streams.get('a'.repeat(64))!.push(frame(1, `${ts(T0 + 1000, 3)} three\n`));
    await h.tick();
    await h.shipper.flush();
    expect(h.lines(h.sent.slice(1))).toEqual(['acs/api:three']);
  });

  it('a container that appears later is read from the previous round, not from its whole history', async () => {
    await h.shipper.init();
    h.shipper.start();
    h.shipper.sync([]);
    h.clock.t += 10_000;
    h.shipper.sync([{ id: 'c'.repeat(64), key: 'acs/api', running: true }]);
    await h.tick();
    expect(h.streams.get('c'.repeat(64))!.since).toBe(`${T0 / 1000}.000000000`);
  });

  it('ships at most 200 lines per second per container and counts the rest', async () => {
    expect(DEFAULT_LINES_PER_S).toBe(AGENT_LOG_LINES_PER_S);
    await h.shipper.init();
    h.shipper.start();
    h.shipper.sync([{ id: 'a'.repeat(64), key: 'acs/genieacs-cwmp', running: true }]);
    await h.tick();
    const s = h.streams.get('a'.repeat(64))!;
    s.push(Buffer.concat(Array.from({ length: 450 }, (_, i) => frame(1, `${ts(T0, i + 1)} inform ${i}\n`))));
    await h.tick();
    h.clock.t += 1000; // the next second: the limit starts again
    s.push(frame(1, `${ts(T0 + 1000, 1)} later\n`));
    await h.tick();
    await h.shipper.flush();
    const b = h.sent[0]!.batches[0]!;
    expect(b.lines).toHaveLength(201);
    expect(b.dropped).toBe(250);
    expect(b.lines[200]!.msg).toBe('later');
    expect(h.shipper.dropped).toBe(250);
  });

  it('keeps Caddy access records off the wire', async () => {
    await h.shipper.init();
    h.shipper.start();
    h.shipper.sync([{ id: 'd'.repeat(64), key: 'acs/caddy', running: true }]);
    await h.tick();
    const s = h.streams.get('d'.repeat(64))!;
    s.push(frame(2, `${ts(T0, 1)} {"level":"info","logger":"http.log.access.log0","request":{"remote_ip":"203.0.113.9","uri":"/secret?token=x"},"status":200}\n`));
    s.push(frame(2, `${ts(T0, 2)} {"level":"info","logger":"tls","msg":"certificate obtained"}\n`));
    await h.tick();
    await h.shipper.flush();
    const wire = JSON.stringify(h.sent);
    expect(wire).not.toContain('203.0.113.9');
    expect(wire).not.toContain('secret');
    expect(h.lines(h.sent)).toEqual(['acs/caddy:{"level":"info","logger":"tls","msg":"certificate obtained"}']);
  });

  it('sends at once when 256 KB are waiting', async () => {
    await h.shipper.init();
    h.shipper.start();
    h.shipper.sync([{ id: 'a'.repeat(64), key: 'acs/api', running: true }]);
    await h.tick();
    const big = 'z'.repeat(60_000);
    for (let i = 0; i < Math.ceil(FLUSH_CHARS / 60_000); i++) h.streams.get('a'.repeat(64))!.push(frame(1, `${ts(T0, i + 1)} ${big}\n`));
    await h.tick();
    await h.tick();
    expect(h.sent).toHaveLength(1);
  });

  it('stops following and drops queued lines of services the monitor excludes, and takes its limit', async () => {
    h = harness({ post: () => ({ kind: 'ok', body: { excluded: ['acs/caddy'], linesPerS: 2 } }) });
    await h.shipper.init();
    h.shipper.start();
    h.shipper.sync([
      { id: 'a'.repeat(64), key: 'acs/api', running: true },
      { id: 'd'.repeat(64), key: 'acs/caddy', running: true },
    ]);
    await h.tick();
    h.streams.get('a'.repeat(64))!.push(frame(1, `${ts(T0, 1)} first\n`));
    await h.tick();
    await h.shipper.flush();
    expect(h.streams.get('d'.repeat(64))!.aborted).toBe(true);
    expect(h.shipper.following).toEqual(['a'.repeat(64)]);
    h.shipper.sync([
      { id: 'a'.repeat(64), key: 'acs/api', running: true },
      { id: 'd'.repeat(64), key: 'acs/caddy', running: true },
    ]);
    expect(h.shipper.following).toEqual(['a'.repeat(64)]);
    h.clock.t += 1000;
    h.streams.get('a'.repeat(64))!.push(Buffer.concat([1, 2, 3, 4].map((i) => frame(1, `${ts(T0, i + 1)} l${i}\n`))));
    await h.tick();
    await h.shipper.flush();
    expect(h.sent[1]!.batches[0]).toMatchObject({ service: 'acs/api', dropped: 2 });
    expect(h.sent[1]!.batches[0]!.lines.map((l) => l.msg)).toEqual(['l1', 'l2']);
  });

  it('a limit set on the host wins over the monitor’s', async () => {
    const s = new LogShipper({
      docker: { logs: async () => ({ async *[Symbol.asyncIterator]() {} }) },
      post: async () => ({ kind: 'ok' }),
      blocked: () => false,
      answer: () => undefined,
      log: silentLog,
      bufferDir: h.bufferDir,
      bufferMaxBytes: 1_000_000,
      linesPerS: 3,
      now: () => h.clock.t,
    });
    s.onAnswer({ excluded: [], linesPerS: 200 });
    for (let i = 1; i <= 5; i++) s.take('a'.repeat(64), 'acs/api', { sec: T0 / 1000, nanos: i, ts: T0, s: 'out', msg: `l${i}` });
    expect(s.dropped).toBe(2);
  });

  it('an older monitor answering 204 changes nothing', async () => {
    h = harness({ post: () => ({ kind: 'ok' }) });
    await h.shipper.init();
    h.shipper.start();
    h.shipper.sync([{ id: 'a'.repeat(64), key: 'acs/api', running: true }]);
    await h.tick();
    h.streams.get('a'.repeat(64))!.push(frame(1, `${ts(T0, 1)} x\n`));
    await h.tick();
    await h.shipper.flush();
    expect(h.sent).toHaveLength(1);
    expect(h.shipper.state().error).toBeNull();
  });
});

describe('LogShipper disk buffer', () => {
  let h: ReturnType<typeof harness>;
  afterEach(async () => {
    await h.shipper.stop();
    h.cleanup();
  });

  const feed = async (n: number, from = 0) => {
    const s = [...h.streams.values()][0]!;
    for (let i = 0; i < n; i++) {
      s.push(frame(1, `${ts(h.clock.t, from + i + 1)} line ${from + i}\n`));
      await h.tick();
      await h.shipper.flush();
      h.clock.t += 1000;
    }
  };

  it('keeps every batch while the monitor is down and sends them in order when it is back, also after a restart', async () => {
    let up = false;
    h = harness({ post: () => (up ? { kind: 'ok', body: { excluded: [], linesPerS: 200 } } : { kind: 'unavailable', detail: 'ECONNREFUSED' }) });
    await h.shipper.init();
    h.shipper.start();
    h.shipper.sync([{ id: 'a'.repeat(64), key: 'acs/api', running: true }]);
    await h.tick();
    await feed(1); // tried, failed: buffered, and the agent is told
    expect(h.answers).toEqual(['unavailable']);
    h.setBlocked(true); // the agent now waits: batches go straight to the buffer
    await feed(9, 1);
    expect(h.answers).toEqual(['unavailable']);
    expect(fs.readdirSync(h.bufferDir)).toHaveLength(10);
    expect(h.shipper.bufferBytes).toBeGreaterThan(0);

    // The agent restarts before the monitor is back: the buffer is still there.
    await h.shipper.stop();
    const again = new LogShipper({
      docker: { logs: async () => ({ async *[Symbol.asyncIterator]() {} }) },
      post: async (gz) => {
        h.sent.push(JSON.parse(zlib.gunzipSync(gz).toString('utf8')) as AgentLogs);
        return { kind: 'ok' };
      },
      blocked: () => false,
      answer: () => undefined,
      log: silentLog,
      bufferDir: h.bufferDir,
      bufferMaxBytes: 50 * 1024 * 1024,
      now: () => h.clock.t,
    });
    await again.init();
    expect(again.bufferBytes).toBe(h.shipper.bufferBytes);
    up = true;
    await again.flush(); // five per flush
    await again.flush();
    expect(h.lines(h.sent)).toEqual(Array.from({ length: 10 }, (_, i) => `acs/api:line ${i}`));
    expect(fs.readdirSync(h.bufferDir)).toEqual([]);
    expect(again.bufferBytes).toBe(0);
    await again.stop();
  });

  it('drops the oldest batches when the buffer is full and counts their lines on the service', async () => {
    let up = false;
    h = harness({ bufferMaxBytes: 1_000, post: () => (up ? { kind: 'ok' } : { kind: 'unavailable', detail: 'down' }) });
    await h.shipper.init();
    h.shipper.start();
    h.shipper.sync([{ id: 'a'.repeat(64), key: 'acs/api', running: true }]);
    await h.tick();
    h.setBlocked(true);
    const s = [...h.streams.values()][0]!;
    for (let i = 0; i < 12; i++) {
      // Random text does not compress, so each batch takes room.
      s.push(frame(1, `${ts(h.clock.t, 1)} ${i} ${Math.random().toString(36).repeat(8)}\n`));
      await h.tick();
      await h.shipper.flush();
      h.clock.t += 1000;
    }
    expect(h.shipper.bufferBytes).toBeLessThanOrEqual(1_000);
    expect(h.shipper.dropped).toBeGreaterThan(0);
    up = true;
    h.setBlocked(false);
    for (let i = 0; i < 5; i++) await h.shipper.flush();
    expect(fs.readdirSync(h.bufferDir)).toEqual([]);
    // Every line either arrived or is counted as dropped on its service; none vanish.
    const shipped = h.lines(h.sent).length;
    const counted = h.sent.flatMap((b) => b.batches).reduce((n, b) => n + b.dropped, 0);
    expect(shipped).toBeLessThan(12);
    expect(counted).toBe(h.shipper.dropped);
    expect(shipped + counted).toBe(12);
  });
});

describe('log settings', () => {
  it('ships logs with a 50 MB buffer unless told otherwise', () => {
    const base = { CC_MONITOR_URL: 'https://monitor-api.thediv.in' };
    expect(loadConfig(base)).toMatchObject({ logs: true, logBufferBytes: 50 * 1024 * 1024, logLinesPerS: null });
    expect(loadConfig({ ...base, CC_LOG_LINES_PER_S: '500' }).logLinesPerS).toBe(500);
    expect(() => loadConfig({ ...base, CC_LOG_LINES_PER_S: '5' })).toThrow(/CC_LOG_LINES_PER_S/);
    expect(loadConfig({ ...base, CC_LOGS: 'off', CC_LOG_BUFFER_MB: '10' })).toMatchObject({ logs: false, logBufferBytes: 10 * 1024 * 1024 });
    expect(() => loadConfig({ ...base, CC_LOG_BUFFER_MB: '0' })).toThrow(/CC_LOG_BUFFER_MB/);
    expect(() => loadConfig({ ...base, CC_LOGS: 'maybe' })).toThrow(/CC_LOGS/);
  });
});
