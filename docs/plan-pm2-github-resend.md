# Plan: PM2 actions, GitHub read-only, Resend delivery monitoring

**Status:** **Approved.** On 2026-10-09 you accepted decisions D1 to D10 exactly as recommended in section 7, and added two fixes (section 3A). Building starts now.
**Based on:** the repo as of commit `d51895a` (after pull request #2), read from the zip you sent. Companion to `aim-pm2-github-resend.md`.
**Delivery:** I cannot push to your private repo (the GitHub connection I have only sees public repos), so the work is delivered as **a zip of the changed files plus git patch files**, built on top of `d51895a`. You apply it, open a pull request, and the pipeline deploys it as before.

---

## 1. Summary

Two fixes and three additions, kept as **separate commits (one patch file each), in this order**, so they can also go through as separate pull requests:

| Order | Part | What you get | Risk |
|---|---|---|---|
| 0 | Two fixes | Services you deleted from PM2 disappear from the dashboard by themselves. The DVD drive (D:) no longer triggers disk-full alerts. | Low |
| A | GitHub read-only | Per service: is the server behind or ahead of `main`, latest CI and deploy result, open pull requests | Low. Reads only. |
| B | Resend delivery monitoring | An **Email** page: sent, delivered, delayed, bounced, complained, failed, by sender domain | Medium. A new public endpoint, protected by Resend's signature. |
| C | PM2 actions | Restart, stop, start for named services, with a permission, a confirmation and an audit trail. No TOTP. | Highest. It changes production, so it goes last. |

Every merge to `main` deploys the backend to your server, so each part ships on its own and can be checked on the real server before the next one starts.

Only **one database migration** is needed (`008`), for parts A and B. Part C needs none, because the database already has the columns it needs.

---

## 2. What I found in the code (facts the design is built on)

| Finding | Where | Consequence |
|---|---|---|
| Backend is Fastify. Every route under `/api/v1` requires the `X-Monitor-Client` header on POST/PATCH/DELETE and checks the Origin. | `server.ts` | Resend cannot call a route under `/api/v1`. The webhook must live outside it, like `/health` does. |
| `requireUser` knows only one option, `admin`. Roles are `admin` and `engineer`. | `guard.ts`, shared schemas | Part C needs a new guard option. |
| `users.can_operate` **already exists** (migration 001, default 0) but nothing reads it. The TOTP columns also exist and stay unused. | `001_init.sql` | The Operator permission needs no migration. `UserDto` and the user schemas need to expose it. |
| `audit_log.event` is free text with no CHECK constraint. | `001_init.sql`, `audit.ts` | New audit events need only a code change. |
| The PM2 interface is read-only on purpose, and PM2 runs inside a worker thread that accepts only fixed operation names. | `pm2/types.ts`, `worker.ts` | Part C adds new operations carrying a process name. It does not loosen anything else. |
| Services are discovered from PM2, not created by hand. Admins can edit name, URL, notes through `PATCH /services/:id`. | `pm2/services.ts`, `routes/services.ts` | "Registered service" means a row in `services` that PM2 currently lists. Repo mapping fits next to the existing editable fields. |
| `alert_rules.category` and `alert_subscriptions.category` have a CHECK limiting them to `host, pm2, nginx, mongo, app, monitor`. | `003_alerts.sql` | New alert categories would mean rebuilding two tables on the production database. See decision D5. |
| `alert_notifications.provider_msg_id` stores the Resend email id of every alert email. | `003_alerts.sql`, `notifier.ts` | Webhook events can later be matched to your own alert emails (optional, D6). |
| The deploy script copies the code **without `.git`**, so the deploy folder is not a git repo. It writes `.deploy-sha` only at the end of a successful run, and writes it **empty** for a manual run. | `scripts/deploy.ps1` | For `monitor-api` the running commit comes from `.deploy-sha`. The script needs a small fix so manual runs record the real commit. |
| `ResendMailer` takes an injectable `fetch`. | `alerts/mailer.ts` | The same pattern gives a testable GitHub client. |
| Config is validated with zod, error messages never print values, and the startup summary shows only "set / not set" for secrets. | `config.ts` | New secrets follow the same rules. |

---

## 3A. Part 0: two fixes

### Fix 1: services you deleted from PM2 stay on the dashboard

**Cause.** This is how the monitor was designed: a service PM2 no longer lists is shown as "not running" until an admin archives it by hand (`pm2/collector.ts`). The Archive button exists only on each service's own page, so `chatty` and `crasher` (the test apps you deleted) stay on the Overview and Services lists indefinitely.

**Fix.**
- A service that PM2 has **not listed for 15 minutes** is archived automatically. The time is a new setting, `pm2.auto_archive_minutes` (default 15, `0` turns it off), editable on the Settings page.
- "Not listed" is measured with the service's stored `last_seen_at`, so it works across restarts, and the two existing test apps are archived on the first run after the deploy.
- A **stopped** process is still listed by PM2, so `pm2 stop` never triggers it. Only a `pm2 delete` (or a process that is really gone) does.
- It runs only when PM2 answered and listed at least one other service, so a PM2 outage cannot wipe the list.
- It is reversible: if PM2 lists the name again, the existing discovery logic restores the service. Archiving closes that service's open alerts quietly (existing behavior) and writes a `service_updated` audit entry attributed to `system`.

### Fix 2: false disk alerts from drive D:

**Cause.** `D:` is your DVD drive holding a 5 GB disc, so Windows reports it 100% full. The disk collector on Windows keeps every drive letter (`selectDisks` in `collectors/host.ts`), so the "disk usage high / critical" rules fire on it.

**Fix.**
- On Windows, optical file systems (`CDFS`, `UDF`, `ISO9660`) are excluded, so a DVD or a mounted ISO is never treated as a disk.
- An explicit escape hatch: a new optional env variable `DISK_EXCLUDE` (for example `D:,F:`) hides any other drive letters from the disk list and the alerts.
- Nothing else is needed for the alerts: the alert engine already closes an incident when its target stops being reported, so the open `D:` incident resolves by itself shortly after the deploy.

**Tests:** both fixes get unit tests (the collector's archive rule, including the "PM2 returned nothing" and "stopped is not deleted" cases, and the drive selection with a DVD in the list).

---

## 3. Part A: GitHub read-only

### What you see
- **Services list:** a small badge per service: *in sync*, *N behind*, *N ahead*, *diverged*, *dirty* (uncommitted changes on the server), or *unknown*.
- **Service page:** a "Code and deploys" card with the running commit, the latest commit on the branch, behind/ahead counts, the latest CI run and the latest deploy run (result, time, link), and the number of open pull requests.
- Admins edit the mapping (repo, branch, folder) on the same page.

### How it works
- **Local side (what is on the server):** for each service with a folder set, the monitor runs fixed read-only commands: `git rev-parse HEAD`, `git symbolic-ref --short HEAD`, `git status --porcelain`. It never fetches or pulls. For `monitor-api`, whose folder has no `.git`, it reads `.deploy-sha` instead.
- **Remote side (GitHub):** the GitHub API, using a read-only token:
  - branch head: `GET /repos/{repo}/branches/{branch}`
  - behind/ahead: `GET /repos/{repo}/compare/{serverSha}...{branch}`
  - runs: `GET /repos/{repo}/actions/runs?branch={branch}`
  - open pull requests: `GET /repos/{repo}/pulls?state=open`
- Using the compare call means the server never needs to `git fetch`, and "ahead" (a hotfix committed on the server and never pushed) shows up as well as "behind". A server commit that GitHub does not know shows as *not on GitHub*.
- Runs as a scheduler collector, every 5 minutes by default, with a "Refresh now" button. Conditional requests (ETag) keep it far below GitHub's rate limit.

### Data and settings
- Migration `008`: new columns on `services`: `git_repo`, `git_branch` (default `main`), `git_path`. New table `service_git`: one row per service holding the last result and when it was checked.
- Env: `GITHUB_TOKEN` (optional). Setting: `github.poll_minutes`.
- `PATCH /services/:id` accepts the three new fields (admin only) and writes them to the existing `service_updated` audit event.

### Safety
- The token stays in the backend env file, is never sent to the browser, never logged. The API host is fixed to `api.github.com`.
- `git_repo` must match `owner/name`. `git_path` must be an absolute path that exists. The git commands run with `execFile` (no shell), fixed arguments, a 10-second timeout and prompts disabled. Nothing the user types becomes part of a command line.
- Everything a logged-in user can already see stays visible to all users. Only the mapping is admin-only.

### Failure behavior
| Situation | What the page shows |
|---|---|
| No token set | "GitHub is not configured". Nothing else is affected. |
| Token rejected or expired | "GitHub rejected the token" with the time of the last good check. |
| Repo not visible to the token | "Repo not found or not shared with this token". |
| GitHub unreachable or rate limited | The last result, marked stale with its age. |
| Folder missing or git not found | "Cannot read the server's commit", with the reason. |

The collector is isolated by the scheduler, so a failure here cannot slow the rest of the monitor.

---

## 4. Part B: Resend delivery monitoring

### What you see
A new **Email** page (all logged-in users): for 24 hours, 7 days or 30 days, counts of sent, delivered, delayed, bounced (permanent, temporary), complained, failed and suppressed, with a delivery rate and a table by **sender domain**. It also shows when the last webhook arrived and whether the webhook secret is set.

### How it works
- Resend sends a signed `POST` to **`https://monitor-api.thediv.in/webhooks/resend`**. It is registered once in the Resend dashboard (Webhooks > Add endpoint).
- The route sits **outside `/api/v1`**, reads the **raw body** (Resend's signature breaks if the body is parsed and re-serialised), and checks the three Svix headers `svix-id`, `svix-timestamp`, `svix-signature` against the endpoint's signing secret. Anything unsigned, or with a timestamp outside a 5-minute window, is rejected.
- Resend retries failed deliveries (immediately, then 5 s, 5 min, 30 min, 2 h, 5 h, 10 h) and disables an endpoint that keeps failing. So each `svix-id` is remembered for a few days to **ignore duplicates**, and the route answers 2xx quickly for anything valid, including event types it does not use.
- Used events: `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`. Ignored: `opened`, `clicked`, `received`, `scheduled`.

### What is stored: counts only
- Table of counts per **hour, sender domain, event** (plus bounce type for bounces). The sender domain is taken from the `from` field.
- **Not stored:** recipient addresses, subjects, bodies, tags, message ids. A table of seen webhook ids (for duplicates) is the only per-event record, and it is pruned after a few days.
- No domain checks and no API-key checks, as you decided.

### Data, settings, config
- Migration `008`: `email_event_counts`, `email_webhook_seen`.
- Env: `RESEND_WEBHOOK_SECRET` (the `whsec_...` value). Setting: `retention.email_days` (default 30), added to the existing retention job.
- The route is rate limited in the app. Optionally add a limit for `/webhooks/` in `nginx.conf` too (a small change you make by hand).

### Alerts
One optional rule, reusing the existing alert engine: bounce or complaint spike over the last hour (see D5 for where it lives).

### Failure behavior
| Situation | Result |
|---|---|
| Secret not set | The endpoint answers 404, the page says "webhook not set up". |
| Bad signature or old timestamp | 400, nothing stored, counted in a diagnostic counter. |
| Duplicate delivery | 200, not counted twice. |
| Our database write fails | 5xx, so Resend retries. |
| Resend disables the endpoint | The page shows the time of the last webhook, so silence is visible. |

---

## 5. Part C: PM2 actions

### What you see
On the service page, an **Actions** card with **Restart**, **Stop** and **Start**, shown only to users who may operate. Each button asks for confirmation naming the service. The result and the new process state appear straight away, and the event shows up in the existing process-events list.

### Rules
- **Service id in, never a free name.** The request carries the service id. The backend looks up the PM2 name itself, and refuses unless the service exists, is not archived, is currently listed by PM2 and is not a PM2 module.
- **Permission:** the existing login plus the `can_operate` flag (see D1). Engineers without it get a 403 and never see the buttons. **No TOTP.** The reserved TOTP columns stay untouched.
- **Audit:** every attempt is written to the audit log with the person, service, action, result and error, as `service_action` and `service_action_failed`.
- **Limits:** one action at a time per service, a short cooldown, and a per-route rate limit.
- **No arbitrary commands.** Only restart, stop and start for the resolved process.
- **`monitor-api` itself is not restartable from the app** (D2): restarting it would cut the request that asked for it. The card says it is managed by the deploy pipeline.
- **Planned stops do not page you** (D3): a Stop can create a short alert mute for that service's "service down" rule, so a deliberate stop does not email the admins.

### How it works
- `Pm2Source` gets restart and stop operations. `Start` is PM2's restart of a stopped process (to confirm on the server). The worker message gains a process name field; everything else in the PM2 layer is unchanged.
- New route `POST /services/:id/actions` (body: `restart | stop | start`), guarded by a new `operate` option in `requireUser`.
- Frontend: the Actions card, a "Can operate" toggle in the user admin page, and `canOperate` in the user types.

### Failure behavior
PM2 unreachable gives 503 and an audit entry. A timeout gives an audit entry with the error and no blind retry. A repeated click while an action is running gets 409.

---

## 6. Cross-cutting

- **One migration, `008`:** `services` columns, `service_git`, `email_event_counts`, `email_webhook_seen`. It is tested against a copy of your real database before anything is merged.
- **New settings:** `pm2.auto_archive_minutes`, `github.poll_minutes`, `retention.email_days`, `actions.stop_mute_minutes`.
- **New env (all optional):** `GITHUB_TOKEN`, `RESEND_WEBHOOK_SECRET`, `DISK_EXCLUDE`. They go into the server's `.env` by you, never into git. The deploy never overwrites that file.
- **New audit events:** `service_action`, `service_action_failed`. Repo mapping changes reuse `service_updated`.
- **Tests (CI runs them on every pull request):** a GitHub client with a fake `fetch`; git reading through an injectable runner; signature vectors, duplicate and replay cases for the webhook; a fake PM2 source for the actions, including the permission and monitor-api cases; the migration on a copy of the production-shaped database; Playwright smoke tests for the three screens.
- **`scripts/deploy.ps1`:** a small change so a manual run records the real commit in `.deploy-sha` instead of an empty file. Since that file is in the workflow's path filter, merging it also triggers a deploy.
- **Deviations from your PRD and implementation plan:** (1) action endpoints will exist without TOTP, which the PRD forbids; (2) Git and Resend features are new scope. I will list these in the pull request and **will not edit the PRD, TRD or implementation plan unless you ask**. The runbook text for the new variables goes into the pull request description; the `docs/` folder is edited only on request.
- **How each part ships:** branch, pull request, green CI, you review, you merge, the self-hosted runner deploys, then we check it on the real server before starting the next part.

---

## 7. Decisions (all approved as recommended)

You answered "go with your recommendations" for D1 to D10. The right-hand column is what is being built.

| # | Question | Decision (approved) |
|---|---|---|
| D1 | Who may restart, stop and start? | Admins always; engineers only when "Can operate" is switched on for them. |
| D2 | Can `monitor-api` be restarted from its own screen? | No. Leave it to the deploy pipeline. |
| D3 | Should Stop create a short alert mute so a planned stop does not page you? | Yes, 30 minutes by default (setting, 0 turns it off). |
| D4 | Webhook signature check: write it by hand, or use Resend's recommended `svix` package? | Use the `svix` package. It is a security check, and it is the official, small implementation. It adds one dependency. |
| D5 | Where do new alert rules live? The two CHECK constraints allow only six categories, so a new "git" or "email" category means rebuilding two tables on production. | Reuse the existing `monitor` category, no rebuild. Add one rule for Resend bounce and complaint spikes. No alert rules for GitHub in the first version, only visibility. |
| D6 | Also mark your own alert emails as bounced or delayed, by matching Resend email ids? It adds two columns to `alert_notifications`. | Skip for now. |
| D7 | The repo name, branch and server folder for each of the 9 services. | You enter them in the UI after Part A is live. Tell me the folders and I can list them for you. |
| D8 | Where should the code status show? | Services list badge plus the service page card. Overview later if you want it. |
| D9 | GitHub token | One fine-grained, read-only token under `administrator-cpu` covering all service repos, with Metadata, Contents, Pull requests and Actions set to read. It expires within a year, and the app shows when it is rejected. |
| D10 | One pull request or three? | Three, in the order A, B, C. |

---

## 8. To verify on the real server

1. `git` is on the PATH for the account that runs `monitor-api` (Administrator under PM2).
2. The server can reach `api.github.com` over HTTPS.
3. The folders are owned by the same Windows account, so git does not refuse them as "unsafe".
4. PM2's restart on a stopped process starts it (this decides how `Start` is built).
5. A real Resend test event reaches `/webhooks/resend` through Nginx and passes the signature check, and the Svix header names and payload fields match Resend's current docs.
6. `can_operate` survives a user update, and an engineer without it gets a 403 on the real server.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| A bug in Part C restarts the wrong process | Service id in, name resolved server-side, live-list check, tests with a fake PM2, and it ships last. |
| The public webhook is probed or flooded | Signature check, timestamp window, rate limit, nothing stored on failure. |
| A GitHub token leaks | Read-only scopes, env file only, never returned or logged, easy to rotate. |
| The token expires unnoticed | The page shows "token rejected" with the last good check time. |
| Each merge deploys to production | Three small pull requests, CI gate, automatic database backup and rollback already in the pipeline. |
| The migration affects live data | It only adds columns and tables, and is tested on a copy of your real database first. |

---

## 10. Order of work and acceptance

**PR A: GitHub read-only.** Done when your services show a correct behind/ahead status on the real server (including one deliberately behind), `monitor-api` shows its deployed commit, and bad token / missing folder cases show clear messages.

**PR B: Resend.** Done when a test event from the Resend dashboard appears on the Email page, a replayed event is not counted twice, an unsigned request is rejected, and nothing personal is stored.

**PR C: PM2 actions.** Done when an operator can restart a throwaway test app from the browser, an engineer without the flag gets a 403, every action appears in the audit log with the person's name, and `monitor-api` cannot be restarted from the app.

**Part 0 acceptance:** `chatty` and `crasher` disappear from the Overview within a few minutes of the deploy, `D:` is no longer listed and its open alert resolves, and `C:`, `E:` and `F:` are unchanged.

**What you receive:** `monitor-update.zip` containing the changed and new files (same folder layout as the repo, so you copy it over `C:\Apps\command-center`) and a `patches` folder with one patch per part (apply with `git am` or `git apply`). A short README in the zip lists the exact steps and the new environment variables.

**D7 note:** the repo, branch and folder for each service are entered in the UI after Part A is live (admin only on the service page), so nothing has to be known up front.
