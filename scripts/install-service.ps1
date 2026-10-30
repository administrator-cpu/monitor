<#
.SYNOPSIS
  Installs the Command Center backend (monitor-api) as a Windows service with NSSM (H9).

.DESCRIPTION
  The backend runs OUTSIDE PM2, so a PM2 failure (or `pm2 kill`, `pm2 delete all`) no longer
  takes the monitor down with it; the monitor reports the PM2 outage instead.

  The service runs under the Windows account that owns the PM2 daemon and gets PM2_HOME set,
  so it still reaches the same PM2 daemon. It reads the same .env as before.

  Order on the server (docs/runbook-service.md): `pm2 stop monitor-api`, then this script,
  then the checks, then `pm2 delete monitor-api` and `pm2 save`.

.EXAMPLE
  .\scripts\install-service.ps1
  .\scripts\install-service.ps1 -ServiceAccount '.\Administrator' -Pm2Home 'C:\Users\Administrator\.pm2'

  Prerequisites: run from an elevated PowerShell; nssm.exe on PATH; the deploy folder built
  (it is after any successful deploy); nothing listening on the port (stop the PM2 process first).
#>
param(
  [string]$ServiceName    = 'monitor-api',
  [string]$AppDir         = 'C:\Apps\command-center-deploy\apps\backend',
  # Empty means $AppDir\.env, the production env file.
  [string]$EnvFile        = '',
  [string]$NodeExe        = '',
  # Off C: like the other logs. Holds only what the process prints before its own logger starts
  # (the monitor's log proper goes to LOG_ROOT\_monitor, as under PM2).
  [string]$LogDir         = 'E:\monitor-service-logs',
  # The account that owns the PM2 daemon, and that daemon's folder.
  [string]$ServiceAccount = '.\Administrator',
  [string]$Pm2Home        = 'C:\Users\Administrator\.pm2',
  [int]$Port              = 4111,
  [int]$HealthTimeoutSec  = 45
)

$ErrorActionPreference = 'Stop'

function Invoke-Nssm {
  & nssm @args
  # Only the verb and the setting name: the ObjectName call carries the password.
  if ($LASTEXITCODE -ne 0) { throw "nssm $($args[0]) $($args[2]) failed (exit code $LASTEXITCODE)" }
}

# ---- Checks before anything changes --------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this from an elevated PowerShell (Run as administrator).'
}
if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) { throw 'nssm.exe was not found on PATH.' }
if (-not $NodeExe) { $NodeExe = (Get-Command node -ErrorAction Stop).Source }
if (-not $EnvFile) { $EnvFile = Join-Path $AppDir '.env' }
if (-not (Test-Path (Join-Path $AppDir 'dist\index.js'))) { throw "dist\index.js not found in $AppDir. Run a deploy (or pnpm build) first." }
if (-not (Test-Path $EnvFile)) { throw "Env file not found: $EnvFile" }
if (-not (Test-Path $Pm2Home)) { throw "PM2_HOME folder not found: $Pm2Home. Pass -Pm2Home with the folder of the PM2 daemon your apps run under." }
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  throw "A service named '$ServiceName' already exists. Remove it first with .\scripts\uninstall-service.ps1."
}
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  $owner = ($listening | Select-Object -First 1).OwningProcess
  throw "Port $Port is in use (process id $owner). Stop the PM2 process first: pm2 stop monitor-api"
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$cred = Get-Credential -UserName $ServiceAccount -Message "Password of $ServiceAccount (the account that owns PM2)"

# ---- Install ---------------------------------------------------------------
Invoke-Nssm install $ServiceName $NodeExe 'dist\index.js'
try {
  Invoke-Nssm set $ServiceName AppDirectory $AppDir
  # CC_SERVICE_NAME lets the dashboard show "Runs as: Windows service" on the Host page.
  Invoke-Nssm set $ServiceName AppEnvironmentExtra "CC_ENV_FILE=$EnvFile" "PM2_HOME=$Pm2Home" "CC_SERVICE_NAME=$ServiceName"
  Invoke-Nssm set $ServiceName DisplayName 'Command Center backend (monitor-api)'
  Invoke-Nssm set $ServiceName Description 'Command Center monitoring backend. Deployed by scripts\deploy.ps1; see docs\runbook-service.md.'
  Invoke-Nssm set $ServiceName Start SERVICE_AUTO_START

  # Restart the app if it exits; ask Node to stop cleanly (Ctrl+C, handled as SIGINT: flush logs
  # and metrics, close the database) and give it 10 s before killing it.
  Invoke-Nssm set $ServiceName AppExit Default Restart
  Invoke-Nssm set $ServiceName AppRestartDelay 5000
  Invoke-Nssm set $ServiceName AppThrottle 10000
  Invoke-Nssm set $ServiceName AppStopMethodConsole 10000

  Invoke-Nssm set $ServiceName AppStdout (Join-Path $LogDir 'service.log')
  Invoke-Nssm set $ServiceName AppStderr (Join-Path $LogDir 'service.log')
  Invoke-Nssm set $ServiceName AppRotateFiles 1
  Invoke-Nssm set $ServiceName AppRotateOnline 1
  Invoke-Nssm set $ServiceName AppRotateBytes 10485760

  # NSSM grants the account "Log on as a service" when it sets it.
  Invoke-Nssm set $ServiceName ObjectName $cred.UserName ($cred.GetNetworkCredential().Password)

  # If nssm.exe itself dies, Windows restarts the service.
  sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/60000 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc.exe failure $ServiceName failed (exit code $LASTEXITCODE)" }
} catch {
  Write-Host "!! Setup failed: $($_.Exception.Message). Removing the half-installed service."
  nssm remove $ServiceName confirm | Out-Null
  throw
}

# ---- Start and check ---------------------------------------------------------
Start-Service -Name $ServiceName
$deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
$ok = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  try {
    if ((Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5).status -eq 'ok') { $ok = $true; break }
  } catch { }
}

if ($ok) {
  Write-Host "==> '$ServiceName' is installed, running as $ServiceAccount and answers /health on port $Port."
  Write-Host '    Next: the checks in docs\runbook-service.md, then pm2 delete monitor-api and pm2 save.'
} else {
  Write-Host "!! '$ServiceName' is installed but did not answer /health within $HealthTimeoutSec s."
  Write-Host "   Last lines of $(Join-Path $LogDir 'service.log'):"
  Get-Content (Join-Path $LogDir 'service.log') -Tail 30 -ErrorAction SilentlyContinue
  Write-Host '   To go back to PM2: .\scripts\uninstall-service.ps1, then pm2 start monitor-api'
  exit 1
}
