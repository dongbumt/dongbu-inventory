[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNames = @('PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE')
$previous = @{}
foreach($name in $taskNames){ $previous[$name] = [Environment]::GetEnvironmentVariable($name) }
Push-Location -LiteralPath $taskRoot
try {
  # Capture the linked CLI's temporary connection in memory. Never print it.
  $connection = & npx.cmd supabase@latest db dump --linked --dry-run 2>&1 | Out-String
  if($LASTEXITCODE -ne 0){ throw 'Could not resolve the linked Supabase connection.' }
  foreach($name in $taskNames){
    $match = [regex]::Match($connection, 'export ' + $name + '="([^"]+)"')
    if(-not $match.Success){ throw 'Missing Supabase connection field.' }
    [Environment]::SetEnvironmentVariable($name, $match.Groups[1].Value)
  }
  $schema = Get-Content -LiteralPath (Join-Path $taskRoot 'supabase/schema-rpc-34-driver-temperature-records.sql') -Encoding UTF8 -Raw
  $taskArgs = @((Join-Path $PSScriptRoot 'check-temperature-db.py'))
  if($Apply){ $taskArgs += '--apply' }
  $previousEncoding = $OutputEncoding
  try {
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $schema | python @taskArgs
    if($LASTEXITCODE -ne 0){ throw 'Temperature schema verification failed; changes were rolled back.' }
  } finally { $OutputEncoding = $previousEncoding }
} finally {
  foreach($name in $taskNames){ [Environment]::SetEnvironmentVariable($name, $previous[$name]) }
  $connection = $null
  Pop-Location
}
