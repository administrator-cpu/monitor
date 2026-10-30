# Runbook: monitor-api as a Windows service (H9)

Decision O1 (2026-10-30): the backend runs as the Windows service `monitor-api` (NSSM), not inside PM2. A PM2 failure, `pm2 kill` or `pm2 delete all` no longer takes the monitor down; the monitor reports the PM2 outage instead. Every remote host in phase 11 depends on the monitor, so it must not share PM2's fate.

The service runs under the account that owns the PM2 daemon (Administrator) with `PM2_HOME` set, so it reads the same PM2 daemon as before. It reads the same `.env` from the same deploy folder. The database, logs and port (4111) do not change.

`scripts/deploy.ps1` finds the service by name: once `monitor-api` exists as a service, deploys restart the service; until then they restart the PM2 process as before. Merging H9 changes nothing on the server until you do step 2.

## 1. Before you start

1. **NSSM 2.24-101 or newer.** Run `nssm` with no arguments; the first lines show the version. Plain 2.24 has a known start problem on Windows 10 1703 / Server 2016 and newer (nssm.cc download page), so use the pre-release 2.24-101-g897c7ad. Into `C:\Tools\nssm\`, then add that folder to the machine `PATH` and open a new PowerShell:
   ```powershell
   [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
   New-Item -ItemType Directory -Force C:\Tools\nssm | Out-Null
   # nssm.cc is often unavailable; the Chocolatey package carries the same zip inside it.
   Invoke-WebRequest https://community.chocolatey.org/api/v2/package/nssm/2.24.101.20180116 -OutFile $env:TEMP\nssm-pkg.zip -UseBasicParsing
   Expand-Archive $env:TEMP\nssm-pkg.zip -DestinationPath $env:TEMP\nssm-pkg -Force
   Expand-Archive $env:TEMP\nssm-pkg\tools\nssm-2.24-101-g897c7ad.zip -DestinationPath $env:TEMP\nssm101 -Force
   Copy-Item $env:TEMP\nssm101\nssm-2.24-101-g897c7ad\win64\nssm.exe C:\Tools\nssm\nssm.exe -Force
   [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','Machine') + ';C:\Tools\nssm', 'Machine')
   ```
   Done on the VPS on 2026-10-30.
2. **The runner account can restart services.** Deploys run as the GitHub runner's account. Check which one:
   ```powershell
   Get-CimInstance Win32_Service -Filter "Name LIKE 'actions.runner%'" | Select-Object Name, StartName
   ```
   An administrator account (or `LocalSystem`) can run `Restart-Service`. If it is another account, tell Claude before going on; it needs the right to stop and start `monitor-api`. (This also answers V8's question for the runner.)
3. **Save the PM2 definition** so you can go back:
   ```powershell
   pm2 describe monitor-api | Out-File E:\monitor-backups\pm2-monitor-api.txt
   ```
4. **Anything PM2 set that `.env` does not.** In that file, look at the `script path`, `exec cwd` (must be `C:\Apps\command-center-deploy\apps\backend`) and any environment the process was started with (an ecosystem file's `env:` block, or variables set in the shell that ran `pm2 start`). Every setting the backend needs must be in `C:\Apps\command-center-deploy\apps\backend\.env`; in particular `NODE_ENV=production`. `PM2_HOME` is set by the service itself.

## 2. Switch (about one minute without the backend)

From an elevated PowerShell (Run as administrator):

```powershell
cd C:\Apps\command-center-deploy
pm2 stop monitor-api
.\scripts\install-service.ps1
```

The script asks for the Administrator password (the service runs as that account). It refuses to run while anything listens on port 4111, so PM2's copy must be stopped first. It installs the service with automatic start, restart on exit after 5 s, an immediate stop (see below) and its output in `E:\monitor-service-logs\service.log` (rotated over 10 MB when the service starts), then starts it and waits for `/health`. If `/health` does not answer it prints the last lines of that log and how to go back (section 6).

Defaults: `-ServiceName monitor-api`, `-AppDir C:\Apps\command-center-deploy\apps\backend`, `-ServiceAccount <computer name>\Administrator` (the password dialog refuses `.\Administrator`), `-Pm2Home C:\Users\Administrator\.pm2`, `-Port 4111`. Pass a parameter only if yours differs.

**Stop behaviour.** A stop ends `node.exe` at once (`AppStopMethodSkip 7`), as a PM2 restart on Windows always did; SQLite's journal keeps the database consistent. The first install on 2026-10-30 used NSSM's Ctrl+C stop with rotation while running, and a `Restart-Service` left the service in `StopPending` for minutes after node had exited. On that server both settings were then changed by hand (`nssm set monitor-api AppStopMethodSkip 7`, `nssm set monitor-api AppRotateOnline 0`), which matches the install script now; no reinstall is needed. `deploy.ps1` also no longer waits without limit: after 30 s it ends the service's processes itself (section 7).

## 3. Checks

1. `Get-Service monitor-api` shows `Running`; `curl.exe -s http://127.0.0.1:4111/health` gives `{"status":"ok"}`.
2. Dashboard, Host page, "Monitor health": **Runs as** says "Windows service monitor-api"; **Deployed commit** shows the commit of the last deploy (the first 7 characters; the full one on hover).
3. Overview: the services are listed and the `pm2` collector is not stale (the service reaches the PM2 daemon). If it is stale, the Host page's collector row says why (usually `PM2_HOME` or the account).
4. **V2 with the service:** sign in, run `Restart-Service monitor-api`, reload the page: you are still signed in. Record V2.
5. Logs page, "This monitor's own log": new lines appear, starting with the startup summary. Compare it with the summary from before the switch (the same values, apart from the process id).

Expected until section 4 is done: PM2 still lists the stopped `monitor-api`, so the dashboard shows it as stopped and opens a "service down" alert for it (with an email if alert email is set up). It resolves once the entry is deleted. Mute it on Alerts > Mutes if the switch takes longer.

## 4. Finish

When the checks pass:

```powershell
pm2 delete monitor-api
pm2 save
```

Without this the deploy refuses to run, because a PM2 entry with the same name would fight the service for the port. On the dashboard the old `monitor-api` service entry (from PM2) is archived by itself after 15 minutes (`pm2.auto_archive_minutes`), or archive it now on its page. Its GitHub card goes with it; the Host page now shows the deployed commit (V16 for the monitor itself).

Then run one deploy to check the new path: Actions, "Deploy backend", "Run workflow" on `main`. The log shows "Backend runs as the Windows service 'monitor-api'" and "Restarting service 'monitor-api'", and ends with "Deploy of ... succeeded".

## 5. What changes in daily use

| Task | Before (PM2) | Now (service) |
|---|---|---|
| Restart after editing `.env` | `pm2 restart monitor-api --update-env` | `Restart-Service monitor-api` |
| Stop / start (for example to restore a backup) | `pm2 stop monitor-api` / `pm2 start monitor-api` | `Stop-Service monitor-api` / `Start-Service monitor-api` |
| Is it running? | `pm2 list` | `Get-Service monitor-api` |
| Its own log | Logs page, "This monitor's own log" (`E:\monitor-logs\_monitor`) | unchanged |
| Errors before the logger starts (bad `.env`) | `pm2 logs monitor-api` | `E:\monitor-service-logs\service.log` |
| PM2 daemon dies | the monitor dies too; only the watchdog notices | the monitor stays up, shows the `pm2` collector stale and raises its alert |
| After a reboot | started by PM2's startup entry | started by Windows (automatic start); it connects to PM2 once the daemon is up |

## 6. Going back to PM2

```powershell
cd C:\Apps\command-center-deploy
.\scripts\uninstall-service.ps1
pm2 start monitor-api            # if you have not run pm2 delete yet
```

After `pm2 delete`, re-create the entry from the file saved in step 1.3, for example:

```powershell
pm2 start dist\index.js --name monitor-api --cwd C:\Apps\command-center-deploy\apps\backend
pm2 save
```

Deploys go back to PM2 by themselves once the service is gone.

## 7. If a stop hangs (`StopPending`)

`Get-Service monitor-api` stays at `StopPending` and `/health` does not answer. End the processes and start again (the database is safe):

```powershell
$svcPid = (Get-CimInstance Win32_Service -Filter "Name='monitor-api'").ProcessId
Get-CimInstance Win32_Process -Filter "ParentProcessId=$svcPid" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Stop-Process -Id $svcPid -Force
Start-Sleep -Seconds 10
Get-Service monitor-api          # Windows may start it again by itself; if Stopped:
Start-Service monitor-api
curl.exe -s http://127.0.0.1:4111/health
```

Then check the stop settings: `nssm get monitor-api AppStopMethodSkip` must be `7` and `nssm get monitor-api AppRotateOnline` must be `0`. NSSM's own steps are in the Application event log (source `nssm`).
