import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import type { AgentEnrollResponse } from '@cc/shared';
import type { Log } from './log';

const gzip = promisify(zlib.gzip);

/** Mirrors `AGENT_VERSION_HEADER` and `AGENT_INGEST_PREFIX` in @cc/shared (checked by a test). */
export const VERSION_HEADER = 'x-agent-version';
export const INGEST_PREFIX = '/agent/v1';

export type Endpoint = 'metrics' | 'events' | 'logs' | 'app';

export type PostResult =
  | { kind: 'ok' }
  /** 401: revoked, rotated or unknown token. */
  | { kind: 'unauthorized' }
  /** 426: the monitor wants a newer agent. */
  | { kind: 'too_old'; message: string }
  /** 429, with the monitor's Retry-After in seconds. */
  | { kind: 'rate_limited'; retryAfterS: number }
  /** 400, 413, 415: this request will never be accepted; a bug, not a reason to wait. */
  | { kind: 'rejected'; status: number; error: string }
  /** 5xx, a timeout or no connection. */
  | { kind: 'unavailable'; detail: string };

export class EnrollError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Talks to the monitor's agent ingest (TRD 14.3). Holds the host token, which lives only in
 * `<stateDir>/token` (mode 600) and in memory; it is never logged.
 */
export class MonitorClient {
  private token: string | null = null;

  constructor(
    private readonly o: {
      url: string;
      stateDir: string;
      enrollToken: string | null;
      version: string;
      hostname: string;
      log: Log;
      fetch?: typeof fetch;
    },
  ) {}

  private get fetch(): typeof fetch {
    return this.o.fetch ?? fetch;
  }

  private file(name: string): string {
    return path.join(this.o.stateDir, name);
  }

  hasToken(): boolean {
    return this.token !== null;
  }

  /**
   * Loads the saved host token, and enrolls when `CC_ENROLL_TOKEN` is one this agent has not used
   * yet (first start, or a new token the admin issued to rotate or re-enroll after a revoke). The
   * enrollment token itself is never stored, only a hash that says it was used.
   */
  async init(): Promise<'enrolled' | 'saved'> {
    const saved = await fs.readFile(this.file('token'), 'utf8').then(
      (s) => s.trim() || null,
      () => null,
    );
    const usedHash = await fs.readFile(this.file('enrolled-with'), 'utf8').then(
      (s) => s.trim(),
      () => '',
    );
    const enroll = this.o.enrollToken;
    if (enroll && sha256(enroll) !== usedHash) {
      try {
        await this.enroll(enroll);
        return 'enrolled';
      } catch (e) {
        // A used or expired enrollment token with a working saved token: keep going with that.
        if (saved && e instanceof EnrollError && e.code.startsWith('enroll_token_')) {
          this.o.log.warn('the enrollment token was not accepted; using the saved host token', { reason: e.code });
          this.token = saved;
          return 'saved';
        }
        throw e;
      }
    }
    if (!saved) {
      throw new EnrollError(
        'no_token',
        'No saved host token and no new CC_ENROLL_TOKEN. Create one on the Hosts page, put it in the env file and restart the agent.',
      );
    }
    this.token = saved;
    return 'saved';
  }

  private async enroll(enrollToken: string): Promise<void> {
    let r: Response;
    try {
      r = await this.fetch(this.o.url + INGEST_PREFIX + '/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enrollToken, hostname: this.o.hostname.slice(0, 253), os: 'linux', agentVersion: this.o.version }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new EnrollError('unavailable', `The monitor could not be reached: ${errText(e)}`);
    }
    const body = (await r.json().catch(() => ({}))) as Partial<AgentEnrollResponse> & { error?: string; message?: string };
    if (r.status !== 200 || typeof body.token !== 'string') {
      const code = body.error ?? `http_${r.status}`;
      throw new EnrollError(code, `Enrollment refused (${r.status} ${code})${body.message ? `: ${body.message}` : ''}`);
    }
    await fs.mkdir(this.o.stateDir, { recursive: true });
    await writePrivate(this.file('token'), body.token + '\n');
    await writePrivate(this.file('enrolled-with'), sha256(enrollToken) + '\n');
    this.token = body.token;
    this.o.log.info('enrolled with the monitor', { hostId: body.hostId, hostName: body.hostName });
  }

  /** One gzip JSON request to `/agent/v1/<endpoint>`. */
  async post(endpoint: Endpoint, payload: unknown): Promise<PostResult> {
    if (!this.token) return { kind: 'unauthorized' };
    const body = await gzip(Buffer.from(JSON.stringify(payload), 'utf8'));
    let r: Response;
    try {
      r = await this.fetch(this.o.url + INGEST_PREFIX + '/' + endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          [VERSION_HEADER]: this.o.version,
          'content-type': 'application/json',
          'content-encoding': 'gzip',
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      return { kind: 'unavailable', detail: errText(e) };
    }
    if (r.status === 200 || r.status === 204) {
      await r.body?.cancel();
      return { kind: 'ok' };
    }
    const j = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
    if (r.status === 401) return { kind: 'unauthorized' };
    if (r.status === 426) return { kind: 'too_old', message: j.message ?? 'agent too old' };
    if (r.status === 429) {
      const s = Number(r.headers.get('retry-after'));
      return { kind: 'rate_limited', retryAfterS: Number.isFinite(s) && s > 0 ? Math.min(s, 3600) : 60 };
    }
    if (r.status >= 400 && r.status < 500) return { kind: 'rejected', status: r.status, error: j.error ?? 'bad_request' };
    return { kind: 'unavailable', detail: `HTTP ${r.status}` };
  }
}

/** Written to a temporary file and renamed, so a crash never leaves half a token. */
async function writePrivate(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

export const errText = (e: unknown): string => {
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause;
    return cause?.code ? `${e.message} (${cause.code})` : e.message;
  }
  return String(e);
};
