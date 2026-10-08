import type { AlertStatusResponse, TestEmailResponse } from '@cc/shared';
import type { Config } from '../config';
import type { Logger } from '../logger';
import type { Settings } from '../settings';
import type { Mailer } from './mailer';
import type { AlertRepo } from './repo';
import type { IncidentView } from './rules';
import { renderIncidentEmail, renderTestEmail, type EmailKind } from './templates';

export interface NotifierOptions {
  mailer: Mailer | null;
  repo: AlertRepo;
  settings: Settings;
  config: Pick<Config, 'alertFrom' | 'publicDashboardUrl' | 'resendApiKey'>;
  log: Pick<Logger, 'warn' | 'info'>;
  now?: () => number;
  /** Pause between attempts for one recipient. Injectable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: number[];
}

export interface SendOutcome {
  recipients: number;
  sent: number;
  failed: number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Turns an incident and a kind into emails: one per recipient, each with up to three attempts.
 * Every outcome is recorded in alert_notifications. Whether and when to send is the engine's call.
 */
export class Notifier {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly delays: number[];
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  private lastSentAt: number | null = null;

  constructor(private readonly o: NotifierOptions) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? realSleep;
    this.delays = o.retryDelaysMs ?? [1_000, 4_000];
  }

  from(): string | null {
    return this.o.settings.getString('alert.from') ?? this.o.config.alertFrom ?? null;
  }

  dashboardUrl(): string | null {
    return this.o.settings.getString('alert.dashboard_url') ?? this.o.config.publicDashboardUrl ?? null;
  }

  configured(): boolean {
    return this.o.mailer !== null && this.from() !== null;
  }

  get failures(): number {
    return this.consecutiveFailures;
  }

  status(): AlertStatusResponse['email'] {
    const missing: string[] = [];
    if (!this.o.config.resendApiKey) missing.push('RESEND_API_KEY');
    if (!this.from()) missing.push('alert.from (or ALERT_FROM)');
    const warnings: string[] = [];
    const from = this.from();
    if (from && /@resend\.dev>?$/i.test(from)) {
      warnings.push('The sender uses resend.dev: Resend delivers only to the address of your own Resend account.');
    }
    if (!this.dashboardUrl()) warnings.push('No dashboard URL is set, so emails contain no link.');
    return {
      configured: missing.length === 0,
      missing,
      warnings,
      failing: this.consecutiveFailures >= 3,
      lastError: this.lastError,
      lastSentAt: this.lastSentAt,
      consecutiveFailures: this.consecutiveFailures,
      from,
      dashboardUrl: this.dashboardUrl(),
    };
  }

  async sendIncident(inc: IncidentView, kind: Exclude<EmailKind, 'test'>): Promise<SendOutcome> {
    const recipients = this.o.repo.recipients(inc.category);
    const mail = renderIncidentEmail(kind, inc, { dashboardUrl: this.dashboardUrl(), now: this.now() });
    let sent = 0;
    let failed = 0;
    for (const u of recipients) {
      const r = await this.deliver({
        to: u.email,
        mail,
        key: `inc-${inc.id}-${kind}-${inc.notify_count}-u${u.id}`,
      });
      this.o.repo.insertNotification({
        incident_id: inc.id,
        kind,
        to_email: u.email,
        provider_msg_id: r.id,
        status: r.ok ? 'sent' : 'failed',
        attempts: r.attempts,
        error: r.error,
        ts: this.now(),
      });
      if (r.ok) sent += 1;
      else failed += 1;
    }
    return { recipients: recipients.length, sent, failed };
  }

  /** Records a 'muted' row for each recipient instead of sending. */
  recordMuted(inc: IncidentView, kind: Exclude<EmailKind, 'test'>): void {
    for (const u of this.o.repo.recipients(inc.category)) {
      this.o.repo.insertNotification({
        incident_id: inc.id,
        kind,
        to_email: u.email,
        provider_msg_id: null,
        status: 'muted',
        attempts: 0,
        error: null,
        ts: this.now(),
      });
    }
  }

  async sendTest(toEmail: string, key: string): Promise<TestEmailResponse> {
    if (!this.configured()) return { status: 'failed', error: 'Email is not configured' };
    const r = await this.deliver({ to: toEmail, mail: renderTestEmail({ dashboardUrl: this.dashboardUrl(), now: this.now() }), key });
    this.o.repo.insertNotification({
      incident_id: null,
      kind: 'test',
      to_email: toEmail,
      provider_msg_id: r.id,
      status: r.ok ? 'sent' : 'failed',
      attempts: r.attempts,
      error: r.error,
      ts: this.now(),
    });
    return r.ok ? { status: 'sent' } : { status: 'failed', error: r.error ?? 'unknown error' };
  }

  private async deliver(m: {
    to: string;
    mail: { subject: string; html: string; text: string };
    key: string;
  }): Promise<{ ok: boolean; id: string | null; attempts: number; error: string | null }> {
    const from = this.from();
    if (!this.o.mailer || !from) return { ok: false, id: null, attempts: 0, error: 'Email is not configured' };
    let attempts = 0;
    let error: string | null = null;
    for (;;) {
      attempts += 1;
      const r = await this.o.mailer.send({ from, to: m.to, ...m.mail, idempotencyKey: m.key });
      if (r.ok) {
        this.consecutiveFailures = 0;
        this.lastError = null;
        this.lastSentAt = this.now();
        return { ok: true, id: r.id, attempts, error: null };
      }
      error = r.error;
      this.consecutiveFailures += 1;
      this.lastError = r.error;
      this.o.log.warn({ attempt: attempts, permanent: r.permanent, error: r.error }, 'alert email failed');
      if (r.permanent || attempts > this.delays.length) break;
      await this.sleep(this.delays[attempts - 1] as number);
    }
    return { ok: false, id: null, attempts, error };
  }
}
