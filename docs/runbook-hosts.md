# Runbook: remote hosts on the monitor (phase 11, M1)

What the owner does on the Windows VPS for M1: check migration `010` on a copy of the production database **before merging**, add the Nginx `/agent/` location, and check the Hosts page after the deploy. Nothing is installed on the Ubuntu server in M1; the agent and its compose file arrive with M2 (a later section of this runbook, "Adding a host").

## 1. Before merging: migration `010` on a copy (V25)

Migration `010_hosts.sql` rebuilds `services`, `metrics_host`, `metrics_disk` and `metrics_mongo` with a `host_id` column and adds `hosts`. It runs in one transaction when the new backend starts; a failure stops startup and the deploy rolls back. Test it on a copy first (backend-schema.md section 13):

1. Clone the branch with patch 0016 applied into a separate folder, so the repository the backup task uses (`C:\Apps\command-center`) stays as it is, and install (nothing is built or restarted):
   ```powershell
   git clone --branch h1/repo-hygiene https://github.com/administrator-cpu/monitor.git C:\Apps\migration-test
   cd C:\Apps\migration-test
   pnpm install --frozen-lockfile --filter '@cc/backend...'
   pnpm --filter @cc/shared build
   ```
2. Copy the newest nightly backup (H7; a complete, checked copy of the live database) into a test folder:
   ```powershell
   New-Item -ItemType Directory -Force E:\monitor-backups\migration-test | Out-Null
   $latest = Get-ChildItem E:\monitor-backups\monitor-*.db | Sort-Object Name | Select-Object -Last 1
   Copy-Item $latest.FullName E:\monitor-backups\migration-test\monitor.db
   ```
   Never point the check at `C:\monitor\data\monitor.db` itself; the script refuses that path.
3. Run the check on the copy:
   ```powershell
   pnpm --filter @cc/backend migration:check E:\monitor-backups\migration-test\monitor.db
   ```
   Expected: `Applied 010_hosts.sql in <time>`, services and open incidents unchanged, `OK: every row kept`. On a 164 MB database shaped like eight days of production data it took 0.06 s; anything under a few seconds is fine.
4. Record the time and the result as V25 in `implementation-plan.md` section 0.3, then delete both test folders:
   ```powershell
   cd C:\
   Remove-Item -Recurse -Force E:\monitor-backups\migration-test, C:\Apps\migration-test
   ```

If the check prints `FAILED`, do not merge; send the output.

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
