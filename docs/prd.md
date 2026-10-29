# Product Requirements Document: Self-Hosted Command Center

**Version:** v3, 2026-10-29 (replaces v2)
**Scope of this version:** Monitoring of the Windows VPS (built), operator actions, GitHub and Resend visibility (built), audit fixes (planned), and multi-host monitoring with the Ubuntu VPS as the first remote host (approved design, not built)
**Companion documents:** `trd.md`, `backend-schema.md`, `implementation-plan.md` (all v3), `plan-pm2-github-resend.md`, runbooks in `docs/`

v3 is based on a review of the repository at commit `c00d968` (`main`, 2026-10-09), not only on the earlier documents. Where v2 and the code disagreed, v3 follows the code and says so.

---

## 0. Status and Change Log

### 0.1 Status labels

| Label | Meaning |
|---|---|
| **Built** | In `main`, tests passing. Deployed by the pipeline unless noted |
| **Planned** | Approved and scheduled, no code yet |
| **Proposed** | Written as an option, not approved |
| **Not started** | Not planned in detail |
| **[Verify]** | Must be confirmed on the real server. The canonical list is `implementation-plan.md` section 0.3 |

v2 used "Delivered" for Parts 0, A, B and C. They are in `main` since 2026-10-09 (commit `e31724b`), so v3 calls them **Built**.

### 0.2 What exists

| Phase / part | Scope | Status | Evidence |
|---|---|---|---|
| 1. Backend core | Accounts, login, sessions, lockout, audit, host metrics, WebSocket | Built | Part of 364 backend tests |
| 2. Frontend | Next.js UI, login, Overview, Host, Users, Audit, phone layout | Built | Playwright suite (16 tests per the README; not rerun for v3) |
| 3. PM2 and logs | Discovery, process events, log capture, 24 h files on `E:`, live tail | Built | `pnpm pm2:check` against a real PM2 daemon |
| 4. Alerts and email | 5 s engine, durations, hysteresis, grouping, mutes, reminders, Resend with retries | Built | Engine and mail tests |
| 5. Render watchdog | Three-email outage rule, flap suppression | Built | 42 watchdog tests |
| 6. Nginx | `stub_status`, JSON access log, per-service traffic, TLS expiry | Built | Tests, demo server |
| 7. MongoDB | Read-only user, server status, slow-query shapes, current operations | Built | `pnpm mongo:check` |
| 8. Agent | `@cc/agent`: event loop lag, latency, sockets, active users, tenants | Built | 15 agent tests |
| 9. History and search | Rollup, retention, history charts, log search, Windows Event Log | Built | 29 alert rules seeded |
| Deploy pipeline | Merge to `main` → CI → self-hosted runner deploys `monitor-api` | Built | `.github/workflows/deploy-backend.yml`, `scripts/deploy.ps1` |
| Part 0 | Auto-archive of services PM2 no longer lists, optical drives ignored, `DISK_EXCLUDE` | Built (`e31724b`) | Unit tests |
| Part A | GitHub read-only code status per service | Built (`e31724b`) | `github.test.ts` |
| Part B | Resend delivery counts and bounce alert | Built (`e31724b`) | `email.test.ts` |
| Part C | Restart, stop, start of PM2 services with `can_operate` | Built (`e31724b`) | `actions.test.ts` |
| Audit fixes (H1 to H9) | Gaps found in the v3 review | Planned | `implementation-plan.md` phase 10.5 |
| Multi-host (M1 to M6) | Ubuntu VPS monitored through an agent, remote actions | Planned | Section 16 |
| TOTP, alert channels other than email | | Not started | Section 11 |

Test run on `main` for v3: 364 backend, 42 watchdog and 15 agent tests pass; the typecheck of all packages is clean.

### 0.3 Corrections to v2

The review found these differences between v2 and the code. The details are in the TRD and the schema.

- Parts 0 to C are merged and were pushed straight to `main` in one commit, not in four pull requests.
- The GitHub and email tables are two migrations, `008_github.sql` and `009_email.sql`. The multi-host migration is therefore `010`, not `009`.
- The backend listens on port **4111** in production (deploy script and the former `.env.example`), not 4000.
- The webhook answers 503 when its secret is unset and 401 on a bad signature (v2 said 404 and 400).
- Email counts are kept in 10-minute buckets, and webhook ids are kept for `retention.email_days` (30 days), not "a few days".
- The commit that added Parts 0 to C deleted `apps/backend/.env.example`. The README still tells new installs to copy it.
- The README still says "Phase 10 not started" and "no route that starts, stops or restarts anything".

### 0.4 Change log

| Version | Date | Change |
|---|---|---|
| v1 | before 2026-10 | Single Windows VPS, read-only, password login, email alerts, watchdog |
| v2 | 2026-10-28 | Phases 1 to 9 built, Parts 0 to C delivered, multi-host proposed |
| v3 | 2026-10-29 | Status taken from the code. Parts 0 to C recorded as built. Corrections in 0.3. Audit gaps turned into requirements (sections 4, 5, 9, 12). Multi-host approved with the owner's decisions of 2026-10-29: the monitor stays on Windows, actions on remote hosts through agent-pulled commands, all container logs with limits, fail2ban counts and port probes included (section 16) |

---

## 1. Overview

A private, self-hosted web dashboard that shows the health of the owner's servers, the services running on them, their MongoDB databases and their users, in one place. It removes the need to log in over RDP or SSH to check whether something is wrong, and lets an authorized person restart a broken service from the browser.

The central monitor runs on the Windows VPS, which also runs 9 to 10 MERN services under PM2. The Ubuntu VPS, which runs a Docker-based TR-069 platform, becomes the first remote host (section 16).

### 1.1 Problem

- Checking whether an API crashed, why a service is slow, or what an error log says requires logging into the server.
- Generic monitors show raw CPU and RAM but cannot say whether a spike comes from real user demand or from a bug.
- Third-party SaaS monitors would send customer activity, logs and keys to an outside company.
- With a second server, a separate monitor per server would mean separate logins, dashboards and alert settings.

### 1.2 Vision

One browser window, reachable from a laptop, iPad or phone, that answers: *Is everything healthy on every server, and if not, which service is the problem and why?*

### 1.3 Goals

1. **Zero-RDP and zero-SSH operations:** check and, where permitted, restart services on every server from a browser.
2. **Unified visibility:** one view across all servers and services, with automatic discovery.
3. **Contextual monitoring:** resource use next to live user demand, per service and per tenant.
4. **Data sovereignty:** logs and user data stay on servers the owner controls. Only operational alert facts go to third parties.
5. **Failure awareness:** email when something breaks, including when a whole server or the monitor itself is down.
6. **One installation:** the monitor runs once, on the Windows VPS. Other servers get a small agent, never a copy of the monitor.

### 1.4 Non-goals

- TOTP, backup codes and authenticator enrolment, unless the owner asks (section 11).
- Write actions on GitHub (merge, deploy, re-run).
- Resend domain and API-key management.
- Telegram, SMS or push alerts.
- Log redaction. Raw application logs are intentional, so users can be found by email or token. Gateway access logs are the exception (section 4.1).
- Actions other than start, stop and restart (no exec, no shell, no file access, no image or volume changes) on any host.
- A copy of the monitor on each server.
- Moving the monitor off the Windows VPS (decided 2026-10-29).

---

## 2. Users and Roles

| Role | Who | Permissions | Status |
|---|---|---|---|
| **Admin** | Owner | Everything: accounts, settings, rules, service mappings, hosts and agent tokens, audit log, actions | Built; host management Planned |
| **Engineer** | Team members | View everything, opt in to alert categories. No accounts, settings or hosts | Built |
| **Operator** (permission, not a role) | Engineer with "Can operate" (`users.can_operate`) | Engineer rights plus start, stop and restart of services on any host | Built for PM2 on Windows; Planned for remote hosts |

Admins can always operate. Operator permission is granted per user by an admin.

---

## 3. System Architecture

| Component | Hosting | Responsibility | Status |
|---|---|---|---|
| Frontend (Next.js) | Vercel, `monitor.thediv.in` | UI shell. The browser fetches all data from the backend directly | Built |
| Backend (`monitor-api`) | Windows VPS, behind Nginx at `monitor-api.thediv.in`, listening on `127.0.0.1:4111` | Collectors, REST, WebSocket, SQLite, log storage, alerts, actions, webhook, agent ingest | Built; agent ingest Planned |
| Watchdog | Render, sole service in its workspace | Checks `/health` of the monitor (and, planned, of the Ubuntu API); emails on outage | Built (one target) |
| Scheduler | cron-job.org | Pings the watchdog every 5 minutes | Built |
| Deploy runner | Self-hosted GitHub runner on the Windows VPS | Deploys `monitor-api` after CI on `main` | Built |
| Node agent (`cc-node-agent`) | Container on each remote host | Collects host, container, log, database, gateway, backup and security data; runs approved actions | Planned |
| Docker proxy (`cc-docker-proxy`) | Container next to the agent | The only path to the Docker API, limited to an allowlist | Planned |

### 3.1 Domains and public routes

- `monitor.thediv.in`: frontend (Vercel).
- `monitor-api.thediv.in`: backend (Windows VPS, Nginx, HTTPS).

Both share one registrable domain, so the `__Host-session` cookie (Secure, HttpOnly, SameSite=Lax) is same-site. CORS allows only the frontend origin.

Public routes outside `/api/v1`:

| Route | Caller | Protection | Status |
|---|---|---|---|
| `GET /health` | Watchdog | Shallow, rate limited | Built |
| `POST /webhooks/resend` | Resend | Svix signature, timestamp window, rate limit | Built |
| `/agent/v1/*` | Remote agents | Per-host token, size and rate limits, `Origin` refused | Planned |

### 3.2 Data flow

1. Local collectors on the Windows VPS poll their sources into the in-memory state.
2. Remote agents push snapshots, logs and events to `/agent/v1/*` over HTTPS. The monitor never opens a connection into another server, and no monitored server opens a new inbound port.
3. Remote actions are queued on the monitor and fetched by the agent (section 16.6).
4. Browsers subscribe over one WebSocket; collection cost does not grow with viewers.
5. Vercel never proxies data.

### 3.3 Stack

Node.js 22, TypeScript, Fastify, Zod, SQLite (`better-sqlite3`, WAL), `systeminformation` and PowerShell on Windows, PM2 programmatic API in a worker thread, official `mongodb` driver, Resend with `svix` verification, Next.js 16 and React 19 with uPlot. The backend runs under PM2 as `monitor-api` (section 12, decision O1, asks whether to move it to a Windows service).

---

## 4. Functional Requirements

Each layer applies per host. The table in 16.4 shows the source on each host.

### 4.1 Layer 1: Host and gateway

- CPU (overall and per core), RAM, swap, network throughput, uptime, pending reboot.
- Disk usage and I/O per volume. Windows: fixed drives; optical drives and `DISK_EXCLUDE` are ignored. Linux: mount points listed for the agent (default `/`).
- Windows Event Log (Windows host only): critical, error and warning collected; critical alerts.
- Gateway (Nginx on Windows, Caddy on Ubuntu): per-service request rate, status classes, p50 and p95 latency, bytes, TLS expiry. Nginx also: `stub_status` connections and requests per second.
- **Privacy rule for gateway logs (decided in v3):** request paths, query strings, client addresses and headers are never stored or shipped, on any host. Nginx already logs without them; the Ubuntu agent drops them from Caddy records before anything leaves the host.
- **"Top paths" and "top client IPs" are removed** from the Nginx page (decided in v3). With the privacy log format all requests landed under `/` and the IP list stayed empty; the page now says paths and addresses are not logged (audit item H4, fixed).

### 4.2 Layer 2: Services

A service is a PM2 process (Windows) or a Docker Compose service (Ubuntu).

- State, restarts, uptime, CPU, memory, crash and exit events, live stdout and stderr.
- Container health (`healthy`, `unhealthy`, `starting`) where the image defines a health check.
- **Auto-discovery** of new PM2 processes and containers.
- **Auto-archive** of services no longer listed for `pm2.auto_archive_minutes` (15). A stopped service stays listed and is not archived. The safety check "PM2 listed at least one other service" must not count `monitor-api` itself (audit item H2).
- **Code status** (Part A): Windows PM2 services only. Not planned for containers.
- **Actions:** start, stop, restart, for admins and operators, with confirmation, on any host (section 16.6).

### 4.3 Layer 3: Application and users

Through `@cc/agent`, per service and tenant: WebSocket connections, active users in the last 5 minutes, request rate, p95 latency, event loop lag, heap. Only counts and timings leave the application. Tenants without a resolver show as `_unknown`. On Ubuntu, the Express API reports through the local node agent (section 16.4).

Resource use is shown on the same time axis as user demand (stacked charts).

### 4.4 Layer 4: MongoDB

Up/down and response time, connections versus limit, slow queries from `system.profile` as shapes (never values), operations per second, memory and data size, replication, current operations (live only). Read-only user with `clusterMonitor` and read on `system.profile` only. Applies to the Windows MongoDB and the Ubuntu MongoDB 8.

### 4.5 Logs

- Raw application logs, unredacted by design.
- Hourly JSONL files, completed hours gzipped. Windows services: `E:\monitor-logs\<pm2 name>\`. Remote services: `E:\monitor-logs\@<host>\<service>\` (the `@` keeps them apart from PM2 names).
- Retention 24 hours (`logs.retention_hours`).
- Live tail per service over WebSocket, with backpressure and dropped-line counts.
- Search in a worker thread, one per user, four overall, 30 s limit, guarded regex, audited. Search covers all hosts or one.
- **The search range offered is capped at the log retention (decided in v3).** The API and the picker both stop at `logs.retention_hours` (audit item H3, fixed).
- Disk guard at 85% of the log volume; refuses to log onto the database volume.
- Remote hosts: every container's stdout and stderr is shipped, limited to 200 lines per second per container, with dropped counts. An admin can exclude a container from the UI (decided 2026-10-29).

### 4.6 History

Metric history in SQLite, 7 days; 10-second resolution for 24 hours, then 1 minute. Tenants at 1 minute. Charts with incident markers and visible gaps, per host. **The history range offered is capped at `retention.metrics_days` (decided in v3)**, in the API and the picker (audit item H3, fixed).

### 4.7 Email delivery

Resend webhook counts by sender domain in 10-minute buckets, kept 30 days; Email page for 24 hours, 7 days and 30 days; alert at 5 or more bounces or complaints in the last hour (Part B).

### 4.8 Backups and security signals (remote hosts)

- Age of the newest local backup file and of the last successful offsite upload; alert after 26 hours for either.
- fail2ban ban counts per jail and failed SSH login counts, as numbers only. No client addresses leave the host.
- Outside-in probes from the Windows VPS: TCP to `acs.thediv.in` on 7547, 443 and 80, and HTTPS to the Ubuntu API health URL.

---

## 5. Data and Storage

| Data | Location |
|---|---|
| Live metrics | Memory only |
| Accounts, settings, services, hosts, alerts, audit | SQLite at `C:\monitor\data\monitor.db` [Verify the production path], cached in memory |
| Metric history | Same SQLite, batched writes every 10 s |
| Logs (all hosts) | `E:\monitor-logs`, 24 hours |
| GitHub status | `service_git` |
| Email counts | `email_event_counts`, 30 days |
| Remote action queue | `agent_commands` (planned), kept with the audit log retention |

SQLite is separate from every production MongoDB.

**Backups (requirement, audit item H7).** Today the only copies are the pre-deploy backups in `C:\monitor\backups`, on the same drive as the database, keeping the last 10. Required:
- A nightly `VACUUM INTO` copy to a different volume (`E:`) and a second copy off the server.
- One restore tested and recorded.
- Pre-deploy backups moved off `C:` as well.

---

## 6. Authentication and Accounts

### 6.1 Accounts

Username, display name, email, phone, notes, role, active flag, bcrypt hash, last login, failed attempts, lockout, `can_operate`, forced password change, and reserved unused TOTP columns.

### 6.2 Management

The first admin comes from `create-admin`; no default password exists. Admins create, edit, disable and reset accounts, grant "Can operate", and end sessions. Disabling a user closes their WebSocket. No email reset flow.

### 6.3 Login protections (Built)

bcrypt cost 12, 12+ characters, common-password check; 5 failures lock a username for 15 minutes; 20 attempts per IP per 10 minutes; unknown usernames behave like wrong passwords; 12 h absolute and 2 h idle sessions stored as SHA-256 hashes; WebSocket requires session and allowed `Origin`, rechecked every 60 s; audit of logins, failures, lockouts, account and setting changes, searches and actions.

### 6.4 Accepted risk

Password login is the only barrier on the public API. Behind it are raw logs and the ability to stop production services, and from phase 11 also containers on the Ubuntu server. Long, unique passwords are essential. **Recommendation:** add TOTP per action, or Cloudflare Access in front of `/api/v1`, before remote actions are switched on (decision O3). If Cloudflare Access is used, `/health`, `/webhooks/resend` and `/agent/v1/*` must stay outside it.

---

## 7. Alerting

### 7.1 Service-level alerts

Emails carry only operational facts: host, service, what happened, the value, the time and a dashboard link. Never log lines, emails, tokens or user data.

29 rules are seeded today (28 from phase 4 plus `monitor.email_bounce_spike`). Phase 11 adds four (section 16.7). Thresholds and durations are editable by admins; per-service overrides exist.

Noise control: sustained duration before firing, one email per incident, reminders, resolved email after hysteresis, symptom grouping (service down hides its app and 5xx alerts; crash loop hides service down; critical hides warning for disks and certificates; host silent hides that host's other alerts except the outside-in probe), maintenance mutes, and a 30-minute mute after a Stop from the dashboard.

Recipients: admins get everything; engineers opt in by category. Email failures are retried and shown on the dashboard.

### 7.2 Server-down alerts

The Render watchdog checks the monitor's `/health` every 5 minutes and sends at most three emails per outage: down, a 60-minute reminder, back online after two good checks. **Planned:** a second target, the Ubuntu API health URL, with its own independent three-email limit.

Known limitation: if Render, cron-job.org or Resend fail during an outage, no email is sent.

---

## 8. Non-Functional Requirements

- **Efficiency:** viewers do not add collection load. The agent stays under 3% of one vCPU and 150 MB on the Ubuntu server.
- **Scalability:** a new service needs no configuration; a new host needs only the agent and an enrollment token.
- **Resource safety:** log volume problems never affect `C:` or the services; remote logs are rate limited at the source.
- **Resilience:** each collector, each agent and each external API fails on its own. An agent buffers up to 50 MB while the monitor is unreachable.
- **Responsiveness:** desktop, tablet and phone.
- **Privacy:** no customer data, logs or keys to third parties. Application logs from Ubuntu travel to the Windows VPS over TLS (approved 2026-10-29). Gateway logs never carry paths, query strings, client addresses or headers.
- **Change safety:** `main` is protected; every change goes through a pull request with green CI (audit item H1), because a merge deploys to production.

---

## 9. Security Posture

| Control | Status |
|---|---|
| Password login, HTTPS, strict CORS, CSRF header, Origin checks, rate limits, audit | Built |
| `/health` public, shallow, rate limited | Built |
| `/webhooks/resend`: Svix signature, 5-minute window, duplicate ids, 120 per minute | Built |
| PM2 actions: `can_operate`, server-side resolution, confirmation, one at a time, cooldown, `monitor-api` excluded, audited | Built |
| Read-only `GITHUB_TOKEN`; git run without a shell, fixed arguments, `core.fsmonitor=false` | Built (H5 fixed) |
| Protected `main` branch (no direct pushes) | Planned (H1) |
| Off-drive and offsite database backups, tested restore | Planned (H7) |
| Nginx `limit_req` on `/webhooks/` and `/agent/` | Planned (H8, M1) |
| Agent ingest with per-host hashed tokens, size and rate limits, version check | Planned (M1) |
| Docker access only through an allowlisting proxy; no exec, archive, export, inspect or create | Planned (M2) |
| Remote actions pulled by the agent, expiring after 60 s, refused for the agent's own containers | Planned (M5) |
| TOTP per action or Cloudflare Access | Recommended before M5 is switched on (O3) |

---

## 10. Build Phases

| # | Phase | Status |
|---|---|---|
| 1 to 9 | Windows VPS monitoring | Built |
| 10 | Parts 0, A, B, C | Built |
| 10.5 | Audit fixes H1 to H9 | Planned |
| 11 | Multi-host M1 to M6 | Planned |
| later | TOTP, more alert channels | Not started |

---

## 11. Future Scope

- TOTP at login or per action, with backup codes and recovery.
- GitHub write actions.
- Matching Resend events to the monitor's own alert emails (D6, skipped).
- Telegram or push alerts.
- Code status for container services (image tag versus registry).
- Code status on the Overview page (D8).
- More remote hosts: the agent design is not specific to the Ubuntu server.

---

## 12. Open Items and Owner Decisions

| # | Item | Recommendation |
|---|---|---|
| O1 | Run `monitor-api` as a Windows service instead of inside PM2, so a PM2 failure no longer takes the monitor down | Yes, before M1. The NSSM script exists; the deploy script needs a change |
| O2 | The account the backend runs as | Confirm it is the Administrator account (deploy script default); keep, since PM2 runs there, and record it |
| O3 | TOTP per action or Cloudflare Access before remote actions | Yes, one of them before M5 is switched on |
| O4 | Health path on `tr069-api.thediv.in` | Owner to supply |
| O5 | Backup folder on Ubuntu and a marker for the last offsite upload | Owner's backup script writes `.offsite-ok` after each successful upload |
| O6 | Caddy access log as JSON to a file, not to stdout | Owner to configure (section 16.4) |
| O7 | Tenant resolver per service | Open since phase 8 |
| O8 | Resend plan limits versus alert volume | Open |
| O9 | Repo, branch and folder for each service (D7) | Enter in the UI |

Decided on 2026-10-29: the monitor stays on Windows; remote actions through agent-pulled commands for PM2 and Docker; all container logs with limits; fail2ban counts and outside-in probes included. Decided in v3 as recommended defaults (owner can override): search and history ranges capped at retention; top paths and IPs removed; gateway logs never carry paths or addresses.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Public API protected only by password, with raw logs and actions on two servers behind it | Strong passwords, lockout, audit, operators granted sparingly; TOTP or Cloudflare Access (O3) |
| An action hits the wrong process or container | Service id in, target resolved on the server and again by the agent, live-list check, own containers refused, confirmation, audit |
| The monitor dies with PM2 | Watchdog emails; O1 removes the shared fate |
| The Windows VPS is down, so no host is monitored | Watchdog targets per host, so the Ubuntu API is still checked from outside |
| Raw logs contain tokens and emails | Accepted; access audited |
| Logs from Ubuntu fill `E:` | Per-container limits, exclusions, 24 h retention, 85% guard |
| Public agent route attacked | Hashed per-host tokens, limits, version check, no cookies, `Origin` refused, Nginx `limit_req` |
| Docker access on Ubuntu is effectively root | Allowlisting proxy; agent never mounts the socket; no inspect, exec, archive or export |
| Agent compromised on Ubuntu | Non-root, read-only filesystem, no capabilities, only allowlisted Docker calls, outbound only |
| Database lost with the `C:` drive | H7 backups |
| Direct pushes skip review and still deploy | H1 branch protection |

---

## 14. Success Criteria

| Criterion | Status |
|---|---|
| Windows VPS checked from a browser without RDP | Met |
| A crashed or restarting service visible within seconds, with its logs | Met |
| Resource spikes matched to user counts per service and tenant | Met where the agent and a resolver exist |
| Outage email, 60-minute reminder, recovery notice, at most three per outage | Met in tests; not yet seen in production |
| An operator restarts a PM2 service from the browser and the audit names them | Built, [Verify] |
| Each service shows whether the server is behind or ahead of its branch | Built, [Verify] |
| Email delivery problems visible without the Resend dashboard | Built, [Verify] |
| Ubuntu VPS and its containers checked from the same dashboard without SSH | Planned |
| An operator restarts an Ubuntu container from the browser | Planned |
| A database restore has been tested | Planned |

---

## 15. Parts 0, A, B, C (Built)

Approved 2026-10-09 (D1 to D10 as recommended), merged in `e31724b`. Two migrations: `008_github.sql`, `009_email.sql`.

### 15.1 GitHub read-only (Part A)

- Per service: running commit versus branch head (in sync, behind, ahead, diverged, dirty, not on GitHub, unknown), latest CI and deploy runs, open pull requests.
- Running commit from `git rev-parse HEAD`, branch and `git status --porcelain --untracked-files=no`; for `monitor-api`, the `.deploy-sha` file.
- Polled every `github.poll_minutes` (5); admins can refresh (10 per minute).
- Mapping edited by admins on the service page.

### 15.2 Resend delivery (Part B)

- `POST /webhooks/resend`, raw body verified with `svix`. Answers 503 when `RESEND_WEBHOOK_SECRET` is unset, 400 without the Svix headers, 401 on a bad signature or old timestamp, 200 for duplicates (not counted).
- Counts sent, delivered, delayed, bounced (permanent, transient, undetermined), complained, failed, suppressed, per 10 minutes and sender domain, kept 30 days. Recipients, subjects, bodies, tags and message ids are not stored.
- Rule `monitor.email_bounce_spike`: 5 or more in the last hour, warning.

### 15.3 PM2 actions (Part C)

- Start, stop, restart for admins and operators. `POST /api/v1/services/:id/actions`, 20 per minute.
- Refused unless PM2 is on, the process is listed, is not a module and is not the monitor (by name `monitor-api` and by the process's own PM2 id).
- One action per service at a time (409); 10-second cooldown (429); PM2 unreachable or refusing (502).
- Start restarts only the stopped instances. Stop mutes `pm2.service_down` for that service for 30 minutes; Start lifts the mute. The link between a stop and its mute is kept in memory only, so after a monitor restart Start cannot lift it and it runs out by itself (audit item H6).
- Audit `service_action` and `service_action_failed`.

### 15.4 Configuration

Environment: `GITHUB_TOKEN`, `RESEND_WEBHOOK_SECRET`, `DISK_EXCLUDE`. Settings (defaults in code, not seeded): `pm2.auto_archive_minutes` 15, `github.poll_minutes` 5, `retention.email_days` 30, `actions.stop_mute_minutes` 30.

---

## 16. Multi-Host Monitoring (Planned)

### 16.1 Need

Full monitoring of the Ubuntu server (host, containers, logs, database, gateway, backups, security signals) in the same dashboard, with restart, stop and start of its containers, without running the monitor there.

### 16.2 First remote host

| Item | Value |
|---|---|
| Host name in the monitor | `ubuntu-acs` (the Windows VPS is `windows-vps`, host 1) |
| Server | Ubuntu 24.04, 4 vCPU, 8 GB RAM, 4 GB swap, 100 GB NVMe, public IP with NAT |
| Public names | `tr069-api.thediv.in` (dashboard and API), `acs.thediv.in` (CWMP, speed test, firmware) |
| Workload | Compose project `acs`: Caddy, GenieACS 1.2.16 (cwmp public on 7547; nbi, fs, ui on loopback), MongoDB 8 (auth on), Express 5 API, Next 15 dashboard, `cpe-sim`. The exact container list is confirmed at M2 [Verify] |
| Backups | Nightly `mongodump`, 3 days local, 90 days encrypted on Google Drive |
| Owner's known gaps | Single server, snapshot pending, restore drill pending, GenieACS UI admin password unchanged |

SSH details and private addresses stay out of these documents.

### 16.3 Approach

- The monitor stays on the Windows VPS as the only dashboard, database, alert engine and login.
- The Ubuntu server runs a compose project `cc-agent` with two containers: `cc-node-agent` (built by CI, pulled from GHCR with a read-only token) and `cc-docker-proxy`.
- The agent pushes to `https://monitor-api.thediv.in/agent/v1/*` and opens no ports to the internet.
- An admin adds a host in the UI and gets a one-time enrollment token (1 hour, single use) and an install snippet. Tokens are stored hashed and can be revoked per host.

### 16.4 What is collected on the Ubuntu host

| Area | Source |
|---|---|
| Host | Host `/proc` (CPU, memory, swap, uptime, disk I/O), host network counters, disk usage of listed mounts, `/run/reboot-required` |
| Containers | Docker list, stats and events through the proxy: state, health, restarts (counted from events), CPU, memory |
| Logs | Docker log stream per container, batched, compressed, 200 lines/s per container |
| MongoDB | Read-only monitoring user over the `acs` compose network |
| Gateway | Caddy JSON access log file (host, method, status, duration, size only); certificate expiry for both names |
| Application | `@cc/agent` in the Express API, sent to the agent over the compose network |
| Backups | Newest file in the local backup folder; `.offsite-ok` marker written by the backup script |
| Security | fail2ban bans per jail and failed SSH logins, counts only |

Requirement on the owner's side (O6): Caddy writes access logs as JSON to a file in a volume, not to stdout. Otherwise access lines would reach the shipped container logs with paths and client addresses.

### 16.5 Outside-in checks

From the Windows VPS every 60 s: TCP to `acs.thediv.in` on 7547, 443 and 80, and HTTPS to the Ubuntu API health URL (O4). Three consecutive failures raise `host.probe_failed`. The watchdog gets the Ubuntu API as a second target.

### 16.6 Remote actions

- Same button, same permission (`can_operate`), same confirmation and audit as for PM2.
- The monitor queues the command; the agent fetches it with a long-poll over its existing outbound connection and reports the result. No server opens a port.
- A command names only a service id and one of start, stop, restart. The agent checks again that the container exists, is a compose service of an allowed project, and is not the agent, its proxy, or labelled `cc.actions=off`.
- A command not picked up within 60 seconds expires and is shown as "host did not respond".
- The proxy allows only start, stop and restart POST calls; it allows nothing else that changes state.
- The owner can switch actions off on the host itself (`CC_ACTIONS=off`), which the monitor shows.
- A Stop mutes "service down" for that service, as for PM2.

### 16.7 Data model and alerts

- `hosts` table; the Windows VPS is host 1. Services gain a host and a kind (`pm2`, `container`). Names are unique per host. Migration `010`; no table references `services` by foreign key, so the rebuild runs inside the normal migration transaction.
- Alert fingerprints for host-level targets on hosts other than 1 carry the host, so existing Windows incidents keep their fingerprints and stay open across the upgrade.
- New rules: `host.silent` (no agent data for 2 minutes, critical), `host.probe_failed` (critical), `monitor.backup_stale` (warning, local and offsite), `host.auth_failures_high` (failed SSH logins per hour, warning, off by default). Existing host, service, gateway and Mongo rules apply per host.
- The UI gains a Hosts page and a host switcher.

### 16.8 Deviations this creates (approved 2026-10-29)

- Multi-host was a v1 non-goal.
- Application logs from Ubuntu cross the internet (TLS) and are stored on `E:`.
- A third public route carries data in.
- The monitor can change the state of containers on another server.

### 16.9 Build order and effort

| Step | Scope | Days |
|---|---|---|
| M1 | Migration `010`, hosts, enrollment, `/agent/v1/*`, Hosts admin UI, Nginx route | 4 to 5 |
| M2 | Agent and proxy: host metrics, containers, events, `host.silent`, image in GHCR | 4 to 5 |
| M3 | Log shipping, per-host search and tail | 2 to 3 |
| M4 | Mongo, Caddy, relay, backups, fail2ban and SSH counts, probes, watchdog targets | 4 to 5 |
| M5 | Remote actions | 3 to 4 |
| M6 | Host switcher on every page, Hosts overview, per-host rules, host in emails | 3 to 4 |

About 20 to 26 days, plus about 15% for on-host checks. M1 and M2 alone put the Ubuntu host and its containers on the dashboard with alerts. Phase 10.5 (4 to 5 days) comes first.

### 16.10 Acceptance

- The Ubuntu host appears within a minute of starting the agent, with CPU, memory, swap, disks and every `acs` container.
- Stopping `cpe-sim` on the server shows it stopped and opens an alert; starting it resolves the alert.
- An operator restarts `cpe-sim` from the browser; the audit names them; the agent refuses a command for `cc-node-agent`.
- Container logs are searchable next to Windows service logs; a burst above the limit is counted.
- Stopping the agent raises `host.silent`; blocking port 7547 raises `host.probe_failed` while the agent stays green.
- A backup older than 26 hours, or no offsite upload for 26 hours, raises `monitor.backup_stale`.
- No Caddy request path or client address appears anywhere in the monitor.
- Revoking the host token stops all data and all commands for that host.
- Nothing from the monitor is installed on the Ubuntu server except the two images.
