[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$taskNames=@('PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE')
$previous=@{}
foreach($name in $taskNames){$previous[$name]=[Environment]::GetEnvironmentVariable($name)}
Push-Location -LiteralPath $taskRoot
try {
  $previousAction=$ErrorActionPreference
  try {
    $ErrorActionPreference='Continue'
    $connection=& npx.cmd supabase@latest db dump --linked --dry-run 2>&1 | Out-String
    $cliExit=$LASTEXITCODE
  } finally {$ErrorActionPreference=$previousAction}
  if($cliExit -ne 0){throw 'Could not resolve linked database credentials.'}
  foreach($name in $taskNames){
    $match=[regex]::Match($connection,'export '+$name+'="([^"]+)"')
    if(-not $match.Success){throw 'Missing linked database connection field.'}
    [Environment]::SetEnvironmentVariable($name,$match.Groups[1].Value)
  }
  $schema=Get-Content -LiteralPath (Join-Path $taskRoot 'supabase/schema-rpc-40-submaterial-stock-count.sql') -Encoding UTF8 -Raw
  $previousEncoding=$OutputEncoding
  try {
    $OutputEncoding=[System.Text.UTF8Encoding]::new($false)
    $schema | python (Join-Path $PSScriptRoot 'check-submaterial-stock-count-db.py')
    if($LASTEXITCODE -ne 0){throw 'Submaterial count verification failed; all changes were rolled back.'}
  } finally {$OutputEncoding=$previousEncoding}
} finally {
  foreach($name in $taskNames){[Environment]::SetEnvironmentVariable($name,$previous[$name])}
  $connection=$null
  Pop-Location
}
