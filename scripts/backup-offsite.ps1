<#
.SYNOPSIS
  Copies the newest nightly database backup off the server with rclone (H7).

.DESCRIPTION
  The backend writes E:\monitor-backups\monitor-YYYYMMDD.db at 02:30 every night. Run this from a
  Windows scheduled task after that (for example 03:15). It:
    1. finds the newest monitor-YYYYMMDD.db and refuses one older than -MaxAgeHours,
    2. copies it to the rclone remote (rclone verifies size and checksum),
    3. deletes copies on the remote older than -KeepDays, by their nightly file name only.
  Every run appends one line to offsite.log in the backup folder. It exits with code 1 on any
  failure, so Task Scheduler shows the run as failed.

  The remote is set up once with `rclone config`, ideally as a `crypt` remote over the storage, so
  the copy is encrypted before it leaves the server. The database holds password hashes, session
  hashes and the audit log.

.EXAMPLE
  .\scripts\backup-offsite.ps1 -Remote 'monitor-offsite:'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Remote,
  [string]$BackupDir = 'E:\monitor-backups',
  [string]$Rclone = 'rclone',
  [int]$MaxAgeHours = 26,
  [int]$KeepDays = 30
)

$ErrorActionPreference = 'Stop'
$logFile = Join-Path $BackupDir 'offsite.log'

function Write-Log([string]$Text) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text
  Write-Host $line
  Add-Content -Path $logFile -Value $line
}

try {
  if (-not (Test-Path $BackupDir)) { throw "Backup folder $BackupDir does not exist." }
  $newest = Get-ChildItem $BackupDir -File |
    Where-Object { $_.Name -match '^monitor-\d{8}\.db$' } |
    Sort-Object Name -Descending |
    Select-Object -First 1
  if (-not $newest) { throw "No nightly backup (monitor-YYYYMMDD.db) in $BackupDir." }
  $age = (Get-Date) - $newest.LastWriteTime
  if ($age.TotalHours -gt $MaxAgeHours) {
    throw ("The newest backup {0} is {1:N0} hours old; the nightly job may be failing." -f $newest.Name, $age.TotalHours)
  }

  $dest = $Remote.TrimEnd('/')
  if (-not $dest.EndsWith(':')) { $dest = "$dest/" }
  & $Rclone copyto $newest.FullName ($dest + $newest.Name) --retries 3 --low-level-retries 10
  if ($LASTEXITCODE -ne 0) { throw "rclone copyto failed (exit code $LASTEXITCODE)." }

  # Remote retention: only nightly names, decided by the date in the name, not the remote's clock.
  $cut = (Get-Date).AddDays(-$KeepDays).ToString('yyyyMMdd')
  $listed = & $Rclone lsf $Remote --files-only
  if ($LASTEXITCODE -ne 0) { throw "rclone lsf failed (exit code $LASTEXITCODE)." }
  $removed = @()
  foreach ($name in $listed) {
    if ($name -match '^monitor-(\d{8})\.db$' -and $Matches[1] -lt $cut) {
      & $Rclone deletefile ($dest + $name)
      if ($LASTEXITCODE -ne 0) { throw "rclone deletefile $name failed (exit code $LASTEXITCODE)." }
      $removed += $name
    }
  }

  Write-Log ("ok {0} ({1:N1} MB) -> {2}; removed {3} old copies" -f $newest.Name, ($newest.Length / 1MB), $Remote, $removed.Count)
  exit 0
}
catch {
  Write-Log "FAILED $($_.Exception.Message)"
  exit 1
}
