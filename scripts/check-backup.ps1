<#
.SYNOPSIS
  Restore test on a copy (H7, V19): proves a backup file opens and holds the data that matters.

.DESCRIPTION
  Copies the backup to a temporary folder (the original is never opened), runs
  PRAGMA integrity_check on the copy, and prints row counts for the tables that must survive a
  restore: users, settings, alert rules and mutes, services and their git mapping, tenants and the
  audit log, plus the newest audit entry. Uses better-sqlite3 from the deployed backend.
  Exits with code 1 if the check fails. Does not touch the live database or monitor-api.

.EXAMPLE
  .\scripts\check-backup.ps1 -Backup E:\monitor-backups\monitor-20261030.db
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Backup,
  [string]$BackendDir = 'C:\Apps\command-center-deploy\apps\backend'
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Backup)) { throw "No file at $Backup." }

$work = Join-Path $env:TEMP ('cc-restore-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $work | Out-Null
try {
  $copy = Join-Path $work 'monitor.db'
  Copy-Item $Backup $copy
  $helper = Join-Path $work 'check.cjs'
  @'
const path = require('path');
const [,, backendDir, file] = process.argv;
const req = require('module').createRequire(path.join(backendDir, 'package.json'));
const Database = req('better-sqlite3');
const db = new Database(file, { readonly: true, fileMustExist: true });
const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check);
const tables = ['users', 'settings', 'alert_rules', 'alert_mutes', 'services', 'service_git', 'tenants', 'audit_log', 'schema_migrations'];
const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
const counts = {};
for (const t of tables) counts[t] = have.has(t) ? db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n : 'missing';
const last = have.has('audit_log') ? db.prepare('SELECT ts, event FROM audit_log ORDER BY ts DESC LIMIT 1').get() : null;
db.close();
console.log(JSON.stringify({ integrity, counts, newestAudit: last && { at: new Date(last.ts).toISOString(), event: last.event } }, null, 2));
const ok = integrity.length === 1 && integrity[0] === 'ok' && counts.users > 0 && counts.settings !== 'missing';
process.exit(ok ? 0 : 1);
'@ | Set-Content -Path $helper -Encoding UTF8

  node $helper $BackendDir $copy
  if ($LASTEXITCODE -ne 0) { Write-Host '!! Restore test FAILED.'; exit 1 }
  Write-Host '==> Restore test passed: the backup opens, passes integrity_check and has users.'
  exit 0
}
finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
