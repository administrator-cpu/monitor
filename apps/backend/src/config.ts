import path from 'node:path';
import { z } from 'zod';

const isWin = process.platform === 'win32';

const boolish = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const origin = z
  .string()
  .url()
  .transform((v) => new URL(v).origin);

const loopbackUrl = z
  .string()
  .url()
  .refine((v) => {
    const u = new URL(v);
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  }, 'must be an http:// URL on 127.0.0.1 or localhost');

const hostList = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().regex(/^[a-z0-9.-]+(:\d{1,5})?$/, 'invalid host')).max(50));

/** Drive letters (`D:` or just `D`) or absolute mount points, comma separated. */
const diskList = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => (/^[A-Za-z]$/.test(x) ? `${x.toUpperCase()}:` : /^[A-Za-z]:[\\/]*$/.test(x) ? `${x[0]!.toUpperCase()}:` : x)),
  )
  .pipe(z.array(z.string().regex(/^([A-Z]:|\/[^\s,]*)$/, 'use drive letters such as D: or absolute mount points')).max(20));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  BIND_HOST: z.string().min(1).default('127.0.0.1'),
  PORT_API: z.coerce.number().int().min(1).max(65535).default(4000),
  PORT_INGEST: z.coerce.number().int().min(1).max(65535).default(4001),
  ALLOWED_ORIGINS: z
    .string()
    .min(1)
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(origin).min(1)),
  COOKIE_SECRET: z.string().min(32).optional(),
  COOKIE_SECURE: boolish.optional(),
  SQLITE_PATH: z
    .string()
    .min(1)
    .default(
      isWin ? 'C:\\monitor\\data\\monitor.db' : path.resolve(process.cwd(), 'data', 'monitor.db'),
    ),
  LOG_ROOT: z
    .string()
    .min(1)
    .default(isWin ? 'E:\\monitor-logs' : path.resolve(process.cwd(), 'data', 'monitor-logs')),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** The log folder must not be on the system drive (TRD 4.3). Defaults to on in production. */
  LOG_REQUIRE_SEPARATE_VOLUME: boolish.optional(),
  /** Set to false where no PM2 daemon exists (development, tests). */
  PM2_ENABLED: boolish.default('true'),
  /** Read by the pm2 package itself; listed here so it is validated and shown in the startup summary. */
  PM2_HOME: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(8).optional(),
  /** Overrides the Resend endpoint (tests and staging only). */
  RESEND_API_URL: z.string().url().default('https://api.resend.com/emails'),
  ALERT_FROM: z
    .string()
    .max(200)
    .regex(/^[^\r\n]+$/)
    .optional(),
  /** Fine-grained, read-only GitHub token. A secret: never logged. */
  GITHUB_TOKEN: z.string().min(10).max(255).optional(),
  /** Signing secret of the Resend webhook (starts with whsec_). A secret: never logged. */
  RESEND_WEBHOOK_SECRET: z.string().min(10).max(255).optional(),
  /** Volumes to leave out of the disk list and the disk alerts (for example `D:` for a DVD drive). */
  DISK_EXCLUDE: diskList.optional(),
  /** Nginx `stub_status` location; must be loopback so the monitor can never be pointed elsewhere. */
  NGINX_STATUS_URL: loopbackUrl.optional(),
  NGINX_ACCESS_LOG: z.string().min(1).optional(),
  NGINX_ERROR_LOG: z.string().min(1).optional(),
  /** Comma-separated hosts (optionally host:port) whose certificate expiry is checked. */
  TLS_CHECK_HOSTS: hostList.optional(),
  /** Read-only monitoring user. A secret: never logged. */
  MONGO_URI: z
    .string()
    .min(10)
    .regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://')
    .optional(),
  /** Databases whose `system.profile` is read for slow queries (comma separated). */
  MONGO_PROFILE_DBS: z
    .string()
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid database name')).max(20))
    .optional(),
  /** Shared secret for the application agents (ingest listener stays off without it). */
  INGEST_TOKEN: z.string().min(24, 'must be at least 24 characters').optional(),
  PUBLIC_DASHBOARD_URL: z
    .string()
    .url()
    .transform((v) => {
      const u = new URL(v);
      return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    })
    .optional(),
});

export interface Config {
  nodeEnv: 'development' | 'production' | 'test';
  bindHost: string;
  portApi: number;
  portIngest: number;
  allowedOrigins: string[];
  cookieSecret?: string;
  cookieSecure: boolean;
  /** `__Host-` prefix requires Secure, so the plain name is used for http dev. */
  cookieName: string;
  sqlitePath: string;
  logRoot: string;
  logLevel: string;
  logRequireSeparateVolume: boolean;
  pm2Enabled: boolean;
  pm2Home?: string;
  resendApiKey?: string;
  resendApiUrl: string;
  githubToken?: string;
  resendWebhookSecret?: string;
  /** Default sender; the `alert.from` setting overrides it. */
  alertFrom?: string;
  /** Default link base for emails; the `alert.dashboard_url` setting overrides it. */
  publicDashboardUrl?: string;
  nginxStatusUrl?: string;
  nginxAccessLog?: string;
  nginxErrorLog?: string;
  tlsCheckHosts: string[];
  /** Volumes hidden from the disk list (DISK_EXCLUDE). */
  diskExclude: string[];
  mongoUri?: string;
  mongoProfileDbs: string[];
  ingestToken?: string;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validates the environment at startup. Error messages name variables only,
 * never their values, so secrets cannot leak into logs.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const v = parsed.data;
  const cookieSecure = v.COOKIE_SECURE ?? v.NODE_ENV === 'production';
  if (v.NODE_ENV === 'production' && !cookieSecure) {
    throw new ConfigError(['COOKIE_SECURE: must not be disabled in production']);
  }
  return {
    nodeEnv: v.NODE_ENV,
    bindHost: v.BIND_HOST,
    portApi: v.PORT_API,
    portIngest: v.PORT_INGEST,
    allowedOrigins: v.ALLOWED_ORIGINS,
    cookieSecret: v.COOKIE_SECRET,
    cookieSecure,
    cookieName: cookieSecure ? '__Host-session' : 'cc_session',
    sqlitePath: v.SQLITE_PATH,
    logRoot: v.LOG_ROOT,
    logLevel: v.LOG_LEVEL,
    logRequireSeparateVolume: v.LOG_REQUIRE_SEPARATE_VOLUME ?? v.NODE_ENV === 'production',
    pm2Enabled: v.PM2_ENABLED,
    pm2Home: v.PM2_HOME,
    resendApiKey: v.RESEND_API_KEY,
    resendApiUrl: v.RESEND_API_URL,
    githubToken: v.GITHUB_TOKEN,
    resendWebhookSecret: v.RESEND_WEBHOOK_SECRET,
    alertFrom: v.ALERT_FROM,
    publicDashboardUrl: v.PUBLIC_DASHBOARD_URL,
    nginxStatusUrl: v.NGINX_STATUS_URL,
    nginxAccessLog: v.NGINX_ACCESS_LOG,
    nginxErrorLog: v.NGINX_ERROR_LOG,
    tlsCheckHosts: v.TLS_CHECK_HOSTS ?? [],
    diskExclude: v.DISK_EXCLUDE ?? [],
    mongoUri: v.MONGO_URI,
    mongoProfileDbs: v.MONGO_PROFILE_DBS ?? [],
    ingestToken: v.INGEST_TOKEN,
  };
}

/** Safe-to-log summary: no secrets. */
export function describeConfig(c: Config): Record<string, unknown> {
  return {
    nodeEnv: c.nodeEnv,
    bind: `${c.bindHost}:${c.portApi}`,
    allowedOrigins: c.allowedOrigins,
    cookieSecure: c.cookieSecure,
    sqlitePath: c.sqlitePath,
    logRoot: c.logRoot,
    logRequireSeparateVolume: c.logRequireSeparateVolume,
    pm2Enabled: c.pm2Enabled,
    pm2Home: c.pm2Home ?? '(default)',
    // Whether these are set, never their values.
    emailKeySet: Boolean(c.resendApiKey),
    githubTokenSet: Boolean(c.githubToken),
    resendWebhookSecretSet: Boolean(c.resendWebhookSecret),
    alertFromSet: Boolean(c.alertFrom),
    dashboardUrl: c.publicDashboardUrl ?? null,
    nginx: {
      statusUrl: c.nginxStatusUrl ?? null,
      accessLog: c.nginxAccessLog ?? null,
      errorLog: c.nginxErrorLog ?? null,
      tlsHosts: c.tlsCheckHosts.length,
    },
    diskExclude: c.diskExclude,
    mongo: { configured: Boolean(c.mongoUri), profileDbs: c.mongoProfileDbs },
    ingest: { port: c.portIngest, enabled: Boolean(c.ingestToken) },
  };
}
