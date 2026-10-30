# Command Center

Self-hosted dashboard for a Windows VPS and the MERN services on it: host metrics, PM2 services and their logs, Nginx, MongoDB, per-tenant application load, alerts by email, GitHub code status, Resend delivery counts, and restart / stop / start of PM2 services. A TypeScript pnpm monorepo.

**Every change goes through a pull request with green CI. A merge to `main` deploys the backend to production** (see [Deployment](#deployment)).

## Documents

The specification lives in `docs/`. These are the current versions (v3, 2026-10-29):

| Document | What it covers |
|---|---|
| [`docs/prd.md`](docs/prd.md) | Requirements, roles, scope, owner decisions |
| [`docs/trd.md`](docs/trd.md) | Technical design, security controls, configuration, failure behaviour |
| [`docs/backend-schema.md`](docs/backend-schema.md) | Tables, migrations, in-memory shapes, payloads, alert rules, settings |
| [`docs/implementation-plan.md`](docs/implementation-plan.md) | Phase status, on-server checks (section 0.3), next steps |
| [`docs/plan-pm2-github-resend.md`](docs/plan-pm2-github-resend.md) | Design and decisions D1 to D10 for Parts 0, A, B, C |
| `docs/runbook-phase1.md`, `runbook-phase3-5.md`, `runbook-phase6-9.md` | Server setup per phase |
| `docs/runbook-backups.md` | Nightly, pre-deploy and offsite backups; restore test and restore |
| `docs/runbook-nginx.md` | Nginx in front of `monitor-api`: rate limits (H8), the `/agent/` location (phase 11) and the outside port scan |
| `docs/runbook-hosts.md` | Phase 11 M1 on the server: migration `010` on a copy, checks after the deploy, going back |

## Status

| Phase | Status | Where |
|---|---|---|
| 1. Backend core | Built | `apps/backend` |
| 2. Frontend | Built | `apps/frontend` |
| 3. PM2 and logs | Built | `apps/backend/src/pm2`, `src/logs`, migration `002_pm2` |
| 4. Alert engine and email | Built | `apps/backend/src/alerts`, migration `003_alerts` |
| 5. Render watchdog | Built | `apps/watchdog` (standalone, shares no code) |
| 6. Nginx | Built | `src/nginx`, migration `004_nginx` |
| 7. MongoDB | Built | `src/mongo`, migration `005_mongo` |
| 8. Agent and application layer | Built | `packages/agent`, `src/agent`, migration `006_agent` |
| 9. History, search, correlation | Built | `src/rollup.ts`, `src/history.ts`, `src/logs/search*.ts`, migration `007_events` |
| 10. Parts 0, A, B, C | Built | Auto-archive and disk filtering; `src/github`, migration `008_github`; `src/email`, `routes/webhooks.ts`, migration `009_email`; `src/pm2/actions.ts` |
| 10.5. Audit fixes H1 to H9 | In progress | `docs/implementation-plan.md` |
| 11. Multi-host (Ubuntu VPS through an agent) | M1 built: hosts, enrollment, `/agent/v1`, Admin → Hosts, `host.silent` | `src/hosts`, `src/routes/hosts.ts`, migration `010_hosts`; `docs/implementation-plan.md`, `docs/trd.md` section 14 |

**Actions exist.** Admins, and engineers an admin has marked "Can operate", can restart, stop and start PM2 services from the service page (`POST /api/v1/services/:id/actions`). The target is resolved on the server from the service id, `monitor-api` itself and PM2 modules are refused, one action runs per service at a time with a 10-second cooldown, and every attempt is audited. There is no TOTP; see decision O3 in `docs/prd.md`.

## What works now

- **Accounts and login.** `create-admin` command (no default credentials), bcrypt cost 12, sessions stored as SHA-256 hashes in SQLite (they survive restarts), absolute (12 h) and idle (2 h) expiry, per-username lockout (5 failures, 15 min) and per-IP throttle (20 / 10 min), unknown usernames behave identically to wrong passwords, audit log of every login, failure, lockout and logout.
- **Admin.** Create, edit, disable users, grant "Can operate", reset passwords (forces a change and clears a lockout), revoke sessions, view the audit log, edit settings. Disabling a user closes their live WebSocket immediately.
- **Hardening.** Origin allowlist on every API request and on the WebSocket upgrade, custom CSRF header on state-changing requests, exact-origin CORS with credentials, helmet, global and per-route rate limits, strict Zod validation (unknown fields rejected), `__Host-session` Secure/HttpOnly/SameSite=Lax cookie in production, `X-Forwarded-For` honoured only from localhost.
- **Live host metrics.** CPU (overall and per core), RAM, swap, network, disk usage and I/O, uptime, pending reboot (Windows), collected by an isolated scheduler into an in-memory state store with a 30-minute ring buffer, and pushed over one shared WebSocket every 2 s. Optical drives and `DISK_EXCLUDE` volumes are skipped.
- **PM2 and logs.** Services are discovered from PM2, with CPU, memory, restarts and uptime; a crash or restart becomes an event; a service PM2 no longer lists is archived after `pm2.auto_archive_minutes` (15). Logs are captured from the PM2 bus into a ring buffer, hourly gzipped files on the log volume (24 h retention), and a live tail over WebSocket.
- **Alerts.** A 5 s engine with **29 rules**, durations, resolve hysteresis, suppression of symptoms behind a cause, mutes, reminders, per-category subscriptions, and email through Resend with retries and an outbox of every attempt. A dashboard Stop mutes that service's "service down" alert for 30 minutes.
- **Nginx, MongoDB, application.** Gateway traffic from a JSON access log (no paths or client addresses) and `stub_status`, TLS expiry, read-only MongoDB health and slow-query shapes, and an in-app agent (event-loop lag, latency, sockets, active users, per-tenant load).
- **History and search.** Hourly rollup and retention, history charts with incident markers, log search across files, Windows Event Log.
- **Code status (Part A).** Per service: running commit against its GitHub branch (in sync, behind, ahead, diverged, dirty), latest CI and deploy runs, open pull requests. Read-only token; git is run without a shell with fixed arguments.
- **Email delivery (Part B).** `POST /webhooks/resend`, verified with `svix`, stores counts only (by sender domain, 10-minute buckets, 30 days). Email page, and a bounce/complaint spike alert.
- **Watchdog.** A separate Render service checks `/health` and emails at most three times per outage. See `apps/watchdog/README.md`.
- `GET /health`: shallow, unauthenticated, rate limited, returns only `{"status":"ok"}`.

## Quick start (development)

Requires Node 22+ and pnpm 10.

```bash
pnpm install

# Backend
cp apps/backend/.env.example apps/backend/.env       # edit if needed
pnpm build:shared
pnpm --filter @cc/backend create-admin               # prompts for a password (hidden)
pnpm dev:backend                                     # http://localhost:4111

# Frontend (second terminal)
cp apps/frontend/.env.example apps/frontend/.env.local
pnpm dev:frontend                                    # http://localhost:3111
```

Sign in at http://localhost:3111 with the account you just created.

The example files match each other: the backend listens on `PORT_API=4111` and allows the origin `http://localhost:3111`; the frontend calls `NEXT_PUBLIC_API_BASE=http://localhost:4111`. If you change one port, change the other file too. Without a PM2 daemon, set `PM2_ENABLED=false` in `apps/backend/.env`.

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
| `pnpm --filter @cc/frontend e2e` | Playwright browser tests (see below) |
| `pnpm format` | Prettier |

### Browser tests

Build the UI against the test API first, then run Playwright. It starts a throwaway backend (temporary database, one admin, pretend Nginx, MongoDB and agent) and `next start` by itself.

```bash
cd apps/frontend
NEXT_PUBLIC_API_BASE=http://127.0.0.1:4100 pnpm build
npx playwright install chromium            # or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
pnpm e2e
```

## Configuration

Every backend variable is listed, with comments, in [`apps/backend/.env.example`](apps/backend/.env.example) and described in `docs/trd.md` section 9.1. In short:

- **Core:** `ALLOWED_ORIGINS` (required, exact origins), `NODE_ENV`, `BIND_HOST`, `PORT_API` (code default 4000, **4111 in production**), `COOKIE_SECURE`, `COOKIE_SECRET` (optional, unused), `SQLITE_PATH`, `LOG_ROOT`, `LOG_LEVEL`, `CC_ENV_FILE` (point the service and CLI tools at an env file outside the repository).
- **PM2 and logs:** `PM2_ENABLED`, `PM2_HOME`, `LOG_REQUIRE_SEPARATE_VOLUME` (on in production: refuse to log onto the system volume).
- **Alert email:** `RESEND_API_KEY`, `RESEND_API_URL` (testing), `ALERT_FROM`, `PUBLIC_DASHBOARD_URL`. Without a Resend key alerts still show on the dashboard but nothing is emailed.
- **Nginx, MongoDB, agent (optional):** `NGINX_STATUS_URL`, `NGINX_ACCESS_LOG`, `NGINX_ERROR_LOG`, `TLS_CHECK_HOSTS`, `MONGO_URI`, `MONGO_PROFILE_DBS`, `INGEST_TOKEN` (24+ characters), `PORT_INGEST` (default 4001, loopback only).
- **Parts 0, A, B (optional):** `DISK_EXCLUDE`, `GITHUB_TOKEN`, `RESEND_WEBHOOK_SECRET`.

Invalid configuration stops startup and names the variable, never its value. Secrets are shown in the startup log only as set or not set.

Frontend: `NEXT_PUBLIC_API_BASE` only ([`apps/frontend/.env.example`](apps/frontend/.env.example)). It is not a secret.

Tunables (retention, session lifetimes, lockout, poll intervals, stop-mute length) are in the `settings` table, editable by admins on the Settings page; defaults live in `apps/backend/src/settings.ts`.

`NODE_ENV=production` turns on the Secure `__Host-session` cookie and refuses to start with `COOKIE_SECURE=false`, so use it only behind HTTPS.

## Deployment

| Part | Where | How |
|---|---|---|
| Backend | Windows VPS, PM2 process `monitor-api` on `127.0.0.1:4111`, behind Nginx at `monitor-api.thediv.in` | `.github/workflows/deploy-backend.yml`: a push to `main` touching backend paths runs the tests, then `scripts/deploy.ps1` on the self-hosted runner |
| Frontend | Vercel, `monitor.thediv.in` | Vercel's Git integration |
| Watchdog | Render | `apps/watchdog/render.yaml` |

`scripts/deploy.ps1` backs up the database (`VACUUM INTO`), keeps the previous release, copies and builds, restarts `monitor-api` (the Windows service, or the PM2 process before the H9 switch), checks `/health` on port 4111 and stability for 10 s, records `.deploy-sha`, and rolls the code back on failure. Database migrations are not rolled back.

Production paths: deploy folder `C:\Apps\command-center-deploy`, env file `C:\Apps\command-center-deploy\apps\backend\.env` (never overwritten by a deploy), database `C:\monitor\data\monitor.db`, logs `E:\monitor-logs`.

Server setup per phase (Nginx block, PM2, log volume, Resend, MongoDB user, agent) is in the runbooks in `docs/`. `scripts/install-service.ps1` installs the backend as the Windows service `monitor-api` with NSSM (decision O1, H9); the switch from PM2 is `docs/runbook-service.md`.

### Working on this repository

- Branch from `main`, open a pull request, wait for the CI check (`test`) to pass. `main` is protected.
- New migrations start at `010`; test each one on a copy of the production database before merging.
- After a merge or an on-server check, update the status labels in the four documents in `docs/` and the checks in `docs/implementation-plan.md` section 0.3.

## Verification status

On `main` (`c00d968`), all passing: **364 backend tests** (22 files), **42 watchdog tests**, **15 agent tests**, typecheck of all packages clean. The Playwright suite (22 browser tests) and the integration helpers (`pm2:check`, `mongo:check`, `size:check`, `smoke:watchdog`) exist but were not rerun for this count.

What still has to be confirmed on the real server (idle resource budget, sessions across a restart, PM2 Start on a stopped process, the Resend webhook through Nginx, the port scan, the production paths, and others) is tracked in one place: `docs/implementation-plan.md` section 0.3, checks V1 to V24.

## Deviations from the documents

Recorded during phases 1 to 9 and kept here for reference. Later differences between the code and the documents are recorded in the documents themselves (`docs/trd.md` and `docs/implementation-plan.md` appendix A).

### Phase 1

- **Setting defaults live in code** rather than being seeded by a migration.
- **`COOKIE_SECRET` is optional and unused.** It is validated if present and reserved for signed cookies or CSRF tokens. Sessions use random 256-bit tokens and CSRF uses the header plus Origin check specified in the TRD.
- **WebSocket Origin is mandatory.** A socket upgrade without an `Origin` header is closed with 4403 (browsers always send one).
- **Dependency choices.** Zod 3 (not 4), `better-sqlite3` 13, Next.js 16 / React 19, pnpm 10. ESLint is not configured yet (Prettier and strict TypeScript are).
- **`HostState.updatedAt`** is the time of the live CPU/memory sample; staleness of disks and uptime is reported per collector.

### Phases 3 to 5

- **PM2 runs in a worker thread** with a socket probe first, so the monitor never starts a PM2 daemon and a hung PM2 cannot block the event loop. Only whitelisted fields cross the thread boundary.
- **The PM2 bus has no replay**, so when a service is first seen the monitor reads the last ~150 lines of its PM2 out/err files into the live view (memory only, not re-stored; stdout and stderr interleaving is approximate). Lines logged while the monitor was down are not in the monitor's own log files.
- **Services are discovered from PM2 names**; one that disappears shows as stopped until it is auto-archived. Archiving a service PM2 still lists is refused (409).
- **gzip uses streaming zlib** instead of a worker; the hour file is chosen by receive time; `LogStatus` gained `skippedLines` and `volumeReason`.
- **Extra suppression pairs** beyond the document: crash loop hides service down, critical disk hides warning disk for the same volume.
- **Disk I/O is Windows-only** (PowerShell CIM); other platforms report null.
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
- **E2E** runs against `apps/backend/scripts/demo-server.ts`, a pretend Nginx, MongoDB and agent around the real backend.

## Layout

```
apps/backend     Fastify API, WebSocket, collectors, alerts, actions, webhook, SQLite, tests
apps/frontend    Next.js UI (static shell, data fetched directly from the API)
apps/watchdog    Independent Render service (no shared code)
packages/agent   In-app agent (zero runtime dependencies)
packages/shared  Zod schemas and TypeScript types
scripts          deploy.ps1 (production deploy), install-service.ps1 / uninstall-service.ps1 (NSSM)
docs             PRD, TRD, schema, implementation plan, Parts 0 to C plan, runbooks
```
