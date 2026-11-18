[CmdletBinding()]
param([switch]$Installed, [switch]$Profile)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$names = @('PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE','PYTHONIOENCODING')
$previous = @{}
foreach($name in $names){ $previous[$name] = [Environment]::GetEnvironmentVariable($name) }
Push-Location -LiteralPath $root
try {
  # Resolve temporary credentials in memory; never print or persist them.
  $oldAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $connection = & npx.cmd supabase@2.122.1 db dump --linked --dry-run 2>&1 | Out-String
    $cliExit = $LASTEXITCODE
  } finally { $ErrorActionPreference = $oldAction }
  if($cliExit -ne 0){ throw 'Could not resolve the linked Supabase connection.' }
  foreach($name in $names | Where-Object { $_ -ne 'PYTHONIOENCODING' }){
    $match = [regex]::Match($connection, 'export ' + $name + '="([^"]+)"')
    if(-not $match.Success){ throw 'Missing Supabase connection field.' }
    [Environment]::SetEnvironmentVariable($name, $match.Groups[1].Value)
  }
  $env:PYTHONIOENCODING = 'utf-8'
  $arguments = @((Join-Path $PSScriptRoot 'check-label-log-batch-db.py'))
  if($Installed){ $arguments += '--installed' }
  if($Profile){ $arguments += '--profile' }
  & python @arguments
  if($LASTEXITCODE -ne 0){ throw 'Label batch verification failed; all test changes rolled back.' }
} finally {
  foreach($name in $names){ [Environment]::SetEnvironmentVariable($name, $previous[$name]) }
  $connection = $null
  Pop-Location
}
