<#
.SYNOPSIS
  Deploys the Command Center backend on this Windows VPS.

.DESCRIPTION
  Order of work:
    1. Preflight (tools, deploy folder, .env, the backend points at the deploy folder)
    2. Consistent backup of the SQLite database
    3. Snapshot of the current release (for rollback)
    4. Copy the new source into the deploy folder (keeps .env, node_modules, dist)
    5. pnpm install --frozen-lockfile (backend + shared only), build
    6. Restart the backend, then health check and a short stability check
    7. If anything fails after step 3: restore the snapshot, reinstall, restart

  The backend runs as the Windows service -ServiceName when that service exists (H9,
  docs/runbook-service.md), otherwise as the PM2 process -PmName. Both at once is refused.

  Rolling back code does NOT undo database migrations. The backup path is printed
  so you can restore it by hand if a migration was the problem.

  Run by the GitHub Actions self-hosted runner. Can also be run by hand:
    .\scripts\deploy.ps1
#>
[CmdletBinding()]
param(
  [string]$Sha = '',
  [string]$SourceDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$DeployDir = 'C:\Apps\command-center-deploy',
  [string]$PrevDir = 'C:\Apps\command-center-deploy.prev',
  # Off the system drive (H7). The nightly backups are in the parent folder; this script only
  # creates and prunes its own monitor-<date>-<time>-<sha>.db files here.
  [string]$BackupDir = 'E:\monitor-backups\deploy',
  [string]$DbPath = 'C:\monitor\data\monitor.db',
  [string]$PmName = 'monitor-api',
  [string]$ServiceName = 'monitor-api',
  [string]$Pm2Home = 'C:\Users\Administrator\.pm2',
  [int]$Port = 4111,
  [int]$HealthTimeoutSec = 45,
  # How long a service stop may take before the deploy ends the processes itself.
  [int]$StopTimeoutSec = 30,
  [int]$KeepBackups = 10
)

$ErrorActionPreference = 'Stop'
$env:PM2_HOME = $Pm2Home

# A manual run has no commit id passed in: ask git, so the dashboard can show what is deployed.
if (-not $Sha) {
  try {
    $found = (& git -c core.fsmonitor=false -C $SourceDir rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -eq 0 -and $found -match '^[0-9a-f]{40}$') { $Sha = $found.Trim() }
  } catch { }
}

$short = if ($Sha) { $Sha.Substring(0, [Math]::Min(7, $Sha.Length)) } else { 'manual' }
$backendDir = Join-Path $DeployDir 'apps\backend'
$script:mirrored = $false
$script:backupFile = $null
$script:mode = $null   # 'service' or 'pm2', set in the preflight

function Write-Step([string]$Text) { Write-Host "==> $Text" }

function Invoke-Native([string]$Label, [scriptblock]$Command) {
  Write-Step $Label
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit code $LASTEXITCODE)" }
}

# Mirrors a folder. .env, node_modules and git data are never copied or deleted.
# dist folders are protected from deletion unless -WithDist (so the running app keeps
# its code until the new build replaces it).
function Copy-Tree([string]$From, [string]$To, [switch]$WithDist) {
  $skipDirs = @('.git', 'node_modules', '.next', '.turbo')
  if (-not $WithDist) { $skipDirs += 'dist' }
  robocopy $From $To /MIR /XD @skipDirs /XF .env .env.local .deploy-sha `
    /NFL /NDL /NP /NJH /NJS /R:2 /W:2 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $From -> $To failed (exit code $LASTEXITCODE)" }
  $global:LASTEXITCODE = 0
}

# Reads PM2's process list with Node, not ConvertFrom-Json. Windows PowerShell 5.1
# cannot parse `pm2 jlist` because the process environment holds keys that differ only
# in case (for example 'username' and 'USERNAME'). Returns a small flat object:
# Status, RestartTime, Cwd (or $null when the process does not exist).
function Get-Pm2Proc {
  $helper = Join-Path $env:TEMP 'cc-pm2-proc.cjs'
  @'
const { execSync } = require('child_process');
const name = process.argv[2];
const out = execSync('pm2 jlist', { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith('[{') || l.trim() === '[]');
if (!line) process.exit(2);
const p = JSON.parse(line).find((x) => x.name === name);
if (p) console.log(JSON.stringify({ status: p.pm2_env.status, restart: p.pm2_env.restart_time, cwd: p.pm2_env.pm_cwd }));
'@ | Set-Content -Path $helper -Encoding UTF8

  $json = node $helper $PmName
  if ($LASTEXITCODE -ne 0) { throw "Could not read the PM2 process list (exit code $LASTEXITCODE)." }
  if (-not $json) { return $null }
  $o = $json | ConvertFrom-Json
  [pscustomobject]@{ Status = $o.status; RestartTime = $o.restart; Cwd = $o.cwd }
}

# NSSM keeps the app's folder in the service's registry key.
function Get-ServiceAppDir {
  $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters"
  $dir = (Get-ItemProperty -Path $key -Name AppDirectory -ErrorAction SilentlyContinue).AppDirectory
  if (-not $dir) { throw "Service '$ServiceName' has no NSSM AppDirectory. Was it installed with scripts\install-service.ps1?" }
  return [string]$dir
}

# Running = the backend is up; Marker changes when it restarts (PM2 restart count, or the
# process id of the node.exe that NSSM runs: NSSM starts a new one after a crash).
function Get-BackendState {
  if ($script:mode -eq 'service') {
    $svc = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
    $node = $null
    if ($svc -and $svc.ProcessId) {
      $node = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($svc.ProcessId) AND Name='node.exe'" | Select-Object -First 1
    }
    $state = if ($svc) { $svc.State } else { 'missing' }
    return [pscustomobject]@{ Running = ($state -eq 'Running' -and $node -ne $null); Marker = $(if ($node) { $node.ProcessId } else { $null }); Status = $state }
  }
  $p = Get-Pm2Proc
  if (-not $p) { return [pscustomobject]@{ Running = $false; Marker = $null; Status = 'missing' } }
  return [pscustomobject]@{ Running = ($p.Status -eq 'online'); Marker = $p.RestartTime; Status = $p.Status }
}

# Stop, then start. Restart-Service waits without limit: on 2026-10-30 a stop hung in
# STOP_PENDING for minutes after node had exited. After $StopTimeoutSec s this ends node.exe and
# NSSM itself; Windows may then start the service by itself (failure action), which is fine.
function Restart-BackendService {
  Write-Step "Restarting service '$ServiceName'"
  if ((Get-Service -Name $ServiceName).Status -ne 'Stopped') {
    Stop-Service -Name $ServiceName -Force -NoWait -ErrorAction Stop
  }
  $deadline = (Get-Date).AddSeconds($StopTimeoutSec)
  while ((Get-Service -Name $ServiceName).Status -ne 'Stopped' -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }

  if ((Get-Service -Name $ServiceName).Status -ne 'Stopped') {
    Write-Host "   The service did not stop within $StopTimeoutSec s; ending its processes."
    $svc = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
    if ($svc -and $svc.ProcessId) {
      Get-CimInstance Win32_Process -Filter "ParentProcessId=$($svc.ProcessId)" |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      Stop-Process -Id $svc.ProcessId -Force -ErrorAction SilentlyContinue
    }
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Service -Name $ServiceName).Status -eq 'StopPending' -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
  }

  $status = [string](Get-Service -Name $ServiceName).Status
  if ($status -eq 'Stopped') {
    Start-Service -Name $ServiceName -ErrorAction Stop
  } elseif ($status -ne 'Running' -and $status -ne 'StartPending') {
    throw "Service '$ServiceName' is '$status' and could not be restarted."
  }
}

function Restart-Backend {
  if ($script:mode -eq 'service') {
    Restart-BackendService
  } else {
    Invoke-Native "Restarting PM2 process '$PmName'" { pm2 restart $PmName }
  }
}

function Wait-Healthy {
  Start-Sleep -Seconds 3
  $deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5
      if ($r.status -eq 'ok') { return $true }
    } catch { }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Invoke-Rollback {
  Write-Host '!! Rolling back to the previous release'
  try {
    Copy-Tree $PrevDir $DeployDir -WithDist
    Push-Location $DeployDir
    try {
      pnpm install --frozen-lockfile --filter '@cc/backend...'
      if ($LASTEXITCODE -ne 0) { throw "pnpm install failed during rollback ($LASTEXITCODE)" }
    } finally { Pop-Location }
    Restart-Backend
    if (Wait-Healthy) {
      Write-Host '   Rollback succeeded. The previous release is running again.'
    } else {
      Write-Host '!! ROLLBACK DID NOT BECOME HEALTHY. Manual action needed on the server.'
    }
  } catch {
    Write-Host "!! Rollback failed: $($_.Exception.Message)"
  }
  if ($script:backupFile) {
    Write-Host "   Database backup taken before this deploy: $($script:backupFile)"
  }
}

try {
  # ---- 1. Preflight -------------------------------------------------------
  Write-Step "Deploying $short from $SourceDir to $DeployDir"

  $script:mode = if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) { 'service' } else { 'pm2' }
  $tools = @('node', 'pnpm')
  if ($script:mode -eq 'pm2') { $tools += 'pm2' }
  foreach ($tool in $tools) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
      throw "'$tool' is not on PATH for the account running this script."
    }
  }
  if (-not (Test-Path (Join-Path $SourceDir 'pnpm-lock.yaml'))) {
    throw "SourceDir $SourceDir does not look like the repository root (no pnpm-lock.yaml)."
  }
  if (-not (Test-Path $backendDir)) {
    throw "Deploy folder $DeployDir is not set up yet. See the one-time setup steps."
  }
  if (-not (Test-Path (Join-Path $backendDir '.env'))) {
    throw "Missing $backendDir\.env. Copy it into the deploy folder first."
  }

  if ($script:mode -eq 'service') {
    Write-Step "Backend runs as the Windows service '$ServiceName'"
    $dir = (Get-ServiceAppDir).TrimEnd('\')
    if ($dir -ine $backendDir.TrimEnd('\')) {
      throw "Service '$ServiceName' runs from '$dir', not from '$backendDir'. Restarting it would not deploy this code."
    }
    # A PM2 entry left over from before the switch would fight the service for the port.
    # A PM2 outage must not stop the deploy, though: that is what the service is for. Ask PM2
    # only while its daemon runs: `pm2 jlist` would otherwise start a new, empty daemon and hide
    # the outage the monitor is reporting.
    $daemonPid = $null
    $pidFile = Join-Path $Pm2Home 'pm2.pid'
    if (Test-Path $pidFile) { $daemonPid = [string](Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1) }
    $daemonUp = ($daemonPid -match '^\s*\d+\s*$') -and [bool](Get-Process -Id ([int]$daemonPid.Trim()) -ErrorAction SilentlyContinue)
    if (-not $daemonUp) {
      Write-Host "   PM2 daemon is not running (no live pid in $pidFile); not checking for a leftover PM2 entry."
    } elseif (Get-Command pm2 -ErrorAction SilentlyContinue) {
      $left = $null
      try { $left = Get-Pm2Proc } catch { Write-Host "   PM2 could not be read ($($_.Exception.Message)); continuing." }
      if ($left) {
        throw "Both the service '$ServiceName' and a PM2 process '$PmName' exist. Finish the switch first: pm2 delete $PmName; pm2 save (docs\runbook-service.md)."
      }
    }
  } else {
    Write-Step "Backend runs as the PM2 process '$PmName'"
    $proc = Get-Pm2Proc
    if (-not $proc) { throw "PM2 has no process named '$PmName' (PM2_HOME=$Pm2Home), and there is no service '$ServiceName'." }
    $cwd = ([string]$proc.Cwd).TrimEnd('\')
    if ($cwd -ine $backendDir.TrimEnd('\')) {
      throw "PM2 process '$PmName' runs from '$cwd', not from '$backendDir'. Restarting it would not deploy this code. Re-create the PM2 process from the deploy folder first."
    }
  }

  # ---- 2. Database backup -------------------------------------------------
  if (Test-Path $DbPath) {
    New-Item -ItemType Directory -Force $BackupDir | Out-Null
    $script:backupFile = Join-Path $BackupDir ('monitor-{0}-{1}.db' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $short)

    $helper = Join-Path $env:TEMP 'cc-backup-db.cjs'
    @'
const path = require('path');
const [,, backendDir, db, out] = process.argv;
const req = require('module').createRequire(path.join(backendDir, 'package.json'));
const Database = req('better-sqlite3');
const conn = new Database(db, { readonly: true, fileMustExist: true });
conn.prepare('VACUUM INTO ?').run(out);
conn.close();
'@ | Set-Content -Path $helper -Encoding UTF8

    Invoke-Native "Backing up database to $($script:backupFile)" {
      node $helper $backendDir $DbPath $script:backupFile
    }
    if (-not (Test-Path $script:backupFile)) { throw 'Backup file was not created.' }
  } else {
    Write-Host "   No database at $DbPath yet, skipping backup."
  }

  # ---- 3. Snapshot current release ---------------------------------------
  Write-Step "Snapshotting current release to $PrevDir"
  Copy-Tree $DeployDir $PrevDir -WithDist

  # ---- 4. Copy new source -------------------------------------------------
  $script:mirrored = $true
  Write-Step 'Copying new source into the deploy folder'
  Copy-Tree $SourceDir $DeployDir

  # ---- 5. Install and build ----------------------------------------------
  Push-Location $DeployDir
  try {
    Invoke-Native 'Installing dependencies (frozen lockfile)' {
      pnpm install --frozen-lockfile --filter '@cc/backend...'
    }
    Invoke-Native 'Building shared package' { pnpm build:shared }
    Invoke-Native 'Building backend' { pnpm --filter '@cc/backend' build }
  } finally { Pop-Location }

  # ---- 6. Restart and verify ---------------------------------------------
  Restart-Backend

  if (-not (Wait-Healthy)) { throw "Backend did not answer /health within $HealthTimeoutSec s." }

  $afterRestart = Get-BackendState
  Start-Sleep -Seconds 10
  $later = Get-BackendState
  if (-not $later.Running) {
    throw "Backend is '$($later.Status)' after restart."
  }
  if ($later.Marker -ne $afterRestart.Marker) {
    throw 'Backend is restarting repeatedly (crash loop).'
  }
  if (-not (Wait-Healthy)) { throw 'Backend stopped answering /health during the stability check.' }

  # ---- 7. Success bookkeeping --------------------------------------------
  if ($Sha) { Set-Content -Path (Join-Path $DeployDir '.deploy-sha') -Value $Sha }
  if (Test-Path $BackupDir) {
    Get-ChildItem $BackupDir -Filter 'monitor-*.db' |
      Sort-Object LastWriteTime -Descending |
      Select-Object -Skip $KeepBackups |
      Remove-Item -Force
  }
  Write-Host "==> Deploy of $short succeeded."
}
catch {
  Write-Host "!! Deploy failed: $($_.Exception.Message)"
  if ($script:mirrored) { Invoke-Rollback }
  exit 1
}