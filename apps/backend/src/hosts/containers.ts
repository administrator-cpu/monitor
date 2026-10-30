import {
  AGENT_MAX_SKEW_MS,
  type AgentContainer,
  type AgentEvents,
  type ProcessState,
  type ProcessStatus,
} from '@cc/shared';
import type { ProcessEvents, LastExit } from '../pm2/events';
import type { ServiceRow, ServicesRepo } from '../pm2/services';
import type { StateStore } from '../state';

/**
 * Docker states mapped to the five statuses the dashboard and the service rules use, so
 * `pm2.service_down` and the Services page treat a container like a PM2 process (TRD 14.8).
 */
export function containerStatus(state: AgentContainer['state']): ProcessStatus {
  switch (state) {
    case 'running':
      return 'online';
    case 'restarting':
      return 'launching';
    case 'removing':
      return 'stopping';
    case 'dead':
      return 'errored';
    case 'exited':
    case 'paused':
    case 'created':
      return 'stopped';
  }
}

export interface ContainerTrackerDeps {
  services: ServicesRepo;
  state: StateStore;
  events: ProcessEvents;
  now: () => number;
  /**
   * Retires a container service its agent no longer lists (removed with `docker compose down` or
   * `rm`), after `minutes()`; 0 turns it off. A stopped container is still listed, so stopping one
   * never archives it. Only applied when the list holds at least one container outside the agent's
   * own project, so an agent that sees nothing (Docker restarting, projects all removed) cannot
   * clear the dashboard. A key that is listed again is restored by discovery.
   */
  autoArchive?: { minutes: () => number; archive: (svc: ServiceRow) => void };
}

/**
 * Turns an agent host's container list (every metrics report) into services and live process
 * state, and its container events into `process_events` rows. The counterpart of the PM2
 * collector for agent hosts (TRD 14.5, "Service identity").
 */
export class ContainerTracker {
  private readonly lastExits = new Map<number, LastExit>();

  constructor(private readonly d: ContainerTrackerDeps) {}

  /**
   * One container list from host `hostId`, received at `at` (monitor clock). `agentTs` is the
   * report's own time, used only for uptime, which is measured on the agent's clock.
   */
  report(hostId: number, list: AgentContainer[], at: number, agentTs: number): void {
    const states: ProcessState[] = [];
    const seen = new Set<string>();
    for (const c of list) {
      if (seen.has(c.key)) continue; // one row per service; the agent already sums replicas
      seen.add(c.key);
      const svc = this.d.services.discover(c.key, { hostId, kind: 'container' });
      const status = containerStatus(c.state);
      const exit = this.lastExits.get(svc.id);
      states.push({
        serviceId: svc.id,
        name: svc.name,
        pm2Name: svc.source_key,
        updatedAt: at,
        status,
        instances: c.instances,
        instancesOnline: c.instancesRunning,
        cpuPct: Math.round(c.cpuPct * 10) / 10,
        memBytes: c.memBytes,
        restarts: c.restartsTotal,
        uptimeS:
          status === 'online' && c.startedAt !== null
            ? Math.max(0, Math.floor((agentTs - c.startedAt) / 1000))
            : 0,
        health: c.health,
        ...(exit ? { lastExit: exit } : {}),
      });
    }

    const othersListed = list.some((c) => c.own !== true);
    const archiveAfterMs =
      this.d.autoArchive && othersListed ? Math.max(0, this.d.autoArchive.minutes()) * 60_000 : 0;
    for (const svc of this.d.services.list(false, hostId)) {
      if (seen.has(svc.source_key) || svc.kind !== 'container') continue;
      if (archiveAfterMs > 0 && at - svc.last_seen_at > archiveAfterMs) {
        this.d.autoArchive!.archive(svc);
        this.lastExits.delete(svc.id);
        continue;
      }
      const exit = this.lastExits.get(svc.id);
      states.push({
        serviceId: svc.id,
        name: svc.name,
        pm2Name: svc.source_key,
        updatedAt: at,
        status: 'stopped',
        instances: 0,
        instancesOnline: 0,
        cpuPct: 0,
        memBytes: 0,
        restarts: 0,
        uptimeS: 0,
        ...(exit ? { lastExit: exit } : {}),
      });
    }
    this.d.state.setProcesses(states, at, hostId);
  }

  /**
   * Container events, queued for the next database write. Events for a container the monitor has
   * not seen in a list yet are dropped, as PM2 events of unknown processes are; the next list
   * (at most 10 s later) creates the service. Returns how many were kept.
   */
  events(hostId: number, events: AgentEvents['events']): number {
    const now = this.d.now();
    let kept = 0;
    for (const e of events) {
      const svc = this.d.services.getBySource(hostId, e.service);
      if (!svc) continue;
      // A skewed agent clock would put the event far from its neighbours; use the arrival time.
      const ts = Math.abs(e.ts - now) > AGENT_MAX_SKEW_MS ? now : e.ts;
      const detail = e.detail && Object.keys(e.detail).length ? (e.detail as Record<string, unknown>) : null;
      this.d.events.addForService({ ts, name: e.service, pmId: null, event: e.event, detail, serviceId: svc.id });
      if (e.event === 'die' || e.event === 'oom') {
        const code = typeof e.detail?.exitCode === 'number' ? e.detail.exitCode : null;
        this.lastExits.set(svc.id, { at: ts, code, signal: e.event === 'oom' ? 'OOM' : null });
      }
      kept += 1;
    }
    return kept;
  }

  /** A revoked host leaves the live view; its exits are forgotten with it. */
  dropHost(hostId: number): void {
    for (const svc of this.d.services.list(true, hostId)) this.lastExits.delete(svc.id);
  }
}
