param([switch]$Deployed)
$ErrorActionPreference='Stop'
$taskNames=@('PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE','DBMT_LEDGER_TEST_DEPLOYED','PYTHONIOENCODING')
$taskPrevious=@{}
foreach($taskName in $taskNames){$taskPrevious[$taskName]=[Environment]::GetEnvironmentVariable($taskName)}
Push-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
try {
  # Resolve temporary credentials in memory; never print or save the dump plan.
  $ErrorActionPreference='Continue'
  $taskConnection=& npx.cmd supabase@2.122.1 db dump --linked --dry-run 2>&1 | Out-String
  $taskCliExit=$LASTEXITCODE
  $ErrorActionPreference='Stop'
  if($taskCliExit -ne 0){throw 'Could not resolve the linked database connection.'}
  foreach($taskName in $taskNames | Where-Object {$_ -like 'PG*'}){
    $taskMatch=[regex]::Match($taskConnection,'export '+$taskName+'="([^"]+)"')
    if(-not $taskMatch.Success){throw 'Missing database connection field.'}
    [Environment]::SetEnvironmentVariable($taskName,$taskMatch.Groups[1].Value)
  }
  [Environment]::SetEnvironmentVariable('DBMT_LEDGER_TEST_DEPLOYED',$(if($Deployed){'1'}else{'0'}))
  [Environment]::SetEnvironmentVariable('PYTHONIOENCODING','utf-8')
  & python -u (Join-Path $PSScriptRoot 'check-ledgers-db.py')
  if($LASTEXITCODE -ne 0){throw 'Ledger verification failed; all test changes rolled back.'}
}finally{
  foreach($taskName in $taskNames){[Environment]::SetEnvironmentVariable($taskName,$taskPrevious[$taskName])}
  $taskConnection=$null;$taskMatch=$null
  Pop-Location
}
