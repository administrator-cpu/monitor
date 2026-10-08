# Command Center

Self-hosted dashboard for a Windows VPS and the MERN services on it. This repository currently contains **Phases 1 to 9** of the implementation plan, built as a TypeScript pnpm monorepo.

| Phase | Status | Where |
|---|---|---|
| 1. Backend core | built, tested | `apps/backend` |
| 2. Frontend | built, tested | `apps/frontend` |
| 3. PM2 and logs | built, tested | `apps/backend/src/pm2`, `src/logs`, migration `002_pm2` |
| 4. Alert engine and email | built, tested | `apps/backend/src/alerts`, migration `003_alerts` |
| 5. Render watchdog | built, tested | `apps/watchdog` (standalone, shares no code) |
| `packages/shared` | built | Zod schemas and types shared by all |
| 6. Nginx | built, tested | `src/nginx`, migration `004_nginx` |
| 7. MongoDB | built, tested | `src/mongo`, migration `005_mongo` |
| 8. Agent and application layer | built, tested | `packages/agent`, `src/agent`, migration `006_agent` |
| 9. History, search, correlation | built, tested | `src/rollup.ts`, `src/history.ts`, `src/logs/search*.ts`, migration `007_events` |
| 10. Actions | not started | see `implementation-plan.md` |

Read-only by design: there is no route that starts, stops or restarts anything, and none will exist until phase 10 (TOTP).

## What works now

- **Accounts and login.** `create-admin` command (no default credentials), bcrypt cost 12, sessions stored as SHA-256 hashes in SQLite (they survive restarts), absolute (12 h) and idle (2 h) expiry, per-username lockout (5 failures, 15 min) and per-IP throttle (20 / 10 min), unknown usernames behave identically to wrong passwords, audit log of every login, failure, lockout and logout.
- **Admin.** Create, edit, disable users, reset passwords (forces a change and clears a lockout), revoke sessions, view the audit log, edit numeric settings. Disabling a user closes their live WebSocket immediately.
- **Hardening.** Origin allowlist on every API request and on the WebSocket upgrade, custom CSRF header on state-changing requests, exact-origin CORS with credentials, helmet, global and per-route rate limits, strict Zod validation (unknown fields rejected), `__Host-session` Secure/HttpOnly/SameSite=Lax cookie in production, `X-Forwarded-For` honoured only from localhost.
- **Live host metrics.** CPU (overall and per core), RAM, swap, network, disk usage, uptime, pending-reboot (Windows), collected by an isolated scheduler (own interval, timeout, staleness per collector) into an in-memory state store with a 30-minute ring buffer, and pushed over one shared WebSocket every 2 s.
- **UI.** Login, forced password change, Overview (host strip, disks, collectors), Host (30-minute CPU, memory and network charts seeded from the backend so a reload is never empty, per-core bars, monitor-health panel), Users, Audit log. Light and dark, phone width and up. A dropped connection is shown as such (values hidden rather than frozen) and recovers by itself.
- **PM2 and logs (phase 3).** Services are discovered from PM2, with CPU, memory, restarts and uptime; a crash or restart becomes an event. Logs are captured from the PM2 bus into a ring buffer, hourly gzipped files on the log volume (with a guard for a missing or shared volume), and a live tail over WebSocket (250 ms batches, dropped-line counts, audited). Host disk I/O rates on Windows.
- **Alerts (phase 4).** A 5 s engine with 17 working rules, durations, resolve hysteresis, suppression of symptoms behind a cause, mutes, reminders, per-category subscriptions, and email through Resend with retries and an outbox of every attempt. Admins edit rules and send a test email to themselves.
- **Nginx, MongoDB, application (phases 6 to 8).** Gateway traffic from a JSON access log and `stub_status`, TLS expiry, read-only MongoDB health and slow-query shapes, and an in-app agent (event-loop lag, latency, sockets, active users, per-tenant load). All 28 alert rules are now working.
- **History and search (phase 9).** Hourly rollup and retention, history charts with incident markers on every page, log search across days, Windows Event Log.
- **Watchdog (phase 5).** See `apps/watchdog/README.md`.
- `GET /health` for the watchdog: shallow, unauthenticated, rate limited, returns only `{"status":"ok"}`.

## Quick start (development)

Requires Node 22+ and pnpm 10.

```bash
pnpm install

# Backend
cp apps/backend/.env.example apps/backend/.env       # edit if needed
pnpm build:shared
pnpm --filter @cc/backend create-admin               # prompts for a password (hidden)
pnpm dev:backend                                     # http://localhost:4000

# Frontend (second terminal)
cp apps/frontend/.env.example apps/frontend/.env.local
pnpm dev:frontend                                    # http://localhost:3000
```

Sign in at http://localhost:3000 with the account you just created.

Scripted admin creation: `CC_ADMIN_PASSWORD='...' pnpm --filter @cc/backend create-admin -- --username owner --email me@example.com --name "Owner"`.

## Commands

| Command | Does |
|---|---|
| `pnpm typecheck` | Type-checks shared, backend and frontend |
| `pnpm test` | Agent, backend and watchdog tests (Vitest) |
| `pnpm demo` | Backend with pretend Nginx, MongoDB and an agent |
| `pnpm mongo:check` / `agent:bench` / `size:check` | Read-only proof, agent overhead, storage estimate |
| `pnpm smoke:watchdog` | Real watchdog process against a fake target and mock Resend |
| `pnpm pm2:check` | Backend PM2 integration against a real, throw-away PM2 daemon |
| `pnpm build` | Builds all packages |
| `pnpm --filter @cc/frontend e2e` | Playwright smoke tests (see below) |
| `pnpm format` | Prettier |

### Browser tests

Build the UI against the test API first, then run Playwright. It starts a throwaway backend (temporary database, one admin, real collectors) and `next start` by itself.

```bash
cd apps/frontend
NEXT_PUBLIC_API_BASE=http://127.0.0.1:4100 pnpm build
npx playwright install chromium            # or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
pnpm e2e
```

## Configuration

Backend (`apps/backend/.env.example`): `ALLOWED_ORIGINS` (required, exact origins), `PORT_API`, `BIND_HOST`, `SQLITE_PATH`, `LOG_ROOT`, `COOKIE_SECURE`, `LOG_LEVEL`, `CC_ENV_FILE` (point the service at an env file outside the repository). Invalid configuration stops startup and names the variable, never its value. Defaults on Windows are `C:\monitor\data\monitor.db` and `E:\monitor-logs`.

Phases 3 and 4 add: `PM2_HOME` (optional), `LOG_REQUIRE_SEPARATE_VOLUME` (default true: refuse to log onto the system volume), `RESEND_API_KEY`, `RESEND_API_URL` (testing), `ALERT_FROM`, `PUBLIC_DASHBOARD_URL`. Without a Resend key the engine still runs and the dashboard shows alerts, but nothing is emailed and the outbox stays empty. Watchdog variables are in `apps/watchdog/README.md`.

Phases 6 to 8 add (all optional): `NGINX_STATUS_URL`, `NGINX_ACCESS_LOG`, `NGINX_ERROR_LOG`, `TLS_CHECK_HOSTS`, `MONGO_URI`, `MONGO_PROFILE_DBS`, `INGEST_TOKEN` (24+ characters) and `PORT_INGEST` (default 4001, loopback only). See `docs/runbook-phase6-9.md`.

Frontend: `NEXT_PUBLIC_API_BASE` only. It is not a secret.

Tunables (session lifetimes, lockout, retention numbers) are in the `settings` table, editable by admins through `PATCH /api/v1/settings`; defaults live in `apps/backend/src/settings.ts`.

`NODE_ENV=production` turns on the Secure `__Host-session` cookie and refuses to start with `COOKIE_SECURE=false`, so use it once HTTPS is in place. Until then (localhost only, per the plan) use `NODE_ENV=development`.

## Deploying to the VPS

See `docs/runbook-phase6-9.md` for Nginx, MongoDB, the agent and log search, `docs/runbook-phase3-5.md` for PM2, log volume, Resend and the watchdog, and `docs/runbook-phase1.md`: build, env file, `create-admin`, Windows service with NSSM (`scripts/install-service.ps1`), Nginx block, the on-host verification checklist and the demo script.

## Verification status

Run in a Linux container, all passing:

- **173 backend tests** (the list below describes phase 1; phases 3 and 4 add PM2, log pipeline, alert engine, mail, API and WebSocket log tests), **42 watchdog tests**, a watchdog smoke run, and a 20-check PM2 integration against a real daemon. **16 browser tests** pass in total. Phase 1 detail: 72 tests: lockout and per-IP throttle, parallel-guess race, unknown-user parity, Origin/CSRF/CORS rejection, cookie flags, absolute and idle session expiry, session survival across a backend restart (new app on the same database file), role checks, last-admin and self-lockout guards, password policy, settings validation, migrations (idempotent, rollback on failure), scheduler (isolation, timeout, no overlap, staleness), WebSocket close codes 4401 / 4403 / 4429, 60 s session re-check, host collectors.
- **9 browser tests (Chromium)**: login and logout, wrong password, live updates and charts that keep growing, charts populated after reload, admin creating an engineer who is forced to change password and sees no admin pages, an admin disabling a user ends that user's live session, WebSocket drop and automatic recovery, API unreachable then retry, 375 px viewport with no horizontal scroll.
- A real backend process run with real `systeminformation` collectors, the `create-admin` CLI, login over HTTP, and a live WebSocket feed.

**Not verified here, needs the actual VPS** (these are the plan's **[Verify]** items):

- `better-sqlite3` and `bcrypt` loading on Windows. Both ship a `win32-x64` prebuild, so no compiler should be needed, but it has not been run on Windows. `bcryptjs` is the automatic fallback.
- `systeminformation` on that Windows version (CPU, memory, network, `fsSize` for `C:` and `E:`) and the PowerShell pending-reboot check. Per-disk I/O is not collected yet (phase 3), so disks report `null` read/write rates.
- NSSM service install and restart behaviour, running under the low-privilege account.
- The one-hour idle run against the TRD budget (under 500 MB, under 10 % of one core, event loop lag p95 under 50 ms). A short run here showed about 110 MB RSS and p95 lag around 20 ms on a 2-core container, which is encouraging but not that test.
- HTTPS, WSS through Nginx, Vercel deployment and cross-subdomain cookie behaviour.

## Deviations from the documents

Recorded as the plan asks.

- **Migration `001` only.** Phase 1 adds just the tables the plan assigns to it. Host metrics are not persisted yet: that arrives with `002_pm2` and the batched writer in phase 3.
- **Setting defaults live in code** rather than being seeded by a migration (the seed is specified for `003_alerts`). Only numeric keys are editable now; string and list keys (`alert.from`, `tls.hosts`, ...) arrive with the phases that use them.
- **`COOKIE_SECRET` is optional and unused.** It is validated if present and reserved for signed cookies or CSRF tokens in a later phase. Sessions use random 256-bit tokens and CSRF uses the header plus Origin check specified in the TRD.
- **WebSocket log channel** is accepted by the schema and answers `logs_unavailable` until phase 3.
- **WebSocket Origin is mandatory.** A socket upgrade without an `Origin` header is closed with 4403 (browsers always send one).
- **Dependency choices.** Zod 3 (not 4), `better-sqlite3` 13, Next.js 16 / React 19, pnpm 10. ESLint is not configured yet (Prettier and strict TypeScript are).
- **`HostState.updatedAt`** is the time of the live CPU/memory sample; staleness of disks and uptime is reported per collector.
- **`DiskState.readBps` / `writeBps`** are `number | null` (null = not measured until phase 3).
- **Extra endpoints beyond the TRD table:** none are write routes for the host. `GET/PATCH /settings` and `GET /audit` follow the table.

### Phases 3 to 5

- **PM2 runs in a worker thread** with a socket probe first, so the monitor never starts a PM2 daemon and a hung PM2 cannot block the event loop. Only whitelisted fields cross the thread boundary.
- **The PM2 bus has no replay**, so when a service is first seen the monitor reads the last ~150 lines of its PM2 out/err files into the live view (memory only, not re-stored; stdout and stderr interleaving is approximate). Lines logged while the monitor was down are not in the monitor's own log files.
- **Services are discovered from PM2 names**; one that disappears shows as stopped. Archiving a service PM2 still lists is refused (409).
- **gzip uses streaming zlib** instead of a worker; the hour file is chosen by receive time; `LogStatus` gained `skippedLines` and `volumeReason`.
- **Extra suppression pairs** beyond the document: crash loop hides service down, critical disk hides warning disk for the same volume.
- **Interim hourly retention** runs until phase 9 replaces it.
- **Disk I/O is Windows-only** (PowerShell CIM); other platforms report null.
- **Setting defaults live in code**; rules whose data arrives later (Nginx, Mongo, app) are listed as `implemented: false`.
- **Resend `Idempotency-Key`** is sent so retries never duplicate an email. `monitor.email_failing` is dashboard-only.
- **Watchdog:** cannot notify if Resend is also down; a second failure within 30 minutes of recovery is the same outage and sends no new email (at most 3 per outage).

### Phases 6 to 9

- **`TLS_CHECK_HOSTS`** (environment) instead of a `tls.hosts` setting. `nginx.5xx_rate` uses a trailing 60 s window; Nginx windows are keyed by read time; the tailer starts at the end of the file. `cert_critical` hides `cert_expiring`.
- **Mongo storage** is `sizeOnDisk`; slow queries come from `system.profile`. Only field names of a command are stored.
- **Engine:** evaluators may return a refresh hint (`Observation.refresh`). `start(config, { mongoSource, overrides })` is a test and demo seam.
- **Agent:** active users are summed across instances (can overcount a user connected to two). Event-loop lag subtracts the 10 ms histogram resolution. Fastify usage is not tested (Express-style middleware only).
- **Tenants:** stored at 60 s only; detail is held in memory for 3 minutes, so a long persistence outage loses tenant minutes.
- **Rollup:** `repl_lag_s` uses max. History grids contain null gaps.
- **No dual-axis correlation chart:** CPU, users and sockets are stacked on one shared x axis.
- **Windows events:** critical, error and warning are collected, only critical alerts.
- **Log search:** newest first by default, context lines capped at 2000, `matched` counts returned matches.
- **E2E** now runs against `apps/backend/scripts/demo-server.ts`, a pretend Nginx, MongoDB and agent around the real backend.

## Layout

```
apps/backend     Fastify API, WebSocket, collectors, SQLite, tests
apps/watchdog    Independent Render service (no shared code)
apps/frontend    Next.js UI (static shell, data fetched directly from the API)
packages/agent   In-app agent (zero runtime dependencies)
packages/shared  Zod schemas and TypeScript types
scripts          Windows service install / uninstall (NSSM)
docs             Runbook (put prd.md, trd.md, backend-schema.md, implementation-plan.md here)
```
