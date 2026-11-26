[CmdletBinding(DefaultParameterSetName='Lifecycle')]
param(
  [Parameter(ParameterSetName='Lifecycle')][switch]$Apply,
  [Parameter(Mandatory,ParameterSetName='Transfer')][switch]$Transfer,
  [Parameter(ParameterSetName='Transfer')][switch]$Deployed
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$names = @('PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE')
$previous = @{}
foreach($name in $names){ $previous[$name] = [Environment]::GetEnvironmentVariable($name) }
$previousTransferStatus = [Environment]::GetEnvironmentVariable('DBMT_PDA_PRODUCT_TRANSFER_DEPLOYED')
Push-Location -LiteralPath $root
try {
  $cli = if($Transfer){ 'supabase@2.122.1' }else{ 'supabase@latest' }
  $ErrorActionPreference = 'Continue'
  $connection = & npx.cmd $cli db dump --linked --dry-run 2>&1 | Out-String
  $cliExit = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if($cliExit -ne 0){ throw 'Could not resolve the linked Supabase connection.' }
  foreach($name in $names){
    $match = [regex]::Match($connection, 'export ' + $name + '="([^"]+)"')
    if(-not $match.Success){ throw 'Missing Supabase connection field.' }
    [Environment]::SetEnvironmentVariable($name, $match.Groups[1].Value)
  }
  $script = if($Transfer){ 'check-pda-product-transfer-db.py' }else{ 'check-pda-product-db.py' }
  if($Transfer){ [Environment]::SetEnvironmentVariable('DBMT_PDA_PRODUCT_TRANSFER_DEPLOYED', $(if($Deployed){'1'}else{'0'})) }
  $taskArguments = @('-u', (Join-Path $PSScriptRoot $script))
  if($Apply){ $taskArguments += '--apply' }
  & python @taskArguments
  if($LASTEXITCODE -ne 0){ throw 'PDA verification failed; schema and QA fixtures rolled back.' }
} finally {
  foreach($name in $names){ [Environment]::SetEnvironmentVariable($name, $previous[$name]) }
  if($Transfer){ [Environment]::SetEnvironmentVariable('DBMT_PDA_PRODUCT_TRANSFER_DEPLOYED', $previousTransferStatus) }
  $connection = $null
  Pop-Location
}
