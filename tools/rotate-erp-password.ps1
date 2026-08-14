[CmdletBinding()]
param(
  [string]$ProjectRef = 'hdwjwtmbsxfjrlvicgnn'
)

$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'rotate_erp_password.py'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$plainFirst = $null
$plainSecond = $null
$firstBstr = [IntPtr]::Zero
$secondBstr = [IntPtr]::Zero
$locationPushed = $false
$temporaryEnvironmentNames = @(
  'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE',
  'PGSSLMODE', 'DBMT_PROJECT_REF'
)

function Get-PlainTextFromSecureString {
  param(
    [Parameter(Mandatory = $true)]
    [Security.SecureString]$SecureValue,
    [Parameter(Mandatory = $true)]
    [ref]$AllocatedBstr
  )
  $AllocatedBstr.Value = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($AllocatedBstr.Value)
}

function Test-NewErpPassword {
  param([Parameter(Mandatory = $true)][string]$Value)

  if ($Value.Length -lt 8 -or $Value.Length -gt 64) {
    throw 'The password must contain 8 to 64 characters.'
  }
  if ($Value -notmatch '^[A-Za-z0-9!@#$%^&*_+=-]+$') {
    throw 'Use ASCII letters, numbers, and these symbols only: ! @ # $ % ^ & * _ - + ='
  }
  if ($Value -cnotmatch '[a-z]' -or $Value -notmatch '[0-9]' -or
      $Value -notmatch '[!@#$%^&*_+=-]') {
    throw 'Include at least one lowercase letter, number, and symbol. Uppercase letters are optional.'
  }
}

try {
  if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Password rotation helper not found: $scriptPath"
  }
  if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw 'Python is not available.'
  }

  Write-Host ''
  Write-Host 'DBMT ERP production password rotation' -ForegroundColor White
  Write-Host 'The password is hidden and is not written to files or command history.'
  Write-Host 'Target project:' $ProjectRef
  Write-Host ''

  $secureFirst = Read-Host 'New password' -AsSecureString
  $secureSecond = Read-Host 'Confirm new password' -AsSecureString
  $plainFirst = Get-PlainTextFromSecureString -SecureValue $secureFirst -AllocatedBstr ([ref]$firstBstr)
  $plainSecond = Get-PlainTextFromSecureString -SecureValue $secureSecond -AllocatedBstr ([ref]$secondBstr)

  Test-NewErpPassword -Value $plainFirst
  if ($plainFirst -cne $plainSecond) {
    throw 'The two password entries do not match.'
  }

  Write-Host 'Resolving the linked production Supabase connection...'
  Push-Location -LiteralPath $repositoryRoot
  $locationPushed = $true
  $dryOutput = cmd.exe /d /s /c 'npx.cmd supabase@latest db dump --linked --dry-run 2>&1' | Out-String
  $supabaseExitCode = $LASTEXITCODE
  Pop-Location
  $locationPushed = $false
  if ($supabaseExitCode -ne 0) {
    throw 'Could not resolve the linked production Supabase connection.'
  }

  foreach ($name in @('PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE')) {
    $match = [regex]::Match($dryOutput, 'export ' + $name + '="([^"]+)"')
    if (-not $match.Success) {
      throw "Could not resolve $name from the linked Supabase project."
    }
    Set-Item -Path ('Env:' + $name) -Value $match.Groups[1].Value
  }
  $env:PGSSLMODE = 'require'
  $env:DBMT_PROJECT_REF = $ProjectRef

  Write-Host 'Saving the verifier and checking ERP RPC authentication...'
  $plainFirst | python $scriptPath
  if ($LASTEXITCODE -ne 0) {
    throw 'Server verification failed. The database transaction was rolled back.'
  }

  Write-Host ''
  Write-Host 'ERP integration password rotation completed successfully.' -ForegroundColor White
  Write-Host 'Enter the new password once on each ERP PC.'
}
catch {
  Write-Error $_.Exception.Message
  exit 1
}
finally {
  if ($locationPushed) {
    Pop-Location
  }
  foreach ($name in $temporaryEnvironmentNames) {
    Remove-Item -Path ('Env:' + $name) -ErrorAction SilentlyContinue
  }
  if ($firstBstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($firstBstr)
  }
  if ($secondBstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secondBstr)
  }
  $plainFirst = $null
  $plainSecond = $null
  if ($secureFirst) { $secureFirst.Dispose() }
  if ($secureSecond) { $secureSecond.Dispose() }
}
