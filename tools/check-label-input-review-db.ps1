[CmdletBinding()]
param([switch]$Installed)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNames = @('PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE')
$previous = @{}
foreach($name in $taskNames){ $previous[$name] = [Environment]::GetEnvironmentVariable($name) }
$previousPythonEncoding = [Environment]::GetEnvironmentVariable('PYTHONIOENCODING')
Push-Location -LiteralPath $taskRoot
try {
  # Temporary linked credentials remain only in process memory, never output or disk.
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
  $taskPython = (Get-Command python -ErrorAction SilentlyContinue).Source
  if(-not $taskPython){ $taskPython = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe' }
  [Environment]::SetEnvironmentVariable('PYTHONIOENCODING', 'utf-8')
  $previousEncoding = $OutputEncoding
  try {
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    if($Installed){
      & $taskPython (Join-Path $PSScriptRoot 'check-label-input-review-db.py') --installed
    } else {
      & $taskPython (Join-Path $PSScriptRoot 'check-label-input-review-db.py')
    }
    if($LASTEXITCODE -ne 0){ throw 'Label input review verification failed; schema and fixtures were rolled back.' }
  } finally { $OutputEncoding = $previousEncoding }
} finally {
  foreach($name in $taskNames){ [Environment]::SetEnvironmentVariable($name, $previous[$name]) }
  [Environment]::SetEnvironmentVariable('PYTHONIOENCODING', $previousPythonEncoding)
  $connection = $null
  Pop-Location
}
