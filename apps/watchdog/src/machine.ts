import type { CheckFailure, CheckResult } from './check';

export type Phase = 'UP' | 'DOWN' | 'RECOVERING';
export type EmailKind = 'down' | 'reminder' | 'recovered';

export interface EmailFacts {
  kind: EmailKind;
  /** Per-outage sequence number; with `kind` it identifies the logical email (idempotency). */
  incident: number;
  downSince: number;
  /** When the outage was first detected, as ms since epoch. */
  now: number;
  failure: CheckFailure | null;
  recoveredAt: number | null;
}

export interface MachineOptions {
  now: () => number;
  /** Returns true when the email was accepted by the provider. Must not throw. */
  send: (e: EmailFacts) => Promise<boolean>;
  reminderAfterMs: number;
  flapWindowMs: number;
  recoverySuccesses: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface PublicState {
  phase: Phase;
  incident: number;
  downSince: number | null;
  recoveredAt: number | null;
  consecutiveSuccesses: number;
  lastCheckAt: number | null;
  lastCheck: { ok: true } | { ok: false; kind: string; detail: string } | null;
  emails: { down: boolean; reminder: boolean; recovered: boolean };
  owed: EmailKind[];
}

/**
 * UP -> DOWN -> RECOVERING -> UP, in memory. At most three emails per outage: one "down", one
 * "reminder" (if still down after the reminder time) and one "back online". An email that fails to
 * send stays owed and is retried on the next check; it is never sent twice once accepted.
 */
export class Machine {
  private phase: Phase = 'UP';
  private incident = 0;
  private downSince: number | null = null;
  private recoveredAt: number | null = null;
  private successes = 0;
  private failure: CheckFailure | null = null;
  private lastCheckAt: number | null = null;
  private lastCheck: PublicState['lastCheck'] = null;
  private sent = { down: false, reminder: false, recovered: false };
  private owed = new Set<EmailKind>();

  constructor(private readonly o: MachineOptions) {}

  state(): PublicState {
    return {
      phase: this.phase,
      incident: this.incident,
      downSince: this.downSince,
      recoveredAt: this.recoveredAt,
      consecutiveSuccesses: this.successes,
      lastCheckAt: this.lastCheckAt,
      lastCheck: this.lastCheck,
      emails: { ...this.sent },
      owed: [...this.owed],
    };
  }

  /** Applies one finished check, then tries to deliver any email that is owed. */
  async onCheck(r: CheckResult): Promise<void> {
    const t = this.o.now();
    this.lastCheckAt = t;
    this.lastCheck = r.ok ? { ok: true } : { ok: false, kind: r.kind, detail: r.detail };
    if (r.ok) this.onSuccess(t);
    else this.onFailure(t, r);
    await this.deliver(t);
  }

  private onFailure(t: number, f: CheckFailure): void {
    this.failure = f;
    this.successes = 0;
    switch (this.phase) {
      case 'UP':
        this.phase = 'DOWN';
        this.incident += 1;
        this.downSince = t;
        this.recoveredAt = null;
        this.sent = { down: false, reminder: false, recovered: false };
        this.owed = new Set(['down']);
        this.o.log?.('outage detected', { incident: this.incident, kind: f.kind });
        return;
      case 'RECOVERING':
        // Same outage: no new "down" email and the reminder clock keeps running from downSince.
        this.phase = 'DOWN';
        this.recoveredAt = null;
        this.o.log?.('failure after recovery; same outage', { incident: this.incident });
        break;
      case 'DOWN':
        break;
    }
    if (!this.sent.reminder && this.downSince !== null && t - this.downSince >= this.o.reminderAfterMs) {
      this.owed.add('reminder');
    }
  }

  private onSuccess(t: number): void {
    switch (this.phase) {
      case 'UP':
        return;
      case 'DOWN':
        this.successes += 1;
        if (this.successes >= this.o.recoverySuccesses) {
          this.phase = 'RECOVERING';
          this.recoveredAt = t;
          this.owed.delete('reminder'); // pointless once the service is back
          // Saying "back online" about an outage nobody was told about would only confuse.
          if (this.sent.down && !this.sent.recovered) this.owed.add('recovered');
          else this.owed.delete('down');
          this.o.log?.('recovered', { incident: this.incident });
        }
        return;
      case 'RECOVERING':
        if (this.recoveredAt !== null && t - this.recoveredAt >= this.o.flapWindowMs) {
          this.phase = 'UP';
          this.downSince = null;
          this.recoveredAt = null;
          this.successes = 0;
          this.failure = null;
          this.o.log?.('outage closed', { incident: this.incident });
        }
        return;
    }
  }

  private async deliver(t: number): Promise<void> {
    for (const kind of ['down', 'reminder', 'recovered'] as const) {
      if (!this.owed.has(kind) || this.sent[kind]) continue;
      const ok = await this.o.send({
        kind,
        incident: this.incident,
        downSince: this.downSince ?? t,
        now: t,
        failure: this.failure,
        recoveredAt: this.recoveredAt,
      });
      if (ok) {
        this.sent[kind] = true;
        this.owed.delete(kind);
      } else {
        this.o.log?.('email not delivered; will retry on the next check', { kind });
      }
    }
  }
}
