export interface StubSample {
  active: number;
  accepts: number;
  handled: number;
  requests: number;
  reading: number;
  writing: number;
  waiting: number;
}

/**
 * Parses nginx `stub_status`:
 *   Active connections: 291
 *   server accepts handled requests
 *    16630948 16630948 31070465
 *   Reading: 6 Writing: 179 Waiting: 106
 */
export function parseStubStatus(text: string): StubSample | null {
  const a = /Active connections:\s*(\d+)/.exec(text);
  const c = /server accepts handled requests\s*\n\s*(\d+)\s+(\d+)\s+(\d+)/.exec(text);
  const r = /Reading:\s*(\d+)\s+Writing:\s*(\d+)\s+Waiting:\s*(\d+)/.exec(text);
  if (!a || !c || !r) return null;
  return {
    active: Number(a[1]),
    accepts: Number(c[1]),
    handled: Number(c[2]),
    requests: Number(c[3]),
    reading: Number(r[1]),
    writing: Number(r[2]),
    waiting: Number(r[3]),
  };
}

/** Requests per second from two counter readings. A reset (nginx restart) or a clock jump gives null. */
export function rateFromCounters(prev: { at: number; requests: number } | null, cur: { at: number; requests: number }): number | null {
  if (!prev) return null;
  const dt = (cur.at - prev.at) / 1000;
  const dr = cur.requests - prev.requests;
  if (dt <= 0 || dr < 0) return null;
  return dr / dt;
}

export async function fetchStub(
  url: string,
  timeoutMs = 3_000,
  fetchFn: typeof fetch = fetch,
): Promise<StubSample> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ctl.signal, redirect: 'manual' });
    if (res.status !== 200) throw new Error(`stub_status answered HTTP ${res.status}`);
    const body = (await res.text()).slice(0, 4_096);
    const s = parseStubStatus(body);
    if (!s) throw new Error('stub_status answered with text that is not stub_status output');
    return s;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('stub_status did not answer in time');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
