import type { CollectorStatus, LogStatus } from '@cc/shared';
import type { Logger } from '../logger';
import type { Settings } from '../settings';
import type { StateStore } from '../state';
import { toIncidentDto } from './dto';
import {
  createEvaluators,
  fingerprintOf,
  REQUIRED_COLLECTORS,
  type EvalContext,
  type Evaluator,
  type Observation,
} from './evaluators';
import type { Notifier } from './notifier';
import type { AlertRepo, MuteRow } from './repo';
import { findParent, RULE_META, type IncidentView, type RuleRow } from './rules';

export interface EngineDeps {
  repo: AlertRepo;
  state: StateStore;
  settings: Settings;
  notifier: Notifier;
  collectors: () => CollectorStatus[];
  logs: () => LogStatus;
  persistence: () => { consecutiveFailures: number };
  /** True for services whose agent has reported at least once, even before this process started. */
  agentEnabled?: (serviceId: number) => boolean;
  log: Pick<Logger, 'warn' | 'info'>;
  now: () => number;
  /** Broadcasts to the browsers (WebSocket event messages). */
  emit?: (kind: string, fields: Record<string, unknown>) => void;
  evaluators?: Record<string, Evaluator>;
}

interface Tracker {
  activeSince: number | null;
  inactiveSince: number | null;
  /** When the peak of the open incident was last written (limits database writes). */
  wrote: number;
}

interface Retry {
  rounds: number;
  nextAt: number;
}

interface PendingResolved extends Retry {
  incidentId: number;
}

const MIN_RESOLVE_MS = 60_000;
const PEAK_WRITE_EVERY_MS = 30_000;
const MAX_RESOLVED_ROUNDS = 4;
const backoff = (rounds: number): number => Math.min(15 * 60_000, 30_000 * 2 ** (rounds - 1));

/**
 * Evaluates the rules every few seconds from in-memory state and keeps incidents, suppression and
 * notifications in step. A rule must be active continuously for its duration before it opens an
 * incident, and inactive for max(60 s, 2 x duration) before it resolves, so a flapping value does
 * not produce a stream of emails.
 */
export class AlertEngine {
  private readonly evaluators: Record<string, Evaluator>;
  private readonly trackers = new Map<string, Tracker>();
  private readonly retries = new Map<string, Retry>();
  private readonly mutedNoted = new Set<string>();
  private pendingResolved: PendingResolved[] = [];
  private lastTickAt: number | null = null;
  private firingCount: number;
  private dispatching = false;

  constructor(private readonly d: EngineDeps) {
    this.evaluators = d.evaluators ?? createEvaluators();
    this.firingCount = d.repo.countFiring();
  }

  openCount(): number {
    return this.firingCount;
  }

  status(): { lastTickAt: number | null; openIncidents: number } {
    return { lastTickAt: this.lastTickAt, openIncidents: this.firingCount };
  }

  /** The scheduler job: evaluation is synchronous and fast; sending never delays the next tick. */
  run(): void {
    this.evaluate();
    void this.dispatch().catch((err) => this.d.log.warn({ err: String(err) }, 'alert dispatch failed'));
  }

  /** Evaluation followed by sending, awaited. Used by tests and demo scripts. */
  async tick(): Promise<void> {
    this.evaluate();
    await this.dispatch();
  }

  // --- evaluation ----------------------------------------------------------

  evaluate(): void {
    const now = this.d.now();
    const rules = this.d.repo.listRules();
    const firing = this.d.repo.firing();
    const stale = new Set(this.d.collectors().filter((c) => c.stale).map((c) => c.name));
    const ec: EvalContext = {
      now,
      state: this.d.state,
      collectors: this.d.collectors,
      logs: this.d.logs,
      persistence: this.d.persistence,
      email: () => ({ consecutiveFailures: this.d.notifier.failures }),
      agentEnabled: (id) => this.d.agentEnabled?.(id) ?? false,
    };

    for (const rule of rules) {
      const ev = this.evaluators[rule.key];
      if (!ev) continue; // rule for a later phase: nothing to evaluate
      const open = firing.filter((i) => i.rule_id === rule.id);

      if (rule.enabled === 0) {
        for (const inc of open) this.observe(rule, inc.fingerprint, inactive(inc), inc, now);
        continue;
      }
      if (REQUIRED_COLLECTORS[rule.key]?.some((n) => stale.has(n))) continue; // stale data is no evidence

      let obs: Observation[] | null;
      try {
        obs = ev(rule, ec);
      } catch (err) {
        this.d.log.warn({ rule: rule.key, err: String(err) }, 'rule evaluation failed');
        continue;
      }
      if (obs === null) continue;

      const seen = new Set<string>();
      for (const o of obs) {
        const fp = fingerprintOf(rule.key, o.target);
        seen.add(fp);
        this.observe(rule, fp, o, open.find((i) => i.fingerprint === fp), now);
      }
      for (const inc of open) if (!seen.has(inc.fingerprint)) this.observe(rule, inc.fingerprint, inactive(inc), inc, now);
    }

    this.syncSuppression();
    this.lastTickAt = now;
  }

  private observe(rule: RuleRow, fp: string, o: Observation, open: IncidentView | undefined, now: number): void {
    let t = this.trackers.get(fp);
    if (!t) {
      t = { activeSince: null, inactiveSince: null, wrote: 0 };
      this.trackers.set(fp, t);
    }
    if (o.active) {
      t.inactiveSince = null;
      t.activeSince ??= now;
      if (!open) {
        if (now - t.activeSince >= rule.duration_s * 1000) this.open(rule, fp, o, now);
      } else if (
        o.value !== null &&
        (open.peak_value === null || o.value > open.peak_value) &&
        now - t.wrote >= PEAK_WRITE_EVERY_MS
      ) {
        this.d.repo.updateIncident(open.id, { peak_value: o.value, summary: o.summary });
        t.wrote = now;
      } else if (o.refresh && o.summary !== open.summary && now - t.wrote >= PEAK_WRITE_EVERY_MS) {
        this.d.repo.updateIncident(open.id, { summary: o.summary });
        open.summary = o.summary;
        t.wrote = now;
      }
      return;
    }
    t.activeSince = null;
    if (!open) {
      this.trackers.delete(fp);
      return;
    }
    t.inactiveSince ??= now;
    if (now - t.inactiveSince >= Math.max(MIN_RESOLVE_MS, rule.duration_s * 2000)) this.resolve(open, now, true);
  }

  private open(rule: RuleRow, fp: string, o: Observation, now: number): void {
    const inc = this.d.repo.insertIncident({
      ruleId: rule.id,
      serviceId: o.serviceId,
      fingerprint: fp,
      openedAt: now,
      peak: o.value,
      summary: o.summary,
    });
    this.firingCount += 1;
    this.d.log.info({ rule: rule.key, incident: inc.id }, 'alert opened');
    this.d.emit?.('alert_opened', { incident: toIncidentDto(inc) });
  }

  private resolve(inc: IncidentView, now: number, notify: boolean): void {
    this.d.repo.resolveIncident(inc.id, now);
    this.trackers.delete(inc.fingerprint);
    this.firingCount = Math.max(0, this.firingCount - 1);
    if (notify) this.pendingResolved.push({ incidentId: inc.id, rounds: 0, nextAt: 0 });
    this.d.log.info({ rule: inc.rule_key, incident: inc.id }, 'alert resolved');
    const fresh = this.d.repo.getIncident(inc.id);
    if (fresh) this.d.emit?.('alert_resolved', { incident: toIncidentDto(fresh) });
  }

  /** Archiving a service ends its incidents quietly: the operator has made the call. */
  onServiceArchived(serviceId: number): void {
    const now = this.d.now();
    for (const inc of this.d.repo.firing()) {
      if (inc.service_id === serviceId) this.resolve(inc, now, false);
    }
    this.syncSuppression();
  }

  private syncSuppression(): IncidentView[] {
    const firing = this.d.repo.firing();
    for (const inc of firing) {
      const want = findParent(inc, firing)?.id ?? null;
      if (inc.suppressed_by !== want) {
        this.d.repo.updateIncident(inc.id, { suppressed_by: want });
        inc.suppressed_by = want;
      }
    }
    return firing;
  }

  // --- notification --------------------------------------------------------

  private isMuted(inc: IncidentView, mutes: MuteRow[]): boolean {
    return mutes.some(
      (m) =>
        (m.service_id === null || m.service_id === (inc.service_id ?? 0)) &&
        (m.category === null || m.category === inc.category) &&
        (m.rule_id === null || m.rule_id === inc.rule_id),
    );
  }

  private cooldownMs(rule: RuleRow): number {
    return rule.cooldown_s === 0 ? this.d.settings.get('alert.reminder_minutes') * 60_000 : rule.cooldown_s * 1000;
  }

  async dispatch(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      const firing = this.syncSuppression();
      if (!this.d.notifier.configured()) {
        // Nothing is queued while email is off; the dashboard shows a banner instead.
        this.pendingResolved = [];
        return;
      }
      const rules = new Map(this.d.repo.listRules().map((r) => [r.id, r]));

      for (const snap of firing) {
        const rule = rules.get(snap.rule_id);
        if (!rule || snap.suppressed_by !== null || RULE_META[snap.rule_key]?.emailable === false) continue;
        const now = this.d.now();
        const kind =
          snap.notify_count === 0
            ? 'opened'
            : now - (snap.last_notified_at ?? snap.opened_at) >= this.cooldownMs(rule)
              ? 'reminder'
              : null;
        if (kind === null) continue;

        const key = `${snap.id}:${kind}`;
        const mutes = this.d.repo.activeMutes(now);
        if (this.isMuted(snap, mutes)) {
          if (!this.mutedNoted.has(key)) {
            this.mutedNoted.add(key);
            this.d.notifier.recordMuted(snap, kind);
          }
          continue;
        }
        this.mutedNoted.delete(key);

        const r = this.retries.get(key);
        if (r && r.nextAt > now) continue;

        const inc = this.d.repo.getIncident(snap.id);
        if (!inc || inc.state !== 'firing' || inc.suppressed_by !== null) continue;

        const out = await this.d.notifier.sendIncident(inc, kind);
        if (out.recipients === 0) continue;
        if (out.sent > 0) {
          this.d.repo.updateIncident(inc.id, { notify_count: inc.notify_count + 1, last_notified_at: this.d.now() });
          this.retries.delete(key);
        } else {
          const rounds = (r?.rounds ?? 0) + 1;
          this.retries.set(key, { rounds, nextAt: this.d.now() + backoff(rounds) });
        }
      }

      await this.dispatchResolved();
    } finally {
      this.dispatching = false;
    }
  }

  private async dispatchResolved(): Promise<void> {
    const keep: PendingResolved[] = [];
    for (const p of this.pendingResolved) {
      const now = this.d.now();
      if (p.nextAt > now) {
        keep.push(p);
        continue;
      }
      // Read after any in-flight "opened" send finished, so notify_count is current.
      const inc = this.d.repo.getIncident(p.incidentId);
      if (!inc || inc.notify_count === 0) continue; // never told anyone it was firing: nothing to resolve
      if (this.isMuted(inc, this.d.repo.activeMutes(now))) {
        this.d.notifier.recordMuted(inc, 'resolved');
        continue;
      }
      const out = await this.d.notifier.sendIncident(inc, 'resolved');
      if (out.recipients === 0 || out.sent > 0) continue;
      const rounds = p.rounds + 1;
      if (rounds < MAX_RESOLVED_ROUNDS) keep.push({ incidentId: p.incidentId, rounds, nextAt: this.d.now() + backoff(rounds) });
      else this.d.log.warn({ incident: p.incidentId }, 'gave up sending the resolved email');
    }
    this.pendingResolved = keep;
  }
}

function inactive(inc: IncidentView): Observation {
  return {
    target: '',
    serviceId: inc.service_id,
    active: false,
    value: null,
    summary: inc.summary,
  };
}
