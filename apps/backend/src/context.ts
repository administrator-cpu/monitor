import type { Audit } from './audit';
import { AlertEngine } from './alerts/engine';
import { Notifier } from './alerts/notifier';
import { ResendMailer, type Mailer } from './alerts/mailer';
import { AlertRepo } from './alerts/repo';
import { Audit as AuditImpl } from './audit';
import { AuthService } from './auth/service';
import { SessionStore } from './auth/sessions';
import { Users } from './auth/users';
import type { Config } from './config';
import type { Db } from './db';
import { EmailStats } from './email/stats';
import { GitHubClient } from './github/client';
import { readLocalCommit, type LocalRead } from './github/local';
import { GitMonitor } from './github/monitor';
import { HostsRepo } from './hosts/repo';
import { LiveHub } from './hub';
import { LogSystem, type LogSystemOptions } from './logs';
import { LogSearcher, type SearcherOptions } from './logs/searcher';
import type { PipelineSink } from './logs/sink';
import type { Logger } from './logger';
import { MonitorHealthReporter } from './monitor-health';
import { Persistence } from './persist';
import { ProcessEvents } from './pm2/events';
import { ServiceActions } from './pm2/actions';
import { Pm2Link } from './pm2/link';
import { ServicesRepo } from './pm2/services';
import type { Pm2Source } from './pm2/types';
import { WorkerPm2Source } from './pm2/worker-source';
import { Scheduler } from './scheduler';
import { Settings } from './settings';
import { StateStore } from './state';

export interface AppContext {
  config: Config;
  db: Db;
  log: Logger;
  now: () => number;
  settings: Settings;
  audit: Audit;
  users: Users;
  sessions: SessionStore;
  auth: AuthService;
  state: StateStore;
  scheduler: Scheduler;
  hub: LiveHub;
  health: MonitorHealthReporter;
  logs: LogSystem;
  searcher: LogSearcher;
  services: ServicesRepo;
  /** Host 1 (this server) and the agent hosts (phase 11). */
  hosts: HostsRepo;
  procEvents: ProcessEvents;
  /** Null when PM2 monitoring is switched off (PM2_ENABLED=false). */
  pm2: Pm2Link | null;
  persistence: Persistence;
  alertRepo: AlertRepo;
  mailer: Mailer | null;
  notifier: Notifier;
  alerts: AlertEngine;
  git: GitMonitor;
  email: EmailStats;
  actions: ServiceActions;
}

/** Test and demo hooks; production passes none of these. */
export interface ContextOverrides {
  pm2Source?: () => Pm2Source;
  mailer?: Mailer | null;
  /** The sink that feeds the monitor's own log lines into the pipeline. */
  sink?: PipelineSink;
  logOptions?: Partial<LogSystemOptions>;
  searchOptions?: SearcherOptions;
  actions?: { verifyMs?: number; pollMs?: number; cooldownMs?: number; ownPmId?: () => number | null };
  github?: { client?: GitHubClient | null; readLocal?: LocalRead };
}

/** Wires every long-lived object together. `now` is injectable so tests control time. */
export function createContext(opts: {
  config: Config;
  db: Db;
  log: Logger;
  now?: () => number;
  overrides?: ContextOverrides;
}): AppContext {
  const ov = opts.overrides ?? {};
  const now = opts.now ?? Date.now;
  const settings = new Settings(opts.db, now);
  const audit = new AuditImpl(opts.db, now);
  const users = new Users(opts.db, now);
  const sessions = new SessionStore(opts.db, settings, now);
  const auth = new AuthService(users, sessions, settings, audit, now);
  const state = new StateStore();
  const scheduler = new Scheduler(opts.log, now);

  const services = new ServicesRepo(opts.db, now, () => settings.get('pm2.stale_hours'));
  const hosts = new HostsRepo(opts.db, now);
  const procEvents = new ProcessEvents();
  const persistence = new Persistence(opts.db, state, procEvents, services, now);
  const alertRepo = new AlertRepo(opts.db, now);

  // The hub, the log system and the alert engine reach each other only through closures.
  const logs = new LogSystem({
    root: opts.config.logRoot,
    requireSeparateVolume: opts.config.logRequireSeparateVolume,
    now,
    ringLines: () => settings.get('logs.ring_buffer_lines'),
    thresholdPct: () => settings.get('logs.volume_threshold_pct'),
    retentionHours: () => settings.get('logs.retention_hours'),
    warn: (o, m) => opts.log.warn(o, m),
    fallbackUsedPct: (root) => state.diskUsedPctFor(root),
    onWarning: (code, detail) => ctx.hub?.broadcastWarning(code, detail),
    ...ov.logOptions,
  });
  ov.sink?.attach(logs.pipeline);

  const pm2 = opts.config.pm2Enabled
    ? new Pm2Link({
        createSource: ov.pm2Source ?? (() => new WorkerPm2Source()),
        onLogs: (items) => {
          for (const l of items) logs.pipeline.ingest(l.name, l.pmId, l.stream === 'err' ? 'err' : 'out', l.data, l.at);
        },
        onEvents: (items) => {
          for (const e of items) procEvents.add(e);
        },
        now,
        log: { warn: (o, m) => opts.log.warn(o, m), info: (o, m) => opts.log.info(o, m) },
      })
    : null;

  const mailer: Mailer | null =
    ov.mailer !== undefined
      ? ov.mailer
      : opts.config.resendApiKey
        ? new ResendMailer({ apiKey: opts.config.resendApiKey, url: opts.config.resendApiUrl })
        : null;
  const notifier = new Notifier({ mailer, repo: alertRepo, settings, config: opts.config, log: opts.log, now });
  const email = new EmailStats(opts.db, now);
  const alerts = new AlertEngine({
    repo: alertRepo,
    state,
    settings,
    notifier,
    collectors: () => scheduler.status(),
    logs: () => logs.status(),
    persistence: () => persistence.status(),
    agentEnabled: (id) => services.get(id)?.agent_enabled === 1,
    emailBadSince: (since) => email.badSince(since),
    agentHosts: () => hosts.enrolledAgents().map((h) => ({ id: h.id, name: h.name, lastSeenAt: hosts.lastSeenAt(h.id) })),
    log: opts.log,
    now,
    emit: (kind, fields) => ctx.hub?.broadcastEvent(kind, fields),
  });

  const git = new GitMonitor({
    db: opts.db,
    services,
    client:
      ov.github?.client !== undefined ? ov.github.client : opts.config.githubToken ? new GitHubClient({ token: opts.config.githubToken }) : null,
    readLocal: ov.github?.readLocal ?? readLocalCommit,
    pollMinutes: () => settings.get('github.poll_minutes'),
    now,
  });

  const actions = new ServiceActions({
    link: pm2,
    alertRepo,
    audit,
    now,
    stopMuteMinutes: () => settings.get('actions.stop_mute_minutes'),
    ...ov.actions,
  });

  // The hub and the reporter reference each other only through closures.
  const ctx = {
    config: opts.config,
    db: opts.db,
    log: opts.log,
    now,
    settings,
    audit,
    users,
    sessions,
    auth,
    state,
    scheduler,
    logs,
    searcher: new LogSearcher({ ...ov.searchOptions }),
    services,
    hosts,
    procEvents,
    pm2,
    persistence,
    alertRepo,
    mailer,
    notifier,
    alerts,
    git,
    email,
    actions,
  } as AppContext;
  ctx.hub = new LiveHub(ctx);
  ctx.health = new MonitorHealthReporter(opts.config.sqlitePath, () => ctx.hub.size);
  return ctx;
}
