# Runbook: database backups and restore (H7)

What must survive a restore: users, settings, alert rules and mutes, services with their hand-entered git mapping, tenants and the audit log. Metric history may be lost.

## 1. What runs

| Copy | Where | When | Kept | Made by |
|---|---|---|---|---|
| Nightly | `E:\monitor-backups\monitor-YYYYMMDD.db` | 02:30 server time, daily | newest 14 (setting `backup.keep`) | the backend's `backup` job |
| Before each deploy | `E:\monitor-backups\deploy\monitor-<date>-<time>-<sha>.db` | each deploy | newest 10 | `scripts/deploy.ps1` |
| Offsite | your rclone remote | daily, after the nightly | 30 days (`-KeepDays`) | `scripts/backup-offsite.ps1` in a scheduled task |

The nightly copy is made with `VACUUM INTO` to `monitor-YYYYMMDD.db.partial`, checked with `PRAGMA quick_check`, then renamed, so a file with the nightly name is always complete. The job looks every 10 minutes. A failed copy is retried on the next look; after three failures in a row the alert "Collector stale" fires with target `backup`. Before 02:30 the job also fails while yesterday's file is missing, so the alert stays open until a backup is written again. `maintenance_runs` (job `backup`) holds the last result, file, size and duration.

`VACUUM INTO` holds the database for the length of the copy. At the 164 MB projection (V14) that is a few seconds at 02:30, during which metric writes wait (`busy_timeout` 5 s).

## 2. One-time setup on the Windows VPS

1. **Folder.** The backend creates `E:\monitor-backups` itself. The account that runs `monitor-api` (V8) needs write access to it. Check after the first night (step 5).
2. **Setting.** Nothing to set: `BACKUP_DIR` defaults to `E:\monitor-backups` on Windows. To use another folder, set `BACKUP_DIR` in `C:\Apps\command-center-deploy\apps\backend\.env` and run `Restart-Service monitor-api` (before H9's switch: `pm2 restart monitor-api --update-env`). Keep it off `C:`, where the database is. `BACKUP_DIR=off` switches the job off; the startup log then warns.
3. **Old deploy backups.** Earlier deploys wrote to `C:\monitor\backups`. Nothing reads them now. Keep them until the first deploy has written to `E:\monitor-backups\deploy`, then delete the folder by hand.
4. **Offsite copy.**
   1. Install rclone (`winget install Rclone.Rclone`, or the zip from rclone.org into `C:\Tools\rclone`).
   2. Run `rclone config` as the account that will run the task. Create the storage remote (the plan suggests Google Drive, as for the other backups; B2, S3 or OneDrive work the same way), then a `crypt` remote over it named `monitor-offsite`, with a strong password and salt. **Store both in your password manager**: without them the offsite copies cannot be read. The database holds password hashes, session hashes and the audit log, so it must not leave the server unencrypted.
   3. Test by hand, after the first nightly file exists:
      ```powershell
      cd C:\Apps\command-center
      .\scripts\backup-offsite.ps1 -Remote 'monitor-offsite:'
      rclone lsl monitor-offsite:
      ```
   4. Schedule it daily at 03:15 (after the 02:30 job), as the same account:
      ```powershell
      $a = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\Apps\command-center\scripts\backup-offsite.ps1 -Remote monitor-offsite:'
      $t = New-ScheduledTaskTrigger -Daily -At 3:15am
      $s = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
      Register-ScheduledTask -TaskName 'Command Center offsite backup' -Action $a -Trigger $t -Settings $s `
        -User 'Administrator' -Password (Read-Host 'Password for Administrator') -RunLevel Limited
      ```
      Each run adds a line to `E:\monitor-backups\offsite.log` and exits with 1 on failure, which Task Scheduler shows as the last run result. The monitor does not watch this task; look at the log weekly until phase 11 adds a check.
5. **Check after the first night.** `E:\monitor-backups` holds today's `monitor-YYYYMMDD.db` and no `.partial` file, and the Alerts page has no "Collector stale" for `backup`. Overview → Backups and certificates shows the last result (`maintenance_runs`), and Host → Collectors the `backup` job's state. If there is no file, section 5.

## 3. Restore test on a copy (V19)

Do this once after setup, and again after any change to the backup path. It never touches the live database.

```powershell
cd C:\Apps\command-center
.\scripts\check-backup.ps1 -Backup (Get-ChildItem E:\monitor-backups\monitor-*.db | Sort-Object Name | Select-Object -Last 1).FullName
```

It copies the file to a temporary folder, runs `PRAGMA integrity_check` and prints row counts for users, settings, alert rules and mutes, services, `service_git`, tenants, the audit log and `schema_migrations`, plus the newest audit entry. Pass: `integrity` is `ok`, users and services match what you see in the dashboard, the newest audit entry is from the day before. `settings` may be 0 if nothing was ever changed (defaults live in code). Do the same with one file pulled back from the remote (`rclone copy monitor-offsite:monitor-YYYYMMDD.db C:\Temp\`), which also proves the crypt password works. Record the result as V19 in `implementation-plan.md` section 0.3.

## 4. Restoring for real

Only when the live database is lost or damaged. Everything after the backup's time is lost (users created since, audit entries, settings changed since).

```powershell
Stop-Service monitor-api                    # before H9's switch: pm2 stop monitor-api
$db = 'C:\monitor\data\monitor.db'
$aside = "C:\monitor\data\broken-$(Get-Date -Format yyyyMMdd-HHmmss)"
New-Item -ItemType Directory $aside | Out-Null
Move-Item "$db*" $aside                     # monitor.db, monitor.db-wal, monitor.db-shm
.\scripts\check-backup.ps1 -Backup E:\monitor-backups\monitor-YYYYMMDD.db
Copy-Item E:\monitor-backups\monitor-YYYYMMDD.db $db
Start-Service monitor-api                   # before H9's switch: pm2 start monitor-api
```

The `-wal` and `-shm` files belong to the old database and must not stay next to the restored one; moving all `monitor.db*` files aside handles that. If the backup is older than the last migration, the backend applies the missing migrations on start. If a migration caused the damage, restore the backup written by the deploy before it (`E:\monitor-backups\deploy`) and roll back the code.

Check: `Invoke-RestMethod http://127.0.0.1:4111/health` answers, you can log in, Services shows the git mapping, Audit shows entries up to the backup time. Keep the moved-aside folder until you are sure.

## 5. No nightly file in `E:\monitor-backups`

Seen on 2026-10-30: only the deploy copies in `E:\monitor-backups\deploy`, no `monitor-YYYYMMDD.db`, although the backend with the `backup` job had been running since 2026-10-29 and the server clock was past 02:30. The job writes the day's file on its first run after 02:30, and every start of the backend runs it at once, so a backend that has been up for ten minutes after 02:30 should have one. The code and its tests do not explain the gap; the server says which case it is. Read these three, in order:

1. **Host page → Collectors, row `backup`.** This is the job's own state since the last start.
   - No `backup` row: the job is not registered, which happens only when `BACKUP_DIR` is `off`. Go to step 3.
   - `error` with a message: the message is the cause (for example `backup to E:\monitor-backups failed: EPERM ...` or `SQLITE_...`). `stale` means three failed runs in a row, and Alerts then has "Collector stale" for `backup`.
   - `ok`: the job ran without error. Then either the file exists in another folder (step 2 shows where) or the clock is before 02:30 and there is nothing due yet.
2. **Overview → Backups and certificates.** "Last backup" is the last write the job attempted (`maintenance_runs`, job `backup`), with its file path or error. `off (BACKUP_DIR)` means the job is off; `none yet` means it has never tried to write; `failed` shows the error; `ok` with a **File** path elsewhere than `E:\monitor-backups` means `BACKUP_DIR` points elsewhere.
3. **The startup line.** Log search, source `_monitor`, text `starting command-center backend`: its `config.backupDir` is the folder the running backend uses (`off` when switched off). Compare with `BACKUP_DIR` in `C:\Apps\command-center-deploy\apps\backend\.env`; when that line is absent the default `E:\monitor-backups` applies. Each failed run also writes a `collector failed` line with `collector: backup` and the error.

What to do:

| Finding | Fix |
|---|---|
| `backupDir` is `off`, or a folder you did not mean | Remove the `BACKUP_DIR` line from `.env` (or set it to `E:\monitor-backups`), then `Restart-Service monitor-api`. The file appears within a minute of the start. |
| An access error (`EPERM`, `EACCES`) | The service account (`WIN-2G10A0957M9\Administrator`) needs write access to `E:\monitor-backups`: `icacls E:\monitor-backups`. |
| `EBUSY` or `EPERM` on the rename of the `.partial` file | Another program holds the new file for a moment (often antivirus scanning it). Exclude `E:\monitor-backups` from real-time scanning, or send the message so the job can retry the rename. |
| A SQLite error | Send the message with the database size; nothing on disk needs changing. |
| Anything else, or the Collectors row says `ok` and there is still no file | Send the three readings above. |

After the fix, the first run writes the file at once (the time of day is past 02:30); check that `E:\monitor-backups` holds today's file and no `.partial`, then do the restore test (section 3, V19).
