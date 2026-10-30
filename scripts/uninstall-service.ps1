<#
.SYNOPSIS
  Stops and removes the monitor-api Windows service (H9). Run from an elevated PowerShell.
  To run the backend under PM2 again afterwards: pm2 start monitor-api (if the PM2 entry still
  exists), or re-create it from the saved `pm2 describe` output (docs\runbook-service.md).
#>
param([string]$ServiceName = 'monitor-api')

$ErrorActionPreference = 'Stop'
if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
  Write-Host "No service named '$ServiceName'. Nothing to do."
  exit 0
}
nssm stop $ServiceName
nssm remove $ServiceName confirm
if ($LASTEXITCODE -ne 0) { throw "nssm remove $ServiceName failed (exit code $LASTEXITCODE)" }
Write-Host "==> Removed '$ServiceName'."
