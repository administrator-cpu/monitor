# Implementation Plan: Self-Hosted Command Center

**Version:** v3, 2026-10-29 (replaces v2)
**Companion to:** `prd.md`, `trd.md`, `backend-schema.md` (all v3)

v3 follows a review of the repository at `c00d968`. Phases 1 to 10 are built. Phase 10.5 fixes what the review found in the code. Phase 11 adds the Ubuntu server as a remote host, with the owner's decisions of 2026-10-29. Appendix A lists every finding and where it is handled.

---

## 0. Status

### 0.1 Phases

| Phase | Scope | Status | Notes |
|---|---|---|---|
| 0 | Prerequisites | Done except backups | H7 |
| 1 to 9 | Windows VPS monitoring | Built | On-host checks in 0.3 |
| Deploy | Self-deploy pipeline | Built | Runs on pushes to `main` that touch backend paths |
| Public milestone | `monitor-api.thediv.in` public | Done with open items | Section 4 |
| 10 | Parts 0, A, B, C | Built | Pushed directly to `main` in `e31724b` on 2026-10-09, not as four pull requests; the deploy run's result is not recorded (V18) |
| 10.5 | Audit fixes H1 to H9 | In progress | H1 repository part on branch `h1/repo-hygiene`; branch protection is the owner's step. H2 to H8 code done on the same branch, server checks pending. About 4 to 5 days |
| 11 | Multi-host M1 to M6 | Planned | About 20 to 26 days |
| later | TOTP, more alert channels | Not started | |

### 0.2 What happens next

1. **H1 first:** protect `main`, restore `.env.example`, update the README. After this every change is a pull request.
2. **Decide O1** (move `monitor-api` out of PM2). If yes, do H9 before M1.
3. **H2 to H8**, one small pull request each, each checked on the server (0.3).
4. **Run the open on-host checks** V1 to V18 and record results here.
5. **Owner inputs for phase 11:** O4 (health path), O5 (backup folder and offsite marker), O6 (Caddy log to file), plus the M2 facts V20 to V24.
6. **Phase 11** from M1 to M6. M1 and M2 already put the Ubuntu host on the dashboard with alerts.
7. **Before M5 is switched on:** decide O3 (TOTP per action or Cloudflare Access).

### 0.3 On-host checks (canonical list)

Every [Verify] in the four documents points here. Tick with a date and result, or turn the item into a bug.

| # | Check | Phase | Result |
|---|---|---|---|
| V1 | One-hour idle run: RSS under 500 MB, CPU under 10% of a core, event loop lag p95 under 50 ms | 1 | Open |
| V2 | Sessions survive `pm2 restart monitor-api` | 1 | Open |
| V3 | `git --version` works for the account running `monitor-api`; the VPS reaches `api.github.com` | A | Open |
| V4 | Start on a stopped PM2 process brings it online | C | Open |
| V5 | A Resend test event reaches `/webhooks/resend` through Nginx, passes the signature and appears on the Email page | B | Open |
| V6 | An engineer without "Can operate" gets 403 and no buttons; the flag survives a user edit | C | Open |
| V7 | Production `SQLITE_PATH` and `LOG_ROOT` values, on different volumes | Deploy | Open |
| V8 | The account `monitor-api` runs as (O2) | Security | Open |
| V9 | The Nginx tailer follows log rotation | 6 | Open |
| V10 | cron-job.org failure notification is on | 5 | Open |
| V11 | Ports 4111 and 4001 unreachable from outside (port scan) | Public | Open |
| V12 | Which password library is active (`bcrypt` or `bcryptjs`), from the startup log | 1 | Open |
| V13 | Windows disk I/O shows numbers, not blanks | 3 | Open |
| V14 | Database size after 8 days against the 164 MB projection | 9 | Open |
| V15 | Part 0: `chatty` and `crasher` archived; `D:` gone with its alert resolved; `C:`, `E:`, `F:` unchanged | 0 | Open |
| V16 | Part A: each service mapped (D7); a service behind shows "N behind"; `monitor-api` shows its deployed commit | A | Open |
| V17 | The UI checked once on a real phone | 2 | Open |
| V18 | The deploy run for `e31724b` succeeded (GitHub Actions log) and `.deploy-sha` matches `main` | 10 | Open |
| V19 | After H7: a restore from the nightly backup works | 10.5 | Open |
| V20 | Ubuntu: name of the `acs` compose network and of the Mongo service; full container list | 11 (M2) | Open |
| V21 | Ubuntu: a non-root container with `pid: host` can read `/proc/1/net/dev` | 11 (M2) | Open |
| V22 | Ubuntu: `/var/log/auth.log` and `/var/log/fail2ban.log` exist and are group `adm` | 11 (M4) | Open |
| V23 | Ubuntu: Caddy writes JSON access logs to a file in a named volume and not to stdout (O6) | 11 (M4) | Open |
| V24 | Ubuntu: backup folder path and the `.offsite-ok` marker after an upload (O5) | 11 (M4) | Open |

### 0.4 Change log

| Version | Date | Change |
|---|---|---|
| v1 | 2026-10-08 | Phases 0 to 10, actions with TOTP last |
| v2 | 2026-10-29 | Phases 1 to 9 built, Parts 0 to C delivered, phase 11 proposed |
| v3 | 2026-10-29 | Parts 0 to C recorded as built. Phase 10.5 added from the code review. Phase 11 approved with the owner's decisions, extended with remote actions (M5) and a separate UI step (M6), migrations renumbered to `010` to `012`. One canonical on-host list. Appendix A with every finding |
| v3 | 2026-10-29 | Documents moved into `docs/` (H1). H1 repository items done in the H1 pull request; branch protection left to the owner |

---

## 1. Ground Rules

| Rule | Status |
|---|---|
| Read-only until the action phase, actions only with TOTP | Changed 2026-10-09: actions with login and `can_operate`. TOTP is decision O3 |
| Localhost until HTTPS | Followed |
| Verify on the real server | Required for every step; list in 0.3 |
| One migration per step that changes the schema | `008` and `009` for Parts A and B; `010` (M1), `011` (M4), `012` (M5) |
| Persistence arrives with each collector | Followed |
| Every phase ends with a demo | `pnpm demo`, extended to two hosts in M2 |
| **Every change through a pull request with green CI** | **Broken once** (`e31724b`, direct push). Enforced by branch protection in H1 |
| Documents stay current | Status labels here and in the PRD updated after each merge and check |

### 1.1 Repository layout

```
command-center/
  apps/
    backend/        Fastify API, WebSocket, collectors, alert engine, webhook, agent ingest (M1)
    frontend/       Next.js UI
    watchdog/       Render service (no shared code)
    node-agent/     cc-node-agent image (M2, planned)
    docker-proxy/   cc-docker-proxy image: HAProxy allowlist (M2, planned)
  packages/
    agent/          @cc/agent for the MERN services
    shared/         Zod schemas and types
  scripts/          deploy.ps1, install-service.ps1, uninstall-service.ps1
  docs/             runbooks and the four documents (moved here in H1)
```

Server folders: repository `C:\Apps\command-center`, deploy `C:\Apps\command-center-deploy`, previous release `C:\Apps\command-center-deploy.prev`, database `C:\monitor\data`, deploy backups `E:\monitor-backups\deploy` and nightly backups `E:\monitor-backups` (H7; `C:\monitor\backups` before).

### 1.2 Tooling

TypeScript strict, pnpm 10, Vitest, Playwright, Prettier. CI on GitHub's Linux runners for every pull request and push; a self-hosted runner on the VPS deploys the backend. Phase 11 adds a CI job that builds and pushes the two agent images to GHCR on `main`.

---

## 2. Prerequisites and Owner Inputs

| # | Input | Needed for | Status |
|---|---|---|---|
| O1 | Move `monitor-api` to a Windows service | H9, before M1 | Decision (recommended yes) |
| O2 | Account the backend runs as | V8 | Open |
| O3 | TOTP per action or Cloudflare Access | Before M5 is switched on | Decision (recommended yes) |
| O4 | Health URL of the Ubuntu API | M4 | Open |
| O5 | Ubuntu backup folder; backup script writes `.offsite-ok` after each upload | M4 | Open |
| O6 | Caddy access log as JSON to a file in a named volume | M4 | Open |
| O7 | Tenant resolver per service | Ongoing | Open |
| O8 | Resend plan limits | Ongoing | Open |
| O9 | Repo, branch, folder per service | V16 | Open |
| — | GHCR read-only pull token for the Ubuntu server | M2 | Open |
| — | Read-only Mongo user on Ubuntu (`clusterMonitor`) | M4 | Open |
| — | Offsite location for the monitor's backups (e.g. the same encrypted Google Drive remote) | H7 | Open |

---

## 3. Phases

### Phases 1 to 9 [Built]

All tasks done; deviations recorded in the TRD. Open items are in 0.3 and appendix A. Production runs under PM2 as `monitor-api` instead of the NSSM service from the phase 1 runbook.

### Phase 10: Parts 0, A, B, C [Built]

Scope approved 2026-10-09 (D1 to D10). Code, tests and two migrations (`008_github.sql`, `009_email.sql`) merged in `e31724b`. Test run on `main` for v3: 364 backend, 42 watchdog, 15 agent tests pass; typecheck clean.

Acceptance on the server: V3 to V6, V15, V16, V18. Not yet recorded.

---

### Phase 10.5: Audit Fixes [In progress]

Small pull requests, each with tests, merged and checked one at a time.

#### H1: Change safety and repository hygiene (0.5 day)

- [ ] Protect `main` on GitHub: require a pull request and the CI check; no force pushes. (Owner, in the repository settings.)
- [x] Restore `apps/backend/.env.example` with every variable in TRD 9.1, `PORT_API=4111`, and the Part A and B variables.
- [x] Add `apps/frontend/.env.example` with `NEXT_PUBLIC_API_BASE`.
- [x] Update the README: phase status (10 built), "actions exist" instead of "read-only by design", 29 rules, port 4111, test counts, links to the documents.
- [x] Move `prd.md`, `trd.md`, `backend-schema.md`, `implementation-plan.md`, `plan-pm2-github-resend.md` into `docs/`.

Acceptance: a direct push to `main` is refused; a fresh clone can follow the README quick start.

#### H2: Auto-archive guard (0.25 day)

- [x] In `pm2/collector.ts`, run auto-archive only if PM2 listed at least one process other than the monitor itself (by name and by `pm_id`) and other than modules.
- [x] Test: PM2 lists only `monitor-api` → nothing is archived.

#### H3: Ranges capped at retention (0.5 day)

- [x] `POST /logs/search` accepts at most `logs.retention_hours`; the UI picker offers no more.
- [x] History routes accept at most `retention.metrics_days`; the UI picker matches.
- [x] Tests for both limits and for a changed setting.

Done as patch 0003: both limits are read from the settings on each request (`src/limits.ts`), so a change applies without a restart. `GET /limits` gives the pickers the same values; a limit between presets is offered as its own last option ("Last 48 hours"). The tenant history route uses the history limit too. The history picker's span was one minute longer than the label; it is now exact.

#### H4: Nginx top lists removed (0.25 day)

- [x] Remove `topPaths` and `topClientIps` from `NginxState`, the aggregator and the Nginx page; remove the `nginx.top_n` setting.
- [x] The page states that paths and client addresses are not logged.

Done as patch 0004. A `nginx.top_n` row already stored in the production database is ignored on load and no longer listed; setting it is refused as an unknown key, so no migration is needed. The parser still reads optional `uri` and `ip` (unused). Server check: the Nginx page shows no top lists and shows the note under "Traffic by service".

#### H5: Git arguments (0.1 day)

- [x] Add `-c core.fsmonitor=false` to every git call in `github/local.ts`; test the argument list.

Done as patch 0005. The arguments are built in one place (`gitArgs`), so every call gets both `-c` options before `-C`. A second test plants a program in a repository's `core.fsmonitor`, checks that a plain `git status` starts it, and checks that `readLocalCommit` does not. `deploy.ps1` passes the same option to its one `git rev-parse`. No server check beyond V3 and V16: the git status card still shows the commit.

#### H6: Stop mute after a restart (0.25 day)

- [x] On Start, delete mutes for that service on `pm2.service_down` created by a dashboard Stop, found in the database rather than in memory.
- [x] Test across a new `ServiceActions` instance.

Done as patch 0006. The in-memory map is gone. Start and Restart delete that service's mutes on `pm2.service_down` whose reason starts with "Stopped from the dashboard by " and that have not ended (`AlertRepo.deleteServiceMutes`). A mute an admin made by hand has another reason and stays; ended stop mutes stay as history. A second Stop replaces the first stop mute. No migration. Server check: stop a test service, `pm2 restart monitor-api`, start the service; Alerts > Mutes no longer lists the stop mute.

#### H7: Backups (1 day)

- [x] Scheduler job `backup`, daily at 02:30 local: `VACUUM INTO E:\monitor-backups\monitor-YYYYMMDD.db`, keep 14, recorded in `maintenance_runs`; failures show through `monitor.collector_stale`.
- [x] `deploy.ps1`: `BackupDir` to `E:\monitor-backups\deploy`.
- [ ] Owner: a Windows scheduled task copies the newest backup offsite (e.g. `rclone` to an encrypted remote). Script ready: `scripts/backup-offsite.ps1`.
- [x] Runbook: restore steps (stop, copy, start, check): `docs/runbook-backups.md`, with `scripts/check-backup.ps1` for the test on a copy.
- [ ] Do one restore on a copy (V19).

Code done as patch 0007 (`src/backup.ts`). The job looks every 10 minutes and writes the day's file once it is past 02:30 server time; it writes to `.partial`, runs `PRAGMA quick_check` on the copy and renames it, then keeps the newest `backup.keep` (14, new setting) nightly files. Before 02:30 it fails while yesterday's file is missing (unless the folder has no backups yet), so a lost day keeps the alert open. New variable `BACKUP_DIR`: default `E:\monitor-backups` on Windows, off elsewhere, `off` switches it off. Deploy backups go to `E:\monitor-backups\deploy`; the old `C:\monitor\backups` is left for the owner to delete. Owner steps on the server: rclone with a `crypt` remote, the scheduled task, and V19 (runbook sections 2 and 3). Server check: after the first night, today's file exists and there is no "Collector stale" for `backup`.

#### H8: Nginx limits and exposure (0.25 day)

- [x] `limit_req` on `/webhooks/` and `/api/v1/logs/search` (configuration in `docs/runbook-nginx.md`; applying it on the server is the owner's step).
- [ ] Port scan from outside (V11) and record the result.

Done as patch 0008 (documents and a test; no backend code). Limits per client address: webhooks 120 per minute with a burst of 60 and bodies up to 256 KB; log search 6 per minute with a burst of 5, CORS preflights not counted. The auth and search limits answer 429 with the app's JSON error shape and the dashboard's CORS headers, so the page shows "Too many requests" instead of a network error. `apps/backend/test/nginx-config.test.ts` runs the runbook's blocks through `nginx -t` and a burst test wherever nginx is installed and is skipped elsewhere; check in the CI log whether it ran. Owner steps: apply and reload (runbook section 3), then the port scan (section 4, V11).

#### F1: Host collector hangs on Windows (found after the H1 to H8 merge)

- [x] Symptom: "Collector stale" for `host` about every 3 hours on 2026-10-29, each lasting 30 to 50 minutes ("previous run still in flight"); CPU, memory, swap and network showed stale.
- [x] Cause: on Windows `systeminformation` runs `powershell.exe` for `mem()` (page file), `networkStats()` (adapter statistics and the adapter list) and `fsSize()` without any timeout. The `host` collector started several of them every 2 s; when one hung on WMI, the run stayed in flight and no new run started.
- [x] Fix, patch 0009 (`collectors/winhost.ts`): on Windows the 2 s collector reads CPU and memory from Node and starts no process; a new `swapnet` collector reads swap and the network byte counters with one script every 15 s; disk sizes come from one script; both through `runPowerShell`, which kills the process after its timeout. Linux keeps `systeminformation` (it reads `/proc`). 5 new tests.
- [ ] Server check: no "Collector stale" for `host` for a day; the Overview's CPU, memory, swap and network stay live; Task Manager does not show a new `powershell.exe` every 2 s. Network rates now update every 15 s.

#### H9: `monitor-api` outside PM2, if O1 is yes (1 day)

- [ ] Install with `scripts/install-service.ps1` under the account that owns PM2 (so `PM2_HOME` and the PM2 pipe remain reachable).
- [ ] `deploy.ps1`: replace `pm2 restart` and the PM2 checks with `Restart-Service` and service status; keep the health and stability checks; remove the process from PM2 afterwards.
- [ ] Part C self-protection keeps working (the name check no longer matters, the `pm_id` check is harmless).
- [ ] Runbook updated; V2 rechecked with `Restart-Service`.

Acceptance for 10.5: every H item merged through a pull request, its test green, its check in 0.3 recorded.

---

### Phase 11: Multi-Host Monitoring [Planned]

**Goal:** the Ubuntu server (`ubuntu-acs`) monitored and operable from the same dashboard through `cc-node-agent` and `cc-docker-proxy`. Requirements PRD 16, design TRD 14, data schema 13.

**Starts when:** H1 is done (branch protection), O1 is decided, and a production database copy is available for testing `010`.

#### M1: Hosts, ingest, enrollment (4 to 5 days)

- [ ] Migration `010_hosts.sql` (schema 13.1 to 13.3), timed on a production copy; existing tests unchanged.
- [ ] `ServicesRepo` keyed by `(host_id, source_key)`; DTOs gain `hostId`, `kind`, `sourceKey` (keep `pm2Name`).
- [ ] State store keyed by host; host 1 fed by today's collectors.
- [ ] Fingerprint helper: host-scoped targets on hosts other than 1 prefixed `@<id>/`.
- [ ] Enrollment and host tokens (hashed, single use, 1 hour), revoke, re-enroll.
- [ ] `/agent/v1/enroll`, `metrics`, `logs`, `events`, `app` in their own scope: Zod, gzip with decompressed limits, per-host and global limits, version check, clock skew, `Origin` refused, no cookies.
- [ ] Hosts admin page: list, add (shows the enrollment token and compose snippet once), revoke, re-enroll; audit events.
- [ ] Nginx: `/agent/` location, `client_max_body_size 2m`, `limit_req`, read timeout above 30 s.
- [ ] `host.silent` rule and evaluator.

Acceptance: `010` on the production copy leaves every page, rule and open incident unchanged; an enrollment token works once and not after an hour; a revoked token gets 401; a 100 KB gzip body that inflates past the limit gets 413; a request with `Origin` gets 403.

#### M2: Agent, proxy, host and containers (4 to 5 days)

- [ ] `apps/docker-proxy`: HAProxy config with the TRD 14.4 allowlist and `ALLOW_ACTIONS`; CI test that every forbidden path returns 403.
- [ ] `apps/node-agent`: host metrics from `/proc` and `statfs` (TRD 14.5), container list, stats and events through the proxy, restart counting, push every 10 s with retry and backoff, token on the state volume.
- [ ] Discovery and auto-archive of compose services, same rules as PM2.
- [ ] CI builds both images and pushes to GHCR on `main`.
- [ ] Compose file and runbook "Adding a host" (enroll, env file, `docker compose up -d`, check).
- [ ] Minimal host switcher so Host and Services pages work for host 2.
- [ ] `pnpm demo` with two hosts (fake Docker API and fixture `/proc`).
- [ ] On the server: V20, V21.

Acceptance: the Ubuntu host appears within a minute of `docker compose up -d` with CPU, memory, swap, disks and every `acs` container; stopping `cpe-sim` on the server opens "service down" and starting it resolves; stopping the agent raises `host.silent` and hides that host's other alerts.

#### M3: Logs (2 to 3 days)

- [ ] Follow stdout and stderr per container; batches every 1 s or 256 KB; gzip.
- [ ] 200 lines/s per container, dropped counts, 64 KB line cut, `log_excluded` toggle on the service page.
- [ ] 50 MB disk buffer on the state volume while the monitor is unreachable.
- [ ] Backend writes `LOG_ROOT\@ubuntu-acs\<project>.<service>\`; host 1 paths unchanged.
- [ ] Search across hosts or per host; live tail per container.
- [ ] Measure the GenieACS line rate for a day and record it against TRD 14.12.

Acceptance: container logs searchable next to Windows logs; a burst above the limit is counted; a 10-minute monitor outage loses nothing below the buffer size; an excluded container ships nothing.

#### M4: Mongo, Caddy, relay, backups, security counts, probes, watchdog (4 to 5 days)

- [ ] Migration `011_remote_checks.sql` (schema 13.4).
- [ ] Mongo collector in the agent over the `acs` network (read-only user).
- [ ] Caddy access log tailer with the field allowlist; certificate checks by SNI to the Caddy container; second filter on the Caddy container's stdout.
- [ ] Relay on port 4002 with `CC_RELAY_TOKEN`; the Express API's `createMonitor({ url, service, token })` set to it.
- [ ] Backup age and `.offsite-ok`; `monitor.backup_stale` for `local` and `offsite`.
- [ ] fail2ban and SSH failure counts from mounted logs; `host.auth_failures_high` (off by default).
- [ ] Outside-in probes on the Windows backend (TCP 7547, 443, 80; HTTPS health); `host.probe_failed`; not suppressed by `host.silent`.
- [ ] Watchdog `TARGETS` with one state machine per target; tests for two targets.
- [ ] On the server: V22, V23, V24.

Acceptance: a backup older than 26 hours, or no offsite marker for 26 hours, raises `monitor.backup_stale`; blocking 7547 raises `host.probe_failed` while the agent stays green; stopping the Ubuntu API fails its watchdog target and not the monitor's; a search for a known request path or client address in every monitor table and log file finds nothing.

#### M5: Remote actions (3 to 4 days)

- [ ] Migration `012_agent_commands.sql`.
- [ ] `POST /services/:id/actions` for container services: queue, 202, `GET /api/v1/commands/:id`; guard, busy, cooldown, host status checks; audit `service_action_requested`.
- [ ] `commands/next` long-poll (25 s, one per host) and `commands/:id/result`; expiry job (60 s); single use.
- [ ] Agent: re-checks (listed, project allowed, not itself or the proxy, no `cc.actions=off`, `CC_ACTIONS` on), proxy call, state wait, result.
- [ ] Stop mute and Start unmute as for PM2.
- [ ] Actions card works for container services; shows "actions off on this host" when reported.
- [ ] O3 decided and, if yes, in place before the feature is switched on.

Acceptance: an operator restarts `cpe-sim` from the browser and the audit names them; a command for `cc-node-agent` is refused and audited; with the agent stopped a command expires after 60 s as "host did not respond"; an engineer without "Can operate" gets 403; `ALLOW_ACTIONS=0` on the proxy makes every action fail safely.

#### M6: UI and per-host rules (3 to 4 days)

- [ ] Hosts overview page (status, last contact, agent version, actions on or off, open incidents, probes).
- [ ] Host switcher on every page, remembered per user.
- [ ] Per-host and per-service threshold overrides for remote services (`@<host id>/<source key>`).
- [ ] Host name in alert emails, incident list and audit view.
- [ ] Playwright with two hosts.

Acceptance: every page works for both hosts; emails name the host; revoking the host removes it from live views and keeps its history.

#### Phase 11 risks

| Risk | Mitigation |
|---|---|
| `010` damages production data | One transaction; no foreign keys to `services`; tested and timed on a copy; pre-deploy backup |
| GenieACS logs fill `E:` | Per-container limit, exclusions, measurement in M3 |
| Public ingest attacked | Hashed tokens, size and rate limits, decompressed cap, version check, `Origin` refused, Nginx `limit_req` |
| Docker access abused | Allowlisting proxy without inspect, archive, export, exec or create; agent never mounts the socket |
| A remote action hits the wrong container | Key resolved on the monitor and re-checked by the agent; own containers refused; single-use, expiring commands |
| Monitor down means no host is monitored | Watchdog target per host; O1 |
| Agent and proxy images drift | Pinned by digest after M2; updated by the owner |

---

## 4. Public Deployment Milestone [Done, with open items]

| Precondition | Status |
|---|---|
| HTTPS with renewal, CORS allowlist, cookie flags, login throttling, WSS | Done |
| Nginx `limit_req` on `/api/v1/auth/` | Done |
| `limit_req` on `/api/v1/logs/search` and `/webhooks/` | H8 (configuration ready; apply on the server) |
| Ports 4111 and 4001 not reachable from outside | V11 |
| Long, unique passwords on every account | Owner to confirm |
| Backup of the monitor database off the drive and off the server | H7 |
| Watchdog on `/health` | Done |
| Branch protection | H1 |

Phase 11 adds `/agent/v1/*` as a public route (M1) and repeats the port scan after M1.

---

## 5. Cross-Cutting Work

| Area | Next |
|---|---|
| Security review | After 10.5; again before M1 merges (public ingest) and before M5 is switched on (remote actions) |
| Failure injection | PM2 unreachable during an action; GitHub down; bad webhook; agent cut off; monitor down while the agent buffers; agent stopped while a command is queued |
| Runbooks | Parts 0 to C (from the PR notes), H7 restore, H9 service install, "Adding a host", "Rotating or revoking a host" |
| Documents | Status labels updated after each merge and check |
| Secrets | `GITHUB_TOKEN`, `RESEND_WEBHOOK_SECRET`, host tokens, enrollment tokens, `CC_RELAY_TOKEN`, Ubuntu Mongo user, GHCR pull token; rotation steps in the runbooks |

---

## 6. Effort

v1 estimated 58 to 78 days for phases 1 to 10 and was dated 2026-10-08. The repository's history starts on 2026-10-09 with the full code base imported in one commit, so actual effort per phase cannot be derived from it. Actual days are recorded from phase 10.5 on.

| Step | Estimate | Actual |
|---|---|---|
| 10.5 (H1 to H9) | 4 to 5 days | |
| M1 | 4 to 5 days | |
| M2 | 4 to 5 days | |
| M3 | 2 to 3 days | |
| M4 | 4 to 5 days | |
| M5 | 3 to 4 days | |
| M6 | 3 to 4 days | |
| **Phase 11** | **20 to 26 days**, plus about 15% for on-host checks | |

v2 estimated 15 to 20 days for phase 11. v3 adds remote actions (M5), the proxy image, a host `/proc` reader instead of `systeminformation`, the Caddy filter and the relay design, and the security counts.

**Useful stopping points:** after M2 (Ubuntu host and containers with alerts), after M4 (full read-only monitoring), after M5 (remote actions).

---

## 7. Risks

| Risk | Status or mitigation |
|---|---|
| Direct pushes to `main` deploy without review | H1 |
| The monitor dies with PM2 | Watchdog today; H9 |
| The backend runs with Administrator rights | V8; accepted while PM2 runs there |
| Password-only public API with actions behind it | O3 before M5 |
| Database lost with `C:` | H7 |
| Tenant resolvers not written | O7 |
| Estimates optimistic | Actuals recorded from now |
| Phase 11 risks | Listed under phase 11 |

---

## 8. Definition of Done

- All tasks of the step checked.
- Merged through a pull request with green CI (never a direct push).
- Acceptance shown on the real server and recorded in 0.3, not only locally.
- A migration applied cleanly to a copy of the production database, with its run time recorded.
- The TRD failure rows for the step tested.
- Runbook entries written.
- Status labels in all four documents updated.
- `pnpm demo` runs from a clean state.
- For phase 11: also passes on the Ubuntu server itself.

---

## Appendix A: Review Findings and Where They Are Handled

### A.1 Found in the code (fixed in phase 10.5 or recorded)

| # | Finding | Evidence | Handled by |
|---|---|---|---|
| 1 | Parts 0 to C pushed directly to `main`, bypassing pull requests | `git log`: `e31724b` "update actions" after merged PR #2 | H1 |
| 2 | `apps/backend/.env.example` deleted; README still copies it; no frontend example | `e31724b` stat; README quick start | H1 |
| 3 | README says phase 10 not started and "no route that starts, stops or restarts" | `README.md` | H1 |
| 4 | Auto-archive guard always passes because `monitor-api` is listed | `pm2/collector.ts` (`live.length > 0`) | H2 |
| 5 | Log search accepts 7 days, files kept 24 hours | `routes/logsearch.ts` `MAX_RANGE_MS` | H3 |
| 6 | History accepts 31 days, metrics kept 7 days | `history.ts` `MAX_RANGE_MS` | H3 |
| 7 | Top paths count everything as `/`; top IPs always empty; page still shows both | `nginx/aggregate.ts`, `nginx/page.tsx` | H4 |
| 8 | `git status` can start a program configured by the repository (`core.fsmonitor`) | `github/local.ts` | H5 (fixed) |
| 9 | Stop mute link kept in memory only | `pm2/actions.ts` `muteOf` | H6 (fixed) |
| 10 | Backups only on `C:`, no nightly or offsite copy, no restore test | `deploy.ps1` `BackupDir` | H7 (code done; offsite task and V19 open) |
| 11 | No `limit_req` on `/webhooks/` and `/logs/search` | Runbook phase 1 Nginx block | H8 (configuration in `runbook-nginx.md`; apply and V11 open) |
| 12 | Monitor shares fate with PM2 | Deployment | H9 (O1) |
| 13 | Production port is 4111, documents said 4000 | `deploy.ps1` `-Port 4111`, former `.env.example` | Documents v3 |
| 14 | Webhook codes 503 and 401, documents said 404 and 400 | `routes/webhooks.ts` | Documents v3 |
| 15 | Email buckets 10 minutes; ids kept 30 days | `email/stats.ts`, `retention.ts` | Documents v3 |
| 16 | Two migrations `008_github`, `009_email`; multi-host was planned as `009` | `apps/backend/migrations` | Documents v3 (`010` to `012`) |
| 17 | All "verify against the code" items | Various | Resolved in TRD 12 and schema v3 |

### A.2 Found in the v2 multi-host design (fixed in the v3 design)

| # | Problem in v2 | v3 design |
|---|---|---|
| 18 | Agent container reads its own `/proc`, network and disk, not the host's | Host `/proc` values, `pid: host` network counters, `statfs` on a read-only host mount (TRD 14.5) |
| 19 | Relay on `127.0.0.1` unreachable from the API container | Relay on the `acs` compose network, port 4002, own token |
| 20 | Mongo at `127.0.0.1:27017` unreachable from the agent | Agent joins the `acs` network; Mongo by service name |
| 21 | Agent must save its token but has a read-only filesystem and a root-only env file | One writable state volume |
| 22 | TRD `hosts` seed in seconds; `REFERENCES` on `ADD COLUMN` that SQLite rejects | Schema 13 only; metric tables rebuilt without foreign keys |
| 23 | `PRAGMA foreign_keys = OFF` inside the runner's transaction does nothing | Not needed: no foreign keys to `services` |
| 24 | Docker proxy "read-only" still exposes inspect (all environment variables), archive and export | Allowlist without inspect; restarts from events |
| 25 | Caddy logs would carry paths, query strings and client addresses | Field allowlist on read; Caddy logs to a file; second filter on stdout; nothing raw stored |
| 26 | gzip limits on compressed size only | Decompressed caps |
| 27 | `fail2ban-client` needs root and can unban | Log parsing only, group `adm` |
| 28 | `host.silent` would hide `host.probe_failed` | Probes exempt |
| 29 | Rewriting existing fingerprints on upgrade | Host 1 fingerprints unchanged; prefix only for other hosts |
| 30 | Host named `acs`, same as the project and a hostname; `/` in folder names | Host `ubuntu-acs`; folders `@<host>\<project>.<service>` |
| 31 | Only local backups checked | Offsite marker as a second target |
| 32 | Remote actions not designed | Agent-pulled, expiring, single-use commands (TRD 14.7) |
| 33 | Inconsistent rule lists, `hosts` columns, `kind` values and verify lists across documents | One definition each, in the schema and in 0.3 |
