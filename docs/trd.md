# Technical Requirements Document: Self-Hosted Command Center

**Version:** v3, 2026-10-29 (replaces v2)
**Companion to:** `prd.md` v3
**Related:** `backend-schema.md` v3, `implementation-plan.md` v3, `plan-pm2-github-resend.md`, runbooks in `docs/`

v3 was written against the repository at `c00d968` (`main`). Sections 1 to 13 describe what is built, corrected where v2 was wrong. Section 14 is the approved multi-host design.

**Markers**

| Marker | Meaning |
|---|---|
| **[Built]** | In `main`, tests passing |
| **[Planned]** | Approved design, no code |
| **[Verify]** | To confirm on the real server; canonical list in `implementation-plan.md` 0.3 |
| **[Gap]** | Found in the v3 review; fix planned in phase 10.5 (H1 to H9) |

---

## 0. Status and Change Log

### 0.1 Component status

| Component (section) | Status | Notes |
|---|---|---|
| Stack (2) | Built | The backend runs as the Windows service `monitor-api` (O1, H9) |
| Collectors (4.1) | Built | Auto-archive guard counts the monitor itself [Gap H2] |
| State store (4.2) | Built | One slice per host since phase 11 M1 (14.6) |
| Log pipeline (4.3) | Built | Search range capped at `logs.retention_hours` (H3, fixed) |
| Nginx (4.4) | Built | Top paths and IPs removed (H4, fixed) |
| MongoDB (4.5) | Built | |
| Application agent (4.6) | Built | |
| API (4.7) | Built | |
| WebSocket (4.8) | Built | |
| Alert engine (4.9) | Built | 30 rules (`host.silent` from `010`) |
| Watchdog (4.10) | Built | One target |
| Frontend (4.11) | Built | |
| Deployment (10) | Built | Backups on `E:` (H7); offsite task and restore test [Verify] |
| Parts 0, A, B, C (13) | Built | Merged in `e31724b` |
| Multi-host (14) | M1 merged (PR #11) | Hosts, enrollment, `/agent/v1`, Hosts page, `host.silent`; M2 to M6 planned |

### 0.2 Test evidence (run on `main` for v3)

| Suite | Result |
|---|---|
| Backend (Vitest) | 364 passed, 22 files |
| Watchdog | 42 passed |
| Agent | 15 passed |
| Typecheck, all packages | Clean |
| Frontend Playwright | Not rerun (needs a browser build) |
| Integration helpers | `pm2:check`, `mongo:check`, `size:check`, `smoke:watchdog`, `demo` exist; not rerun |

Phase 11 M1 (patch 0016, merged as PR #11): 434 backend tests pass with Nginx 1.24 installed (without Nginx its five configuration tests are skipped); 42 watchdog, 15 agent; typecheck clean; `next build` and 25 Playwright tests pass. Migration check on a 164 MB database shaped like eight days of production data: `010` in 0.06 s, every row kept; on the production copy (V25): 0.61 s on 13.8 MB, every row kept. Patch 0017: the check is `apps/backend/scripts/migration-check.mjs` on Node's built-in `node:sqlite`, so it runs on the VPS with nothing installed. Patch 0019 (dependency bumps, 2026-10-30): typecheck clean; 437 backend with Nginx 1.24, 42 watchdog, 15 agent; `pnpm audit --prod` 7 advisories (zod and the pm2 chain, deferred: plan section 7). The frontend's dependencies did not change, so `next build` and Playwright were not rerun.

### 0.3 Change log

| Version | Date | Change |
|---|---|---|
| v1 | 2026-10-08 | Single Windows VPS, read-only, NSSM |
| v2 | 2026-10-29 | Recorded the build, Parts 0 to C, proposed multi-host |
| v3 | 2026-10-30 | Phase 11 M1 built: 14.3 and 14.6 as built, `host.silent` moved from M2 to M1 (14.13) |
| v3 | 2026-10-29 | Facts from the code: port 4111, migrations `008` and `009`, webhook status codes, 10-minute email buckets, git flags, action codes. Gaps from the review marked [Gap]. Multi-host redesigned: host namespaces for the agent, an allowlisting Docker proxy without inspect, Caddy field filtering, relay and Mongo over the compose network, persistent agent state, agent-pulled remote actions, fingerprints that leave host 1 unchanged, migrations `010` to `012` |

---

## 1. Scope

How the system in the PRD is built: technology, processes, collection, API, security, budgets, failure behavior, configuration, testing and deployment.

**Out of scope:** TOTP, alert channels other than email, GitHub write actions, any host action other than start, stop and restart, any command execution chosen by a user.

---

## 2. Technology Decisions

| Area | Choice | Status |
|---|---|---|
| Runtime | Node.js 22, TypeScript strict | Built |
| HTTP | Fastify 5, `@fastify/websocket`, `@fastify/rate-limit`, `@fastify/helmet`, `@fastify/cors`, `@fastify/cookie` | Built |
| Validation | Zod 3, shared in `@cc/shared` | Built |
| Database | `better-sqlite3` 13, WAL, `foreign_keys = ON` | Built |
| Host metrics (Windows) | Node for CPU and memory; fixed PowerShell scripts with timeouts for swap, network, disk sizes, pending reboot, disk I/O and Event Log (F1: `systeminformation`'s own PowerShell calls had no timeout and hung) | Built |
| Host metrics (Linux agent) | Direct reads of the host's `/proc` and `statfs` | Planned |
| PM2 | Programmatic API in a worker thread | Built |
| Docker (agent) | Docker Engine API over HTTP through `cc-docker-proxy` | Planned |
| MongoDB | Official driver, read-only user | Built |
| Email | Resend over `fetch`; webhooks verified with `svix` | Built |
| Passwords | `bcrypt` cost 12, fallback `bcryptjs` | Built |
| Own logs | `pino`, into the log pipeline as `_monitor` | Built |
| Frontend | Next.js 16 (16.4.3 or later, F3), React 19, uPlot | Built |
| Backend process manager | Windows service `monitor-api` (NSSM 2.24-101), outside PM2 (H9) | Built; in production since 2026-10-30 (see below) |
| Packages | pnpm 10 workspace | Built |

**Process manager.** v1 chose NSSM so a PM2 failure stays visible; production was first set up inside PM2, where the monitor died with the PM2 daemon (and with `pm2 kill` or `pm2 delete all`) and only the watchdog noticed. **Decision O1 (yes, 2026-10-30), H9:** the backend runs as the Windows service `monitor-api`, installed by `scripts/install-service.ps1` with NSSM under the account that owns PM2 and with `PM2_HOME` set, so it still reads the same PM2 daemon. The PM2 client only probes the daemon's socket and never starts a daemon of its own. NSSM restarts the app 5 s after an exit; Windows restarts NSSM itself on failure. A stop ends `node.exe` at once (`AppStopMethodSkip 7`), as a PM2 restart on Windows always did: NSSM's Ctrl+C stop left the service in `StopPending` for minutes on 2026-10-30 (F4). Output goes to `E:\monitor-service-logs\service.log`, rotated over 10 MB at start, not while running. `deploy.ps1` ends the service's processes itself if a stop takes over 30 s. `deploy.ps1` restarts the service when it exists and the PM2 process otherwise, and refuses when both exist. The switch on the server is `docs/runbook-service.md`.

---

## 3. Architecture

```
 Browser ──HTTPS+WSS──────────────────────────────┐
 Vercel: monitor.thediv.in (UI shell)              │
 Render: watchdog ── /health of each target        │
 Resend ── signed webhook ─┐  GitHub ◄─ read only │
┌──────────────────── Windows VPS (host 1) ───────┼──────────────────┐
│ Nginx 443 monitor-api.thediv.in ─► Backend 127.0.0.1:4111           │
│   /api/v1, /api/v1/ws, /health, /webhooks/resend, /agent/v1 (M1)    │
│ Backend (Windows service "monitor-api", H9)                          │
│   collectors: host, disk, system, disk I/O, Event Log, PM2, Nginx,   │
│               Mongo, TLS, GitHub, probes (M4)                        │
│   state store · log pipeline → E:\monitor-logs · alert engine →     │
│   Resend · SQLite (C:) · ingest 127.0.0.1:4001 · agent ingest (M1)   │
│ PM2: 9–10 services · MongoDB · GitHub runner                         │
└───────────────────────────────────▲──────────────────────────────────┘
                                    │ HTTPS, per-host token, outbound only
┌──────────────────── Ubuntu VPS (host 2, "ubuntu-acs") ───────────────┐
│ compose "cc-agent": cc-node-agent ──► cc-docker-proxy ──► docker.sock │
│   reads host /proc, mounts (ro), Caddy log (ro), backups (ro),       │
│   fail2ban and auth logs (ro); joins network "acs" for Mongo and the │
│   app relay                                                          │
│ compose "acs": Caddy, GenieACS, MongoDB 8, Express API, Next, cpe-sim│
└──────────────────────────────────────────────────────────────────────┘
```

### 3.1 Process model [Built]

- One backend Node process: API, WebSocket, scheduler, alert engine, webhook, ingest listener.
- The `@cc/agent` ingest listener is a separate HTTP server on `127.0.0.1:4001`.
- Worker threads: PM2 access, log search. gzip is streaming zlib on the main thread (README deviation).
- Child processes: PowerShell (Event Log, pending reboot, disk I/O) and `git`, each with a timeout and fixed arguments.
- SQLite: one writer, batched every 10 s. Migrations run at startup, one transaction per file, with `foreign_keys = ON`; a failing migration stops startup.
- Runs as the account that owns PM2; the deploy script's default `PM2_HOME` is `C:\Users\Administrator\.pm2` [Verify, O2].

### 3.2 Data flow

1. Collectors sample into the in-memory state.
2. The hub pushes a `live` snapshot every 2 s to subscribed browsers.
3. Every 10 s, aggregated rows go to SQLite in one transaction.
4. Alert rules evaluate in-memory state every 5 s.
5. PM2 bus lines go to a ring buffer and the file writer.
6. Resend posts signed events; counts are written synchronously in the request.
7. The GitHub collector runs every `github.poll_minutes`.
8. [Planned] Agents push to `/agent/v1/*`; their data enters the same state store, log pipeline, alert engine and history, keyed by host.
9. [Planned] Remote actions are queued in SQLite and fetched by the agent.

---

## 4. Components [Built]

### 4.1 Collectors

| Collector | Interval | Source |
|---|---|---|
| `host` | 2 s | CPU, memory, swap, network (loopback excluded). On Windows CPU and memory come from Node (`os.cpus`, `os.totalmem`, `os.freemem`) and swap and network from `swapnet`, so this collector starts no process (fix F1) |
| `swapnet` | 15 s | Windows only: one PowerShell script for page file usage and `Get-NetAdapterStatistics` byte counters; rates from the change between samples; killed after 20 s |
| `disk` | 10 s | `fsSize` (on Windows one PowerShell script on `Win32_LogicalDisk`, killed after 10 s, F1); Windows fixed drives; optical (`cdfs`, `udf`, `iso9660`, `cd9660`) and `DISK_EXCLUDE` skipped; at most 8 volumes |
| `system` | 60 s | Uptime; pending reboot by PowerShell registry check on Windows |
| `diskio`, `eventlog` | 10 s, 60 s | Windows only, PowerShell |
| `pm2` | 5 s | `pm2.list` in a worker |
| Nginx status, log | 5 s, tail | Loopback `stub_status`, JSON access log |
| `mongo` | 10 s | `serverStatus`, `replSetGetStatus`, `currentOp`, `ping`, `system.profile` |
| `tls` | 6 h | Handshake to `TLS_CHECK_HOSTS` and service public URLs |
| `agentsample` | 5 s | Merges `@cc/agent` reports |
| `github` | `github.poll_minutes` | Local git and GitHub REST |
| `persist`, `logguard`, `logmaint`, `rollup`, `retention`, `alerts` | 10 s, 60 s, 10 min, 1 h, 1 h, 5 s | Housekeeping on the same scheduler |

Each collector has its own interval, timeout and error isolation; data older than 3 intervals is shown as stale, and rules that depend on a stale collector are not evaluated.

**Discovery and archive.** Every PM2 process name is upserted into `services`. A service PM2 no longer lists is shown as stopped with 0 instances; after `pm2.auto_archive_minutes` (15) since `last_seen_at` it is archived, its incidents close, and `service_updated` is audited as `system`. The guard is "PM2 listed at least one process"; **[Gap H2]** `monitor-api` is always in that list, so the guard never trips while the monitor runs. Fix: count only processes other than the monitor itself.

### 4.2 State store

Latest values plus ring buffers (30 minutes at 2 s for the host, at 5 s per service). [Planned] Keyed by host from M1; host 1 keeps today's shapes.

### 4.3 Log pipeline

- PM2 bus `log:out` and `log:err`, one JSON line per chunk, 64 KB line limit.
- Files `LOG_ROOT\<pm2 name>\<YYYY-MM-DD>-<HH>.jsonl`, gzipped after the hour; hour chosen by receive time.
- Buffered writes (250 ms or 64 KB); ring buffer 5,000 lines per service (`logs.ring_buffer_lines`).
- Backpressure drops from the noisiest service and counts.
- Live tail: 250 ms batches, at most 200 lines.
- First sight of a service: the last ~150 lines of PM2's own files are shown, not stored.
- `LOG_REQUIRE_SEPARATE_VOLUME` (default on in production) refuses to write logs onto the database volume.
- Search: worker thread, newest first, `logs.search_max_results` (5,000), 30 s cap, one per user and four overall, regex guard, audited.
- **H3 (fixed):** `routes/logsearch.ts` accepts a range of at most `logs.retention_hours` (24), read on each request; the UI picker offers no more. It accepted 7 days before.

### 4.4 Nginx

`stub_status` on loopback (`NGINX_STATUS_URL` must be loopback). The runbook's access log format omits path, query, client address and headers:

```nginx
log_format monitor_json escape=json
  '{"t":"$time_iso8601","host":"$host","status":$status,"rt":$request_time,'
  '"urt":"$upstream_response_time","up":"$upstream_addr","bytes":$body_bytes_sent,"method":"$request_method"}';
```

The parser still reads optional `uri` and `ip`; nothing uses them. **H4 (fixed):** with the format above every request was counted under `/` in "top paths" and "top client IPs" stayed empty. Both lists and the `nginx.top_n` setting are removed from `NginxState`, the aggregator and the page, which now states that paths and addresses are not logged (privacy format kept). The tailer starts at the end of the file and follows rotation [Verify]. Attribution uses `services.nginx_match`.

### 4.5 MongoDB

Slow queries from `system.profile` in `MONGO_PROFILE_DBS`; shapes only. The monitor never changes profiler settings. `pnpm mongo:check` proves writes, drops, `killOp` and application reads are refused.

### 4.6 Application agent (`@cc/agent`)

`createMonitor({ token, service?, url?, tenantResolver? })`. The service name defaults to PM2's `name`; `url` defaults to `http://127.0.0.1:4001/ingest/v1/agent` and can point anywhere (used by the relay in 14.5). No runtime dependencies, never throws, never waits more than 1 s; `COMMAND_CENTER_AGENT=off` disables it. Ingest checks the token before reading the body, 256 KB limit, rejects unknown services.

### 4.7 API

All routes under `/api/v1` are JSON and session-authenticated; state-changing requests need `X-Monitor-Client: web` and an allowed `Origin`. Global rate limit 300 per minute per client IP; Fastify body limit 64 KB.

| Area | Routes |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password` |
| Users (admin) | `GET/POST /users`, `PATCH /users/:id` (includes `canOperate`), `POST /users/:id/reset-password`, `POST /users/:id/revoke-sessions` |
| Admin | `GET /audit`, `GET/PATCH /settings` |
| Live views | `GET /overview`, `GET /overview/summary` (alerts by severity, last backup, nearest certificate, GitHub, email; the page polls it every 30 s and when the open-alert count changes), `GET /host`, `GET /nginx`, `GET /mongo`, `GET /mongo/slow-queries`, `GET /events/windows`, `GET /limits` (longest history and log search ranges) |
| Services | `GET /services`, `GET /services/:id`, `PATCH /services/:id` (admin; includes git mapping), `POST /services/:id/actions` (operate, 20/min), `GET /services/:id/git`, `POST /services/:id/git/refresh` (admin, 10/min), `GET /services/:id/tenants`, `GET /services/:id/tenants/history` |
| History | `GET /history/host`, `/history/services/:id`, `/history/nginx`, `/history/mongo` (at most `retention.metrics_days`, H3) |
| Alerts | incidents, rules (admin edits), mutes (admin), own subscriptions, status, test email |
| Email | `GET /email/summary` |
| Logs | `POST /logs/search` |
| WebSocket | `GET /ws` |

Outside `/api/v1`: `GET /health`, `POST /webhooks/resend`, and from M1 `/agent/v1/*`.

### 4.8 WebSocket

One connection per tab, `Origin` required at upgrade (4403), session required (4401), rechecked every 60 s, at most 5 per user (4429), 1 MB messages. `live` every 2 s, `log_batch` every 250 ms, `event`, `warning`. Action results arrive as process `event` messages. [Planned] `subscribe` carries a host id, default 1.

### 4.9 Alert engine

5-second evaluation; durations; one incident per fingerprint (`<rule key>` or `<rule key>:<target>`, unique while firing); suppression (service down hides memory, app and 5xx alerts of that service; crash loop hides service down; critical disk hides warning disk on the same volume; critical certificate hides expiring); reminders every `alert.reminder_minutes` (60); resolved emails; mutes by time, service, category or rule; Resend with `Idempotency-Key` and 3 retries; outbox of every attempt. 29 rules (`backend-schema.md` section 8).

### 4.10 Watchdog

Standalone Render service. `TARGET_URL` must be HTTPS; `CRON_TOKEN` at least 32 characters, compared in constant time; 3 attempts 10 s apart with 8 s timeouts; one state machine in memory: down email, reminder after 60 minutes, recovery after 2 good checks, flaps within 30 minutes are the same outage. State is lost if Render restarts the service; the worst case is one repeated "down" email.

### 4.11 Frontend

Pages: login, change password, Overview, Host, Services, service detail (live, history, logs, code card, actions card), Nginx, MongoDB, Logs, Alerts (incidents, rules, mutes, subscriptions), Email, Users, Settings, Audit. `NEXT_PUBLIC_API_BASE` is the only setting; there is no `apps/frontend/.env.example` [Gap H1].

---

## 5. Security Controls

| Control | Specification | Status |
|---|---|---|
| Transport | HTTPS, HSTS, WSS through Nginx | Built |
| Cookie | `__Host-session`, Secure, HttpOnly, SameSite=Lax, no Domain; SHA-256 hash stored. `COOKIE_SECURE=false` is refused in production | Built |
| Sessions | 12 h absolute, 2 h idle, revocable | Built |
| CORS | Exact allowlist, credentials | Built |
| CSRF | `X-Monitor-Client: web` plus `Origin` on state-changing `/api/v1` requests | Built |
| Passwords | 12+ characters, common-password list, bcrypt 12 | Built |
| Login throttling | 5 failures per username lock 15 min; 20 per IP per 10 min | Built |
| Client IP | `X-Forwarded-For` trusted from `127.0.0.1` and `::1` only | Built |
| Headers | Helmet; CSP on the frontend | Built |
| Rate limits | Global 300/min; stricter on auth, search, `/health` (60/min), webhook (120/min), actions (20/min), git refresh (10/min) | Built |
| Validation | Zod, unknown fields rejected | Built |
| Secrets | Env only; startup log shows only whether each is set | Built |
| Ingest | `127.0.0.1` only, token, 256 KB | Built |
| Webhook | Raw body, `svix` verification (includes the 5-minute window), duplicate ids, counts only | Built |
| Actions | `operate` guard, server-side resolution, own process refused by name and PM2 id, modules refused, 409 busy, 429 cooldown, audited | Built |
| Git | `execFile`, no shell, fixed arguments, 10 s timeout, `GIT_TERMINAL_PROMPT=0`, `-c safe.directory=*`, `-c core.fsmonitor=false` (H5, fixed: a repository's own config could otherwise make `git status` start a program as the backend's account) | Built |
| Least privilege | Runs as the PM2 owner (Administrator by the deploy defaults) | [Verify, O2] |
| Branch protection | None; Parts 0 to C were pushed directly to `main` | [Gap H1] |
| Nginx `limit_req` | `/api/v1/auth/` on the server. H8: `/webhooks/` (120/min, burst 60, 256 KB bodies) and `/api/v1/logs/search` (6/min, burst 5, preflights not counted), JSON 429 with CORS headers; `runbook-nginx.md`, tested by `nginx-config.test.ts`. `/agent/` in M1 | [Verify] applied on the server |
| Agent ingest | Section 14.3 | Planned |
| Docker access | Section 14.4 | Planned |
| Remote actions | Section 14.7 | Planned |

**Accepted risk.** Password login is the only barrier on the public API, and behind it are raw logs and service actions, on two servers after M5. TOTP per action or Cloudflare Access is recommended before M5 is switched on (O3). If Cloudflare Access is used, `/health`, `/webhooks/resend` and `/agent/v1/*` are excluded from it.

---

## 6. Performance and Capacity

| Item | Target | Status |
|---|---|---|
| Services | 10 now, 50 without change | 9 or 10 |
| Backend memory | Under 500 MB | [Verify] one-hour idle run (a short container run showed about 110 MB) |
| Backend CPU | Under 10% of one core | [Verify] |
| Event loop lag | p95 under 50 ms | [Verify] |
| SQLite at 7 days | Under 2 GB | About 164 MB projected for 10 services and 20 tenants |
| Agent overhead | 25 µs per request | About 0.26 µs |
| Remote host budgets | Section 14.12 | Planned |

---

## 7. Failure Behavior

| Failure | Behavior | Status |
|---|---|---|
| Backend crash | NSSM restarts it after 5 s (PM2 did, before H9); watchdog emails if it stays down | Built |
| PM2 daemon dies | Monitor dies too; watchdog emails in 5 to 15 min (O1 removes this) | Built |
| Bad deploy | Backup, build, restart, health and stability checks, code rollback. Migrations are not rolled back; the backup path is printed | Built |
| A collector fails | Its data turns stale; its rules pause; `monitor.collector_stale` | Built |
| Resend down | Retries, outbox, `monitor.email_failing` on the dashboard | Built |
| GitHub token missing, rejected, repo not visible, unreachable | Card explains; last result kept | Built |
| Git missing or folder missing | "Cannot read the server's commit" with the reason | Built |
| Webhook secret unset | 503 | Built |
| Missing Svix headers | 400 | Built |
| Bad signature or old timestamp | 401, nothing stored | Built |
| Duplicate webhook | 200, not counted | Built |
| Webhook database write fails | 500, Resend retries | Built |
| PM2 unreachable or refusing during an action | 502, audited | Built |
| Action while another runs | 409 | Built |
| Action within 10 s of the last | 429 | Built |
| Action not confirmed by PM2 within 10 s | 200 with `verified: false`, audited | Built |
| Monitor restarted after a Stop | Start finds the stop mute in the database by service, rule and reason, and lifts it (H6, fixed) | Built |
| PM2 lists nothing | Auto-archive skipped | Built |
| Agent stops reporting | `host.silent` after 120 s; that host's data stale; its other alerts suppressed except probes | Planned |
| Monitor unreachable from an agent | Agent buffers up to 50 MB on disk, then drops oldest and counts | Planned |
| Remote action not fetched in 60 s | Expired, audited `service_action_failed` with `host_unreachable` | Planned |
| Agent refuses a command | Result `refused` with the reason, audited | Planned |

---

## 8. Monitoring the Monitor [Built]

The Host page shows the monitor's CPU, memory, event loop lag, queue depths, dropped lines, SQLite size and per-collector last success. Its logs go to `E:\monitor-logs\_monitor\`. The "Monitor health" card also shows how the backend was started (Windows service, PM2 or by hand, from `CC_SERVICE_NAME` and `pm_id`) and the deployed commit from `.deploy-sha` in the deploy folder, read again every 30 s (H9; before, the commit showed on `monitor-api`'s GitHub card, which goes away with its PM2 entry). [Planned] The Hosts page shows each agent's version, last contact, clock skew, buffer size, dropped lines and per-collector status.

---

## 9. Configuration

### 9.1 Backend environment [Built]

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` turns on the Secure cookie and the separate-volume check |
| `BIND_HOST` | `127.0.0.1` | |
| `PORT_API` | 4000 in code | **4111 in production** (deploy script health check) |
| `PORT_INGEST` | 4001 | Loopback ingest |
| `ALLOWED_ORIGINS` | required | `https://monitor.thediv.in` |
| `COOKIE_SECRET` | optional | Validated, unused |
| `COOKIE_SECURE` | follows `NODE_ENV` | |
| `SQLITE_PATH` | `C:\monitor\data\monitor.db` on Windows | Matches the deploy script default [Verify] |
| `LOG_ROOT` | `E:\monitor-logs` on Windows | [Verify] |
| `BACKUP_DIR` | `E:\monitor-backups` on Windows, off elsewhere | Nightly backups (H7); `off` switches the job off |
| `LOG_LEVEL` | `info` | |
| `LOG_REQUIRE_SEPARATE_VOLUME` | on in production | |
| `PM2_ENABLED`, `PM2_HOME` | `true`, PM2 default | |
| `RESEND_API_KEY`, `RESEND_API_URL`, `ALERT_FROM`, `PUBLIC_DASHBOARD_URL` | | Alert email |
| `GITHUB_TOKEN` | optional | Part A |
| `RESEND_WEBHOOK_SECRET` | optional | Part B |
| `DISK_EXCLUDE` | optional | Drive letters or mount points |
| `NGINX_STATUS_URL`, `NGINX_ACCESS_LOG`, `NGINX_ERROR_LOG`, `TLS_CHECK_HOSTS` | optional | |
| `MONGO_URI`, `MONGO_PROFILE_DBS` | optional | |
| `INGEST_TOKEN` | optional, 24+ characters | |
| `CC_ENV_FILE` | | Path to the env file (CLI tools; the Windows service sets it) |
| `CC_SERVICE_NAME` | | Set by `install-service.ps1`; shown as "Runs as" on the Host page |

The production env file is `C:\Apps\command-center-deploy\apps\backend\.env`; the deploy never overwrites it; after editing, `Restart-Service monitor-api` (under PM2: `pm2 restart monitor-api --update-env`). **[Gap H1]** `apps/backend/.env.example` was deleted in `e31724b`; restore it with every variable above (including `PORT_API=4111`) and the phase 11 additions.

### 9.2 Backend environment added in phase 11 [Planned]

None required. Agent ingest is on whenever at least one agent host exists; its limits are settings (`backend-schema.md` section 10). `PROBE_ENABLED` (default `true`) can switch the outside-in prober off.

### 9.3 Settings

Defaults live in code (`apps/backend/src/settings.ts`); admin edits are stored in `settings`. Includes `pm2.stale_hours` (24), still used for the "stale" flag on services. Phase 11 keys are listed in `backend-schema.md` section 10.

### 9.4 Watchdog

Today: `TARGET_URL`, `CRON_TOKEN`, `RESEND_API_KEY`, `ALERT_FROM`, `ALERT_TO`, optional timing overrides. [Planned] `TARGETS` (section 14.10); `TARGET_URL` still accepted as a single target.

### 9.5 Agent environment (Ubuntu) [Planned]

| Variable | Purpose |
|---|---|
| `CC_MONITOR_URL` | `https://monitor-api.thediv.in` |
| `CC_ENROLL_TOKEN` | One-time token, only for the first start |
| `CC_HOST_NAME` | `ubuntu-acs` |
| `CC_DOCKER_URL` | `http://cc-docker-proxy:2375` |
| `CC_PROJECTS` | Compose projects to watch and act on, e.g. `acs` |
| `CC_DISKS` | Mount points to report, default `/` |
| `CC_MONGO_URI` | Read-only user over the `acs` network |
| `CC_CADDY_LOG`, `CC_CADDY_HOSTS` | Access log file in the mounted folder; names to check certificates for |
| `CC_BACKUP_DIR` | Mounted backup folder |
| `CC_RELAY_TOKEN` | Token `@cc/agent` in the API uses for the relay (24+ characters) |
| `CC_ACTIONS` | `on` (default) or `off` |
| `CC_LOG_LINES_PER_S` | Default from the monitor; local override |

Secrets (`CC_ENROLL_TOKEN`, `CC_MONGO_URI`, `CC_RELAY_TOKEN`) live in an env file readable by root only. The host token is written by the agent to its state volume (14.3).

---

## 10. Deployment [Built]

| Part | Where | How |
|---|---|---|
| Backend | Windows VPS, Windows service `monitor-api` (H9, since 2026-10-30) | Push to `main` touching backend paths → CI on GitHub's Linux runner → `scripts/deploy.ps1` on the self-hosted runner |
| Frontend | Vercel | Git integration |
| Watchdog | Render | `apps/watchdog/render.yaml` |
| Agent images | GHCR | [Planned] CI job on `main` builds `cc-node-agent` and `cc-docker-proxy`, tagged by commit and `latest` |

`deploy.ps1`: preflight (tools, `.env`, the service's NSSM folder or the PM2 process's folder is the deploy folder) → `VACUUM INTO` backup to `E:\monitor-backups\deploy` (last 10 kept) → snapshot to `C:\Apps\command-center-deploy.prev` → robocopy → `pnpm install --frozen-lockfile` → build → stop and start `monitor-api` (processes ended after 30 s in `StopPending`; `pm2 restart` before the switch) → `/health` on port 4111 and a 10 s stability check (the PID of NSSM's `node.exe`, or PM2's restart count, must not change) → `.deploy-sha`. On failure: code rollback; database migrations are not undone.

**H7 (code done).** The backend's `backup` job (`src/backup.ts`, every 10 min) writes `BACKUP_DIR\monitor-YYYYMMDD.db` once a day after 02:30 server time: `VACUUM INTO` a `.partial` file, `PRAGMA quick_check` on the copy, rename, keep the newest `backup.keep` (14). A failure throws, is retried on the next run and after three makes the job stale (`monitor.collector_stale`, target `backup`); before 02:30 a missing file for yesterday is also a failure. `VACUUM INTO` is synchronous and holds the database for the copy (seconds at the projected size). Offsite: `scripts/backup-offsite.ps1` copies the newest file to an rclone (crypt) remote and prunes remote copies older than 30 days, run by a scheduled task the monitor does not watch. Restore test on a copy: `scripts/check-backup.ps1`. Runbook: `runbook-backups.md`. Nightly files written since 2026-10-29; V19's local part passed 2026-10-30. [Verify] offsite task and the offsite half of V19.

**[Gap H1]** No branch protection: `e31724b` was pushed directly to `main` and deployed without a pull request. Required: protect `main` (pull request, passing CI).

Nginx: `monitor-api.thediv.in` → `127.0.0.1:4111` with WebSocket upgrade headers, long read timeout, `limit_req` on `/api/v1/auth/`. Phase 11 adds `/agent/` with `client_max_body_size 2m`, its own `limit_req` zone, and a read timeout above 30 s for the command long-poll.

---

## 11. Testing

| Level | Coverage | Status |
|---|---|---|
| Unit and integration | 364 backend tests: auth, sessions, CSRF, WebSocket, collectors, PM2 (fake and real), logs, search, alerts, mail, Nginx, Mongo, agent ingest, rollup, history, GitHub, email, actions | Built |
| Watchdog | 42 tests plus smoke run | Built |
| Agent package | 15 tests plus overhead bench | Built |
| Browser | Playwright against the demo server | Built |
| Audit fixes | One test per H item (archive guard with `monitor-api` listed, range caps, Nginx state without top lists, git arguments, mute after restart, nightly backup) | Built for H2 to H7 |
| Multi-host | Migration `010` on a copy of the production database; enrollment, revocation, limits, gzip bomb, `Origin` refusal; agent against a fake Docker API and a fixture `/proc`; proxy allowlist (every forbidden path returns 403); command expiry, refusal and replay; two hosts in `pnpm demo`; Playwright with two hosts | Planned |
| On-host | `implementation-plan.md` 0.3 | Open |

---

## 12. Items to Verify

The canonical list with owners and status is `implementation-plan.md` section 0.3. Resolved by the v3 review: git "unsafe" folders (handled by `safe.directory=*`), the email rule key (`monitor.email_bounce_spike`), how a stop mute ends (the row is deleted), whether settings are seeded (no, defaults in code), whether `pm2.stale_hours` is still read (yes), whether `NginxState` still has the top lists (it did; removed by H4).

---

## 13. Parts 0, A, B, C [Built]

### 13.1 Part 0

Auto-archive (4.1). `selectDisks` in `collectors/host.ts` skips optical file systems on every platform and `DISK_EXCLUDE` entries; incidents on a volume that is no longer reported resolve.

### 13.2 Part A: GitHub

Local: `git -c safe.directory=* -C <dir> rev-parse HEAD`, `symbolic-ref --short -q HEAD`, `status --porcelain --untracked-files=no`; or `.deploy-sha` when the folder has no `.git`. Remote, with ETags: branch, compare, workflow runs, open pulls. States: in sync, behind, ahead, diverged, dirty, not on GitHub, unknown. Stored in `service_git` as JSON. Mapping changes audited as `service_updated`.

### 13.3 Part B: Resend

`POST /webhooks/resend` in its own Fastify scope that keeps the raw body. Counted events: sent, delivered, delivery_delayed, bounced (permanent, transient, undetermined), complained, failed, suppressed; others acknowledged and ignored. Each delivery id and its count are written in one transaction. 10-minute buckets per sender domain. Retention: counts and ids after `retention.email_days`.

### 13.4 Part C: PM2 actions

Order of checks: session → `operate` → service exists and not archived → PM2 on → not busy (409) → cooldown 10 s (429) → PM2 list (502 if unreachable) → listed, not a module, not the monitor (409 `not_operable`) → state check (`already_running`, `not_stopped`, `already_stopped`) → `restart` or `stop` per instance → wait up to 10 s for the new state → mute or unmute → audit. Start uses `restart` on the stopped instances only [Verify that this starts a stopped process on the server].

---

## 14. Multi-Host Monitoring [Planned]

Requirements: PRD 16. Data: `backend-schema.md` 13. Order: `implementation-plan.md` phase 11.

### 14.1 Principles

1. One monitor, on the Windows VPS.
2. Outbound only: agents connect to the monitor; the monitor never connects into a host; monitored hosts open no inbound port.
3. Two images, no repository on monitored hosts.
4. Same pipelines after ingest: state store, log pipeline, alert engine, history.
5. Host 1 unchanged: local collectors, log paths and alert fingerprints stay as they are.
6. Least access on the host: the agent reads only what it reports, and the Docker API only through an allowlist.

### 14.2 Components on the Ubuntu host

Compose project `cc-agent` (illustrative; names of the `acs` network, Mongo service and folders are confirmed at M2 [Verify]):

```yaml
services:
  cc-docker-proxy:
    image: ghcr.io/administrator-cpu/cc-docker-proxy:<tag>
    volumes: [ "/var/run/docker.sock:/var/run/docker.sock:ro" ]
    environment: [ "ALLOW_ACTIONS=1" ]          # 0 removes the three POST routes
    networks: [ cc-internal ]
    read_only: true
    restart: unless-stopped
  cc-node-agent:
    image: ghcr.io/administrator-cpu/cc-node-agent:<tag>
    user: "10001:10001"
    group_add: [ "4" ]                          # adm: read auth.log and fail2ban.log
    pid: host                                   # host /proc/1/net/dev for network counters
    read_only: true
    cap_drop: [ ALL ]
    security_opt: [ "no-new-privileges:true" ]
    env_file: /etc/cc-agent/agent.env           # mode 600, root
    volumes:
      - /:/host:ro,rslave                       # statfs of mounts, nothing written
      - /run:/host-run:ro                       # reboot-required
      - /var/log:/host-log:ro                   # auth.log, fail2ban.log
      - acs_caddy_logs:/caddy-logs:ro
      - /var/backups/acs:/backups:ro
      - cc-agent-state:/var/lib/cc-agent        # host token, log buffer (the only writable path)
    networks: [ cc-internal, acs ]
    restart: unless-stopped
networks:
  cc-internal: { internal: true }
  acs: { external: true, name: acs_default }       # checked (V20)
volumes:
  cc-agent-state: {}
  acs_caddy_logs: { external: true }
```

- The agent is never on the host network and never mounts the Docker socket.
- `cc-internal` is internal, so the proxy cannot reach the internet and only the agent can reach the proxy.
- The relay listens on the agent's address in the `acs` network (port 4002). Nothing is published on the host.

### 14.3 Agent ingest API (on the monitor)

Public, outside `/api/v1`, on the existing Fastify server, in its own scope: no cookies read, no CORS, requests with an `Origin` header refused (403), Zod schemas with unknown fields rejected.

| Method and path | Purpose | Limits |
|---|---|---|
| `POST /agent/v1/enroll` | Enrollment token → host token | 10/min per IP |
| `POST /agent/v1/metrics` | Snapshot every 10 s | 512 KB decompressed |
| `POST /agent/v1/logs` | Log batches, every 1 s or 256 KB | 4 MB decompressed |
| `POST /agent/v1/events` | Container events as they happen | 256 KB |
| `POST /agent/v1/app` | Relayed `@cc/agent` reports | 256 KB |
| `POST /agent/v1/commands/next` | Long-poll for one action, held up to 25 s | 1 open poll per host |
| `POST /agent/v1/commands/:id/result` | Result of an action | 16 KB |

- Request bodies may be gzip; the decompressed size is enforced while inflating, so a small compressed body cannot expand past the limit.
- The route scope overrides Fastify's 64 KB body limit.
- Per-host limit 600 requests per minute; global limit across hosts; Nginx `limit_req` in front.
- `X-Agent-Version` below `agent.min_version` → 426, audited `agent_version_rejected`.
- Agent timestamps more than 5 minutes off are replaced by arrival time and the host is marked `clock_skew`.

**Authentication.**
- An admin creates a host; the backend returns a 32-byte random enrollment token once and stores its SHA-256 hash with a 1-hour expiry.
- `enroll` exchanges it (single use) for a 32-byte host token; only its hash is stored. The response is the only time the token is sent.
- Every other request: `Authorization: Bearer <host token>`; the host is taken from the token, never from the body; lookup by hash.
- Revocation clears the hash: 401 for data and for command polls. The agent backs off to one attempt per 10 minutes after a 401.
- Rotation: the admin issues a new enrollment token; the owner sets it in the env file and restarts the agent, which re-enrolls and replaces the hash.
- The agent writes the host token to `/var/lib/cc-agent/token` (mode 600) on its state volume and deletes nothing else on the host.

Audit: `host_created`, `host_updated`, `host_enrolled`, `host_token_rotated`, `host_revoked`, `agent_version_rejected`; remote actions add `service_action_requested` (14.7).

**As built (M1).** `apps/backend/src/hosts/ingest.ts` and `src/hosts/repo.ts`; Hosts admin API under `/api/v1/hosts` (`src/routes/hosts.ts`). The checks run in this order: `Origin` (403), declared `Content-Length` above the endpoint limit (413), token (401), `X-Agent-Version` (400 when missing, 426 below `hosts.min_agent_version`), rate (429); then the body is read with the limit applied to the compressed bytes and again while inflating. Tokens are 32 random bytes in base64url; lookups use the SHA-256 hash, kept in memory. A host's `last_seen_at` is exact in memory and written at most once a minute. Metrics are stored at arrival time (backend-schema.md 13.6). Nginx removes the `Cookie` header on `/agent/` (`runbook-nginx.md`).

### 14.4 Docker access through `cc-docker-proxy`

A small HAProxy image built in this repository, with a fixed allowlist. Anything not listed returns 403.

| Method | Path | Used for |
|---|---|---|
| GET | `/_ping`, `/version` | Health |
| GET | `/containers/json` | List with labels, state, status text (health) |
| GET | `/containers/{id}/stats?stream=false` | CPU and memory |
| GET | `/containers/{id}/logs` | Log stream |
| GET | `/events` | start, stop, die, oom, restart, health_status |
| POST | `/containers/{id}/start`, `/stop`, `/restart` | Actions, only when `ALLOW_ACTIONS=1` |

Not allowed, among others: inspect (`/containers/{id}/json`, which returns every environment variable), `archive`, `export`, `exec`, `attach`, `create`, `kill`, `update`, any `DELETE`, images, volumes, networks, build, swarm, secrets. Inspect is not needed: the list gives labels and health, and restarts are counted from events.

Tests in CI start the proxy against a fake Docker socket and assert 403 on every forbidden path.

### 14.5 Collection on the Ubuntu host

| Area | Method | Interval |
|---|---|---|
| CPU, memory, swap, uptime, disk I/O | `/proc/stat`, `/proc/meminfo`, `/proc/uptime`, `/proc/diskstats` (host-wide inside any container) | 2 s sample, 10 s push |
| Network | `/proc/1/net/dev` with `pid: host` (host network namespace), excluding `lo`, `docker0`, `br-*`, `veth*`. Checked (V21, 2026-10-30): readable by a non-root container; on `acs-prod` that leaves `ens3` | 2 s |
| Disk usage | `statfs` on `/host<mount>` for each mount in `CC_DISKS` | 10 s |
| Pending reboot | Exists `/host-run/reboot-required` | 60 s |
| Containers | Proxy list and stats, for projects in `CC_PROJECTS` and the agent's own project | 10 s |
| Container events | Proxy event stream; restarts counted per container | continuous |
| Logs | Proxy `logs?follow=1&stdout=1&stderr=1&timestamps=1` per container | continuous |
| MongoDB | The phase 7 collector code, reused; `CC_MONGO_URI` over the `acs` network | 10 s |
| Caddy traffic | Tail the JSON access log; keep only `ts`, `request.host`, `request.method`, `status`, `duration`, `size`; everything else discarded on read | continuous, aggregated per 10 s |
| Certificates | TLS handshake to the Caddy container on 443 with SNI for each name in `CC_CADDY_HOSTS` (avoids NAT hairpin) | 6 h |
| App relay | HTTP listener on the `acs` network, port 4002, token `CC_RELAY_TOKEN`; forwards to `/agent/v1/app` | as received |
| Backups | Newest file time and size in `/backups`; mtime of `/backups/.offsite-ok` | 5 min |
| fail2ban | Count "Ban" and "Unban" lines per jail in `/host-log/fail2ban.log` | 60 s |
| SSH failures | Count "Failed password" and "Invalid user" lines in `/host-log/auth.log` | 60 s |

Client addresses read from `auth.log` and `fail2ban.log` are never stored or sent; only counts.

**Service identity.** A container belongs to service `<compose service>` in project `<compose project>`; its key is `<project>/<service>` (e.g. `acs/genieacs-cwmp`), its display name the compose service. Scaled replicas are instances of one service, like PM2 cluster instances. Discovery and auto-archive follow 4.1 using the container list; a stopped container is still listed. Containers without compose labels are ignored.

**Logs.** 200 lines per second per container by default (`agent.log_lines_per_s`), with dropped counts; containers excluded in the UI are not followed. Lines longer than 64 KB are cut. While the monitor is unreachable, batches go to a 50 MB ring on the state volume; the oldest are dropped and counted when it is full.

**Caddy stdout.** Caddy must write access logs to the file, not to stdout (PRD O6). The agent also drops any line from the Caddy container's log stream that parses as a Caddy access record, as a second safeguard.

### 14.6 Monitor side: hosts in the backend

- [Built, M1] `ServicesRepo` keys services by `(host_id, source_key)` instead of PM2 name; `source_key` is the PM2 name on host 1 and `<project>/<service>` on agent hosts. `list()` and `getByPm2Name()` mean host 1 unless another host or `'all'` is asked for, so the PM2, Nginx, GitHub and log-folder code is unchanged.
- [Built, M1] The state store holds a `HostSlice` per host (`Map<hostId, HostSlice>`); host 1's slice is fed by the local collectors, an agent host's by its metrics. Processes are tagged with their host; `setProcesses` replaces one host's list only. Nginx, Mongo, TLS and Event Log state stay host 1 until M4.
- Log folders: host 1 unchanged; other hosts under `LOG_ROOT\@<host name>\<project>.<service>\`.
- `live` snapshots carry a host list plus the detail of the subscribed host, staying under 50 KB.
- [Built, M1] Rollup groups by host where the table has `host_id`; persistence writes `metrics_host` and `metrics_disk` per host; `GET /history/host?host=<id>` reads one host (host 1 by default).

### 14.7 Remote actions

Flow:

1. `POST /api/v1/services/:id/actions` with `start`, `stop` or `restart`. For a `pm2` service on host 1, Part C runs as today.
2. For a `container` service: same guard, busy and cooldown checks; refused if the host is revoked, silent, or reports `actions: off`. Otherwise a row in `agent_commands` (state `queued`, expires in 60 s) and a 202 with the command id. Audited `service_action_requested`.
3. The agent holds `POST /agent/v1/commands/next`; the monitor answers at once if a command is queued for that host, otherwise after 25 s with 204. Delivery sets the state to `sent`.
4. The agent checks: not expired; the container key is listed now; its project is in `CC_PROJECTS`; it is not the agent or the proxy; it has no `cc.actions=off` label; `CC_ACTIONS` is on. Then it calls the proxy and waits up to 20 s for the new state.
5. `POST /agent/v1/commands/:id/result` with `done`, `failed` or `refused`, the reason and the observed state. The monitor audits `service_action` or `service_action_failed`, applies the Stop mute, and pushes an `event` to browsers.
6. The browser polls `GET /api/v1/commands/:id` (or receives the event) and shows the outcome.

Rules:
- A command id is used once; a second result for it is ignored.
- A command still `queued` or `sent` at its expiry becomes `expired`, audited with `host_unreachable`.
- The command carries only the container key and the action. No command text, image, argument or path ever reaches the host.
- Only one open command per service.

### 14.8 Alerts

- **Fingerprints.** Service-scoped targets use the service id, which is unique across hosts, so they do not change. Host-scoped targets (volumes, certificates, Mongo, collectors, backups, probes) on hosts other than 1 are prefixed `@<host id>/`, for example `host.disk_high:@2//`. Host 1 fingerprints stay exactly as today, so no rewrite is needed and open incidents stay open.
- `alert_incidents.host_id` is filled for filtering and grouping.
- Service rules (`pm2.*`) apply to containers: down = not running; crash loop = restarts counted from events in 10 minutes; memory from stats. The category name stays `pm2`.
- Host, Mongo and certificate rules apply per host; `nginx.5xx_rate` applies to Caddy traffic per service.
- New rules (all in existing categories, no CHECK rebuild): `host.silent`, `host.probe_failed`, `monitor.backup_stale`, `host.auth_failures_high` (`backend-schema.md` section 8).
- Grouping: `host.silent` suppresses every other incident with the same `host_id` except `host.probe_failed`. A failing probe while the agent reports points at the network, NAT or gateway.
- `host.pending_reboot` uses `/run/reboot-required` on Linux.
- Emails and the incident list name the host.

### 14.9 Outside-in probes

A collector on the Windows backend, per host, configured on the Hosts page:
- TCP connect to `acs.thediv.in` on 7547, 443 and 80; 5 s timeout; every 60 s.
- HTTPS GET to the Ubuntu API health URL (O4), expecting 200.
- Results stored in `metrics_probe`; three consecutive failures of one target raise `host.probe_failed` for that target.

### 14.10 Watchdog

`TARGETS` is a JSON list, e.g. `[{"name":"monitor","url":"https://monitor-api.thediv.in/health"},{"name":"ubuntu-acs","url":"https://tr069-api.thediv.in/<path>"}]`. Each target gets its own state machine and three-email limit; all are checked in parallel on each ping. `TARGET_URL` alone still works. Tests cover two targets failing independently.

### 14.11 Security of the agent

- Non-root user, read-only root filesystem, no capabilities, `no-new-privileges`; one writable volume.
- All host mounts read-only; only the paths in 14.2.
- Docker only through the proxy allowlist (14.4).
- Outbound: HTTPS to `monitor-api.thediv.in`; GHCR for pulls (by Docker, not the agent).
- Mongo user with `clusterMonitor` (plus `system.profile` read only if wanted).
- The relay accepts only the relay token and only on the internal network.
- Secrets in a root-only env file; the host token on the state volume, mode 600.
- Images pinned by digest in the compose file once stable; updated by the owner, never automatically.

### 14.12 Budgets for the first remote host

| Item | Target |
|---|---|
| Agent CPU | Under 3% of one vCPU |
| Agent memory | Under 150 MB plus the 50 MB disk buffer |
| Proxy | Under 20 MB |
| Network to the monitor | Metrics under 10 KB per 10 s; logs compressed |
| Extra backend load per host | Under 2% CPU, 50 MB |
| Delay | Metrics under 15 s, logs under 5 s, events under 2 s, actions under 30 s |
| `E:` worst case | 9 containers at the 200 lines/s cap and 200 bytes per line is about 360 KB/s, 1.3 GB per hour before gzip. With 24 h retention and gzip (about 10x) this is about 3 GB per day. Measure the real GenieACS rate in M3 |

### 14.13 Build steps

| Step | Scope | Main tests |
|---|---|---|
| M1 (merged, deployed, V26 passed) | Migration `010`; host-aware `ServicesRepo`, state store and fingerprints; enrollment and tokens; `/agent/v1/*` except commands; Hosts admin page; Nginx `/agent/`; `host.silent` | Migration on a production copy (V25); existing tests pass; token, revocation, limits, gzip bomb, `Origin` |
| M2 | `apps/node-agent` and `cc-docker-proxy`; host metrics and host rules on agent hosts; containers and events; GHCR build; compose snippet; minimal host switcher | Fixture `/proc`, fake Docker API, proxy allowlist, two hosts in `pnpm demo` |
| M3 | Log shipping, buffer, per-host search and tail, exclusions | Burst and drop counts, outage buffer |
| M4 | Migration `011`; Mongo, Caddy filter, relay, backups, fail2ban and SSH counts, probes, watchdog `TARGETS` | Each collector against fixtures; no path or IP survives the Caddy filter |
| M5 | Migration `012`; remote actions end to end | Expiry, refusal, own-container refusal, single use, permission, audit |
| M6 | Host switcher everywhere, Hosts overview, per-host rule overrides, host in emails | Playwright with two hosts |

### 14.14 Open questions

1. O4 (health path), O5 (backup folder and offsite marker), O6 (Caddy log to file).
2. The exact `acs` network name, Mongo service name and container list (M2).
3. Whether the Ubuntu Mongo profiler is wanted (`genieacs`, application database).
4. O1 before M1.
