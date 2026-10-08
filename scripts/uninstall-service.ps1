param([string]$ServiceName = 'CommandCenterBackend')
$ErrorActionPreference = 'Stop'
nssm stop $ServiceName
nssm remove $ServiceName confirm
