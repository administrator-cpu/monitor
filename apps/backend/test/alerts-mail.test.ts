import { describe, expect, it } from 'vitest';
import { ResendMailer } from '../src/alerts/mailer';
import type { IncidentView } from '../src/alerts/rules';
import { renderIncidentEmail, renderTestEmail } from '../src/alerts/templates';

const MSG = { from: 'a@x.io', to: 'b@x.io', subject: 's', html: '<p>h</p>', text: 't', idempotencyKey: 'k-1' };

function mailerWith(res: () => Response | Promise<Response>, calls: { url: string; init: RequestInit }[] = []) {
  return new ResendMailer({
    apiKey: 're_secretkey123',
    url: 'https://resend.test/emails',
    timeoutMs: 50,
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return res();
    }) as unknown as typeof fetch,
  });
}

describe('ResendMailer', () => {
  it('posts with the bearer key and an idempotency key, one recipient per request', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const r = await mailerWith(() => Response.json({ id: 'abc' }), calls).send(MSG);
    expect(r).toEqual({ ok: true, id: 'abc' });
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer re_secretkey123');
    expect(h['Idempotency-Key']).toBe('k-1');
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ from: 'a@x.io', to: ['b@x.io'], subject: 's' });
  });

  it('treats most 4xx as permanent, and 429, 408 and 5xx as retryable', async () => {
    const r422 = await mailerWith(() => Response.json({ message: 'bad sender' }, { status: 422 })).send(MSG);
    expect(r422).toEqual({ ok: false, permanent: true, error: 'HTTP 422: bad sender' });
    for (const status of [429, 408, 500, 503]) {
      const r = await mailerWith(() => new Response('oops', { status })).send(MSG);
      expect(r).toMatchObject({ ok: false, permanent: false });
    }
  });

  it('reports a timeout and a network error as retryable without leaking the key', async () => {
    const slow = new ResendMailer({
      apiKey: 're_secretkey123',
      url: 'https://resend.test/emails',
      timeoutMs: 20,
      fetchImpl: ((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })) as unknown as typeof fetch,
    });
    const t = await slow.send(MSG);
    expect(t).toEqual({ ok: false, permanent: false, error: 'timeout after 20 ms' });
    const n = await mailerWith(() => {
      throw new Error('getaddrinfo ENOTFOUND');
    }).send(MSG);
    expect(n).toMatchObject({ ok: false, permanent: false });
    expect(JSON.stringify([t, n])).not.toContain('re_secretkey123');
  });
});

const inc = (over: Partial<IncidentView> = {}): IncidentView => ({
  id: 7, rule_id: 1, service_id: 3, fingerprint: 'pm2.service_down:3', state: 'firing', opened_at: 1_800_000_000_000,
  resolved_at: null, last_notified_at: null, notify_count: 0, peak_value: null,
  summary: 'Service api is errored', suppressed_by: null, rule_key: 'pm2.service_down', rule_name: 'Service down',
  category: 'pm2', severity: 'critical', service_name: 'api', ...over,
});

describe('email templates', () => {
  const o = { dashboardUrl: 'https://mon.example.com', now: 1_800_000_300_000 };

  it('renders subject, facts and a link for an opened alert', () => {
    const m = renderIncidentEmail('opened', inc(), o);
    expect(m.subject).toBe('[CRITICAL] Service down (api)');
    expect(m.text).toContain('Service api is errored');
    expect(m.text).toContain('https://mon.example.com/alerts?incident=7');
    expect(m.text).toContain('Firing for: 5 min');
  });

  it('marks reminders and resolutions', () => {
    expect(renderIncidentEmail('reminder', inc(), o).subject.startsWith('[STILL FIRING]')).toBe(true);
    const r = renderIncidentEmail('resolved', inc({ state: 'resolved', resolved_at: 1_800_000_240_000 }), o);
    expect(r.subject.startsWith('[RESOLVED]')).toBe(true);
    expect(r.text).toContain('after 4 min');
  });

  it('escapes HTML and strips line breaks from the subject', () => {
    const m = renderIncidentEmail(
      'opened',
      inc({ service_name: 'a<script>x</script>\r\nBcc: evil@x.io', summary: '"quoted" <b>' }),
      o,
    );
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).toContain('&quot;quoted&quot; &lt;b&gt;');
  });

  it('omits the link when no dashboard URL is set', () => {
    const m = renderIncidentEmail('opened', inc(), { dashboardUrl: null, now: o.now });
    expect(m.text).not.toContain('http');
    expect(m.html).not.toContain('href');
  });

  it('has a test email that carries no incident data', () => {
    const m = renderTestEmail(o);
    expect(m.subject).toContain('TEST');
    expect(m.text).not.toContain('Severity');
  });
});
