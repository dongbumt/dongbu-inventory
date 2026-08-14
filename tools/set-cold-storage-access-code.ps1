[CmdletBinding()]
param(
  [string]$ProjectRef = 'hdwjwtmbsxfjrlvicgnn'
)

$ErrorActionPreference = 'Stop'
$plainFirst = $null
$plainSecond = $null
$firstBstr = [IntPtr]::Zero
$secondBstr = [IntPtr]::Zero

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
  Write-Host 'DBMT cold-storage public access code setup' -ForegroundColor White
  Write-Host 'Use a code different from the ERP integration password.'
  Write-Host 'The plaintext code is hidden and is not stored in the repository.'
  Write-Host ''

  $secureFirst = Read-Host 'New access code' -AsSecureString
  $secureSecond = Read-Host 'Confirm access code' -AsSecureString
  $plainFirst = Get-PlainTextFromSecureString -SecureValue $secureFirst -AllocatedBstr ([ref]$firstBstr)
  $plainSecond = Get-PlainTextFromSecureString -SecureValue $secureSecond -AllocatedBstr ([ref]$secondBstr)

  if ($plainFirst.Length -lt 8 -or $plainFirst.Length -gt 64) {
    throw 'The access code must contain 8 to 64 characters.'
  }
  if ($plainFirst -notmatch '^[A-Za-z0-9!@#$%^&*_+=-]+$') {
    throw 'Use ASCII letters, numbers, and these symbols only: ! @ # $ % ^ & * _ - + ='
  }
  if ($plainFirst -cne $plainSecond) {
    throw 'The two access-code entries do not match.'
  }

  $bytes = [Text.Encoding]::UTF8.GetBytes($plainFirst)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
  }
  finally {
    $sha.Dispose()
    [Array]::Clear($bytes, 0, $bytes.Length)
  }

  Write-Host 'Saving the SHA-256 verifier to the production Edge Function...'
  npx.cmd supabase@latest secrets set --project-ref $ProjectRef "COLD_STORAGE_PUBLIC_ACCESS_SHA256=$hash"
  if ($LASTEXITCODE -ne 0) {
    throw 'Supabase secret update failed.'
  }

  Write-Host ''
  Write-Host 'Cold-storage public access code setup completed successfully.' -ForegroundColor White
  Write-Host 'Staff will enter this code on the standalone cold-storage page.'
}
catch {
  Write-Error $_.Exception.Message
  exit 1
}
finally {
  if ($firstBstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($firstBstr)
  }
  if ($secondBstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secondBstr)
  }
  $plainFirst = $null
  $plainSecond = $null
  $hash = $null
  if ($secureFirst) { $secureFirst.Dispose() }
  if ($secureSecond) { $secureSecond.Dispose() }
}
