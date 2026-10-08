import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LogPipeline } from '../src/logs/pipeline';
import { LogBackfill, tailFile } from '../src/pm2/backfill';
import type { Pm2Proc } from '../src/pm2/types';

const writer = { enqueue: () => { throw new Error('history must not be re-written to the monitor logs'); } };
const pipe = () => new LogPipeline({ writer: writer as never, ringLines: () => 1000 });
const proc = (o: Partial<Pm2Proc>): Pm2Proc => ({
  name: 'api', pmId: 0, status: 'online', restarts: 0, pmUptime: 1, cpu: 0, memory: 0, isModule: false, ...o,
});

describe('log backfill', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-'));
  const out = path.join(dir, 'out.log');
  const err = path.join(dir, 'err.log');
  fs.writeFileSync(out, 'one\ntwo\nthree\n');
  fs.writeFileSync(err, 'boom\n');

  it('shows recent history of a quiet service without writing it again', async () => {
    const p = pipe();
    await new LogBackfill(p).run([proc({ outLog: out, errLog: err })]);
    const t = p.tail('api', 50);
    expect(t.map((l) => l.msg.trim()).sort()).toEqual(['boom', 'one', 'three', 'two']);
    expect(t.find((l) => l.msg.startsWith('boom'))?.s).toBe('err');
  });

  it('skips a service that already has live lines, and runs once per service', async () => {
    const p = pipe();
    const w = { enqueue: () => undefined };
    const live = new LogPipeline({ writer: w as never, ringLines: () => 1000 });
    live.ingest('api', 0, 'out', 'live\n');
    const b = new LogBackfill(live);
    await b.run([proc({ outLog: out })]);
    expect(live.tail('api', 10).map((l) => l.msg)).toEqual(['live\n']);
    await new LogBackfill(p).run([proc({ outLog: out })]);
    fs.appendFileSync(out, 'four\n');
    const before = p.tail('api', 50).length;
    const b2 = new LogBackfill(p);
    await b2.run([proc({ outLog: out })]);
    expect(p.tail('api', 50).length).toBe(before);
  });

  it('tolerates missing, empty and absent paths and caps size', async () => {
    expect((await tailFile(path.join(dir, 'nope.log'))).lines).toEqual([]);
    const big = path.join(dir, 'big.log');
    fs.writeFileSync(big, Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n'));
    const r = await tailFile(big);
    expect(r.lines.length).toBeLessThanOrEqual(150);
    expect(r.lines.at(-1)).toBe('line 4999');
    await new LogBackfill(pipe()).run([proc({ outLog: null, errLog: undefined }), proc({ name: 'm', isModule: true, outLog: out })]);
  });
});
