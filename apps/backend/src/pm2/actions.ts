import type { ServiceAction, ServiceActionResponse } from '@cc/shared';
import type { AlertRepo } from '../alerts/repo';
import type { Audit } from '../audit';
import type { Pm2Link } from './link';
import { envPmId, SELF_NAMES } from './self';
import type { ServiceRow } from './services';
import type { Pm2Proc } from './types';

export class ActionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Actor {
  id: number;
  username: string;
  ip?: string;
  userAgent?: string;
}

export interface ActionDeps {
  link: Pm2Link | null;
  alertRepo: AlertRepo;
  audit: Audit;
  now: () => number;
  stopMuteMinutes: () => number;
  /** PM2 id of this very process (PM2 puts it in the `pm_id` environment variable), null outside PM2. */
  ownPmId?: () => number | null;
  /** How long to wait for PM2 to show the new state, and how often to look. */
  verifyMs?: number;
  pollMs?: number;
  cooldownMs?: number;
}


const isRunning = (p: Pm2Proc): boolean => p.status === 'online';
const isStopped = (p: Pm2Proc): boolean => p.status === 'stopped';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Start, stop and restart for services that are registered here. The caller supplies only a
 * service id and one of three words; the PM2 instance ids are looked up on the server, so no text
 * from the browser ever reaches PM2.
 */
export class ServiceActions {
  private readonly busy = new Set<number>();
  private readonly last = new Map<number, number>();
  /** Mutes this feature created, so starting the service again can lift them. */
  private readonly muteOf = new Map<number, number>();

  constructor(private readonly d: ActionDeps) {}

  /**
   * Why this service cannot be operated, or null when it can. Used by the detail page too. The
   * monitor never acts on itself: a restart would cut the request, and deploys manage it.
   */
  blockedReason(svc: ServiceRow, procs: Pm2Proc[] | null): string | null {
    if (!this.d.link) return 'PM2 monitoring is switched off on the server.';
    if (SELF_NAMES.has(svc.pm2_name.toLowerCase())) return 'The monitor cannot restart itself. It is updated by the deploy pipeline.';
    if (procs) {
      const mine = procs.filter((p) => p.name === svc.pm2_name);
      if (mine.length === 0) return 'PM2 does not list this process.';
      if (mine.some((p) => p.isModule)) return 'This is a PM2 module, not a service.';
      const own = (this.d.ownPmId ?? envPmId)();
      if (own !== null && mine.some((p) => p.pmId === own)) return 'The monitor cannot restart itself. It is updated by the deploy pipeline.';
    }
    return null;
  }

  async run(svc: ServiceRow, action: ServiceAction, actor: Actor): Promise<ServiceActionResponse> {
    const t0 = this.d.now();
    const base = { serviceId: svc.id, pm2Name: svc.pm2_name, action };
    const fail = (e: ActionError, before?: string): never => {
      this.d.audit.write({
        event: 'service_action_failed',
        userId: actor.id,
        username: actor.username,
        ip: actor.ip,
        userAgent: actor.userAgent,
        detail: { ...base, error: e.code, message: e.message, before },
      });
      throw e;
    };

    const link = this.d.link;
    if (!link) return fail(new ActionError(503, 'pm2_disabled', 'PM2 monitoring is switched off on the server.'));
    if (this.busy.has(svc.id)) return fail(new ActionError(409, 'action_in_progress', 'Another action on this service is still running.'));
    const cool = this.d.cooldownMs ?? 10_000;
    if (t0 - (this.last.get(svc.id) ?? -Infinity) < cool) {
      return fail(new ActionError(429, 'cooldown', `Wait a few seconds before the next action on this service.`));
    }

    this.busy.add(svc.id);
    this.last.set(svc.id, t0);
    let before: string | undefined;
    try {
      let procs: Pm2Proc[];
      try {
        procs = await link.list();
      } catch (e) {
        return fail(new ActionError(502, 'pm2_unreachable', `Cannot reach PM2: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200)));
      }
      const blocked = this.blockedReason(svc, procs);
      if (blocked) return fail(new ActionError(409, 'not_operable', blocked));
      const mine = procs.filter((p) => p.name === svc.pm2_name);
      before = mine.map((p) => p.status).join(',');

      if (action === 'start' && mine.every(isRunning)) return fail(new ActionError(409, 'already_running', 'This service is already running.'), before);
      if (action === 'start' && !mine.some(isStopped) && !mine.every((p) => !isRunning(p))) {
        return fail(new ActionError(409, 'not_stopped', 'Start only works on a stopped service. Use Restart instead.'), before);
      }
      if (action === 'stop' && mine.every(isStopped)) return fail(new ActionError(409, 'already_stopped', 'This service is already stopped.'), before);

      const pmAction = action === 'stop' ? 'stop' : 'restart';
      // Instances that need the change; Start leaves a running sibling alone.
      const targets = action === 'start' ? mine.filter((p) => !isRunning(p)) : mine;
      try {
        for (const p of targets) await link.act(pmAction, p.pmId);
      } catch (e) {
        return fail(new ActionError(502, 'pm2_failed', `PM2 refused the command: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200)), before);
      }

      const status = await this.waitFor(link, svc.pm2_name, action);
      let mutedMinutes = 0;
      if (action === 'stop') mutedMinutes = this.muteDown(svc, actor);
      else this.unmute(svc.id);

      this.d.audit.write({
        event: 'service_action',
        userId: actor.id,
        username: actor.username,
        ip: actor.ip,
        userAgent: actor.userAgent,
        detail: { ...base, before, after: status.status, verified: status.ok, mutedMinutes },
      });
      return { ok: true, action, status: status.status, verified: status.ok, mutedMinutes };
    } finally {
      this.busy.delete(svc.id);
      this.last.set(svc.id, this.d.now());
    }
  }

  /** Looks at PM2 until every instance shows the wanted state, or the wait ends. */
  private async waitFor(link: Pm2Link, name: string, action: ServiceAction): Promise<{ ok: boolean; status: string }> {
    const deadline = Date.now() + (this.d.verifyMs ?? 10_000);
    const poll = this.d.pollMs ?? 500;
    let status = 'unknown';
    for (;;) {
      try {
        const mine = (await link.list()).filter((p) => p.name === name);
        status = mine.map((p) => p.status).join(',') || 'unknown';
        const done = action === 'stop' ? mine.length > 0 && mine.every(isStopped) : mine.length > 0 && mine.every(isRunning);
        if (done) return { ok: true, status: [...new Set(mine.map((p) => p.status))].join(',') };
      } catch {
        // PM2 may be busy while it restarts the process; try again until the deadline.
      }
      if (Date.now() >= deadline) return { ok: false, status };
      await sleep(poll);
    }
  }

  private muteDown(svc: ServiceRow, actor: Actor): number {
    const minutes = this.d.stopMuteMinutes();
    if (minutes <= 0) return 0;
    const rule = this.d.alertRepo.listRules().find((r) => r.key === 'pm2.service_down');
    if (!rule) return 0;
    this.unmute(svc.id);
    const now = this.d.now();
    const m = this.d.alertRepo.insertMute({
      starts_at: now,
      ends_at: now + minutes * 60_000,
      service_id: svc.id,
      category: null,
      rule_id: rule.id,
      reason: `Stopped from the dashboard by ${actor.username}`,
      created_by: actor.id,
    });
    this.muteOf.set(svc.id, m.id);
    return minutes;
  }

  private unmute(serviceId: number): void {
    const id = this.muteOf.get(serviceId);
    if (id === undefined) return;
    this.muteOf.delete(serviceId);
    this.d.alertRepo.deleteMute(id);
  }
}
