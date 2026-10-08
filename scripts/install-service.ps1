<#
.SYNOPSIS
  Installs the Command Center backend as a Windows service with NSSM.
  Runs OUTSIDE PM2 on purpose, so a PM2 failure is visible to the monitor.

.EXAMPLE
  .\install-service.ps1 -AppDir C:\monitor\app\apps\backend -EnvFile C:\monitor\config\backend.env `
      -ServiceAccount '.\svc-monitor'

  Prerequisites: nssm.exe on PATH, Node 22 installed, the repo built (pnpm build), the env file
  created, and `create-admin` already run. Run from an elevated PowerShell.
#>
param(
  [string]$ServiceName    = 'CommandCenterBackend',
  [string]$AppDir         = 'C:\monitor\app\apps\backend',
  [string]$EnvFile        = 'C:\monitor\config\backend.env',
  [string]$NodeExe        = (Get-Command node -ErrorAction Stop).Source,
  [string]$LogDir         = 'C:\monitor\service-logs',
  # Same Windows user that owns the PM2 daemon (phase 3), or set PM2_HOME in the env file.
  [string]$ServiceAccount = ''
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) { throw 'nssm.exe was not found on PATH.' }
if (-not (Test-Path (Join-Path $AppDir 'dist\index.js'))) { throw "dist\index.js not found in $AppDir. Run 'pnpm build' first." }
if (-not (Test-Path $EnvFile)) { throw "Env file not found: $EnvFile" }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

nssm install $ServiceName $NodeExe 'dist\index.js'
nssm set $ServiceName AppDirectory $AppDir
# The env file lives outside the repository; its ACL should allow only the service account and admins.
nssm set $ServiceName AppEnvironmentExtra "CC_ENV_FILE=$EnvFile"
nssm set $ServiceName DisplayName 'Command Center backend'
nssm set $ServiceName Start SERVICE_AUTO_START

# Restart on failure with a delay; ask Node to exit cleanly (Ctrl+C) before killing it.
nssm set $ServiceName AppExit Default Restart
nssm set $ServiceName AppRestartDelay 5000
nssm set $ServiceName AppThrottle 10000
nssm set $ServiceName AppStopMethodConsole 5000

# Service stdout/stderr (startup errors before the logger is up). Rotated.
nssm set $ServiceName AppStdout (Join-Path $LogDir 'service.log')
nssm set $ServiceName AppStderr (Join-Path $LogDir 'service.log')
nssm set $ServiceName AppRotateFiles 1
nssm set $ServiceName AppRotateOnline 1
nssm set $ServiceName AppRotateBytes 10485760

if ($ServiceAccount) {
  $cred = Get-Credential -UserName $ServiceAccount -Message 'Password for the service account'
  nssm set $ServiceName ObjectName $cred.UserName ($cred.GetNetworkCredential().Password)
}

nssm start $ServiceName
Write-Host "Installed and started '$ServiceName'. Check: curl http://127.0.0.1:4000/health"
