export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Stable per logical email, so a retry after a timeout cannot send it twice. */
  idempotencyKey: string;
}

export type MailResult =
  | { ok: true; id: string | null }
  | { ok: false; permanent: boolean; error: string };

export interface Mailer {
  send(m: MailMessage): Promise<MailResult>;
}

export interface ResendOptions {
  apiKey: string;
  url: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Sends through the Resend HTTP API. The key never leaves the Authorization header. */
export class ResendMailer implements Mailer {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: ResendOptions) {
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  async send(m: MailMessage): Promise<MailResult> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.o.url, {
        method: 'POST',
        signal: ctl.signal,
        headers: {
          Authorization: `Bearer ${this.o.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': m.idempotencyKey,
        },
        body: JSON.stringify({ from: m.from, to: [m.to], subject: m.subject, html: m.html, text: m.text }),
      });
      const body = (await res.json().catch(() => null)) as { id?: unknown; message?: unknown } | null;
      if (res.ok) return { ok: true, id: typeof body?.id === 'string' ? body.id : null };
      const detail = typeof body?.message === 'string' ? `: ${body.message}` : '';
      // 4xx means the request itself is wrong (bad key, bad sender); retrying cannot fix it.
      // 408, 409 and 429 are the exceptions: they are about timing or load.
      const permanent = res.status >= 400 && res.status < 500 && ![408, 409, 429].includes(res.status);
      return { ok: false, permanent, error: `HTTP ${res.status}${detail}`.slice(0, 300) };
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      return {
        ok: false,
        permanent: false,
        error: aborted ? `timeout after ${this.timeoutMs} ms` : `network error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
