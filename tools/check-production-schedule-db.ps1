[CmdletBinding()]
param([switch]$Deploy)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNames = @('PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE')
$previous = @{}
foreach($name in $taskNames){ $previous[$name] = [Environment]::GetEnvironmentVariable($name) }
Push-Location -LiteralPath $taskRoot
try {
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
  $testArgs = @(if($Deploy){'--deploy'})
  $previousEncoding = $OutputEncoding
  try {
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    python (Join-Path $PSScriptRoot 'check-production-schedule-db.py') @testArgs
    if($LASTEXITCODE -ne 0){ throw 'Production schedule verification or deployment failed.' }
  } finally { $OutputEncoding = $previousEncoding }
} finally {
  foreach($name in $taskNames){ [Environment]::SetEnvironmentVariable($name, $previous[$name]) }
  $connection = $null
  Pop-Location
}
