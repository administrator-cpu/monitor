import type { ProcessState, ProcessStatus } from '@cc/shared';
import type { CollectorDef } from '../scheduler';
import type { StateStore } from '../state';
import type { ProcessEvents } from './events';
import type { Pm2Link } from './link';
import type { ServicesRepo } from './services';
import type { Pm2Proc } from './types';

const PRIORITY: Record<ProcessStatus, number> = {
  online: 1,
  launching: 2,
  stopping: 3,
  stopped: 4,
  errored: 5,
};

/** PM2 statuses mapped to the five the monitor shows. Anything unknown is flagged as errored. */
export function normalizeStatus(s: string): ProcessStatus {
  switch (s) {
    case 'online':
    case 'one-launch-status':
      return 'online';
    case 'launching':
    case 'stopping':
    case 'stopped':
    case 'errored':
      return s;
    default:
      return 'errored';
  }
}

export interface Aggregate {
  name: string;
  status: ProcessStatus;
  instances: number;
  instancesOnline: number;
  cpuPct: number;
  memBytes: number;
  restarts: number;
  uptimeS: number;
}

/** Groups PM2 instances by name (cluster mode): sums load, takes the worst status. */
export function aggregate(procs: Pm2Proc[], now: number): Aggregate[] {
  const groups = new Map<string, Aggregate & { minUptimeMs: number | null }>();
  for (const p of procs) {
    if (p.isModule) continue;
    const status = normalizeStatus(p.status);
    let g = groups.get(p.name);
    if (!g) {
      g = {
        name: p.name,
        status: 'online',
        instances: 0,
        instancesOnline: 0,
        cpuPct: 0,
        memBytes: 0,
        restarts: 0,
        uptimeS: 0,
        minUptimeMs: null,
      };
      groups.set(p.name, g);
    }
    g.instances += 1;
    if (status === 'online') {
      g.instancesOnline += 1;
      if (p.pmUptime !== null) {
        const up = Math.max(0, now - p.pmUptime);
        g.minUptimeMs = g.minUptimeMs === null ? up : Math.min(g.minUptimeMs, up);
      }
    }
    if (PRIORITY[status] > PRIORITY[g.status]) g.status = status;
    g.cpuPct += Math.max(0, p.cpu);
    g.memBytes += Math.max(0, p.memory);
    g.restarts += Math.max(0, p.restarts);
  }
  return [...groups.values()].map(({ minUptimeMs, ...g }) => ({
    ...g,
    cpuPct: Math.round(g.cpuPct * 10) / 10,
    uptimeS: minUptimeMs === null ? 0 : Math.floor(minUptimeMs / 1000),
  }));
}

export interface ProcessCollectorDeps {
  link: Pm2Link;
  services: ServicesRepo;
  state: StateStore;
  events: ProcessEvents;
  backfill?: { run(procs: Pm2Proc[]): Promise<void> };
  now?: () => number;
}

/**
 * PM2 process list every 5 s. Every name PM2 reports becomes a service automatically. Services
 * the monitor knows but PM2 no longer lists are reported as stopped with 0 instances (not hidden),
 * unless an admin archived them.
 */
export function pm2Collector(d: ProcessCollectorDeps): CollectorDef {
  const now = d.now ?? Date.now;
  return {
    name: 'pm2',
    intervalMs: 5_000,
    timeoutMs: 20_000,
    async run() {
      const procs = await d.link.list();
      await d.backfill?.run(procs).catch(() => undefined);
      const at = now();
      const live = aggregate(procs, at);
      const states: ProcessState[] = [];
      const seen = new Set<string>();

      for (const g of live) {
        const svc = d.services.discover(g.name);
        seen.add(g.name);
        states.push({
          serviceId: svc.id,
          name: svc.name,
          pm2Name: svc.pm2_name,
          updatedAt: at,
          status: g.status,
          instances: g.instances,
          instancesOnline: g.instancesOnline,
          cpuPct: g.cpuPct,
          memBytes: g.memBytes,
          restarts: g.restarts,
          uptimeS: g.uptimeS,
          ...exitFor(d.events, g.name),
        });
      }
      for (const svc of d.services.list(false)) {
        if (seen.has(svc.pm2_name)) continue;
        states.push({
          serviceId: svc.id,
          name: svc.name,
          pm2Name: svc.pm2_name,
          updatedAt: at,
          status: 'stopped',
          instances: 0,
          instancesOnline: 0,
          cpuPct: 0,
          memBytes: 0,
          restarts: 0,
          uptimeS: 0,
          ...exitFor(d.events, svc.pm2_name),
        });
      }
      d.state.setProcesses(states, at);
    },
  };
}

function exitFor(events: ProcessEvents, name: string): Pick<ProcessState, 'lastExit'> | Record<string, never> {
  const e = events.lastExit(name);
  return e ? { lastExit: e } : {};
}

/** Names of the services PM2 currently lists (used to refuse archiving a running service). */
export function liveNames(states: ProcessState[]): Set<string> {
  return new Set(states.filter((s) => s.instances > 0).map((s) => s.pm2Name));
}
