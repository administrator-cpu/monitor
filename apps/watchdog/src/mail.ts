import type { Config } from './config';
import type { EmailFacts } from './machine';

export interface Mail {
  subject: string;
  text: string;
  html: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const utc = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

export function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (ms < 45_000) return 'less than a minute';
  if (m < 120) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

function failureText(f: EmailFacts['failure'], host: string): string {
  if (!f) return 'No details were recorded.';
  if (f.kind === 'unreachable') {
    return `The connection to ${host} failed (${f.detail}). The VPS, its network connection or Nginx is unreachable, so the backend cannot be checked.`;
  }
  return `${host} answered, but the health check did not pass (${f.detail}). The connection works, so the VPS and Nginx are up; the backend is not responding correctly.`;
}

/** Operational facts only: what failed, since when, how long. No tokens, no response bodies. */
export function renderMail(e: EmailFacts, host: string): Mail {
  let subject: string;
  let lines: string[];
  switch (e.kind) {
    case 'down':
      subject = `[DOWN] Command Center backend is not responding`;
      lines = [
        `The backend at ${host} failed its health check on all attempts.`,
        failureText(e.failure, host),
        `First failed: ${utc(e.downSince)}`,
        'Next emails: one reminder if it is still down after an hour, and one when it is back.',
      ];
      break;
    case 'reminder':
      subject = `[STILL DOWN] Command Center backend, down for ${span(e.now - e.downSince)}`;
      lines = [
        `The backend at ${host} is still not responding.`,
        failureText(e.failure, host),
        `Down since: ${utc(e.downSince)} (${span(e.now - e.downSince)})`,
        'This is the only reminder. You will get one more email when it is back.',
      ];
      break;
    case 'recovered':
      subject = `[RECOVERED] Command Center backend is back online`;
      lines = [
        `The backend at ${host} passes its health check again (two checks in a row).`,
        `Down since: ${utc(e.downSince)}`,
        `Back at: ${utc(e.recoveredAt ?? e.now)} (outage lasted about ${span((e.recoveredAt ?? e.now) - e.downSince)})`,
        'If it fails again within 30 minutes this is treated as the same outage and you will not get a new "down" email.',
      ];
      break;
  }
  const text = lines.join('\n\n');
  const html = `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;color:#1a1a1a">${lines
    .map((l) => `<p>${esc(l)}</p>`)
    .join('')}</body></html>`;
  return { subject, text, html };
}

export type Sender = (e: EmailFacts) => Promise<boolean>;

/** One request per email to Resend; the idempotency key stops a retried request from sending twice. */
export function resendSender(
  c: Pick<Config, 'resendApiKey' | 'resendApiUrl' | 'alertFrom' | 'alertTo' | 'targetUrl'>,
  bootId: string,
  warn: (msg: string, extra?: Record<string, unknown>) => void,
  fetchImpl: typeof fetch = fetch,
): Sender {
  return async (e) => {
    const mail = renderMail(e, c.targetUrl.host);
    try {
      const res = await fetchImpl(c.resendApiUrl, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${c.resendApiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `wd-${bootId}-${e.incident}-${e.kind}`,
        },
        body: JSON.stringify({ from: c.alertFrom, to: c.alertTo, subject: mail.subject, text: mail.text, html: mail.html }),
      });
      if (res.ok) return true;
      warn('Resend rejected the email', { status: res.status, kind: e.kind });
      return false;
    } catch (err) {
      warn('could not reach Resend', { kind: e.kind, error: err instanceof Error ? err.name : 'error' });
      return false;
    }
  };
}
