# Backend Schema: Self-Hosted Command Center

**Version:** v3, 2026-10-29 (replaces v2)
**Companion to:** `prd.md`, `trd.md`, `implementation-plan.md` (all v3)

Every data structure the backend owns: SQLite tables, log files, in-memory shapes, ingest payloads, WebSocket messages, alert rules, settings and retention. Sections 1 to 12 describe what is in `main` (`c00d968`); section 13 is the planned multi-host schema.

**Markers:** **[Built]** in `main`; **[Planned]** approved, no code; **[Gap]** fix planned in phase 10.5.

---

## 0. Status and Change Log

### 0.1 Migrations

| File | Content | Status |
|---|---|---|
| `001_init.sql` | `users`, `sessions`, `audit_log`, `settings`, `services`, `tenants`, `schema_migrations`, `maintenance_runs`, reserved `_unattributed` service | Built |
| `002_pm2.sql` | `metrics_host`, `metrics_disk`, `metrics_process`, `process_events` | Built |
| `003_alerts.sql` | Alert tables, 28 rules | Built |
| `004_nginx.sql` | `metrics_nginx`, `metrics_nginx_service`, `tls_certs` | Built |
| `005_mongo.sql` | `metrics_mongo`, `mongo_slow_queries` | Built |
| `006_agent.sql` | `metrics_app_service`, `metrics_app_tenant` | Built |
| `007_events.sql` | `windows_events` | Built |
| `008_github.sql` | `services.git_repo`, `git_branch`, `git_path`; `service_git` | Built |
| `009_email.sql` | `email_event_counts`, `email_webhook_seen`, rule `monitor.email_bounce_spike` | Built |
| `010_hosts.sql` | `hosts`, `services` rebuild, `host_id` columns, rule `host.silent` | Planned (M1) |
| `011_remote_checks.sql` | Probes, host check metrics, three rules | Planned (M4) |
| `012_agent_commands.sql` | Remote action queue | Planned (M5) |

v2 described one migration `008` for GitHub and email and a multi-host `009`. The repository has `008_github.sql` and `009_email.sql`, so multi-host starts at `010`.

### 0.2 Change log

| Version | Date | Change |
|---|---|---|
| v1 | 2026-10-08 | Migrations `001` to `007` |
| v2 | 2026-10-29 | Proposed `008` and `009` |
| v3 | 2026-10-29 | `008` and `009` recorded from the repository. All "verify against the code" items resolved. Multi-host as `010` to `012`: `services` rebuilt with `host_id`, `kind`, `source_key`, `log_excluded`; host-scoped fingerprints that leave host 1 unchanged; payloads without container inspect; remote action queue |

---

## 1. Conventions [Built]

- Timestamps in milliseconds UTC (`_at` for events, `ts` for samples). SQL defaults use `CAST(strftime('%s','now') AS INTEGER) * 1000`.
- Booleans are `INTEGER` 0 or 1 with CHECK.
- `INTEGER PRIMARY KEY` ids; JSON in `TEXT`.
- Metric tables are prefixed `metrics_`, carry `res_s` (10 or 60), are mostly `WITHOUT ROWID`, and have no foreign keys.
- [Planned] Per-host tables carry `host_id INTEGER NOT NULL DEFAULT 1`. In metric tables it is checked by the application, not by a foreign key.

---

## 2. Database Setup [Built]

- `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = ON`, `busy_timeout = 5000`, `temp_store = MEMORY`.
- One writer; metric rows batched every 10 s.
- Migrations: files `NNN_name.sql`, forward only, each run in **one transaction** together with its `schema_migrations` row. A failure rolls the file back and stops startup. Because the runner opens the transaction, a migration cannot change `PRAGMA foreign_keys`; none needs to (13.2).
- Path: `SQLITE_PATH`, default `C:\monitor\data\monitor.db` on Windows, which the deploy script also assumes [Verify the production value].
- Backups today: `VACUUM INTO` before each deploy into `C:\monitor\backups`, last 10 kept. **[Gap H7]** Same drive as the database; no nightly copy; no offsite copy; no tested restore. Required: nightly `VACUUM INTO E:\monitor-backups\monitor-YYYYMMDD.db` (keep 14), a second copy off the server, pre-deploy backups on `E:`, one restore tested. Metric history may be lost; users, settings, rules, services (including the hand-entered git mapping), hosts and audit must not.

---

## 3. SQLite Tables

### 3.1 Accounts and sessions [Built]

`users` (unique username and email, case-insensitive; role `admin` or `engineer`; `can_operate`; `must_change_password`; lockout fields; reserved `totp_secret_enc`, `totp_enabled`), `sessions` (id is the SHA-256 of the token; absolute and idle expiry; revocation), `audit_log` (`user_id` nullable, `username` text, `event`, `ip`, `user_agent`, `detail` JSON; no CHECK on `event`).

Automatic events are written with `user_id = NULL` and `username = 'system'` (for example auto-archive).

Audit events added since v1: `service_updated` (also git mapping and auto-archive), `service_action`, `service_action_failed`. [Planned] `service_action_requested`, `host_created`, `host_updated`, `host_enrolled`, `host_token_rotated`, `host_revoked`, `agent_version_rejected`.

### 3.2 Settings, services, tenants [Built]

`settings(key, value JSON, updated_at, updated_by)`: only admin edits are stored; defaults are in code (section 10).

`services` today:

| Column | Notes |
|---|---|
| `id` | 0 is the reserved `_unattributed` row |
| `name` | Display name, `UNIQUE` |
| `pm2_name` | `NOT NULL UNIQUE`; key for discovery, the log folder and the log channel |
| `nginx_match`, `public_url`, `notes` | Admin-edited |
| `agent_enabled` | Set by the first valid `@cc/agent` report |
| `first_seen_at`, `last_seen_at` | `last_seen_at` written at most once a minute |
| `is_archived` | Set by auto-archive or an admin; cleared by rediscovery |
| `git_repo`, `git_branch` (`NOT NULL DEFAULT 'main'`), `git_path` | From `008` |

No table has a foreign key to `services`. [Planned] Rebuilt in `010` (13.2).

`tenants(tenant_key UNIQUE, display_name, first_seen_at, last_seen_at)`.

### 3.3 Host metrics [Built]

`metrics_host(res_s, ts, cpu_pct, cpu_max_core_pct, mem_*, swap_*, net_rx_bps, net_tx_bps, uptime_s, pending_reboot)`, PK `(res_s, ts)`.
`metrics_disk(volume, res_s, ts, used_bytes, total_bytes, read_bps, write_bps)`, PK `(volume, res_s, ts)`. `volume` is a drive letter on Windows and a mount point on Linux. Optical volumes and `DISK_EXCLUDE` entries are never written.

[Planned] Both rebuilt with `host_id` in the primary key (13.3).

### 3.4 Processes [Built]

`metrics_process(service_id, res_s, ts, status, instances, cpu_pct, mem_bytes, restarts, uptime_s)` and `process_events(id, ts, service_id, pm_id, event, detail)`. Neither `status` nor `event` has a CHECK constraint, so container states (`running`, `exited`, `paused`, `restarting`, `created`, `dead`) and events (`die`, `oom`, `health_status`, `start`, `stop`, `restart`) need no rebuild. `pm_id` is NULL for containers. Actions appear here as ordinary events and are attributed through `audit_log`.

### 3.5 Application metrics [Built]

`metrics_app_service` (10 s and 60 s) and `metrics_app_tenant` (60 s only). Keyed by `service_id`, so they work for any host unchanged.

### 3.6 Gateway [Built]

`metrics_nginx` (Windows `stub_status`, stays host 1 only), `metrics_nginx_service` (per service; also used for Caddy traffic on other hosts, since `service_id` identifies the host), `tls_certs(host PRIMARY KEY, not_after, issuer, checked_at, last_error)`.

**[Gap H4]** `NginxState.topPaths` and `topClientIps` exist in memory and on the Nginx page but cannot be filled with the privacy log format (everything counts as `/`). They are removed.

### 3.7 MongoDB [Built]

`metrics_mongo` PK `(res_s, ts)`; `mongo_slow_queries` with namespace, op, millis, plan summary, counts, app name, and a command shape of field names only. [Planned] `host_id` on both.

### 3.8 Windows Event Log [Built]

`windows_events(log_name, record_id, ts, level, provider, event_id, message ≤ 2000 chars)`, unique `(log_name, record_id)`. Host 1 only.

### 3.9 Alerting [Built]

- `alert_rules(key UNIQUE, category CHECK IN ('host','pm2','nginx','mongo','app','monitor'), name, description, severity, enabled, threshold, duration_s, cooldown_s, params JSON)`. `params.overrides` maps a PM2 name to a per-service threshold.
- `alert_incidents(rule_id, service_id, fingerprint, state, opened_at, resolved_at, last_notified_at, notify_count, peak_value, summary, suppressed_by)`; unique index on `fingerprint` while `state = 'firing'`.
- `alert_notifications` (outbox; `provider_msg_id` kept, not matched to webhooks, D6).
- `alert_subscriptions(user_id, category)`.
- `alert_mutes(starts_at, ends_at, service_id, category, rule_id, reason, created_by)`. A Stop action inserts a mute on `pm2.service_down` for that service; Start deletes it. **[Gap H6]** The link from service to mute id is held in memory, so after a monitor restart Start cannot find it. Fix: on Start, delete mutes for that service and rule whose `reason` starts with "Stopped from the dashboard".

The category CHECK is why every new rule reuses an existing category (D5).

**Fingerprints.** `<rule key>` or `<rule key>:<target>`. Targets: service id for service rules, volume for disks, host name for certificates, collector name, and so on.

### 3.10 Housekeeping [Built]

`maintenance_runs(job, last_run_at, last_status, last_detail)` for rollup, retention and session cleanup; `schema_migrations(version, name, applied_at)`.

### 3.11 Code status and email [Built]

See section 12.

### 3.12 Relationships

```
users ──< sessions, audit_log (SET NULL), settings.updated_by, alert_rules.updated_by,
          alert_subscriptions, alert_mutes.created_by
alert_rules ──< alert_incidents ──< alert_notifications
alert_incidents ── suppressed_by → alert_incidents
services ── service_git (by service_id, no FK)
(metrics_*, process_events, alert_incidents.service_id: by service_id, no FK)

Planned:
hosts ──< services (FK)
hosts ── metrics_host, metrics_disk, metrics_mongo, mongo_slow_queries, tls_certs,
         alert_incidents, metrics_probe, metrics_host_checks, host_probes, agent_commands (by host_id)
services ──< agent_commands (FK)
```

---

## 4. Log Files [Built]

`LOG_ROOT\<pm2 name>\<YYYY-MM-DD>-<HH>.jsonl`, gzipped after the hour; one line per chunk:

```json
{"ts":1790000000123,"svc":"billing-api","pm":3,"s":"out","msg":"user login ok email=a@b.com"}
```

64 KB line limit; retention by file name after `logs.retention_hours`; monitor's own logs under `_monitor`.

Nginx access log source (no path, query, client address or headers):

```json
{"t":"2026-10-07T10:15:04+00:00","host":"api.example.com","status":200,"rt":0.034,"urt":"0.030","up":"127.0.0.1:3001","bytes":512,"method":"GET"}
```

**[Gap H3]** Search accepts 7 days against 24 hours of files; capped at `logs.retention_hours`.

**[Planned] Remote hosts:** `LOG_ROOT\@<host name>\<project>.<service>\<YYYY-MM-DD>-<HH>.jsonl`. Lines use `pm: -1`, `s: "out" | "err"`, and add `"h": <host id>`. Host 1 paths and lines are unchanged. Caddy access records are never written as log lines.

---

## 5. In-Memory Shapes [Built]

Defined in `packages/shared/src/index.ts`. Relevant today: `HostState`, `DiskState` (`readBps`, `writeBps` nullable), `ProcessState` (`serviceId`, `name`, `pm2Name`, status `online | launching | stopping | stopped | errored`, instances, CPU, memory, restarts, uptime, `lastExit`), `NginxState` (includes `topPaths`, `topClientIps` [Gap H4]), `MongoState`, `AppState`, `CollectorStatus`, `LogStatus`, `ServiceDto` (includes `gitRepo`, `gitBranch`, `gitPath`, `stale`), `UserDto` (includes `canOperate`), git status DTO, `ServiceActionResponse` (`ok`, `action`, `status`, `verified`, `mutedMinutes`).

[Planned] additions:

```ts
type HostKind = 'local' | 'agent';
type HostStatus = 'ok' | 'silent' | 'revoked' | 'clock_skew' | 'never_seen';

interface HostSummary {
  id: number; name: string; kind: HostKind; os: 'windows' | 'linux';
  status: HostStatus; agentVersion: string | null; lastSeenAt: number | null;
  actions: 'on' | 'off' | null;          // reported by the agent; null for host 1
  openIncidents: number;
}

// ProcessState and ServiceDto gain:
//   hostId: number; kind: 'pm2' | 'container'; sourceKey: string;
//   health?: 'healthy' | 'unhealthy' | 'starting';   // containers with a health check
// pm2Name stays, equal to sourceKey for kind 'pm2', so the current frontend keeps working.
// ProcessStatus gains 'running' | 'exited' | 'paused' | 'restarting' | 'created' | 'dead',
// shown in the same five colour groups.

interface CommandDto {
  id: number; serviceId: number; action: 'start' | 'stop' | 'restart';
  state: 'queued' | 'sent' | 'done' | 'failed' | 'refused' | 'expired';
  reason: string | null; observed: string | null;
  requestedAt: number; finishedAt: number | null;
}
```

The state store becomes `Map<hostId, HostSlice>` with `{ host, disks, services, mongo, gateway, collectors, logs, checks }`.

---

## 6. `@cc/agent` Ingest Payload [Built]

`POST http://127.0.0.1:4001/ingest/v1/agent`, header `X-Monitor-Token` (checked before the body is read), 256 KB limit; 204, 400 (invalid or unknown service), 401, 404, 405, 413. `INGEST_TOKEN` is 24+ characters.

[Planned] On agent hosts the same payload goes to the node agent's relay (`http://cc-node-agent:4002/ingest/v1/agent`, header `X-Monitor-Token: <CC_RELAY_TOKEN>`), which forwards it to `/agent/v1/app`. `service` must be the compose service name of the API container; the monitor resolves it on that host.

---

## 7. WebSocket Messages [Built]

`GET /api/v1/ws`. Client: `subscribe`, `unsubscribe`, `ping`. Server: `live` (2 s), `log_batch` (250 ms), `event`, `warning`, `error`, `pong`. Close codes 4401, 4403, 4429.

[Planned]

```json
{ "type": "subscribe", "channel": "live", "host": 2 }
{ "type": "subscribe", "channel": "logs", "host": 2, "service": 41, "stream": "all", "backfill": 200 }
```

`host` defaults to 1. The `live` message gains `hosts: HostSummary[]` and `hostId`; its other fields describe the subscribed host. `event` messages gain `host`. A command result is sent as `{ "type": "event", "kind": "command", "command": CommandDto }`.

---

## 8. Alert Rules

### 8.1 Seeded today [Built] (29)

| Category | Keys |
|---|---|
| host (6) | `host.disk_high` 85%, `host.disk_critical` 95%, `host.cpu_high` 90%, `host.mem_high` 90%, `host.pending_reboot` (24 h), `host.eventlog_critical` |
| pm2 (3) | `pm2.service_down` (60 s), `pm2.crash_loop` (5 in 10 min), `pm2.memory_high` (1 GiB, per-service overrides) |
| nginx (4) | `nginx.5xx_rate` 5%, `nginx.status_unreachable`, `nginx.cert_expiring` 14 d, `nginx.cert_critical` 3 d |
| mongo (5) | `mongo.down`, `mongo.connections_high` 80%, `mongo.long_op` 60 s, `mongo.slow_query_burst` 20 per 5 min, `mongo.repl_lag` 30 s |
| app (4) | `app.event_loop_lag` 200 ms, `app.latency_high` 2000 ms, `app.cpu_no_users` 80%, `app.agent_silent` |
| monitor (7) | `monitor.log_volume_missing`, `monitor.log_volume_high` 85%, `monitor.log_dropped`, `monitor.collector_stale`, `monitor.sqlite_write_failing`, `monitor.email_failing`, `monitor.email_bounce_spike` (5 in the last hour, warning, from `009`) |

Behavior added by Parts 0 and C: a Stop mutes `pm2.service_down` for that service; an archived service's incidents close quietly; a volume no longer reported resolves its disk incidents.

### 8.2 Added in phase 11 [Planned]

| Key | Category | Condition | Threshold | Duration | Severity | Migration |
|---|---|---|---|---|---|---|
| `host.silent` | monitor | No agent request from a host | — | 120 s | critical | `010` |
| `host.probe_failed` | monitor | Outside-in probe target failing | 3 consecutive | 0 | critical | `011` |
| `monitor.backup_stale` | monitor | Newest local backup, or last offsite marker, older than threshold; targets `local` and `offsite` | 26 h | 0 | warning | `011` |
| `host.auth_failures_high` | host | Failed SSH logins in the last hour | 300 | 0 | warning, **disabled** by default | `011` |

- `host.silent` applies only to agent hosts. It suppresses every incident with the same `host_id` except `host.probe_failed`.
- Existing rules apply per host; `pm2.*` cover containers; `nginx.5xx_rate` and the certificate rules cover Caddy.
- `params.overrides` keys: PM2 name on host 1 (unchanged); `@<host id>/<source key>` on other hosts.
- `host.pending_reboot`'s description changes from "A Windows reboot" to "A reboot".

### 8.3 Fingerprints after `010`

Service targets (service id) are unchanged on every host. Host-scoped targets on hosts other than 1 are prefixed `@<host id>/`. Host 1 keeps its exact fingerprints, so the migration rewrites nothing and open incidents stay open.

---

## 9. Retention, Rollups and Sizing

### 9.1 Retention [Built]

| Data | Setting | Default |
|---|---|---|
| Metric rows (all resolutions) | `retention.metrics_days` | 7 |
| 10 s rows | `retention.metrics_raw_hours` (rollup) | 24 |
| Process events, Windows events, slow queries | `retention.events_days` | 7 |
| Resolved incidents and notifications | `retention.alerts_days` | 90 |
| Audit log | `retention.audit_days` | 365 |
| Email counts and webhook ids | `retention.email_days` | 30 |
| Log files | `logs.retention_hours` | 24 |
| `service_git` | One row per service, overwritten | |
| [Planned] `metrics_probe`, `metrics_host_checks` | `retention.metrics_days` | |
| [Planned] `agent_commands` | `retention.audit_days` | |
| [Planned] `hosts` | Kept, revoked hosts too | |

**[Gap H3]** History accepts 31 days against 7 days of metrics; capped at `retention.metrics_days`.

### 9.2 Rollup [Built]

Hourly; 10 s rows older than `retention.metrics_raw_hours` become 60 s rows; one transaction per table; safe to run twice. [Planned] Groups by `host_id` where present.

### 9.3 Size

About 164 MB at 7 days for 10 services and 20 tenants (`pnpm size:check`); measured size not recorded [Verify]. `008` and `009` add little (one row per service; 10-minute email buckets). The Ubuntu host adds under 10 MB of host, disk and Mongo rows and about 30 MB of process rows for 9 containers per 7 days, plus probes and checks (under 5 MB). Log files are the real cost (TRD 14.12).

---

## 10. Settings [Built]

Defaults live in `apps/backend/src/settings.ts`; only admin edits are stored.

| Key | Default | Range |
|---|---|---|
| `retention.metrics_raw_hours` | 24 | 1–168 |
| `retention.metrics_days` | 7 | 1–90 |
| `retention.events_days` | 7 | 1–90 |
| `retention.alerts_days` | 90 | 1–730 |
| `retention.audit_days` | 365 | 1–3650 |
| `retention.email_days` | 30 | 1–365 |
| `logs.retention_hours` | 24 | 1–168 |
| `logs.volume_threshold_pct` | 85 | 50–99 |
| `logs.ring_buffer_lines` | 5000 | 100–100000 |
| `logs.search_max_results` | 5000 | 100–50000 |
| `session.absolute_hours` | 12 | |
| `session.idle_hours` | 2 | |
| `login.max_failures` | 5 | |
| `login.lock_minutes` | 15 | |
| `alert.reminder_minutes` | 60 | |
| `alert.from`, `alert.dashboard_url` | none | text |
| `pm2.stale_hours` | 24 | "stale" flag on services |
| `pm2.auto_archive_minutes` | 15 | 0 turns it off |
| `github.poll_minutes` | 5 | 1–1440 |
| `actions.stop_mute_minutes` | 30 | 0 turns it off |
| `agent.max_tenants_per_report` | 50 | |
| `nginx.top_n` | 50 | Removed with H4 |
| `mongo.slow_ms` | 100 | |

[Planned]

| Key | Default | Meaning |
|---|---|---|
| `agent.min_version` | none | Lowest node agent version accepted (text) |
| `agent.log_lines_per_s` | 200 | Per-container log limit sent to agents |
| `agent.enroll_minutes` | 60 | Enrollment token lifetime |
| `commands.ttl_seconds` | 60 | Remote action expiry |
| `probes.interval_seconds` | 60 | Outside-in probe interval |

Boot-time values and secrets stay in the environment (`trd.md` section 9).

---

## 11. Seed Data and First Run

No default credentials: the first admin comes from `create-admin`. Migrations seed the reserved service row, the alert rules, and from `010` host 1. Each new migration is tested on a copy of the production database before merge; the deploy backs the database up before applying it.

---

## 12. Migrations `008` and `009` [Built]

### 12.1 `008_github.sql`

```sql
ALTER TABLE services ADD COLUMN git_repo   TEXT;                      -- 'owner/name'
ALTER TABLE services ADD COLUMN git_branch TEXT NOT NULL DEFAULT 'main';
ALTER TABLE services ADD COLUMN git_path   TEXT;                      -- folder on this server

CREATE TABLE service_git (
  service_id  INTEGER PRIMARY KEY,
  checked_at  INTEGER NOT NULL,
  state       TEXT    NOT NULL,          -- in_sync | behind | ahead | diverged | dirty | not_on_github | unknown
  data        TEXT    NOT NULL           -- JSON git status DTO (commits, counts, runs, PRs, ETags, error, last good check)
);
```

### 12.2 `009_email.sql`

```sql
CREATE TABLE email_event_counts (
  bucket      INTEGER NOT NULL,          -- start of a 10-minute window
  domain      TEXT    NOT NULL,          -- sender domain, lower case
  event       TEXT    NOT NULL,          -- sent | delivered | delivery_delayed | bounced | complained | failed | suppressed
  bounce_kind TEXT    NOT NULL DEFAULT '', -- permanent | transient | undetermined, for bounced only
  count       INTEGER NOT NULL,
  PRIMARY KEY (bucket, domain, event, bounce_kind)
) WITHOUT ROWID;

CREATE TABLE email_webhook_seen (
  id       TEXT    PRIMARY KEY,          -- svix-id
  seen_at  INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX email_webhook_seen_at ON email_webhook_seen (seen_at);

-- plus the rule monitor.email_bounce_spike (section 8.1)
```

Not stored: recipients, subjects, bodies, tags, message ids. Both tables are pruned after `retention.email_days`. The id insert and the count update share one transaction, so a retried webhook is never counted twice.

---

## 13. Migrations `010` to `012` and Agent Payloads [Planned]

Each migration runs in the runner's single transaction with `foreign_keys = ON`. That is safe for the `services` rebuild because no table references `services` by foreign key. The column lists below must be checked against the live schema before merge (`PRAGMA table_info`), and each migration is timed on a copy of the production database.

### 13.1 `010_hosts.sql`: hosts

```sql
CREATE TABLE hosts (
  id                 INTEGER PRIMARY KEY,
  name               TEXT    NOT NULL UNIQUE COLLATE NOCASE,   -- 'windows-vps', 'ubuntu-acs'
  kind               TEXT    NOT NULL CHECK (kind IN ('local','agent')),
  os                 TEXT    NOT NULL CHECK (os IN ('windows','linux')),
  token_hash         TEXT,                                      -- SHA-256 hex of the host token
  enroll_hash        TEXT,                                      -- SHA-256 hex of the one-time token
  enroll_expires_at  INTEGER,
  agent_version      TEXT,
  actions_enabled    INTEGER CHECK (actions_enabled IN (0,1)),  -- as last reported by the agent
  last_seen_at       INTEGER,
  clock_skew_ms      INTEGER,
  created_at         INTEGER NOT NULL,
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  revoked_at         INTEGER,
  notes              TEXT
);
CREATE UNIQUE INDEX idx_hosts_token  ON hosts(token_hash)  WHERE token_hash  IS NOT NULL;
CREATE UNIQUE INDEX idx_hosts_enroll ON hosts(enroll_hash) WHERE enroll_hash IS NOT NULL;

INSERT INTO hosts (id, name, kind, os, created_at)
VALUES (1, 'windows-vps', 'local', 'windows', CAST(strftime('%s','now') AS INTEGER) * 1000);
```

### 13.2 `010_hosts.sql`: `services` rebuild

`pm2_name` becomes `source_key` (PM2 name, or `<project>/<service>` for containers); uniqueness becomes per host.

```sql
CREATE TABLE services_new (
  id            INTEGER PRIMARY KEY,
  host_id       INTEGER NOT NULL DEFAULT 1 REFERENCES hosts(id),
  kind          TEXT    NOT NULL DEFAULT 'pm2' CHECK (kind IN ('pm2','container','pseudo')),
  name          TEXT    NOT NULL,
  source_key    TEXT    NOT NULL,
  nginx_match   TEXT,
  public_url    TEXT,
  agent_enabled INTEGER NOT NULL DEFAULT 0 CHECK (agent_enabled IN (0,1)),
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  is_archived   INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
  notes         TEXT,
  git_repo      TEXT,
  git_branch    TEXT    NOT NULL DEFAULT 'main',
  git_path      TEXT,
  log_excluded  INTEGER NOT NULL DEFAULT 0 CHECK (log_excluded IN (0,1)),  -- remote log shipping off
  UNIQUE (host_id, source_key),
  UNIQUE (host_id, name)
);

INSERT INTO services_new (id, host_id, kind, name, source_key, nginx_match, public_url, agent_enabled,
                          first_seen_at, last_seen_at, is_archived, notes, git_repo, git_branch, git_path)
SELECT id, 1, CASE WHEN id = 0 THEN 'pseudo' ELSE 'pm2' END, name, pm2_name, nginx_match, public_url,
       agent_enabled, first_seen_at, last_seen_at, is_archived, notes, git_repo, git_branch, git_path
FROM services;

DROP TABLE services;
ALTER TABLE services_new RENAME TO services;
CREATE INDEX idx_services_host ON services(host_id, is_archived);
```

Ids are kept, so `service_git`, every metric table, `process_events` and `alert_incidents` still point at the right service. The code change (`ServicesRepo`, DTOs, log folder lookup) ships in the same pull request.

### 13.3 `010_hosts.sql`: `host_id` elsewhere

| Table | Change |
|---|---|
| `metrics_host` | Rebuilt: `host_id` first in the primary key `(host_id, res_s, ts)`, rows copied as host 1 |
| `metrics_disk` | Rebuilt: primary key `(host_id, volume, res_s, ts)` |
| `metrics_mongo` | Rebuilt: primary key `(host_id, res_s, ts)` |
| `mongo_slow_queries` | `ADD COLUMN host_id INTEGER NOT NULL DEFAULT 1`; index `(host_id, ts DESC)` |
| `tls_certs` | `ADD COLUMN host_id INTEGER NOT NULL DEFAULT 1` |
| `alert_incidents` | `ADD COLUMN host_id INTEGER NOT NULL DEFAULT 1`; index `(host_id, opened_at DESC)`. Fingerprints not rewritten (8.3) |
| `metrics_process`, `process_events`, `metrics_app_*`, `metrics_nginx_service`, `service_git` | Unchanged (`service_id` identifies the host) |
| `metrics_nginx`, `windows_events` | Unchanged (host 1 only) |

Rebuild pattern for each of the three metric tables (example):

```sql
CREATE TABLE metrics_host_new (
  host_id INTEGER NOT NULL DEFAULT 1,
  res_s INTEGER NOT NULL, ts INTEGER NOT NULL,
  cpu_pct REAL, cpu_max_core_pct REAL, mem_used_bytes INTEGER, mem_total_bytes INTEGER,
  swap_used_bytes INTEGER, swap_total_bytes INTEGER, net_rx_bps REAL, net_tx_bps REAL,
  uptime_s INTEGER, pending_reboot INTEGER CHECK (pending_reboot IN (0,1)),
  PRIMARY KEY (host_id, res_s, ts)
) WITHOUT ROWID;
INSERT INTO metrics_host_new SELECT 1, res_s, ts, cpu_pct, cpu_max_core_pct, mem_used_bytes, mem_total_bytes,
  swap_used_bytes, swap_total_bytes, net_rx_bps, net_tx_bps, uptime_s, pending_reboot FROM metrics_host;
DROP TABLE metrics_host;
ALTER TABLE metrics_host_new RENAME TO metrics_host;
```

If the copy takes too long on the production copy, the migration may instead drop the old metric rows (history is disposable); that choice is recorded in the pull request.

`010` also seeds rule `host.silent`.

### 13.4 `011_remote_checks.sql`

```sql
CREATE TABLE host_probes (
  id        INTEGER PRIMARY KEY,
  host_id   INTEGER NOT NULL REFERENCES hosts(id),
  kind      TEXT    NOT NULL CHECK (kind IN ('tcp','https')),
  target    TEXT    NOT NULL,            -- 'acs.thediv.in' or a full https URL
  port      INTEGER,                     -- tcp only
  enabled   INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  UNIQUE (host_id, kind, target, port)
);

CREATE TABLE metrics_probe (
  probe_id  INTEGER NOT NULL,
  res_s     INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  ok        INTEGER NOT NULL CHECK (ok IN (0,1)),   -- 60 s rows: 1 only if all samples were ok
  ms        REAL,
  PRIMARY KEY (probe_id, res_s, ts)
) WITHOUT ROWID;

CREATE TABLE metrics_host_checks (
  host_id              INTEGER NOT NULL,
  res_s                INTEGER NOT NULL,
  ts                   INTEGER NOT NULL,
  backup_newest_at     INTEGER,
  backup_newest_bytes  INTEGER,
  offsite_ok_at        INTEGER,
  f2b_bans             INTEGER,          -- bans in the interval, all jails
  ssh_failures         INTEGER,          -- failed logins in the interval
  PRIMARY KEY (host_id, res_s, ts)
) WITHOUT ROWID;
```

Seeds `host.probe_failed`, `monitor.backup_stale`, `host.auth_failures_high` (disabled), and the probes for host 2 once it exists (TCP 7547, 443, 80 to `acs.thediv.in`; HTTPS health URL added by the admin when O4 is answered). Per-jail ban counts are shown live only.

### 13.5 `012_agent_commands.sql`

```sql
CREATE TABLE agent_commands (
  id            INTEGER PRIMARY KEY,
  host_id       INTEGER NOT NULL REFERENCES hosts(id),
  service_id    INTEGER NOT NULL REFERENCES services(id),
  action        TEXT    NOT NULL CHECK (action IN ('start','stop','restart')),
  state         TEXT    NOT NULL CHECK (state IN ('queued','sent','done','failed','refused','expired')),
  requested_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  sent_at       INTEGER,
  finished_at   INTEGER,
  reason        TEXT,                    -- refusal or failure reason from the agent
  observed      TEXT                     -- container state after the action
);
CREATE INDEX idx_cmd_host_state ON agent_commands(host_id, state, requested_at);
CREATE UNIQUE INDEX idx_cmd_open_per_service ON agent_commands(service_id) WHERE state IN ('queued','sent');
```

This adds the first foreign key to `services`; any later rebuild of `services` must account for it.

### 13.6 Agent payloads

All `/agent/v1/*` requests except `enroll` carry `Authorization: Bearer <host token>` and `X-Agent-Version`; bodies are JSON, optionally `Content-Encoding: gzip`. The host comes from the token.

**`POST /agent/v1/enroll`**

```json
{ "enrollToken": "…", "hostname": "acs-prod", "os": "linux", "agentVersion": "0.1.0" }
```

Response `{ "hostId": 2, "hostName": "ubuntu-acs", "token": "…" }`. The host name is the one the admin chose; `hostname` is stored in `notes` for reference.

**`POST /agent/v1/metrics`** (every 10 s; 512 KB decompressed)

```json
{
  "v": 1, "ts": 1790000010000, "actions": "on",
  "host": { "cpuPct": 12.5, "cpuPerCore": [10, 15], "memUsedBytes": 0, "memTotalBytes": 0,
            "swapUsedBytes": 0, "swapTotalBytes": 0, "netRxBps": 0, "netTxBps": 0,
            "uptimeS": 0, "pendingReboot": false,
            "disks": [ { "volume": "/", "usedBytes": 0, "totalBytes": 0, "readBps": 0, "writeBps": 0 } ] },
  "containers": [ { "key": "acs/genieacs-cwmp", "name": "genieacs-cwmp", "instances": 1, "instancesRunning": 1,
                    "state": "running", "health": "healthy", "restartsTotal": 0,
                    "cpuPct": 3.1, "memBytes": 0, "startedAt": 1790000000000 } ],
  "mongo": { "up": true, "pingMs": 1.2, "...": "same fields as MongoState" },
  "gateway": { "perHost": [ { "host": "acs.thediv.in", "requests": 0, "s2xx": 0, "s3xx": 0, "s4xx": 0, "s5xx": 0,
                               "p50Ms": 0, "p95Ms": 0, "bytes": 0 } ],
               "certs": [ { "host": "acs.thediv.in", "notAfter": 1795000000000, "error": null } ] },
  "checks": { "backupNewestAt": 1789990000000, "backupNewestBytes": 0, "offsiteOkAt": 1789990500000,
              "f2b": [ { "jail": "sshd", "bans": 0, "unbans": 0 } ], "sshFailures": 0 },
  "agent": { "droppedLogLines": 0, "bufferBytes": 0,
             "collectors": [ { "name": "docker", "lastOkAt": 1790000009000, "error": null } ] }
}
```

`restartsTotal` counts restart and die-then-start events since the agent started; the monitor works with differences, as it does for PM2's counter. Gateway `perHost` is mapped to services by `nginx_match` on that host. Any section may be omitted when its collector is off.

**`POST /agent/v1/logs`** (every 1 s or 256 KB; 4 MB decompressed)

```json
{ "v": 1, "batches": [ { "service": "acs/genieacs-cwmp",
  "lines": [ { "ts": 1790000010100, "s": "out", "msg": "…" } ], "dropped": 0 } ] }
```

**`POST /agent/v1/events`**

```json
{ "v": 1, "events": [ { "ts": 1790000011000, "service": "acs/cpe-sim", "event": "die", "detail": { "exitCode": 137 } } ] }
```

**`POST /agent/v1/app`**: the section 6 payload, unchanged.

**`POST /agent/v1/commands/next`**: empty body. 204 after 25 s with nothing to do, or:

```json
{ "id": 812, "service": "acs/cpe-sim", "action": "restart", "expiresAt": 1790000070000 }
```

**`POST /agent/v1/commands/:id/result`**

```json
{ "state": "done", "reason": null, "observed": "running" }
```

`state` is `done`, `failed` or `refused`. A result for an unknown, expired or finished command is answered 409 and ignored.

**Responses:** 200 or 204 on success; 400 invalid body; 401 bad, missing or revoked token; 403 request carried an `Origin` header; 409 command conflict; 413 too large (compressed or decompressed); 426 agent too old; 429 rate limited with `Retry-After`.

### 13.7 Counts

- `hosts`: one row per host (2 after enrollment).
- `services`: one row per compose service on agent hosts (about 9 on Ubuntu).
- Audit events: seven new names (3.1).
- Rules: four (8.2). Settings: five (10). Tables: `hosts`, `host_probes`, `metrics_probe`, `metrics_host_checks`, `agent_commands`.
