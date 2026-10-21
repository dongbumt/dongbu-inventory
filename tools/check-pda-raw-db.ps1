$ErrorActionPreference='Stop'
$names=@('PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE')
$previous=@{}
foreach($name in $names){$previous[$name]=[Environment]::GetEnvironmentVariable($name)}
Push-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
try {
  $connection=& npx.cmd --no-install supabase db dump --linked --dry-run 2>&1 | Out-String
  if($LASTEXITCODE -ne 0){throw 'Could not resolve linked database connection.'}
  foreach($name in $names){
    $match=[regex]::Match($connection,'export '+$name+'="([^"]+)"')
    if(-not $match.Success){throw 'Missing connection field.'}
    [Environment]::SetEnvironmentVariable($name,$match.Groups[1].Value)
  }
  & python -u (Join-Path $PSScriptRoot 'check-pda-raw-db.py')
  if($LASTEXITCODE -ne 0){throw 'Raw-material tests failed; all changes rolled back.'}
}finally{
  foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$previous[$name])}
  $connection=$null
  Pop-Location
}
