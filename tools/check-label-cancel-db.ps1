[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNames = @('PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE')
$previous = @{}
foreach($name in $taskNames){ $previous[$name] = [Environment]::GetEnvironmentVariable($name) }
Push-Location -LiteralPath $taskRoot
try {
  # Linked connection secrets stay only in memory, never in files or output.
  $previousAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $connection = & npx.cmd supabase@latest db dump --linked --dry-run 2>&1 | Out-String
    $cliExit = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousAction }
  if($cliExit -ne 0){ throw 'Could not resolve the linked Supabase connection.' }
  foreach($name in $taskNames){
    $match = [regex]::Match($connection, 'export ' + $name + '="([^"]+)"')
    if(-not $match.Success){ throw 'Missing Supabase connection field.' }
    [Environment]::SetEnvironmentVariable($name, $match.Groups[1].Value)
  }
  $schema = Get-Content -LiteralPath (Join-Path $taskRoot 'supabase/schema-rpc-41-label-production-cancel.sql') -Encoding UTF8 -Raw
  $migration = Get-Content -LiteralPath (Join-Path $taskRoot 'supabase/migrations/20260915090000_label_production_cancel.sql') -Encoding UTF8 -Raw
  if($schema.Replace("`r`n","`n").Trim() -cne $migration.Replace("`r`n","`n").Trim()){ throw 'Cancellation schema and migration differ.' }
  $taskArguments = @((Join-Path $PSScriptRoot 'check-label-cancel-db.py'))
  if($Apply){ $taskArguments += '--apply' }
  $previousEncoding = $OutputEncoding
  try {
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $schema | python @taskArguments
    if($LASTEXITCODE -ne 0){ throw 'Cancellation verification failed; all changes were rolled back.' }
  } finally { $OutputEncoding = $previousEncoding }
} finally {
  foreach($name in $taskNames){ [Environment]::SetEnvironmentVariable($name, $previous[$name]) }
  $connection = $null
  Pop-Location
}
