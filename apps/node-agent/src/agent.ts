import type { AgentContainer, AgentEvents, AgentMetrics } from '@cc/shared';
import { errText, type MonitorClient, type PostResult } from './client';
import type { AgentConfig } from './config';
import { aggregate, type DockerClient, type DockerContainer, EventTracker, LABEL_PROJECT, LABEL_SERVICE, type TrackerSnapshot } from './docker';
import type { Log } from './log';
import { type CursorStore, LogShipper } from './logs';
import { diskUsage, type HostReader } from './proc';

type CollectorName = 'host' | 'disks' | 'docker' | 'events' | 'monitor';
interface CollectorState {
  lastOkAt: number | null;
  error: string | null;
}

/** After a 401 the agent tries once every 10 minutes (TRD 14.3); after a 426 once an hour. */
export const UNAUTHORIZED_WAIT_MS = 600_000;
export const TOO_OLD_WAIT_MS = 3_600_000;
/** Events waiting for the monitor; past this the oldest are dropped (and counted in the log). */
const MAX_QUEUED_EVENTS = 1_000;
const STATS_CONCURRENCY = 4;
/** Container state changes are saved at most this often (and once more when the agent stops). */
export const SAVE_DELAY_MS = 2_000;

/** Where the restart counts and start times survive a restart of the agent (the state volume). */
export interface TrackerStore {
  load(): Promise<unknown>;
  save(s: TrackerSnapshot): Promise<void>;
}

export interface AgentDeps {
  config: AgentConfig;
  client: MonitorClient;
  reader: HostReader;
  docker: DockerClient | null;
  log: Log;
  /** The container's hostname, which Docker sets to the start of its id unless told otherwise. */
  hostname: string;
  /** Absent in tests that do not need it: the state then lives in memory only. */
  store?: TrackerStore;
  /** Container logs (M3); absent, or without Docker, no logs are followed. */
  logs?: { bufferDir: string; bufferMaxBytes: number; cursors?: CursorStore; linesPerS?: number | null };
  now?: () => number;
  random?: () => number;
}

/**
 * The node agent's loops: one metrics report every interval, container events as they happen
 * (sent within half a second), and the monitor's answers turned into waits: 401 → 10 minutes,
 * 426 → an hour, 429 → Retry-After, unreachable → growing up to a minute. Metrics are snapshots,
 * so a report that could not be sent is dropped, not queued.
 */
export class NodeAgent {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly states = new Map<CollectorName, CollectorState>();
  private readonly projects: Set<string>;
  private ownProject: string | null;
  private readonly tracker: EventTracker;
  private queue: AgentEvents['events'] = [];
  private droppedEvents = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private flushing = false;
  private eventsAbort: AbortController | null = null;
  private running = false;
  private blockedUntil = 0;
  private failures = 0;
  private lastRejectLog = new Map<string, number>();
  /** True after a saved state was loaded, until the first container list squares it with Docker. */
  private reconcilePending = false;
  private saveTimer: NodeJS.Timeout | null = null;
  /** Follows and ships container logs; null without Docker or without a buffer folder. */
  readonly logs: LogShipper | null;

  constructor(private readonly d: AgentDeps) {
    this.now = d.now ?? Date.now;
    this.random = d.random ?? Math.random;
    this.logs =
      d.docker && d.logs
        ? new LogShipper({
            docker: d.docker,
            post: (gz) => d.client.postGzip('logs', gz),
            blocked: () => this.blocked(),
            answer: (r) => this.answer('logs', r),
            log: d.log,
            bufferDir: d.logs.bufferDir,
            bufferMaxBytes: d.logs.bufferMaxBytes,
            cursors: d.logs.cursors,
            linesPerS: d.logs.linesPerS,
            now: this.now,
          })
        : null;
    this.projects = new Set(d.config.projects);
    this.ownProject = d.config.ownProject;
    this.tracker = new EventTracker((p) => this.projects.has(p) || p === this.ownProject);
    for (const n of ['host', 'disks', 'docker', 'events', 'monitor'] as const) this.states.set(n, { lastOkAt: null, error: null });
  }

  /**
   * Loads the restart counts and start times saved by the previous run; call before `start`. A
   * missing or unreadable file is a fresh start.
   */
  async loadState(): Promise<void> {
    if (this.logs) {
      try {
        await this.logs.init();
      } catch (e) {
        this.d.log.warn('could not prepare the log buffer', { error: errText(e) });
      }
    }
    if (!this.d.store) return;
    try {
      const raw = await this.d.store.load();
      if (raw !== null && raw !== undefined) {
        if (this.tracker.restore(raw)) this.reconcilePending = true;
        else this.d.log.warn('ignored an unreadable saved container state');
      }
    } catch (e) {
      this.d.log.warn('could not read the saved container state', { error: errText(e) });
    }
  }

  /** Saves the tracker if it changed; at most once per SAVE_DELAY_MS. */
  private scheduleSave(): void {
    if (!this.d.store || !this.tracker.dirty || this.saveTimer || !this.running) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveState();
    }, SAVE_DELAY_MS);
  }

  async saveState(): Promise<void> {
    if (!this.d.store || !this.tracker.dirty) return;
    this.tracker.dirty = false;
    try {
      await this.d.store.save(this.tracker.snapshot());
    } catch (e) {
      this.tracker.dirty = true;
      this.d.log.warn('could not save the container state', { error: errText(e) });
    }
  }

  private ok(name: CollectorName): void {
    this.states.set(name, { lastOkAt: this.now(), error: null });
  }

  private fail(name: CollectorName, e: unknown): void {
    const s = this.states.get(name)!;
    this.states.set(name, { lastOkAt: s.lastOkAt, error: errText(e).slice(0, 300) });
  }

  /** True while an earlier answer from the monitor says to wait. */
  blocked(): boolean {
    return this.now() < this.blockedUntil;
  }

  /** Builds one metrics report; null when the host figures could not be read at all. */
  async buildMetrics(): Promise<AgentMetrics | null> {
    const c = this.d.config;
    let host;
    try {
      host = await this.d.reader.sample();
      this.ok('host');
    } catch (e) {
      this.fail('host', e);
      return null;
    }

    const disks: AgentMetrics['host']['disks'] = [];
    let diskError: unknown = null;
    for (const mount of c.disks) {
      try {
        const u = await diskUsage(c.hostRoot, mount);
        const io = host.io.get(mount);
        disks.push({ ...u, readBps: io?.readBps ?? null, writeBps: io?.writeBps ?? null });
      } catch (e) {
        diskError = e;
      }
    }
    if (diskError) this.fail('disks', diskError);
    else this.ok('disks');

    const containers = await this.containers();
    const { io: _io, ...h } = host;
    return {
      v: 1,
      ts: this.now(),
      actions: c.actions ? 'on' : 'off',
      host: { ...h, disks },
      ...(containers ? { containers } : {}),
      agent: {
        droppedLogLines: this.logs?.dropped ?? 0,
        bufferBytes: this.logs?.bufferBytes ?? 0,
        collectors: [
          ...[...this.states].map(([name, s]) => ({ name, lastOkAt: s.lastOkAt, error: s.error })),
          ...(this.logs ? [{ name: 'logs', ...this.logs.state() }] : []),
        ],
      },
    };
  }

  /** The watched projects' services; undefined when Docker could not be read (the report omits them). */
  private async containers(): Promise<AgentContainer[] | undefined> {
    const docker = this.d.docker;
    if (!docker) return undefined;
    let list: DockerContainer[];
    try {
      list = await docker.list();
    } catch (e) {
      this.fail('docker', e);
      return undefined;
    }
    if (this.reconcilePending) {
      this.reconcilePending = false;
      this.tracker.reconcile(list, this.now());
      this.scheduleSave();
    }
    if (!this.ownProject) {
      const self = list.find((x) => this.d.hostname.length >= 12 && x.Id.startsWith(this.d.hostname));
      const p = self?.Labels?.[LABEL_PROJECT];
      if (p) {
        this.ownProject = p;
        this.d.log.info('found the agent’s own compose project', { project: p });
      }
    }
    const watched = list.filter((x) => {
      const p = x.Labels?.[LABEL_PROJECT];
      return p !== undefined && (this.projects.has(p) || p === this.ownProject);
    });
    this.logs?.sync(
      watched.flatMap((x) => {
        const svc = x.Labels?.[LABEL_SERVICE];
        return svc ? [{ id: x.Id, key: `${x.Labels![LABEL_PROJECT]}/${svc}`, running: x.State === 'running' }] : [];
      }),
    );
    const stats = new Map<string, { cpuPct: number; memBytes: number }>();
    const running = watched.filter((x) => x.State === 'running');
    let statsError: unknown = null;
    for (let i = 0; i < running.length; i += STATS_CONCURRENCY) {
      await Promise.all(
        running.slice(i, i + STATS_CONCURRENCY).map(async (x) => {
          try {
            const s = await docker.stats(x.Id);
            if (s) stats.set(x.Id, s);
          } catch (e) {
            statsError = e;
          }
        }),
      );
    }
    if (statsError) this.fail('docker', statsError);
    else this.ok('docker');
    return aggregate(watched, {
      projects: this.projects,
      ownProject: this.ownProject,
      now: this.now(),
      startedAt: this.tracker.startedAt,
      stats,
      restarts: this.tracker.restarts,
    });
  }

  /** One metrics report, unless the monitor asked to wait. */
  async tick(): Promise<void> {
    if (this.ticking || this.blocked()) return;
    this.ticking = true;
    try {
      const m = await this.buildMetrics();
      if (!m || this.blocked()) return;
      this.answer('metrics', await this.d.client.post('metrics', m));
    } finally {
      this.ticking = false;
    }
  }

  /** Turns the monitor's answer into the next wait. */
  answer(what: string, r: PostResult): void {
    const now = this.now();
    switch (r.kind) {
      case 'ok':
        this.failures = 0;
        this.ok('monitor');
        return;
      case 'unauthorized':
        this.blockedUntil = now + UNAUTHORIZED_WAIT_MS;
        this.fail('monitor', 'token refused (401)');
        this.d.log.warn('the monitor refused the host token (revoked or replaced); trying again in 10 minutes. To re-enroll, put a new CC_ENROLL_TOKEN in the env file and restart the agent.');
        return;
      case 'too_old':
        this.blockedUntil = now + TOO_OLD_WAIT_MS;
        this.fail('monitor', r.message);
        this.d.log.error('the monitor needs a newer agent; pull the new image', { message: r.message });
        return;
      case 'rate_limited':
        this.blockedUntil = now + r.retryAfterS * 1000;
        this.fail('monitor', `rate limited for ${r.retryAfterS} s`);
        return;
      case 'rejected': {
        // A bug on one side; logging it once a minute is enough, waiting would not help.
        this.fail('monitor', `${what} refused: ${r.status} ${r.error}`);
        const key = `${what}:${r.status}:${r.error}`;
        if (now - (this.lastRejectLog.get(key) ?? 0) >= 60_000) {
          this.lastRejectLog.set(key, now);
          this.d.log.error('the monitor refused a report', { endpoint: what, status: r.status, error: r.error });
        }
        return;
      }
      case 'unavailable': {
        this.failures += 1;
        // 10 s, 20 s, 40 s, then every 60 s between attempts (±20 %). Reports are only due on the
        // interval, so the wait ends half an interval early to land on the intended report.
        const base = Math.min(60_000, this.d.config.intervalMs * 2 ** (this.failures - 1));
        this.blockedUntil = now + Math.round(base * (0.8 + 0.4 * this.random())) - this.d.config.intervalMs / 2;
        this.fail('monitor', r.detail);
        if (this.failures === 1 || this.failures % 10 === 0) {
          this.d.log.warn('the monitor is not reachable', { detail: r.detail, failures: this.failures });
        }
        return;
      }
    }
  }

  /** A Docker event; container events are queued and sent within half a second. */
  onDockerEvent(e: Parameters<EventTracker['handle']>[0]): void {
    const out = this.tracker.handle(e, this.now());
    this.scheduleSave();
    if (!out) return;
    this.queue.push(out);
    if (this.queue.length > MAX_QUEUED_EVENTS) {
      const n = this.queue.length - MAX_QUEUED_EVENTS;
      this.queue.splice(0, n);
      this.droppedEvents += n;
    }
    if (!this.flushTimer && this.running) this.flushTimer = setTimeout(() => void this.flushEvents(), 500);
  }

  async flushEvents(): Promise<void> {
    this.flushTimer = null;
    if (this.flushing || this.queue.length === 0) return;
    if (this.blocked()) {
      if (this.running) this.flushTimer = setTimeout(() => void this.flushEvents(), Math.max(1_000, this.blockedUntil - this.now()));
      return;
    }
    this.flushing = true;
    const batch = this.queue.splice(0, MAX_QUEUED_EVENTS);
    try {
      const r = await this.d.client.post('events', { v: 1, events: batch });
      if (r.kind === 'unavailable' || r.kind === 'rate_limited' || r.kind === 'unauthorized') {
        this.queue = [...batch, ...this.queue].slice(-MAX_QUEUED_EVENTS);
      }
      this.answer('events', r);
    } finally {
      this.flushing = false;
    }
    if (this.droppedEvents > 0) {
      this.d.log.warn('container events dropped while the monitor was unreachable', { dropped: this.droppedEvents });
      this.droppedEvents = 0;
    }
    if (this.queue.length > 0 && this.running && !this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flushEvents(), 1_000);
    }
  }

  /** Follows Docker's event stream for as long as the agent runs, reconnecting with a growing wait. */
  private async followEvents(): Promise<void> {
    const docker = this.d.docker;
    if (!docker) return;
    let wait = 1_000;
    while (this.running) {
      this.eventsAbort = new AbortController();
      const started = this.now();
      try {
        this.ok('events');
        await docker.events(this.eventsAbort.signal, (e) => this.onDockerEvent(e));
        if (!this.running) return;
        this.fail('events', 'the event stream ended');
      } catch (e) {
        if (!this.running) return;
        this.fail('events', e);
      }
      if (this.now() - started > 60_000) wait = 1_000;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(30_000, wait * 2);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logs?.start();
    void this.followEvents();
    void this.tick();
    this.tickTimer = setInterval(() => void this.tick(), this.d.config.intervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.eventsAbort?.abort();
    await this.logs?.stop();
    await this.saveState();
    // A last try for events still queued, so a restart of the agent loses none.
    if (this.queue.length > 0 && !this.blocked()) await this.flushEvents().catch(() => undefined);
  }
}
