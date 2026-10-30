import type { AgentContainer, AgentEvents } from '@cc/shared';

/**
 * Docker through cc-docker-proxy (TRD 14.4): the container list, one-shot stats and the event
 * stream. Inspect is not allowed by the proxy and not needed: the list carries labels, state and
 * health; restarts are counted from events.
 */

export const LABEL_PROJECT = 'com.docker.compose.project';
export const LABEL_SERVICE = 'com.docker.compose.service';

/** The fields of GET /containers/json the agent reads. */
export interface DockerContainer {
  Id: string;
  Names?: string[];
  State: string;
  Status: string;
  Labels?: Record<string, string> | null;
  Created?: number;
}

/** One message of GET /events. */
export interface DockerEvent {
  Type?: string;
  Action?: string;
  Actor?: { ID?: string; Attributes?: Record<string, string> };
  time?: number;
  timeNano?: number;
}

type Fetch = typeof fetch;

export class DockerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private url(p: string): string {
    return this.baseUrl.replace(/\/$/, '') + p;
  }

  private async getJson<T>(p: string, timeoutMs: number): Promise<T> {
    const r = await this.fetchImpl(this.url(p), { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) {
      await r.body?.cancel();
      throw new Error(`docker ${p.split('?')[0]}: HTTP ${r.status}`);
    }
    return (await r.json()) as T;
  }

  /** Every compose container, running or not (a stopped container is still listed). */
  list(): Promise<DockerContainer[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [LABEL_PROJECT] }));
    return this.getJson<DockerContainer[]>(`/containers/json?all=1&filters=${filters}`, 10_000);
  }

  /** CPU (percent of one core) and memory of one running container; null when Docker has no figures. */
  async stats(id: string): Promise<{ cpuPct: number; memBytes: number } | null> {
    // stream=false makes Docker take two readings a second apart, so precpu_stats is filled.
    const s = await this.getJson<DockerStats>(`/containers/${encodeURIComponent(id)}/stats?stream=false`, 8_000);
    return statsFigures(s);
  }

  /**
   * Follows the event stream until it ends or `signal` aborts. Docker writes one JSON object per
   * line; each is handed to `onEvent`.
   */
  async events(signal: AbortSignal, onEvent: (e: DockerEvent) => void): Promise<void> {
    const filters = encodeURIComponent(JSON.stringify({ type: ['container'] }));
    const r = await this.fetchImpl(this.url(`/events?filters=${filters}`), { signal });
    if (!r.ok || !r.body) {
      await r.body?.cancel();
      throw new Error(`docker /events: HTTP ${r.status}`);
    }
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          onEvent(JSON.parse(line) as DockerEvent);
        } catch {
          // a malformed line is skipped; the stream continues
        }
      }
      if (buf.length > 1_000_000) buf = ''; // never hold an unbounded line
    }
  }
}

export interface DockerStats {
  cpu_stats?: { cpu_usage?: { total_usage?: number; percpu_usage?: number[] }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number; stats?: Record<string, number> };
}

/** The `docker stats` formulas: CPU as percent of one core, memory without the reclaimable file cache. */
export function statsFigures(s: DockerStats): { cpuPct: number; memBytes: number } | null {
  const cpu = s.cpu_stats;
  const pre = s.precpu_stats;
  const usage = s.memory_stats?.usage;
  if (!cpu?.cpu_usage || usage === undefined) return null;
  const dc = (cpu.cpu_usage.total_usage ?? 0) - (pre?.cpu_usage?.total_usage ?? 0);
  const ds = (cpu.system_cpu_usage ?? 0) - (pre?.system_cpu_usage ?? 0);
  const cpus = cpu.online_cpus || cpu.cpu_usage.percpu_usage?.length || 1;
  const cpuPct = ds > 0 && dc >= 0 ? (dc / ds) * cpus * 100 : 0;
  const stats = s.memory_stats?.stats ?? {};
  const cache = stats.inactive_file ?? stats.total_inactive_file ?? 0;
  return { cpuPct: Math.round(cpuPct * 10) / 10, memBytes: Math.max(0, usage - cache) };
}

/**
 * Seconds in Docker's "Up …" status text (go-units HumanDuration), for containers whose start the
 * agent did not see. Approximate by design: "Up 3 hours" is anything from 3 to 4 hours.
 */
export function upForSeconds(status: string): number | null {
  const m = /^Up (.+?)(?: \(.*\))?$/.exec(status.trim());
  if (!m) return null;
  const s = m[1]!.toLowerCase();
  if (s.startsWith('less than a second')) return 0;
  if (s === 'about a minute') return 60;
  if (s === 'about an hour') return 3600;
  const n = /^(\d+) (second|minute|hour|day|week|month|year)s?$/.exec(s);
  if (!n) return null;
  const unit = { second: 1, minute: 60, hour: 3600, day: 86_400, week: 604_800, month: 2_592_000, year: 31_536_000 }[n[2] as 'second'];
  return Number(n[1]) * unit;
}

export function healthOf(status: string): AgentContainer['health'] {
  if (/\(unhealthy\)/.test(status)) return 'unhealthy';
  if (/\(health: starting\)/.test(status)) return 'starting';
  if (/\(healthy\)/.test(status)) return 'healthy';
  return null;
}

const STATES = ['running', 'exited', 'paused', 'restarting', 'created', 'dead', 'removing'] as const;
type State = (typeof STATES)[number];
/** Worst first wins when replicas differ, as PM2 instances do in the monitor. */
const STATE_RANK: Record<State, number> = { running: 0, paused: 1, created: 2, exited: 3, removing: 4, restarting: 5, dead: 6 };
const HEALTH_RANK = { healthy: 1, starting: 2, unhealthy: 3 } as const;

export const containerKeyOf = (labels: Record<string, string> | null | undefined): string | null => {
  const project = labels?.[LABEL_PROJECT];
  const service = labels?.[LABEL_SERVICE];
  if (!project || !service) return null;
  const key = `${project}/${service}`;
  return /^[a-z0-9][a-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(key) && key.length <= 160 ? key : null;
};

/**
 * Groups containers into compose services (scaled replicas are instances of one service), keeping
 * only the watched projects and the agent's own one. Containers without compose labels are ignored.
 */
export function aggregate(
  list: DockerContainer[],
  o: {
    projects: ReadonlySet<string>;
    ownProject: string | null;
    now: number;
    /** Start times the agent saw in events, by container id. */
    startedAt: ReadonlyMap<string, number>;
    stats: ReadonlyMap<string, { cpuPct: number; memBytes: number }>;
    restarts: ReadonlyMap<string, number>;
  },
): AgentContainer[] {
  const groups = new Map<string, AgentContainer>();
  for (const c of list) {
    const key = containerKeyOf(c.Labels);
    if (!key) continue;
    const project = key.slice(0, key.indexOf('/'));
    const own = project === o.ownProject;
    if (!own && !o.projects.has(project)) continue;
    const state: State = (STATES as readonly string[]).includes(c.State) ? (c.State as State) : 'dead';
    const running = state === 'running';
    let started: number | null = null;
    if (running) {
      started = o.startedAt.get(c.Id) ?? null;
      if (started === null) {
        const up = upForSeconds(c.Status);
        if (up !== null) started = o.now - up * 1000;
      }
    }
    const st = running ? o.stats.get(c.Id) : undefined;
    const health = healthOf(c.Status);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        name: key.slice(key.indexOf('/') + 1),
        instances: 0,
        instancesRunning: 0,
        state,
        health,
        restartsTotal: o.restarts.get(key) ?? 0,
        cpuPct: 0,
        memBytes: 0,
        startedAt: started,
        ...(own ? { own: true } : {}),
      };
      groups.set(key, g);
    } else {
      if (STATE_RANK[state] > STATE_RANK[g.state]) g.state = state;
      if (health && (!g.health || HEALTH_RANK[health] > HEALTH_RANK[g.health])) g.health = health;
      // Uptime is the youngest running instance's, as for PM2 cluster instances.
      if (started !== null && (g.startedAt === null || started > g.startedAt)) g.startedAt = started;
    }
    g.instances += 1;
    if (running) g.instancesRunning += 1;
    g.cpuPct = Math.round((g.cpuPct + (st?.cpuPct ?? 0)) * 10) / 10;
    g.memBytes += st?.memBytes ?? 0;
  }
  for (const g of groups.values()) if (g.startedAt !== null) g.startedAt = Math.round(g.startedAt);
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

type OutEvent = AgentEvents['events'][number];

/**
 * Turns Docker events into the monitor's container events and counts restarts: a start that
 * follows a die of the same container is one restart, whether Docker's restart policy, `docker
 * restart` or a stop and start caused it (the monitor works with differences, as for PM2).
 */
export class EventTracker {
  readonly startedAt = new Map<string, number>();
  readonly restarts = new Map<string, number>();
  private died = new Set<string>();

  constructor(private readonly watched: (project: string) => boolean) {}

  handle(e: DockerEvent, now: number): OutEvent | null {
    if (e.Type !== 'container' || !e.Action || !e.Actor?.ID) return null;
    const id = e.Actor.ID;
    const attrs = e.Actor.Attributes ?? {};
    const key = containerKeyOf(attrs);
    if (!key || !this.watched(key.slice(0, key.indexOf('/')))) return null;
    const ts = e.timeNano ? Math.floor(e.timeNano / 1e6) : e.time ? e.time * 1000 : now;
    const [action, rest] = e.Action.split(':').map((x) => x.trim()) as [string, string | undefined];
    switch (action) {
      case 'die': {
        this.died.add(id);
        this.startedAt.delete(id);
        const code = Number(attrs.exitCode);
        return { ts, service: key, event: 'die', ...(Number.isInteger(code) ? { detail: { exitCode: code } } : {}) };
      }
      case 'start':
        if (this.died.delete(id)) this.restarts.set(key, (this.restarts.get(key) ?? 0) + 1);
        this.startedAt.set(id, ts);
        return { ts, service: key, event: 'start' };
      case 'stop':
        return { ts, service: key, event: 'stop' };
      case 'restart':
        return { ts, service: key, event: 'restart' };
      case 'oom':
        return { ts, service: key, event: 'oom' };
      case 'health_status':
        return rest ? { ts, service: key, event: 'health_status', detail: { status: rest.slice(0, 40) } } : null;
      case 'destroy':
        this.died.delete(id);
        this.startedAt.delete(id);
        return null;
      default:
        return null; // create, exec_*, attach, kill, pause, …: not reported
    }
  }
}
