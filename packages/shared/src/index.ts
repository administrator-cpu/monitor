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
  })
  .strict();
export type ServicePatchInput = z.infer<typeof servicePatchSchema>;

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
export interface MonitorHealth {
  pid: number;
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
  host: HostState | null;
  series: HostSeries;
  collectors: CollectorStatus[];
  monitor: MonitorHealth;
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
  lastExit?: { at: number; code: number | null; signal: string | null };
}

export interface ServiceDto {
  id: number;
  name: string;
  pm2Name: string;
  nginxMatch: string | null;
  publicUrl: string | null;
  agentEnabled: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  isArchived: boolean;
  notes: string | null;
  /** Not seen in PM2 within `pm2.stale_hours`. */
  stale: boolean;
}

export interface ServiceLive {
  process: ProcessState;
  /** Runtime figures from the in-app agent, without the tenant list; null when none is reporting. */
  app: Omit<AppServiceState, 'tenants'> | null;
}

export interface ServiceListItem extends ServiceDto {
  process: ProcessState | null;
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
  topPaths: { path: string; count: number }[];
  topClientIps: { ip: string; count: number }[];
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

export const LOG_SEARCH_MAX_CONTEXT = 5;

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
