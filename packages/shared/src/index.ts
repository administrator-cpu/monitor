import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;

/** WebSocket close codes (backend-schema.md section 7.2). */
export const WS_CLOSE = {
  UNAUTHENTICATED: 4401,
  ORIGIN_NOT_ALLOWED: 4403,
  TOO_MANY_CONNECTIONS: 4429,
} as const;

export const API_PREFIX = '/api/v1';

/** State-changing requests must carry this header (TRD section 5, CSRF). */
export const CSRF_HEADER = 'x-monitor-client';
export const CSRF_VALUE = 'web';

// ---------------------------------------------------------------------------
// Request schemas (shared by backend validation and frontend forms)
// ---------------------------------------------------------------------------

export const roleSchema = z.enum(['admin', 'engineer']);
export type Role = z.infer<typeof roleSchema>;

const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

export const loginSchema = z
  .object({
    username: z.string().trim().min(1).max(64),
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  })
  .strict();
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    newPassword: passwordSchema,
  })
  .strict();
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, dot, underscore and hyphen only');

export const createUserSchema = z
  .object({
    username: usernameSchema,
    displayName: z.string().trim().min(1).max(100),
    email: z.string().trim().toLowerCase().email().max(200),
    phone: z.string().trim().max(50).nullish(),
    notes: z.string().trim().max(1000).nullish(),
    role: roleSchema,
    password: passwordSchema,
    mustChangePassword: z.boolean().default(true),
  })
  .strict();
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100).optional(),
    email: z.string().trim().toLowerCase().email().max(200).optional(),
    phone: z.string().trim().max(50).nullish(),
    notes: z.string().trim().max(1000).nullish(),
    role: roleSchema.optional(),
    isActive: z.boolean().optional(),
    /** Engineers only: may start, stop and restart services. Admins always may. */
    canOperate: z.boolean().optional(),
  })
  .strict();
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const resetPasswordSchema = z.object({ password: passwordSchema }).strict();
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.number().int().optional(),
  event: z.string().max(64).optional(),
  username: z.string().max(64).optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** A setting value: number, text, list of text, or null to restore the default. */
export const settingValueSchema = z.union([
  z.number().finite(),
  z.string().max(500),
  z.array(z.string().max(255)).max(100),
  z.null(),
]);
export const settingsPatchSchema = z.record(z.string(), settingValueSchema);
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
export type SettingValue = z.infer<typeof settingValueSchema>;

// --- services (phase 3) ----------------------------------------------------

export const servicePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    publicUrl: z.string().trim().url().max(300).nullable().optional(),
    nginxMatch: z.string().trim().max(200).nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    isArchived: z.boolean().optional(),
    /** GitHub repository as `owner/name`. */
    gitRepo: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, 'Use owner/name, for example acme/shop-api')
      .nullable()
      .optional(),
    gitBranch: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,99}$/, 'Not a valid branch name')
      .optional(),
    /** Absolute folder of the checkout (or deploy folder with a `.deploy-sha` file) on the server. */
    gitPath: z
      .string()
      .trim()
      .max(300)
      .regex(/^([A-Za-z]:[\\/]|\/)[^\0\r\n]*$/, 'Use an absolute path, for example C:\\Apps\\shop-api')
      .nullable()
      .optional(),
  })
  .strict();
export type ServicePatchInput = z.infer<typeof servicePatchSchema>;

export const SERVICE_ACTIONS = ['restart', 'stop', 'start'] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];
export const serviceActionSchema = z.object({ action: z.enum(SERVICE_ACTIONS) }).strict();
export interface ServiceActionResponse {
  ok: true;
  action: ServiceAction;
  /** PM2 status after the action, as far as it could be confirmed. */
  status: string;
  /** False when PM2 accepted the command but the new state was not seen within the wait time. */
  verified: boolean;
  /** Length of the automatic alert mute set by Stop; 0 when none. */
  mutedMinutes: number;
}

// --- alerts (phase 4) ------------------------------------------------------

export const alertCategorySchema = z.enum(['host', 'pm2', 'nginx', 'mongo', 'app', 'monitor']);
export type AlertCategory = z.infer<typeof alertCategorySchema>;
export const severitySchema = z.enum(['info', 'warning', 'critical']);
export type Severity = z.infer<typeof severitySchema>;

export const ruleUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    threshold: z.number().finite().positive().optional(),
    durationS: z.number().int().min(0).max(604_800).optional(),
    /** 0 means "use the global reminder interval" (setting alert.reminder_minutes). */
    cooldownS: z.number().int().min(0).max(2_592_000).optional(),
    /** Per-service threshold overrides, keyed by PM2 name. */
    overrides: z.record(z.string().min(1).max(200), z.number().finite().positive()).optional(),
  })
  .strict();
export type RuleUpdateInput = z.infer<typeof ruleUpdateSchema>;

export const muteCreateSchema = z
  .object({
    /** Defaults to now. */
    startsAt: z.number().int().optional(),
    endsAt: z.number().int(),
    serviceId: z.number().int().min(0).nullable().optional(),
    category: alertCategorySchema.nullable().optional(),
    ruleId: z.number().int().positive().nullable().optional(),
    reason: z.string().trim().max(300).nullable().optional(),
  })
  .strict();
export type MuteCreateInput = z.infer<typeof muteCreateSchema>;

export const subscriptionsPutSchema = z
  .object({ categories: z.array(alertCategorySchema).max(6) })
  .strict();
export type SubscriptionsPutInput = z.infer<typeof subscriptionsPutSchema>;

export const incidentsQuerySchema = z.object({
  state: z.enum(['firing', 'resolved', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().optional(),
  serviceId: z.coerce.number().int().optional(),
  /** Incidents that were open at any time in [from, to] (epoch ms). */
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
});
export type IncidentsQuery = z.infer<typeof incidentsQuerySchema>;

// WebSocket client -> server (backend-schema.md section 7.1)
export const wsClientMessageSchema = z.union([
  z.object({ type: z.literal('subscribe'), channel: z.literal('live') }),
  z.object({
    type: z.literal('subscribe'),
    channel: z.literal('logs'),
    service: z.string().min(1).max(200),
    stream: z.enum(['all', 'out', 'err']).default('all'),
    backfill: z.number().int().min(0).max(1000).default(200),
  }),
  z.object({
    type: z.literal('unsubscribe'),
    channel: z.enum(['live', 'logs']),
    service: z.string().optional(),
  }),
  z.object({ type: z.literal('ping') }),
]);
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;

// ---------------------------------------------------------------------------
// DTOs and state shapes (backend-schema.md section 5)
// ---------------------------------------------------------------------------

export interface UserDto {
  id: number;
  username: string;
  displayName: string;
  email: string;
  phone: string | null;
  notes: string | null;
  role: Role;
  isActive: boolean;
  /** True for admins, and for engineers an admin has allowed. */
  canOperate: boolean;
  mustChangePassword: boolean;
  lastLoginAt: number | null;
  lastLoginIp: string | null;
  createdAt: number;
}

export interface MeResponse {
  user: UserDto;
  mustChangePassword: boolean;
  sessionExpiresAt: number;
}

export interface AuditEntry {
  id: number;
  ts: number;
  userId: number | null;
  username: string | null;
  event: string;
  ip: string | null;
  userAgent: string | null;
  detail: unknown;
}

export interface DiskState {
  volume: string;
  usedBytes: number;
  totalBytes: number;
  /** Disk I/O arrives with the disk collector in phase 3; null until then. */
  readBps: number | null;
  writeBps: number | null;
}

export interface HostState {
  updatedAt: number;
  cpuPct: number;
  cpuPerCore: number[];
  memUsedBytes: number;
  memTotalBytes: number;
  swapUsedBytes: number;
  swapTotalBytes: number;
  netRxBps: number;
  netTxBps: number;
  uptimeS: number;
  pendingReboot: boolean;
  disks: DiskState[];
}

export interface CollectorStatus {
  name: string;
  intervalMs: number;
  lastOkAt: number | null;
  lastError?: string;
  stale: boolean;
}

export interface LogStatus {
  volumeOk: boolean;
  /** Why logs are not being written: log root missing, on the system volume, or unusable. */
  volumeReason: 'missing' | 'same_volume' | 'error' | null;
  volumeUsedPct: number;
  /** Lines dropped by writer backpressure since start (also counted per service). */
  droppedLines: number;
  /** Lines kept for the live view but not written to disk while the volume is unavailable. */
  skippedLines: number;
  writerQueue: number;
}

export interface HostSeries {
  /** Seconds since epoch (uPlot-friendly). */
  ts: number[];
  cpuPct: number[];
  memPct: number[];
  netRxBps: number[];
  netTxBps: number[];
}

/** The monitor's own health (TRD section 8). */
/** How the backend process was started (H9: a Windows service in production). */
export interface MonitorRunsAs {
  kind: 'service' | 'pm2' | 'direct';
  /** Windows service name or PM2 process name, when known. */
  name: string | null;
}

export interface MonitorHealth {
  pid: number;
  runsAs: MonitorRunsAs;
  /** Commit from the deploy folder's `.deploy-sha`; null for a manual start or before the first deploy. */
  deployedSha: string | null;
  uptimeS: number;
  cpuPct: number;
  rssBytes: number;
  heapUsedBytes: number;
  eventLoopLagP95Ms: number;
  eventLoopLagMaxMs: number;
  wsClients: number;
  sqliteBytes: number | null;
}

export interface HostResponse {
  /** The host these figures belong to; 1 (this server) unless `?host=` asked for another. */
  hostId: number;
  host: HostState | null;
  series: HostSeries;
  /** The monitor's own collectors; empty for an agent host (its collectors are in `agent`). */
  collectors: CollectorStatus[];
  monitor: MonitorHealth;
  /** Agent hosts only. */
  agent: HostAgentInfo | null;
}

export interface OverviewResponse {
  host: HostState | null;
  nginx: NginxState | null;
  mongo: MongoState | null;
  services: ServiceLive[];
  collectors: CollectorStatus[];
  logs: LogStatus | null;
  openIncidents: number;
}

export interface LiveMessage {
  type: 'live';
  ts: number;
  host: HostState | null;
  services: ServiceLive[];
  nginx: NginxState | null;
  mongo: MongoState | null;
  /** Totals across agent-enabled services; null while no agent has reported. */
  app: AppTotals | null;
  collectors: CollectorStatus[];
  logs: LogStatus | null;
  openIncidents: number;
  /** The monitor's own process (Overview "Monitor" card). Absent from older backends. */
  monitor?: MonitorHealth;
  /** Every host that is not revoked, for the host switcher. Absent from older backends. */
  hosts?: HostSummary[];
}

export type LogStream = 'out' | 'err' | 'app' | 'access' | 'error';

export interface LogLine {
  ts: number;
  pm: number;
  s: LogStream;
  msg: string;
  /** Characters removed from `msg` for the live view (the stored line is complete). */
  cut?: number;
}

export type WsServerMessage =
  | LiveMessage
  | { type: 'log_batch'; service: string; lines: LogLine[]; dropped: number }
  | { type: 'pong' }
  | { type: 'warning'; code: string; detail?: unknown }
  | { type: 'error'; code: string; message: string }
  | { type: 'event'; kind: string; ts: number; [k: string]: unknown };

export interface SettingEntry {
  key: string;
  type: 'number' | 'string' | 'list';
  value: number | string | string[] | null;
  default: number | string | string[] | null;
  updatedAt: number | null;
  /** Numeric bounds, when the setting is a number. */
  min?: number;
  max?: number;
  integer?: boolean;
}

/**
 * Sections of the Settings page, in order, by key prefix. Keys under HIDDEN_SETTING_PREFIXES are
 * defined on the server but read by nothing yet, so the page leaves them out. Any other key that
 * matches no prefix is shown under "Other" rather than dropped (backend test `settings-groups`).
 */
export const SETTING_GROUPS: readonly (readonly [prefix: string, title: string])[] = [
  ['alert.', 'Alert email'],
  ['logs.', 'Logs'],
  ['retention.', 'Retention'],
  ['backup.', 'Backups'],
  ['pm2.', 'Services'],
  ['actions.', 'Dashboard actions'],
  ['github.', 'GitHub'],
  ['hosts.', 'Remote hosts'],
  ['session.', 'Sessions'],
  ['login.', 'Sign-in protection'],
];

export const HIDDEN_SETTING_PREFIXES: readonly string[] = ['agent.', 'mongo.'];

export const OTHER_SETTINGS_TITLE = 'Other';

/** Splits settings into the page's sections; empty sections are left out, list settings too. */
export function groupSettings<T extends Pick<SettingEntry, 'key' | 'type'>>(
  settings: readonly T[],
): { prefix: string; title: string; rows: T[] }[] {
  const shown = settings.filter(
    (s) => s.type !== 'list' && !HIDDEN_SETTING_PREFIXES.some((p) => s.key.startsWith(p)),
  );
  const out = SETTING_GROUPS.map(([prefix, title]) => ({
    prefix,
    title,
    rows: shown.filter((s) => s.key.startsWith(prefix)),
  }));
  const rest = shown.filter((s) => !SETTING_GROUPS.some(([p]) => s.key.startsWith(p)));
  out.push({ prefix: '', title: OTHER_SETTINGS_TITLE, rows: rest });
  return out.filter((g) => g.rows.length > 0);
}

/** GET /overview/summary: the slower-changing parts of the Overview, polled every 30 s. */
export interface OverviewSummary {
  generatedAt: number;
  alerts: {
    critical: number;
    warning: number;
    info: number;
    /** Newest firing incidents first, at most 5. */
    newest: IncidentDto[];
  };
  backup: {
    /** False when BACKUP_DIR is off. */
    enabled: boolean;
    lastRunAt: number | null;
    status: 'ok' | 'error' | null;
    file: string | null;
    bytes: number | null;
    error: string | null;
  };
  tls: {
    hosts: number;
    /** Hosts whose last check failed. */
    errors: number;
    /** The certificate that expires first (checked hosts only). */
    soonest: { host: string; notAfter: number; daysLeft: number } | null;
  };
  github: {
    tokenSet: boolean;
    /** Services with a repository set. */
    mapped: number;
    inSync: number;
    behind: { serviceId: number; name: string; behindBy: number }[];
    /** Mapped services whose last check failed, or not checked yet. */
    problems: number;
  };
  email: {
    /** Start of the window (last 24 hours). */
    since: number;
    webhookConfigured: boolean;
    sent: number;
    delivered: number;
    delayed: number;
    bounced: number;
    complained: number;
    failed: number;
    lastEventAt: number | null;
  };
}

export interface ApiErrorBody {
  error: string;
  message?: string;
  issues?: unknown;
}

// ---------------------------------------------------------------------------
// Services and processes (phase 3)
// ---------------------------------------------------------------------------

export type ProcessStatus = 'online' | 'stopped' | 'errored' | 'launching' | 'stopping';

export interface ProcessState {
  serviceId: number;
  /** Display name (editable by admins). */
  name: string;
  /** The PM2 process name; also the key of the log channel and the log folder. */
  pm2Name: string;
  updatedAt: number;
  /** Worst status across instances. 0 instances = no longer listed by PM2. */
  status: ProcessStatus;
  instances: number;
  instancesOnline: number;
  /** Percent of one core, summed across instances (can exceed 100). */
  cpuPct: number;
  memBytes: number;
  /** Sum of PM2 restart counters across instances. */
  restarts: number;
  uptimeS: number;
  /**
   * The start time behind `uptimeS` is only known to the unit Docker's "Up 6 days" text gives
   * (a container the agent has not seen start); shown as "~6d". Absent for exact uptimes.
   */
  uptimeApprox?: boolean;
  lastExit?: { at: number; code: number | null; signal: string | null };
  /** Containers with a health check (agent hosts); absent for PM2 processes. */
  health?: 'healthy' | 'unhealthy' | 'starting' | null;
  /**
   * An agent host's container that has had no report for over `AGENT_HOST_FRESH_MS` (agent
   * stopped, host down, Docker unreadable): the figures are the last ones known, not current.
   * Set by the API when it answers; never stored.
   */
  stale?: boolean;
}

export type ServiceKind = 'pm2' | 'container' | 'pseudo';

export interface ServiceDto {
  id: number;
  /** 1 is this Windows server; other hosts report through their agent (phase 11). */
  hostId: number;
  kind: ServiceKind;
  /** The PM2 name on host 1, `<project>/<service>` for a container on another host. */
  sourceKey: string;
  name: string;
  /** Same as `sourceKey`; kept for the pages that predate phase 11. */
  pm2Name: string;
  nginxMatch: string | null;
  publicUrl: string | null;
  agentEnabled: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  isArchived: boolean;
  notes: string | null;
  gitRepo: string | null;
  gitBranch: string;
  gitPath: string | null;
  /** Not seen in PM2 within `pm2.stale_hours`. */
  stale: boolean;
}

export interface ServiceLive {
  process: ProcessState;
  /** Runtime figures from the in-app agent, without the tenant list; null when none is reporting. */
  app: Omit<AppServiceState, 'tenants'> | null;
}

export type GitState =
  | 'ok'
  | 'no_token'
  | 'token_rejected'
  | 'repo_not_found'
  | 'rate_limited'
  | 'no_server_commit'
  | 'sha_unknown'
  | 'error';
export type GitSync = 'in_sync' | 'behind' | 'ahead' | 'diverged' | 'unknown';

export interface GitRunDto {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  sha: string;
  url: string;
  at: number;
  event: string;
}
export interface GitPrDto {
  number: number;
  title: string;
  author: string;
  draft: boolean;
  url: string;
  updatedAt: number;
}
export interface GitStatusDto {
  serviceId: number;
  state: GitState;
  /** Plain-language reason when `state` is not `ok`. */
  message: string | null;
  checkedAt: number;
  repo: string;
  branch: string;
  /** Commit found in the folder on this server. */
  serverSha: string | null;
  serverBranch: string | null;
  /** Uncommitted changes in the folder. */
  dirty: boolean;
  branchSha: string | null;
  /** Commits on the branch that the server does not have. */
  behindBy: number;
  /** Commits on the server that the branch does not have. */
  aheadBy: number;
  sync: GitSync;
  runs: GitRunDto[];
  prs: GitPrDto[];
  lastDeployAt: number | null;
}
export interface GitBadge {
  state: GitState;
  sync: GitSync;
  behindBy: number;
  dirty: boolean;
}
export interface GitResponse {
  /** True when an admin has set a repository for the service. */
  configured: boolean;
  /** Whether the server has a GitHub token at all. */
  tokenSet: boolean;
  git: GitStatusDto | null;
}

export interface ServiceListItem extends ServiceDto {
  process: ProcessState | null;
  git: GitBadge | null;
}

export interface ServicesResponse {
  services: ServiceListItem[];
}

export interface ServiceSeries {
  /** Seconds since epoch (uPlot-friendly). */
  ts: number[];
  cpuPct: number[];
  memBytes: number[];
}

export interface ProcessEventDto {
  id: number;
  ts: number;
  pm: number | null;
  event: string;
  detail: unknown;
}

export interface ServiceTraffic {
  now: NginxServiceState | null;
  /** Seconds since epoch, one point per 10 s window. */
  series: { ts: number[]; reqPerS: number[]; err5xxPct: number[]; p95Ms: number[] };
}

export interface ServiceDetailResponse {
  service: ServiceDto;
  /** Runtime figures from the in-app agent; null when the service has no agent or it is silent. */
  app: AppServiceState | null;
  appSeries: AppSeries;
  /** Gateway traffic for this service; null until Nginx has been seen. */
  traffic: ServiceTraffic | null;
  process: ProcessState | null;
  series: ServiceSeries;
  events: ProcessEventDto[];
  openIncidents: number;
  git: GitBadge | null;
  /** Whether Start, Stop and Restart are possible for this service at all (not who may press them). */
  operable: { ok: boolean; reason: string | null };
}

// ---------------------------------------------------------------------------
// Alerts (phase 4)
// ---------------------------------------------------------------------------

export interface AlertRuleDto {
  id: number;
  key: string;
  category: AlertCategory;
  name: string;
  description: string | null;
  severity: Severity;
  enabled: boolean;
  threshold: number | null;
  durationS: number;
  cooldownS: number;
  overrides: Record<string, number>;
  /** False for rules whose data source arrives in a later phase. */
  implemented: boolean;
  /** Whether the rule applies per service (per-service overrides are possible). */
  perService: boolean;
  /** Unit label for the threshold, e.g. "%", "bytes", "s". */
  unit: string | null;
  updatedAt: number;
}

export interface IncidentDto {
  id: number;
  ruleId: number;
  ruleKey: string;
  ruleName: string;
  category: AlertCategory;
  severity: Severity;
  serviceId: number | null;
  serviceName: string | null;
  /** 1 is this server; other ids are agent hosts (phase 11). */
  hostId: number;
  fingerprint: string;
  state: 'firing' | 'resolved';
  openedAt: number;
  resolvedAt: number | null;
  lastNotifiedAt: number | null;
  notifyCount: number;
  peakValue: number | null;
  summary: string;
  suppressedBy: number | null;
}

export interface NotificationDto {
  id: number;
  incidentId: number | null;
  kind: 'opened' | 'reminder' | 'resolved' | 'test';
  /** Only returned to admins. */
  toEmail: string | null;
  status: 'sent' | 'failed' | 'muted';
  attempts: number;
  error: string | null;
  ts: number;
}

export interface IncidentDetailResponse {
  incident: IncidentDto;
  /** Delivery log; empty for non-admins. */
  notifications: NotificationDto[];
}

export interface MuteDto {
  id: number;
  startsAt: number;
  endsAt: number;
  serviceId: number | null;
  serviceName: string | null;
  category: AlertCategory | null;
  ruleId: number | null;
  ruleName: string | null;
  reason: string | null;
  createdBy: number | null;
  createdAt: number;
  active: boolean;
}

export interface AlertStatusResponse {
  email: {
    configured: boolean;
    /** Names of the missing settings or environment variables. */
    missing: string[];
    warnings: string[];
    failing: boolean;
    lastError: string | null;
    lastSentAt: number | null;
    consecutiveFailures: number;
    from: string | null;
    dashboardUrl: string | null;
  };
  engine: { lastTickAt: number | null; openIncidents: number };
}

export interface TestEmailResponse {
  status: 'sent' | 'failed';
  error?: string;
}

// ---------------------------------------------------------------------------
// Nginx (phase 6)
// ---------------------------------------------------------------------------

export interface NginxServiceState {
  /** 0 is the reserved `_unattributed` service. */
  serviceId: number;
  reqPerS: number;
  /** Request counts in the last completed 10 s window. */
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  p50Ms: number;
  p95Ms: number;
}

export interface NginxState {
  updatedAt: number;
  /** `stub_status` answered on the last attempt (null when no status URL is configured). */
  statusOk: boolean | null;
  statusError?: string;
  activeConn: number;
  reading: number;
  writing: number;
  waiting: number;
  reqPerS: number;
  perService: NginxServiceState[];
  /** Access-log lines that could not be parsed (skipped, never fatal). */
  malformedLines: number;
  linesTotal: number;
  /** When the access log last yielded a line, null if never. */
  lastLineAt: number | null;
}

export interface TlsCertDto {
  host: string;
  notAfter: number | null;
  issuer: string | null;
  checkedAt: number;
  lastError: string | null;
  daysLeft: number | null;
}

export interface NginxSeries {
  /** Seconds since epoch. */
  ts: number[];
  reqPerS: number[];
  activeConn: number[];
  /** 5xx share of requests, percent, per 10 s window. */
  err5xxPct: number[];
}

export interface NginxResponse {
  nginx: NginxState | null;
  configured: { status: boolean; accessLog: boolean; tls: boolean };
  series: NginxSeries;
  certs: TlsCertDto[];
  collectors: CollectorStatus[];
}

// ---------------------------------------------------------------------------
// MongoDB (phase 7)
// ---------------------------------------------------------------------------

export interface MongoCurrentOp {
  opid: number;
  /** `db.collection`. Never the command or its filter values. */
  ns: string;
  op: string;
  secsRunning: number;
  plan?: string;
}

export interface MongoState {
  updatedAt: number;
  up: boolean;
  /** Why the monitor could not read the server (credentials removed). */
  error?: string;
  version?: string;
  pingMs: number | null;
  connCurrent: number;
  connAvailable: number;
  opsPerS: { insert: number; query: number; update: number; delete: number; getmore: number; command: number };
  memResidentMb: number;
  dataSizeBytes: number | null;
  repl?: { state: string; lagS: number | null };
  currentOps: MongoCurrentOp[];
  /** Slow queries recorded in the last 5 minutes (null when no profiler database is configured). */
  slowQueries5m: number | null;
  /** Parts of the picture the monitoring user was not allowed to read, in plain words. */
  warnings: string[];
}

export interface MongoSeries {
  /** Seconds since epoch, one point per 10 s sample. */
  ts: number[];
  connCurrent: number[];
  opsPerS: number[];
  pingMs: number[];
  memResidentMb: number[];
}

export interface MongoSlowQueryDto {
  id: number;
  ts: number;
  namespace: string;
  op: string | null;
  millis: number;
  planSummary: string | null;
  docsExamined: number | null;
  keysExamined: number | null;
  nReturned: number | null;
  appName: string | null;
  /** Field names only; values are replaced by `?`. */
  commandShape: string | null;
}

export interface MongoResponse {
  mongo: MongoState | null;
  configured: boolean;
  profileDbs: string[];
  series: MongoSeries;
  slowQueries: MongoSlowQueryDto[];
  collectors: CollectorStatus[];
}

// ---------------------------------------------------------------------------
// Application agent (phase 8)
// ---------------------------------------------------------------------------

/** Largest body the ingest listener accepts. */
export const AGENT_MAX_BODY_BYTES = 256 * 1024;
/** Instance data older than this is dropped from the merged view. */
export const AGENT_FRESH_MS = 15_000;
export const AGENT_MAX_TENANTS = 50;

const nonNeg = z.number().finite().nonnegative();

/** `POST /ingest/v1/agent` (backend-schema.md section 6). Unknown fields are ignored, not stored. */
export const agentReportSchema = z.object({
  v: z.literal(1),
  service: z.string().min(1).max(100),
  pm: z.number().int().min(-1).max(100_000),
  pid: z.number().int().nonnegative().optional(),
  ts: z.number().finite().optional(),
  window_s: z.number().finite().min(1).max(300),
  uptime_s: nonNeg.optional(),
  runtime: z.object({
    event_loop_lag_ms: z.object({ mean: nonNeg, p95: nonNeg, max: nonNeg }),
    heap_used_bytes: nonNeg,
    heap_total_bytes: nonNeg.optional(),
    rss_bytes: nonNeg,
    active_handles: nonNeg.optional(),
  }),
  http: z.object({
    req_count: nonNeg,
    err5xx_count: nonNeg,
    p50_ms: nonNeg,
    p95_ms: nonNeg,
  }),
  sockets: z.object({ open: nonNeg }),
  tenants: z
    .array(
      z.object({
        key: z.string().min(1).max(100),
        sockets: nonNeg,
        active_users_5m: nonNeg,
        req_count: nonNeg,
        p95_ms: nonNeg,
      }),
    )
    .max(AGENT_MAX_TENANTS + 1),
  tenants_truncated: z.boolean().optional(),
});
export type AgentReport = z.infer<typeof agentReportSchema>;

export interface AppTenantState {
  key: string;
  sockets: number;
  activeUsers: number;
  reqPerS: number;
  p95Ms: number;
}

export interface AppServiceState {
  updatedAt: number;
  /** Instances that reported within the last 15 s. */
  instances: number;
  sockets: number;
  /** Sum over instances: a user connected to two instances is counted twice. */
  activeUsers: number;
  reqPerS: number;
  err5xxPerS: number;
  p50Ms: number;
  p95Ms: number;
  eventLoopLagMeanMs: number;
  eventLoopLagP95Ms: number;
  eventLoopLagMaxMs: number;
  heapUsedBytes: number;
  rssBytes: number;
  activeHandles: number | null;
  tenants: AppTenantState[];
  tenantsTruncated: boolean;
}

export interface AppTotals {
  services: number;
  sockets: number;
  activeUsers: number;
}

/** 5 s points, 30 minutes, seconds since epoch. CPU and memory come from PM2 at the same instant. */
export interface AppSeries {
  ts: number[];
  sockets: number[];
  activeUsers: number[];
  reqPerS: number[];
  p95Ms: number[];
  eventLoopLagP95Ms: number[];
  cpuPct: number[];
  memBytes: number[];
}

export interface TenantsResponse {
  serviceId: number;
  updatedAt: number | null;
  tenants: (AppTenantState & { displayName: string | null })[];
  truncated: boolean;
}

export interface TenantHistoryResponse {
  serviceId: number;
  key: string;
  /** 60 s points (further averaged when the range is long). */
  ts: number[];
  sockets: number[];
  activeUsers: number[];
  reqPerS: number[];
  p95Ms: number[];
}

// ---------------------------------------------------------------------------
// History, log search and Windows events (phase 9)
// ---------------------------------------------------------------------------

export interface HistoryRange {
  from: number;
  to: number;
  /** Width of one point in seconds. */
  stepS: number;
  /** Where stored resolution changes from 60 s (older) to 10 s (newer), when both occur in the range. */
  boundary: number | null;
}

/** Every series has one value per entry of `ts`; null where nothing was recorded. */
export interface HistoryResponse {
  range: HistoryRange;
  /** Seconds since epoch. */
  ts: number[];
  series: Record<string, (number | null)[]>;
  /** Restarts, crashes and similar moments inside the range (service history only). */
  events?: ProcessEventDto[];
}

/**
 * The longest ranges the server accepts, taken from the retention settings at the time of the request,
 * so a range never reaches past data that has already been deleted.
 */
export interface RangeLimitsResponse {
  /** `retention.metrics_days` in milliseconds: the longest range the history routes accept. */
  historyMaxMs: number;
  /** `logs.retention_hours` in milliseconds: the longest range log search accepts. */
  logSearchMaxMs: number;
}

/** A span in words: "1 hour", "1.5 hours", "24 hours", "7 days". Whole days are shown as days from 2 days up. */
export function spanLabel(ms: number): string {
  const DAY = 86_400_000;
  if (ms >= 2 * DAY && ms % DAY === 0) return `${ms / DAY} days`;
  const h = Math.round((ms / 3_600_000) * 100) / 100;
  return `${h} hour${h === 1 ? '' : 's'}`;
}

export interface RangeOption {
  id: string;
  label: string;
  ms: number;
}

/**
 * The presets a range picker may offer under a server limit: those no longer than `maxMs`, plus
 * `maxMs` itself as a last option when it falls between presets (a 48 hour log retention gets
 * "48 hours" after "24 hours"). With the limit not loaded yet, the presets are offered unchanged;
 * the server still refuses anything too long.
 */
export function capRanges(presets: readonly RangeOption[], maxMs: number | undefined, label: (ms: number) => string): RangeOption[] {
  if (maxMs === undefined || !(maxMs > 0)) return [...presets];
  const fit = presets.filter((p) => p.ms <= maxMs);
  const top = fit.length > 0 ? fit[fit.length - 1]!.ms : 0;
  return top < maxMs ? [...fit, { id: 'max', label: label(maxMs), ms: maxMs }] : fit;
}

export const LOG_SEARCH_MAX_CONTEXT = 5;

/**
 * Chart data with a null point in every gap, so a line stops where no sample was taken (a stopped
 * agent, a monitor restart) instead of joining the two sides. A gap is a step longer than
 * `factor` times the usual (median) step and at least `minGapS`. `data[0]` holds the times in
 * seconds, ascending; the series follow. Data without a gap is returned unchanged.
 */
export type ChartColumns = ReadonlyArray<ArrayLike<number | null | undefined>>;
export function breakGaps(data: ChartColumns, factor = 3, minGapS = 30): ChartColumns {
  const ts = data[0];
  if (!ts || ts.length < 3) return data;
  const steps: number[] = [];
  for (let i = 1; i < ts.length; i++) steps.push((ts[i] as number) - (ts[i - 1] as number));
  const sorted = [...steps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const limit = Math.max(minGapS, median * factor);
  if (!steps.some((d) => d > limit)) return data;
  const out: (number | null)[][] = data.map(() => []);
  for (let i = 0; i < ts.length; i++) {
    if (i > 0 && steps[i - 1]! > limit) {
      out[0]!.push((ts[i - 1] as number) + median);
      for (let k = 1; k < data.length; k++) out[k]!.push(null);
    }
    for (let k = 0; k < data.length; k++) out[k]!.push((data[k]![i] ?? null) as number | null);
  }
  return out;
}

export const logSearchSchema = z.object({
  /** PM2 names of the services to search, or `_nginx` / `_monitor`. At least one, at most 10. */
  services: z.array(z.string().min(1).max(200)).min(1).max(10),
  from: z.number().int().nonnegative(),
  to: z.number().int().positive(),
  stream: z.enum(['all', 'out', 'err', 'access', 'error']).default('all'),
  /** Plain text, or a regular expression when `regex` is true. Empty means "every line". */
  query: z.string().max(200).default(''),
  regex: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
  limit: z.number().int().min(1).max(50_000).optional(),
  context: z.number().int().min(0).max(LOG_SEARCH_MAX_CONTEXT).default(0),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type LogSearchRequest = z.infer<typeof logSearchSchema>;

export interface LogSearchLine {
  ts: number;
  svc: string;
  pm: number;
  s: string;
  msg: string;
  /** True for a surrounding line, shown for context, not a match. */
  ctx?: true;
}

export interface LogSearchResponse {
  lines: LogSearchLine[];
  matched: number;
  /** More matches exist than `limit` allowed: narrow the range or the filter. */
  truncated: boolean;
  /** The 30 s ceiling was reached: the result covers only part of the range. */
  timedOut: boolean;
  filesScanned: number;
  linesScanned: number;
  tookMs: number;
}

export interface WindowsEventDto {
  id: number;
  logName: string;
  recordId: number;
  ts: number;
  level: 'critical' | 'error' | 'warning';
  provider: string | null;
  eventId: number | null;
  message: string | null;
}

export interface WindowsEventsResponse {
  /** False on a non-Windows host or before the collector has run. */
  collecting: boolean;
  events: WindowsEventDto[];
}

// --- email delivery (Resend webhooks) ----------------------------------------

export interface EmailSummaryRowDto {
  domain: string;
  sent: number;
  delivered: number;
  delayed: number;
  bounced: number;
  complained: number;
  failed: number;
  suppressed: number;
}
export interface EmailSummaryResponse {
  /** False until RESEND_WEBHOOK_SECRET is set on the server. */
  configured: boolean;
  /** When the last webhook arrived; null if none yet. */
  lastReceivedAt: number | null;
  hours: number;
  from: number;
  rows: EmailSummaryRowDto[];
  hourly: { ts: number; delivered: number; bad: number }[];
  badLastHour: number;
}

// ---------------------------------------------------------------------------
// Remote hosts and agent ingest (phase 11, M1). TRD section 14, backend-schema.md section 13.
// ---------------------------------------------------------------------------

/** Host 1: this Windows server, fed by the local collectors. */
export const LOCAL_HOST_ID = 1;

export type HostKind = 'local' | 'agent';
export type HostOs = 'windows' | 'linux';
/**
 * local: host 1. waiting: created, no agent has enrolled yet. online: the agent reported recently.
 * silent: enrolled, but nothing for a while. revoked: its token no longer works.
 */
export type HostStatus = 'local' | 'waiting' | 'online' | 'silent' | 'revoked';

/** A host counts as silent in the list after this long without a request (the alert waits longer). */
export const HOST_ONLINE_MS = 60_000;
/** Agent timestamps further than this from the monitor's clock are replaced by the arrival time. */
export const AGENT_MAX_SKEW_MS = 5 * 60_000;
/**
 * An agent host's figures count as current for this long after its last metrics report (three
 * 10 s reports plus a margin). Older figures are not evidence: its alerts neither open nor resolve
 * until reports resume, and `host.silent` takes over.
 */
export const AGENT_HOST_FRESH_MS = 35_000;

/** One host as the live message and the host switcher list it. */
export interface HostSummary {
  id: number;
  name: string;
  kind: HostKind;
  os: HostOs;
  status: HostStatus;
}

/** What an agent host reports about itself (the metrics `agent` section) plus what the monitor knows. */
export interface HostAgentInfo {
  version: string | null;
  lastSeenAt: number | null;
  actionsEnabled: boolean | null;
  /** From the latest metrics report that carried an `agent` section; null before one arrives. */
  reportedAt: number | null;
  droppedLogLines: number;
  bufferBytes: number;
  collectors: { name: string; lastOkAt: number | null; error: string | null }[];
}

export interface HostIngestCounts {
  /** Requests accepted since the monitor started, by endpoint. */
  metrics: number;
  logs: number;
  events: number;
  app: number;
  /** Requests refused since the monitor started (bad body, too large, rate limited, too old). */
  rejected: number;
  /** Log lines and events received; stored from M3 and M2. */
  logLines: number;
  eventCount: number;
}

export interface HostDto {
  id: number;
  name: string;
  kind: HostKind;
  os: HostOs;
  status: HostStatus;
  /** An agent has exchanged an enrollment token at least once and the host is not revoked. */
  enrolled: boolean;
  /** Set while an unused enrollment token exists. */
  enrollExpiresAt: number | null;
  agentVersion: string | null;
  /** As last reported by the agent; null before the first report. */
  actionsEnabled: boolean | null;
  lastSeenAt: number | null;
  /** Agent clock minus monitor clock at the last report, when it was more than 5 minutes off. */
  clockSkewMs: number | null;
  createdAt: number;
  revokedAt: number | null;
  notes: string | null;
  /** Live figures from the latest metrics report; null before one arrives. */
  latest: {
    at: number;
    cpuPct: number;
    memUsedBytes: number;
    memTotalBytes: number;
    disks: number;
    containers: number;
  } | null;
  counts: HostIngestCounts | null;
}

export interface HostsResponse {
  hosts: HostDto[];
}

const hostName = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Use lower-case letters, digits and dashes, starting and ending with a letter or digit.');

export const createHostSchema = z
  .object({
    name: hostName,
    os: z.literal('linux').default('linux'),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict();
export type CreateHostRequest = z.input<typeof createHostSchema>;

export const updateHostSchema = z
  .object({
    name: hostName.optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict();
export type UpdateHostRequest = z.infer<typeof updateHostSchema>;

/** POST /hosts and POST /hosts/:id/enroll-token: the only time the token is sent. */
export interface EnrollTokenResponse {
  host: HostDto;
  enrollToken: string;
  enrollExpiresAt: number;
}

// --- agent ingest (/agent/v1) -------------------------------------------------

export const AGENT_INGEST_PREFIX = '/agent/v1';
export const AGENT_VERSION_HEADER = 'x-agent-version';

/** Decompressed size limits per endpoint (TRD 14.3). The compressed body may not exceed them either. */
export const AGENT_INGEST_LIMITS = {
  enroll: 4 * 1024,
  metrics: 512 * 1024,
  logs: 4 * 1024 * 1024,
  events: 256 * 1024,
  app: 256 * 1024,
} as const;
export type AgentEndpoint = keyof typeof AGENT_INGEST_LIMITS;

/** Requests per minute per host, across every endpoint, and across all hosts together. */
export const AGENT_RATE_PER_HOST = 600;
export const AGENT_RATE_GLOBAL = 3000;

const semver = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/, 'version must look like 1.2.3');
/** `<compose project>/<service>`, the source key of a container service. */
export const containerKey = z
  .string()
  .max(160)
  .regex(/^[a-z0-9][a-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'expected <project>/<service>');
const finite = z.number().finite();
const nonNegF = finite.nonnegative();
const epochMs = z.number().int().positive().max(1e14);

export const agentEnrollSchema = z
  .object({
    enrollToken: z.string().min(16).max(200),
    hostname: z.string().trim().min(1).max(253),
    os: z.enum(['windows', 'linux']),
    agentVersion: semver,
  })
  .strict();
export type AgentEnrollRequest = z.infer<typeof agentEnrollSchema>;
export interface AgentEnrollResponse {
  hostId: number;
  hostName: string;
  token: string;
}

const agentDiskSchema = z
  .object({
    volume: z.string().min(1).max(200),
    usedBytes: nonNegF,
    totalBytes: nonNegF,
    readBps: nonNegF.nullable().optional(),
    writeBps: nonNegF.nullable().optional(),
  })
  .strict();

export const agentContainerSchema = z
  .object({
    key: containerKey,
    name: z.string().min(1).max(200),
    instances: z.number().int().nonnegative().max(1000),
    instancesRunning: z.number().int().nonnegative().max(1000),
    state: z.enum(['running', 'exited', 'paused', 'restarting', 'created', 'dead', 'removing']),
    health: z.enum(['healthy', 'unhealthy', 'starting']).nullable(),
    restartsTotal: z.number().int().nonnegative(),
    cpuPct: nonNegF,
    memBytes: nonNegF,
    startedAt: epochMs.nullable(),
    /** `startedAt` comes from Docker's rounded "Up …" text, not a start event (agent 0.2.1+). */
    startedApprox: z.boolean().optional(),
    /** A container of the agent's own compose project (the agent and its Docker proxy). */
    own: z.boolean().optional(),
  })
  .strict();
export type AgentContainer = z.infer<typeof agentContainerSchema>;

/** POST /agent/v1/metrics, every 10 s. Sections other than `host` arrive with M2 to M4. */
export const agentMetricsSchema = z
  .object({
    v: z.literal(1),
    ts: epochMs,
    actions: z.enum(['on', 'off']),
    host: z
      .object({
        cpuPct: nonNegF.max(100),
        cpuPerCore: z.array(nonNegF.max(100)).max(1024),
        memUsedBytes: nonNegF,
        memTotalBytes: nonNegF,
        swapUsedBytes: nonNegF,
        swapTotalBytes: nonNegF,
        netRxBps: nonNegF,
        netTxBps: nonNegF,
        uptimeS: nonNegF,
        pendingReboot: z.boolean(),
        disks: z.array(agentDiskSchema).max(64),
      })
      .strict(),
    containers: z.array(agentContainerSchema).max(500).optional(),
    // Validated for shape now, stored from M4.
    mongo: z.record(z.unknown()).optional(),
    gateway: z
      .object({
        perHost: z
          .array(
            z
              .object({
                host: z.string().min(1).max(253),
                requests: z.number().int().nonnegative(),
                s2xx: z.number().int().nonnegative(),
                s3xx: z.number().int().nonnegative(),
                s4xx: z.number().int().nonnegative(),
                s5xx: z.number().int().nonnegative(),
                p50Ms: nonNegF,
                p95Ms: nonNegF,
                bytes: nonNegF,
              })
              .strict(),
          )
          .max(200),
        certs: z
          .array(
            z.object({ host: z.string().min(1).max(253), notAfter: epochMs.nullable(), error: z.string().max(500).nullable() }).strict(),
          )
          .max(200),
      })
      .strict()
      .optional(),
    checks: z
      .object({
        backupNewestAt: epochMs.nullable(),
        backupNewestBytes: nonNegF.nullable(),
        offsiteOkAt: epochMs.nullable(),
        f2b: z
          .array(z.object({ jail: z.string().min(1).max(100), bans: z.number().int().nonnegative(), unbans: z.number().int().nonnegative() }).strict())
          .max(50),
        sshFailures: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    agent: z
      .object({
        droppedLogLines: z.number().int().nonnegative(),
        bufferBytes: z.number().int().nonnegative(),
        collectors: z
          .array(
            z.object({ name: z.string().min(1).max(40), lastOkAt: epochMs.nullable(), error: z.string().max(500).nullable() }).strict(),
          )
          .max(32),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AgentMetrics = z.infer<typeof agentMetricsSchema>;

/** One log line is cut to this many characters by the agent; longer lines are refused here. */
export const AGENT_LOG_LINE_MAX = 65_536;

/** POST /agent/v1/logs, every 1 s or 256 KB. Stored from M3. */
export const agentLogsSchema = z
  .object({
    v: z.literal(1),
    batches: z
      .array(
        z
          .object({
            service: containerKey,
            lines: z
              .array(z.object({ ts: epochMs, s: z.enum(['out', 'err']), msg: z.string().max(AGENT_LOG_LINE_MAX) }).strict())
              .max(20_000),
            dropped: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();
export type AgentLogs = z.infer<typeof agentLogsSchema>;

/** POST /agent/v1/events, as containers change state. Stored in `process_events` (M2). */
export const agentEventsSchema = z
  .object({
    v: z.literal(1),
    events: z
      .array(
        z
          .object({
            ts: epochMs,
            service: containerKey,
            event: z.enum(['die', 'oom', 'health_status', 'start', 'stop', 'restart']),
            detail: z.record(z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()])).optional(),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export type AgentEvents = z.infer<typeof agentEventsSchema>;
