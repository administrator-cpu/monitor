import { describe, expect, it, vi } from 'vitest';
import { isHealthyBody, runCheck } from '../src/check';

const URL_ = new URL('https://api.example.com/health');
const respond = (status: number, body: string) => async () => new Response(body, { status });
const netError = (code: string) => async () => {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code } });
};

function opts(f: typeof fetch, extra: Partial<Parameters<typeof runCheck>[0]> = {}) {
  const sleeps: number[] = [];
  return {
    sleeps,
    o: {
      url: URL_, attempts: 3, delayMs: 10_000, timeoutMs: 8_000, fetchImpl: f,
      sleep: async (ms: number) => void sleeps.push(ms), ...extra,
    },
  };
}

describe('runCheck', () => {
  it('accepts 200 with {"status":"ok"} on the first attempt', async () => {
    const { o, sleeps } = opts(respond(200, '{"status":"ok"}') as never);
    expect(await runCheck(o)).toEqual({ ok: true, attempts: 1 });
    expect(sleeps).toEqual([]);
  });

  it('two failed attempts followed by one success is a successful check', async () => {
    const f = vi.fn().mockImplementationOnce(netError('ECONNREFUSED')).mockImplementationOnce(respond(502, 'bad gateway')).mockImplementation(respond(200, 'ok'));
    const { o, sleeps } = opts(f as never);
    expect(await runCheck(o)).toEqual({ ok: true, attempts: 3 });
    expect(sleeps).toEqual([10_000, 10_000]); // 10 s between attempts
  });

  it('three failures is a failed check, with no sleep after the last attempt', async () => {
    const { o, sleeps } = opts(netError('ECONNREFUSED') as never);
    expect(await runCheck(o)).toEqual({ ok: false, kind: 'unreachable', detail: 'connection refused', attempts: 3 });
    expect(sleeps).toHaveLength(2);
  });

  it.each([
    ['ENOTFOUND', 'DNS name not found'],
    ['ETIMEDOUT', 'connection timed out'],
    ['CERT_HAS_EXPIRED', 'TLS certificate expired'],
    ['SOMETHING_ODD', 'SOMETHING_ODD'],
  ])('classifies %s as unreachable', async (code, detail) => {
    const { o } = opts(netError(code) as never, { attempts: 1 });
    expect(await runCheck(o)).toMatchObject({ ok: false, kind: 'unreachable', detail });
  });

  it('classifies a non-200 answer as the backend responding incorrectly', async () => {
    const { o } = opts(respond(502, '<html>secret page</html>') as never, { attempts: 1 });
    const r = await runCheck(o);
    expect(r).toMatchObject({ ok: false, kind: 'bad_response', detail: 'HTTP 502' });
    expect(JSON.stringify(r)).not.toContain('secret page'); // bodies never reach the email
  });

  it('treats a 200 with the wrong body, and any redirect, as a bad response', async () => {
    expect(await runCheck(opts(respond(200, '<html>maintenance</html>') as never, { attempts: 1 }).o)).toMatchObject({ kind: 'bad_response' });
    expect(await runCheck(opts(respond(301, '') as never, { attempts: 1 }).o)).toMatchObject({ kind: 'bad_response', detail: 'HTTP 301' });
  });

  it('classifies by the last attempt', async () => {
    const f = vi.fn().mockImplementationOnce(netError('ECONNREFUSED')).mockImplementationOnce(netError('ECONNREFUSED')).mockImplementation(respond(503, ''));
    expect(await runCheck(opts(f as never).o)).toMatchObject({ ok: false, kind: 'bad_response', detail: 'HTTP 503' });
  });

  it('gives up on an attempt that does not answer within the timeout', async () => {
    const hang = ((_u: unknown, init: RequestInit) =>
      new Promise((_r, rej) => init.signal?.addEventListener('abort', () => rej(init.signal!.reason)))) as unknown as typeof fetch;
    const t0 = Date.now();
    const { o } = opts(hang, { attempts: 1, timeoutMs: 120 });
    const r = await runCheck(o);
    expect(r).toMatchObject({ ok: false, kind: 'unreachable', detail: 'no answer before the timeout' });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('never follows redirects', async () => {
    const f = vi.fn(respond(200, 'ok'));
    await runCheck(opts(f as never, { attempts: 1 }).o);
    expect(((f.mock.calls as unknown as [string, RequestInit][])[0]![1]).redirect).toBe('manual');
  });
});

describe('isHealthyBody', () => {
  it('accepts only an explicit ok', () => {
    expect(isHealthyBody('ok')).toBe(true);
    expect(isHealthyBody(' OK\n')).toBe(true);
    expect(isHealthyBody('{"status":"ok"}')).toBe(true);
    expect(isHealthyBody('{"status":"degraded"}')).toBe(false);
    expect(isHealthyBody('')).toBe(false);
    expect(isHealthyBody('<html>')).toBe(false);
  });
});
