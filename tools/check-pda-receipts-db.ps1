param([ValidateSet('check-pda-receipts-db.py','check-pda-corrections-db.py','check-inventory-refresh-db.py','check-pda-shipment-edits-db.py','check-pda-product-cancellations-db.py')][string]$TestScript='check-pda-receipts-db.py')
$ErrorActionPreference='Stop'
$names=@('PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE')
$previous=@{}
foreach($name in $names){$previous[$name]=[Environment]::GetEnvironmentVariable($name)}
try {
  $cli=Get-ChildItem -LiteralPath "$env:LOCALAPPDATA/npm-cache/_npx" -Filter supabase.exe -Recurse | Select-Object -First 1 -ExpandProperty FullName
  if(-not $cli){throw 'Supabase CLI is unavailable.'}
  $ErrorActionPreference='Continue'
  $connection=& $cli db dump --linked --dry-run 2>&1 | Out-String
  $ErrorActionPreference='Stop'
  if($LASTEXITCODE -ne 0){throw 'Could not resolve linked database connection.'}
  foreach($name in $names){
    $match=[regex]::Match($connection,'export '+$name+'="([^"]+)"')
    if(-not $match.Success){throw 'Missing connection field.'}
    [Environment]::SetEnvironmentVariable($name,$match.Groups[1].Value)
  }
  & python -u (Join-Path $PSScriptRoot $TestScript)
  if($LASTEXITCODE -ne 0){throw 'Receipt tests failed; all changes rolled back.'}
}finally{
  foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$previous[$name])}
  $connection=$null
}
