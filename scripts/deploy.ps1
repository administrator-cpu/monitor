<#
.SYNOPSIS
  Deploys the Command Center backend on this Windows VPS.

.DESCRIPTION
  Order of work:
    1. Preflight (tools, deploy folder, .env, PM2 process points at the deploy folder)
    2. Consistent backup of the SQLite database
    3. Snapshot of the current release (for rollback)
    4. Copy the new source into the deploy folder (keeps .env, node_modules, dist)
    5. pnpm install --frozen-lockfile (backend + shared only), build
    6. pm2 restart, then health check and a short stability check
    7. If anything fails after step 3: restore the snapshot, reinstall, restart

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
  [string]$BackupDir = 'C:\monitor\backups',
  [string]$DbPath = 'C:\monitor\data\monitor.db',
  [string]$PmName = 'monitor-api',
  [string]$Pm2Home = 'C:\Users\Administrator\.pm2',
  [int]$Port = 4111,
  [int]$HealthTimeoutSec = 45,
  [int]$KeepBackups = 10
)

$ErrorActionPreference = 'Stop'
$env:PM2_HOME = $Pm2Home

# A manual run has no commit id passed in: ask git, so the dashboard can show what is deployed.
if (-not $Sha) {
  try {
    $found = (& git -C $SourceDir rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -eq 0 -and $found -match '^[0-9a-f]{40}$') { $Sha = $found.Trim() }
  } catch { }
}

$short = if ($Sha) { $Sha.Substring(0, [Math]::Min(7, $Sha.Length)) } else { 'manual' }
$backendDir = Join-Path $DeployDir 'apps\backend'
$script:mirrored = $false
$script:backupFile = $null

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
    pm2 restart $PmName
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

  foreach ($tool in 'node', 'pnpm', 'pm2') {
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

  $proc = Get-Pm2Proc
  if (-not $proc) { throw "PM2 has no process named '$PmName' (PM2_HOME=$Pm2Home)." }
  $cwd = ([string]$proc.Cwd).TrimEnd('\')
  if ($cwd -ine $backendDir.TrimEnd('\')) {
    throw "PM2 process '$PmName' runs from '$cwd', not from '$backendDir'. Restarting it would not deploy this code. Re-create the PM2 process from the deploy folder first."
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
  Invoke-Native "Restarting PM2 process '$PmName'" { pm2 restart $PmName }

  if (-not (Wait-Healthy)) { throw "Backend did not answer /health within $HealthTimeoutSec s." }

  $afterRestart = Get-Pm2Proc
  Start-Sleep -Seconds 10
  $later = Get-Pm2Proc
  if (-not $later -or $later.Status -ne 'online') {
    throw "PM2 process is '$($later.Status)' after restart."
  }
  if ($later.RestartTime -ne $afterRestart.RestartTime) {
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