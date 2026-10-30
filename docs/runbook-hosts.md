# Runbook: remote hosts on the monitor (phase 11, M1 and M2)

What the owner does for phase 11. On the Windows VPS for M1: check migration `010` on a copy of the production database **before merging** (done, V25), add the Nginx `/agent/` location (done 2026-10-30), and check the Hosts page after the deploy (done, V26 passed 2026-10-30). For M2: V27 before merging patch 0021 (section 1), then the agent on the Ubuntu server (section 5, "Adding a host").

## 1. Before merging: a migration on a copy (V25 for `010`)

**V25 passed on 2026-10-30:** `010` on a copy of the deploy backup `monitor-20261030-123832-3cfc953.db` (13.8 MB, 12 services, 2 open incidents) took 0.61 s; every row was kept and services and open incidents were unchanged. The steps below are the same for every later migration (`011` onward).

**V27, before merging patch 0021 (M2):** the same check for `011_tls_certs_host.sql`. Production is at `010`, so the expected line is `Applied 011_tls_certs_host.sql in <time>`, then `OK: every row kept`. It only rebuilds `tls_certs` (a handful of rows), so it should take well under a second.

Migration `010_hosts.sql` rebuilds `services`, `metrics_host`, `metrics_disk` and `metrics_mongo` with a `host_id` column and adds `hosts`. Each migration runs in one transaction when the new backend starts; a failure stops startup and the deploy rolls back. Test it on a copy first (backend-schema.md section 13). The check is `apps\backend\scripts\migration-check.mjs`: it uses Node's built-in `node:sqlite`, so it needs Node 22.13 or later (the VPS has 22.22) and **nothing installed**, no `pnpm install` and no build.

1. Get the branch to be merged into a separate folder, so the repository the backup task uses (`C:\Apps\command-center`) stays as it is:
   ```powershell
   git clone --branch h1/repo-hygiene https://github.com/administrator-cpu/monitor.git C:\Apps\migration-test
   ```
   If the owner's patches are not pushed yet, apply them in that clone with `git am` first.
2. Copy the newest backup into a test folder: the newest nightly file, or, while there is none, the newest deploy copy (both are complete `VACUUM INTO` copies of the live database):
   ```powershell
   New-Item -ItemType Directory -Force E:\monitor-backups\migration-test | Out-Null
   $latest = Get-ChildItem E:\monitor-backups\monitor-*.db, E:\monitor-backups\deploy\monitor-*.db |
     Sort-Object LastWriteTime | Select-Object -Last 1
   $latest.FullName
   Copy-Item $latest.FullName E:\monitor-backups\migration-test\monitor.db
   ```
   Never point the check at `C:\monitor\data\monitor.db` itself; the script refuses that path.
3. Run the check on the copy:
   ```powershell
   node C:\Apps\migration-test\apps\backend\scripts\migration-check.mjs E:\monitor-backups\migration-test\monitor.db
   ```
   Expected: `Applied 0NN_<name>.sql in <time>`, services and open incidents unchanged, `OK: every row kept`. Anything under a few seconds is fine. `Nothing to apply` means the copy already has the branch's migrations (for example a backup taken after the merge). Exit code 1 with `FAILED` or `threw` means do not merge; send the output.
4. Record the time and the result in `implementation-plan.md` section 0.3 (V25 for `010`, V27 for `011`), then delete both test folders:
   ```powershell
   cd C:\
   Remove-Item -Recurse -Force E:\monitor-backups\migration-test, C:\Apps\migration-test
   ```

## 2. Nginx: the `/agent/` location

Apply the phase 11 lines of `docs/runbook-nginx.md`: the `agents` zone in the `http` block and the `location /agent/` block in the `monitor-api.thediv.in` server, then `nginx -t` and reload (section 3 of that runbook, with the copy named `nginx.conf.before-m1`). This can be done before or after the merge: until the backend has M1, `/agent/` answers 404 from the app.

## 3. After the merge and deploy

1. The deploy log ends with a healthy start. In Log search, the monitor's own log (`_monitor`) has `migrations applied` with `010_hosts.sql` at the time of the restart.
2. Every page looks as before: Overview, Services (the same list), Host, Alerts (open incidents still open), Logs. `Settings` has a new section "Remote hosts" with the agent version floor (empty) and the enrollment token lifetime (60 minutes).
3. **Admin → Hosts** lists `windows-vps` as "this server".
4. From your own computer, the Nginx check of `runbook-nginx.md` section 3, step 6: `401`, then `403`.
5. Optional dry run of enrollment (the M1 acceptance), from your own computer with PowerShell:
   - Hosts → Add host → name `test-enroll` → copy the token from the panel.
   - Enroll once:
     ```powershell
     $body = @{ enrollToken = '<token>'; hostname = 'test'; os = 'linux'; agentVersion = '0.1.0' } | ConvertTo-Json
     $r = Invoke-RestMethod -Method Post -Uri https://monitor-api.thediv.in/agent/v1/enroll -ContentType 'application/json' -Body $body
     $r.hostName
     ```
     prints `test-enroll`. Running the same command again fails with 401 (`enroll_token_invalid`).
   - A report with the host token:
     ```powershell
     $m = @{ v = 1; ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); actions = 'off'; host = @{ cpuPct = 5; cpuPerCore = @(5); memUsedBytes = 1; memTotalBytes = 2; swapUsedBytes = 0; swapTotalBytes = 0; netRxBps = 0; netTxBps = 0; uptimeS = 1; pendingReboot = $false; disks = @() } } | ConvertTo-Json -Depth 5
     Invoke-WebRequest -Method Post -Uri https://monitor-api.thediv.in/agent/v1/metrics -ContentType 'application/json' -Headers @{ Authorization = "Bearer $($r.token)"; 'X-Agent-Version' = '0.1.0' } -Body $m
     ```
     answers 204, and the Hosts page shows `test-enroll` as online with CPU 5%.
   - About 2.5 minutes later, Alerts shows "Host silent" for `test-enroll` (critical; it is emailed like any other incident).
   - Hosts → `test-enroll` → Revoke. The incident closes without an email, and the report command above now fails with 401.
     The revoked test host stays in the list (its history is kept). Use a name you will not need for the real Ubuntu host.

## 4. If the deploy rolls back, or to go back later

`deploy.ps1` rolls back the **code** only; it never undoes a migration. The previous backend cannot read a database that has `010` (the `services` table no longer has `pm2_name`), so after a rollback of this deploy, or to go back to the release before M1 later, restore the database copy the deploy took just before it migrated. The deploy log prints its path (`Database backup taken before this deploy: E:\monitor-backups\deploy\monitor-<date>-<commit>.db`):

```powershell
Stop-Service monitor-api
Copy-Item C:\monitor\data\monitor.db C:\monitor\data\monitor.db.with-010     # keep the migrated file, just in case
Remove-Item C:\monitor\data\monitor.db-wal, C:\monitor\data\monitor.db-shm -ErrorAction SilentlyContinue
Copy-Item '<the printed backup path>' C:\monitor\data\monitor.db
Start-Service monitor-api
```

Data collected between the deploy and the restore (metrics, incidents, audit entries of those minutes) is lost; log files on `E:` are not affected. If the deploy rolled back, send the deploy log: the cause has to be fixed before the next attempt, which will migrate again.

## 5. Adding a host (M2)

The agent and its Docker proxy run as one compose project, `cc-agent`, on the monitored server. They open no port: the agent calls the monitor over HTTPS, and nothing calls into the host. For `acs-prod` (`154.49.142.251`, SSH on 35610), as `deploy` with `sudo`, or as `root` without it.

### 5.1 Once, on GitHub: the images

After patches 0022 and 0023 are merged, the **Images** workflow (Actions tab) builds both images and publishes them to `ghcr.io/administrator-cpu/cc-node-agent` and `ghcr.io/administrator-cpu/cc-docker-proxy`, tagged `latest`, the version (`0.2.0`) and `sha-<commit>`. Its summary shows the digests.

New packages start **private**. Either:
- make them public (they contain no secret: the code is in this public repository): GitHub → your profile → **Packages** → `cc-node-agent` → **Package settings** → **Change visibility** → Public; the same for `cc-docker-proxy`. Then the server needs no login; or
- keep them private and log in once on the server with the classic token that has only `read:packages`:
  ```bash
  sudo docker login ghcr.io -u administrator-cpu      # paste the token as the password
  ```
  (With `sudo`, the login is stored for root, which is who runs the compose commands below.)

### 5.2 On the monitor: the host and its token

Admin → **Hosts** → **Add host** → name `ubuntu-acs` → **Add host and make a token** → **Copy**. The token works once, for 60 minutes; if it runs out, **New token** on that host's row.

### 5.3 On the server: start the agent

```bash
ssh -p 35610 deploy@154.49.142.251

# The env file, root only (paste the copied lines into it):
sudo install -d -m 700 -o root -g root /etc/cc-agent
sudo install -m 600 -o root -g root /dev/null /etc/cc-agent/agent.env
sudo nano /etc/cc-agent/agent.env

# The compose file, and the docker group's id for the proxy:
mkdir -p ~/cc-agent && cd ~/cc-agent
curl -fsSLO https://raw.githubusercontent.com/administrator-cpu/monitor/main/deploy/cc-agent/docker-compose.yml
echo "DOCKER_GID=$(getent group docker | cut -d: -f3)" > .env

sudo docker compose pull
sudo docker compose up -d
```

Compose reads `agent.env` itself, so every `docker compose` command needs `sudo` while that file is root-only. `deploy/cc-agent/agent.env.example` explains each line.

### 5.4 Check (V28)

1. `sudo docker compose ps`: both containers `running`. `sudo docker compose logs cc-node-agent`: `enrolled with the monitor` and `found the agent's own compose project` (`cc-agent`), then nothing more while all is well.
2. Within a minute, **Hosts** shows `ubuntu-acs` online with agent `0.2.0`. On **Host**, the host picker (top right) → `ubuntu-acs`: CPU, memory, swap, uptime, the `/` disk with read and write rates, and the agent's collectors all `ok`. If the disk shows `—` for read/write, the agent could not read `/proc/1/mountinfo`; usage is still right. Note the disk percentage and compare with `df -h /` on the server: they should match.
3. **Services** → picker → `ubuntu-acs`: the nine `acs` services (`api`, `caddy`, `cpe-sim`, `dashboard`, `genieacs-cwmp`, `genieacs-fs`, `genieacs-nbi`, `genieacs-ui`, `mongo`) and the agent's own two, with CPU, memory and uptime.
4. Service down and back:
   ```bash
   sudo docker stop acs-cpe-sim-1      # the container name from `sudo docker ps`
   ```
   `cpe-sim` shows `stopped` within 10 s; after the rule's duration, **Alerts** has "Service cpe-sim on ubuntu-acs is stopped" (critical, emailed). Its page lists `die` and `stop` under Recent process events.
   ```bash
   sudo docker start acs-cpe-sim-1
   ```
   It shows `online` within 10 s; the incident resolves after twice the rule's duration (at least a minute).
5. Host silent: `sudo docker compose stop cc-node-agent`. About 2.5 minutes later **Alerts** has "Host silent" for `ubuntu-acs`; any other `ubuntu-acs` incident is shown under it and not emailed. `sudo docker compose start cc-node-agent`: the host is online again at once; the incident resolves after 4 minutes.
6. The proxy refuses what the agent does not need (optional):
   ```bash
   sudo docker compose exec cc-node-agent node -e "for (const p of ['/containers/json','/info','/containers/acs-api-1/json']) fetch('http://cc-docker-proxy:2375'+p).then(r=>console.log(p, r.status))"
   ```
   Expected: `200`, `403`, `403`.
7. Record the date and the results as V28 in `implementation-plan.md` section 0.3, with the agent's memory from `sudo docker stats --no-stream` (budget: under 150 MB, the proxy under 20 MB).

### 5.5 Later

- **Update:** `cd ~/cc-agent && sudo docker compose pull && sudo docker compose up -d`. To stay on a release, put `CC_TAG=0.2.0` (or `sha-<commit>`) in `~/cc-agent/.env`. The agent never updates itself.
- **New token** (rotation, or after a revoke): **New token** on the Hosts page, replace `CC_ENROLL_TOKEN` in `/etc/cc-agent/agent.env`, `sudo docker compose up -d --force-recreate cc-node-agent`. The agent enrolls again and the old host token stops working.
- **Remove:** `sudo docker compose down -v` (also deletes the stored host token), `sudo rm -r /etc/cc-agent`, then **Revoke** on the Hosts page. The host's history stays on the monitor.
- **Outside probes (M4):** the monitor will check `acs.thediv.in` (`154.49.142.251`) on ports 7547, 443 and 80 from the Windows VPS. Nothing to set up yet.
