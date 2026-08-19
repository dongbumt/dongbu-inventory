[CmdletBinding()]
param(
  [string]$ProjectRef = 'hdwjwtmbsxfjrlvicgnn'
)

$ErrorActionPreference = 'Stop'
$plainFirst = $null
$plainSecond = $null
$firstBstr = [IntPtr]::Zero
$secondBstr = [IntPtr]::Zero
$temporaryFile = $null

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

try {
  Write-Host ''
  Write-Host 'DBMT livestock trace OpenAPI key setup' -ForegroundColor White
  Write-Host 'The key is hidden and is not stored in the repository or command history.'
  Write-Host 'Target project:' $ProjectRef
  Write-Host ''

  $secureFirst = Read-Host 'Public-data service key' -AsSecureString
  $secureSecond = Read-Host 'Confirm service key' -AsSecureString
  $plainFirst = Get-PlainTextFromSecureString -SecureValue $secureFirst -AllocatedBstr ([ref]$firstBstr)
  $plainSecond = Get-PlainTextFromSecureString -SecureValue $secureSecond -AllocatedBstr ([ref]$secondBstr)

  if ($plainFirst.Length -lt 10 -or $plainFirst.Length -gt 300) {
    throw 'The service key length must be between 10 and 300 characters.'
  }
  if ($plainFirst -match "[\r\n]") {
    throw 'The service key must be entered on one line.'
  }
  if ($plainFirst -cne $plainSecond) {
    throw 'The two service-key entries do not match.'
  }

  $temporaryFile = [IO.Path]::GetTempFileName()
  [IO.File]::WriteAllText($temporaryFile, "EKAPE_TRACE_SERVICE_KEY=$plainFirst", [Text.UTF8Encoding]::new($false))

  Write-Host 'Saving the service key to the production Edge Function secrets...'
  npx.cmd --yes supabase@latest secrets set --project-ref $ProjectRef --env-file $temporaryFile
  if ($LASTEXITCODE -ne 0) {
    throw 'Supabase secret update failed.'
  }

  Write-Host ''
  Write-Host 'Livestock trace OpenAPI key setup completed successfully.' -ForegroundColor White
}
catch {
  Write-Error $_.Exception.Message
  exit 1
}
finally {
  if ($temporaryFile -and (Test-Path -LiteralPath $temporaryFile)) {
    try { [IO.File]::WriteAllText($temporaryFile, '') } catch {}
    Remove-Item -LiteralPath $temporaryFile -Force -ErrorAction SilentlyContinue
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
