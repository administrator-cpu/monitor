import dotenv from 'dotenv';
import { ConfigError, describeConfig, loadConfig, type Config } from './config';
import type { AppContext } from './context';
import { eventLogCollector } from './collectors/eventlog';
import { diskIoCollector } from './collectors/diskio';
import { cpuMemCollector, diskCollector, systemCollector } from './collectors/host';
import { createContext, type ContextOverrides } from './context';
import { migrate, openDb } from './db';
import { createLogger } from './logger';
import { PipelineSink } from './logs/sink';
import { mongoCollector } from './mongo/collector';
import { DriverMongoSource, type MongoSource } from './mongo/source';
import { startIngest, type IngestServer } from './agent/ingest';
import { LogBackfill } from './pm2/backfill';
import { nginxLogCollector, nginxStatusCollector, tlsCollector, tlsHostsFor } from './nginx/collector';
import { pm2Collector } from './pm2/collector';
import { runRetention } from './retention';
import { runRollup } from './rollup';
import { buildApp } from './server';

/** Test and demo hooks. Production passes none of these. */
export interface StartOptions {
  mongoSource?: MongoSource | null;
  overrides?: ContextOverrides;
}

export interface Running {
  ctx: AppContext;
  /** Port the agent ingest listener is bound to, null when INGEST_TOKEN is not set. */
  ingestPort: number | null;
  /** Orderly shutdown: stop collectors, flush logs and metrics, close the database. */
  stop(): Promise<void>;
}

export async function start(config: Config, opts: StartOptions = {}): Promise<Running> {
  // The monitor's own log lines also go to the pipeline (pseudo-service `_monitor`).
  const sink = new PipelineSink();
  const log = createLogger(config.logLevel, sink);
  log.info({ config: describeConfig(config) }, 'starting command-center backend');

  const db = openDb(config.sqlitePath);
  const { applied } = migrate(db); // a failed migration throws and stops startup
  if (applied.length > 0) log.info({ applied }, 'migrations applied');

  const ctx = createContext({ config, db, log, overrides: { sink, ...opts.overrides } });
  const app = await buildApp(ctx);

  ctx.scheduler.register(cpuMemCollector(ctx.state));
  ctx.scheduler.register(diskCollector(ctx.state, undefined, undefined, config.diskExclude));
  ctx.scheduler.register(systemCollector(ctx.state));
  if (process.platform === 'win32') {
    ctx.scheduler.register(diskIoCollector(ctx.state));
    ctx.scheduler.register(eventLogCollector({ db, state: ctx.state }));
  }
  if (ctx.pm2) {
    ctx.scheduler.register(
      pm2Collector({
        link: ctx.pm2,
        services: ctx.services,
        state: ctx.state,
        events: ctx.procEvents,
        backfill: new LogBackfill(ctx.logs.pipeline),
        autoArchive: {
          minutes: () => ctx.settings.get('pm2.auto_archive_minutes'),
          archive: (svc) => {
            // Not live by definition (the collector only offers services PM2 did not list).
            ctx.services.update(svc.id, { isArchived: true }, new Set());
            ctx.alerts.onServiceArchived(svc.id);
            ctx.audit.write({
              event: 'service_updated',
              username: 'system',
              detail: { serviceId: svc.id, pm2Name: svc.pm2_name, changed: ['isArchived'], auto: true, reason: 'not listed by PM2' },
            });
            log.info({ service: svc.pm2_name }, 'service archived: PM2 no longer lists it');
          },
        },
      }),
    );
  } else {
    log.warn('PM2 monitoring is switched off (PM2_ENABLED=false)');
  }

  // Nginx (phase 6): each source is optional and only registered when it is configured.
  let nginxLog: ReturnType<typeof nginxLogCollector> | null = null;
  if (config.nginxStatusUrl) ctx.scheduler.register(nginxStatusCollector({ url: config.nginxStatusUrl, state: ctx.state }));
  if (config.nginxAccessLog) {
    nginxLog = nginxLogCollector({
      accessLog: config.nginxAccessLog,
      errorLog: config.nginxErrorLog,
      state: ctx.state,
      services: ctx.services,
      pipeline: ctx.logs.pipeline,
      warn: (o, m) => log.warn(o, m),
    });
    ctx.scheduler.register(nginxLog);
  }
  const mongoSource = opts.mongoSource !== undefined ? opts.mongoSource : config.mongoUri ? new DriverMongoSource(config.mongoUri) : null;
  let mongo: ReturnType<typeof mongoCollector> | null = null;
  if (mongoSource) {
    mongo = mongoCollector({ source: mongoSource, db, state: ctx.state, profileDbs: config.mongoProfileDbs });
    ctx.scheduler.register(mongo);
  }
  ctx.scheduler.register(
    tlsCollector({ db, state: ctx.state, hosts: () => tlsHostsFor(config.tlsCheckHosts, ctx.services) }),
  );

  // Application agent (phase 8): merged samples every 5 s, and the loopback ingest listener.
  ctx.scheduler.register({
    name: 'agentsample',
    intervalMs: 5_000,
    async run() {
      ctx.state.app.sample(ctx.now(), (id) => ctx.state.getProcessState(id));
    },
  });
  let ingest: IngestServer | null = null;
  if (config.ingestToken) {
    ingest = await startIngest(ctx, config.ingestToken);
  } else {
    log.info('agent ingest is off (set INGEST_TOKEN to accept reports from the in-app agent)');
  }

  // Background jobs run on the same scheduler, so each has its own timeout, error isolation and
  // staleness status.
  ctx.scheduler.register({ name: 'persist', intervalMs: 10_000, async run() { ctx.persistence.flush(); } });
  ctx.scheduler.register({ name: 'logguard', intervalMs: 60_000, run: () => ctx.logs.volume.check() });
  ctx.scheduler.register({
    name: 'logmaint',
    intervalMs: 600_000,
    timeoutMs: 30_000,
    async run() {
      await ctx.logs.writer.sweepCompress();
    },
  });
  ctx.scheduler.register({
    name: 'rollup',
    intervalMs: 3_600_000,
    timeoutMs: 120_000,
    async run() {
      runRollup(db, ctx.settings, Date.now());
    },
  });
  ctx.scheduler.register({
    name: 'retention',
    intervalMs: 3_600_000,
    timeoutMs: 30_000,
    async run() {
      runRetention(db, ctx.settings, Date.now());
    },
  });
  ctx.scheduler.register(ctx.git.collector());
  ctx.scheduler.register({ name: 'alerts', intervalMs: 5_000, async run() { ctx.alerts.run(); } });

  // Decide whether the log volume is usable before any log line is written.
  await ctx.logs.volume.check();
  ctx.logs.writer.start();
  ctx.scheduler.start();
  ctx.hub.start();
  ctx.health.start();

  // Hourly housekeeping: drop sessions that expired more than 7 days ago.
  const cleanup = setInterval(() => {
    try {
      const removed = ctx.sessions.cleanup();
      db.prepare(
        `INSERT INTO maintenance_runs (job, last_run_at, last_status, last_detail)
         VALUES ('session_cleanup', ?, 'ok', ?)
         ON CONFLICT(job) DO UPDATE SET last_run_at = excluded.last_run_at,
           last_status = excluded.last_status, last_detail = excluded.last_detail`,
      ).run(Date.now(), JSON.stringify({ removed }));
    } catch (err) {
      log.error({ err }, 'session cleanup failed');
    }
  }, 3_600_000);
  cleanup.unref();

  await app.listen({ host: config.bindHost, port: config.portApi });

  let closing = false;
  const stop = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    clearInterval(cleanup);
    ctx.scheduler.stop();
    ctx.hub.stop();
    ctx.health.stop();
    await ingest?.close();
    await app.close();
    await ctx.logs.writer.stop();
    try {
      ctx.persistence.flush(); // the last completed buckets
    } catch (err) {
      log.warn({ err }, 'final metric write failed');
    }
    await ctx.pm2?.close();
    await nginxLog?.close();
    await mongo?.close();
    db.close();
  };
  const addr = ingest?.server.address();
  return { ctx, stop, ingestPort: addr && typeof addr === 'object' ? addr.port : null };
}

async function main(): Promise<void> {
  // CC_ENV_FILE lets the Windows service point at a .env that lives outside the repository.
  dotenv.config({ path: process.env.CC_ENV_FILE, quiet: true });

  let config: Config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  const running = await start(config);
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    running.ctx.log.info({ signal }, 'shutting down');
    try {
      await running.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
