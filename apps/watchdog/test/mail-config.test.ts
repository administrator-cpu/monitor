import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, loadConfig } from '../src/config';
import type { EmailFacts } from '../src/machine';
import { renderMail, resendSender, span } from '../src/mail';

const GOOD = {
  TARGET_URL: 'https://api.example.com/health', CRON_TOKEN: 'c'.repeat(32), RESEND_API_KEY: 're_secret_key_123',
  ALERT_FROM: 'Watchdog <alerts@example.com>', ALERT_TO: 'a@example.com, b@example.com',
};
const facts = (over: Partial<EmailFacts> = {}): EmailFacts => ({
  kind: 'down', incident: 1, downSince: Date.UTC(2026, 5, 1, 10, 0, 0), now: Date.UTC(2026, 5, 1, 11, 5, 0),
  failure: { ok: false, kind: 'unreachable', detail: 'connection refused', attempts: 3 }, recoveredAt: null, ...over,
});

describe('config', () => {
  it('accepts a complete configuration with production defaults', () => {
    const c = loadConfig(GOOD);
    expect(c).toMatchObject({ attempts: 3, attemptDelayMs: 10_000, attemptTimeoutMs: 8_000, reminderAfterMs: 3_600_000, flapWindowMs: 1_800_000, port: 10_000 });
    expect(c.alertTo).toEqual(['a@example.com', 'b@example.com']);
    expect(c.overridden).toEqual([]);
  });

  it('lists every problem and never echoes a secret', () => {
    try {
      loadConfig({ TARGET_URL: 'http://api.example.com', CRON_TOKEN: 'short-secret', ALERT_TO: 'not-an-address', ALERT_FROM: 'x' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const m = (e as Error).message;
      expect(m).toMatch(/TARGET_URL must start with https/);
      expect(m).toMatch(/CRON_TOKEN must be at least 32/);
      expect(m).toMatch(/RESEND_API_KEY is required/);
      expect(m).toMatch(/ALERT_TO contains an invalid address/);
      expect(m).not.toContain('short-secret');
    }
  });

  it('allows plain http only for localhost, and rejects credentials in the URL', () => {
    expect(() => loadConfig({ ...GOOD, TARGET_URL: 'http://127.0.0.1:9001/health' })).not.toThrow();
    expect(() => loadConfig({ ...GOOD, TARGET_URL: 'http://example.com/health' })).toThrow(/https/);
    expect(() => loadConfig({ ...GOOD, TARGET_URL: 'https://u:p@example.com/health' })).toThrow(/credentials/);
  });

  it('flags overridden timings and validates their range', () => {
    expect(loadConfig({ ...GOOD, ATTEMPT_DELAY_MS: '100', REMINDER_AFTER_MS: '2000' }).overridden).toEqual(['ATTEMPT_DELAY_MS', 'REMINDER_AFTER_MS']);
    expect(() => loadConfig({ ...GOOD, ATTEMPTS: '0' })).toThrow(/ATTEMPTS/);
    expect(() => loadConfig({ ...GOOD, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('describeConfig hides secrets and addresses', () => {
    const s = JSON.stringify(describeConfig(loadConfig(GOOD)));
    expect(s).not.toContain('re_secret_key_123');
    expect(s).not.toContain('example.com>');
    expect(s).not.toContain('a@example.com');
    expect(s).not.toContain('c'.repeat(32));
  });
});

describe('emails', () => {
  it('the down email names the failure mode: connection versus wrong answer', () => {
    const a = renderMail(facts(), 'api.example.com');
    expect(a.subject).toBe('[DOWN] Command Center backend is not responding');
    expect(a.text).toContain('connection to api.example.com failed (connection refused)');
    expect(a.text).toContain('VPS, its network connection or Nginx');
    const b = renderMail(facts({ failure: { ok: false, kind: 'bad_response', detail: 'HTTP 502', attempts: 3 } }), 'api.example.com');
    expect(b.text).toContain('answered, but the health check did not pass (HTTP 502)');
    expect(b.text).toContain('backend is not responding correctly');
  });

  it('reminder and recovery carry durations', () => {
    expect(renderMail(facts({ kind: 'reminder' }), 'h').subject).toBe('[STILL DOWN] Command Center backend, down for 65 minutes');
    const r = renderMail(facts({ kind: 'recovered', recoveredAt: Date.UTC(2026, 5, 1, 11, 20, 0) }), 'h');
    expect(r.subject).toBe('[RECOVERED] Command Center backend is back online');
    expect(r.text).toContain('about 80 minutes');
    expect(span(30_000)).toBe('less than a minute');
  });

  it('escapes HTML and contains no token or key', () => {
    const m = renderMail(facts({ failure: { ok: false, kind: 'bad_response', detail: 'HTTP 200 but the body was not "ok"', attempts: 3 } }), '<b>host</b>');
    expect(m.html).not.toContain('<b>host</b>');
    expect(m.html).toContain('&lt;b&gt;');
  });
});

describe('resendSender', () => {
  async function withServer(status: number, fn: (url: string, got: { headers: http.IncomingHttpHeaders; body: any }[]) => Promise<void>) {
    const got: { headers: http.IncomingHttpHeaders; body: any }[] = [];
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        got.push({ headers: req.headers, body: JSON.parse(b) });
        res.statusCode = status;
        res.end('{"id":"x"}');
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/emails`, got);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  }
  const cfg = (url: string) => ({ ...loadConfig({ ...GOOD, RESEND_API_URL: url, TARGET_URL: 'https://api.example.com/health' }) });

  it('posts one request to all recipients, with auth and an idempotency key unique to this boot', async () => {
    await withServer(200, async (url, got) => {
      const send = resendSender(cfg(url), 'boot1', () => undefined);
      expect(await send(facts())).toBe(true);
      expect(got).toHaveLength(1);
      expect(got[0]!.headers.authorization).toBe('Bearer re_secret_key_123');
      expect(got[0]!.headers['idempotency-key']).toBe('wd-boot1-1-down');
      expect(got[0]!.body.to).toEqual(['a@example.com', 'b@example.com']);
      expect(got[0]!.body.from).toBe('Watchdog <alerts@example.com>');
      expect(JSON.stringify(got[0]!.body)).not.toContain('re_secret_key_123');
    });
  });

  it('reports failure (so the machine retries) without throwing', async () => {
    const warns: string[] = [];
    await withServer(422, async (url) => {
      expect(await resendSender(cfg(url), 'b', (m) => warns.push(m))(facts())).toBe(false);
    });
    expect(warns).toEqual(['Resend rejected the email']);
    expect(await resendSender(cfg('http://127.0.0.1:1/emails'), 'b', (m) => warns.push(m))(facts())).toBe(false);
    expect(warns).toContain('could not reach Resend');
  });
});
