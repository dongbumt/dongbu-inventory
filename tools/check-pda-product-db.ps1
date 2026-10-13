[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$names = @('PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE')
$previous = @{}
foreach($name in $names){ $previous[$name] = [Environment]::GetEnvironmentVariable($name) }
Push-Location -LiteralPath $root
try {
  $connection = & npx.cmd supabase@latest db dump --linked --dry-run 2>&1 | Out-String
  if($LASTEXITCODE -ne 0){ throw 'Could not resolve the linked Supabase connection.' }
  foreach($name in $names){
    $match = [regex]::Match($connection, 'export ' + $name + '="([^"]+)"')
    if(-not $match.Success){ throw 'Missing Supabase connection field.' }
    [Environment]::SetEnvironmentVariable($name, $match.Groups[1].Value)
  }
  $taskArguments = @((Join-Path $PSScriptRoot 'check-pda-product-db.py'))
  if($Apply){ $taskArguments += '--apply' }
  & python @taskArguments
  if($LASTEXITCODE -ne 0){ throw 'PDA verification failed; schema and QA fixtures rolled back.' }
} finally {
  foreach($name in $names){ [Environment]::SetEnvironmentVariable($name, $previous[$name]) }
  $connection = $null
  Pop-Location
}
