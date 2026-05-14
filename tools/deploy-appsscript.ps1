param(
  [switch]$CreateVersion,
  [string]$DeploymentId
)

$ErrorActionPreference = 'Stop'

function Invoke-Clasp {
  param(
    [Parameter(Mandatory=$true)][string]$Exe,
    [Parameter(ValueFromRemainingArguments=$true)][string[]]$Args
  )

  $output = & $Exe @Args 2>&1
  $output | Write-Host
  if ($LASTEXITCODE -ne 0) {
    throw "clasp command failed: $($Args -join ' ')"
  }
  return $output
}

if (-not (Test-Path ".clasp.json")) {
  throw ".clasp.json is missing. Copy .clasp.json.example and set scriptId."
}

$clasp = Get-Command clasp.cmd -ErrorAction SilentlyContinue
if (-not $clasp) {
  $clasp = Get-Command clasp -ErrorAction SilentlyContinue
}
if (-not $clasp) {
  $npmClasp = Join-Path $env:APPDATA "npm\clasp.cmd"
  if (Test-Path $npmClasp) {
    $clasp = [pscustomobject]@{ Source = $npmClasp }
  }
}
if (-not $clasp) {
  throw "clasp is not installed. Run: npm install -g @google/clasp"
}

Invoke-Clasp $clasp.Source push --force

if ($CreateVersion -or $DeploymentId) {
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $versionOutput = Invoke-Clasp $clasp.Source version "ERP update $stamp"
  $version = ($versionOutput | Select-String -Pattern '\d+' -AllMatches | ForEach-Object { $_.Matches.Value } | Select-Object -Last 1)
  if (-not $version) {
    throw "Could not detect the new version number from clasp output."
  }

  if ($DeploymentId) {
    Invoke-Clasp $clasp.Source redeploy -V $version -d "ERP update $stamp" $DeploymentId
  }
}
