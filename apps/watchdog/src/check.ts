export type FailureKind = 'unreachable' | 'bad_response';

export interface CheckFailure {
  ok: false;
  kind: FailureKind;
  /** Short, safe description (an error code or an HTTP status). Never a response body. */
  detail: string;
  attempts: number;
}
export interface CheckSuccess {
  ok: true;
  attempts: number;
}
export type CheckResult = CheckSuccess | CheckFailure;

export interface CheckOptions {
  url: URL;
  attempts: number;
  delayMs: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Attempt = { ok: true } | { ok: false; kind: FailureKind; detail: string };

const NETWORK_CODES: Record<string, string> = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  ENOTFOUND: 'DNS name not found',
  EAI_AGAIN: 'DNS lookup failed',
  ETIMEDOUT: 'connection timed out',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  UND_ERR_CONNECT_TIMEOUT: 'connection timed out',
  CERT_HAS_EXPIRED: 'TLS certificate expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS certificate not trusted',
  SELF_SIGNED_CERT_IN_CHAIN: 'TLS certificate not trusted',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate not trusted',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate name mismatch',
};

function describeNetworkError(e: unknown): string {
  const err = e as { name?: string; code?: string; cause?: { code?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'no answer before the timeout';
  const code = err?.cause?.code ?? err?.code;
  if (code && NETWORK_CODES[code]) return NETWORK_CODES[code] as string;
  if (code && /^[A-Z0-9_]{3,40}$/.test(code)) return code;
  return 'connection failed';
}

/** `/health` answers 200 with `{"status":"ok"}` (or the plain text `ok`). Anything else is wrong. */
export function isHealthyBody(text: string): boolean {
  const t = text.trim();
  if (t.toLowerCase() === 'ok') return true;
  try {
    return (JSON.parse(t) as { status?: unknown }).status === 'ok';
  } catch {
    return false;
  }
}

async function once(url: URL, timeoutMs: number, f: typeof fetch): Promise<Attempt> {
  const signal = AbortSignal.timeout(timeoutMs); // covers connecting and reading the body
  let res: Response;
  try {
    res = await f(url, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: { 'user-agent': 'command-center-watchdog', accept: 'application/json, text/plain' },
    });
  } catch (e) {
    return { ok: false, kind: 'unreachable', detail: describeNetworkError(e) };
  }
  try {
    const text = (await res.text()).slice(0, 2_000);
    if (res.status !== 200) return { ok: false, kind: 'bad_response', detail: `HTTP ${res.status}` };
    if (!isHealthyBody(text)) return { ok: false, kind: 'bad_response', detail: 'HTTP 200 but the body was not "ok"' };
    return { ok: true };
  } catch (e) {
    // The server answered but did not finish the body in time: it is up, but not healthy.
    return { ok: false, kind: 'bad_response', detail: `HTTP ${res.status}, ${describeNetworkError(e)} while reading the answer` };
  }
}

/**
 * Up to `attempts` tries, `delayMs` apart. One success is a successful check; all failing is a
 * failed check, classified by the LAST attempt (the most recent evidence).
 */
export async function runCheck(o: CheckOptions): Promise<CheckResult> {
  const f = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? realSleep;
  let last: Attempt = { ok: false, kind: 'unreachable', detail: 'no attempt made' };
  for (let i = 1; i <= o.attempts; i++) {
    last = await once(o.url, o.timeoutMs, f);
    if (last.ok) return { ok: true, attempts: i };
    if (i < o.attempts) await sleep(o.delayMs);
  }
  const fail = last as Extract<Attempt, { ok: false }>;
  return { ok: false, kind: fail.kind, detail: fail.detail, attempts: o.attempts };
}
