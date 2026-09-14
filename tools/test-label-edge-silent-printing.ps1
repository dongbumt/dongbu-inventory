# Isolated state-machine tests: mock every registry, printer and backup operation.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'set-label-edge-silent-printing.ps1')

function Reset-Fixture {
    $script:computer = 'POS-PC'
    $script:userPolicy = [pscustomobject]@{ Exists = $false; Kind = ''; Value = $null }
    $script:machinePolicy = [pscustomobject]@{ Exists = $false; Kind = ''; Value = $null }
    $script:backupState = $null
    $script:policyWrites = 0
    $script:backupWrites = 0
    $script:backupFailure = $false
    $script:printingDisabled = $false
    $script:environment = [pscustomobject]@{
        EdgeMajor = 152; Printer = 'DBMT_ERP_LABEL_70x100'; Port = 'USB001'
        PaperWidth_mm = 72.39; PaperHeight_mm = 100.08; Landscape = $false
    }
}
function Get-DbmtSilentIdentity { [pscustomobject]@{ Computer = $script:computer; Sid = 'test-user' } }
function Get-DbmtSilentPolicy {
    param($Path)
    if ($Path.StartsWith('HKLM:')) { return $script:machinePolicy }
    return $script:userPolicy
}
function Set-DbmtSilentPolicy { param($Snapshot) $script:policyWrites++; $script:userPolicy = $Snapshot }
function Read-DbmtSilentBackup { return $script:backupState }
function Write-DbmtSilentBackup {
    param($Backup)
    if ($script:backupFailure) { throw 'Mock backup failed' }
    $script:backupWrites++
    $script:backupState = $Backup
}
function Get-DbmtSilentBackupPath { return 'mock-backup.json' }
function Get-DbmtLabelPrintEnvironment { return $script:environment }
function Get-ItemProperty {
    [CmdletBinding()]param($LiteralPath, $Name)
    if ($script:printingDisabled) { return [pscustomobject]@{ PrintingEnabled = 0 } }
    return $null
}
function Assert-True { param($Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Assert-Rejected {
    param([scriptblock]$Operation, [string]$Pattern)
    $caught = $false
    try { & $Operation | Out-Null } catch {
        $caught = $true
        Assert-True ($_.Exception.Message -match $Pattern) ('Unexpected error: ' + $_.Exception.Message)
    }
    Assert-True $caught ('Expected rejection: ' + $Pattern)
}

Reset-Fixture
Invoke-DbmtEdgeSilentPrinting Status | Out-Null
Assert-True ($script:policyWrites -eq 0 -and $script:backupWrites -eq 0) 'Status must be read-only'
Invoke-DbmtEdgeSilentPrinting Enable | Out-Null
Assert-True ($script:userPolicy.Value -eq 1 -and $script:backupState.Active -and -not $script:backupState.Previous.Exists) 'Enable must preserve an absent previous policy'
Invoke-DbmtEdgeSilentPrinting Enable | Out-Null
Assert-True ($script:backupWrites -eq 1 -and -not $script:backupState.Previous.Exists) 'Repeated enable must not replace the original backup'
$script:environment.Printer = 'Printer disconnected'
Invoke-DbmtEdgeSilentPrinting Restore | Out-Null
Assert-True (-not $script:userPolicy.Exists -and -not $script:backupState.Active) 'Restore must remove only a newly introduced value, even without the printer'
$writes = $script:policyWrites
Invoke-DbmtEdgeSilentPrinting Restore | Out-Null
Assert-True ($script:policyWrites -eq $writes) 'Repeated restore must not write'

foreach ($oldValue in @(0, 1)) {
    Reset-Fixture
    $script:userPolicy = [pscustomobject]@{ Exists = $true; Kind = 'DWord'; Value = $oldValue }
    Invoke-DbmtEdgeSilentPrinting Enable | Out-Null
    Invoke-DbmtEdgeSilentPrinting Restore | Out-Null
    Assert-True ($script:userPolicy.Exists -and $script:userPolicy.Value -eq $oldValue) 'Restore must preserve a pre-existing DWORD value'
}

foreach ($case in @('OfficePC', 'OldEdge', 'WrongPrinter', 'WrongPort', 'TallPaper', 'WidePaper', 'Landscape', 'MachinePolicy', 'PrintingDisabled', 'InvalidKind', 'BackupFailure')) {
    Reset-Fixture
    $pattern = ''
    switch ($case) {
        'OfficePC' { $script:computer = 'KSY'; $pattern = 'POS-PC' }
        'OldEdge' { $script:environment.EdgeMajor = 143; $pattern = '144' }
        'WrongPrinter' { $script:environment.Printer = 'Microsoft Print to PDF'; $pattern = 'default printer' }
        'WrongPort' { $script:environment.Port = 'USB002'; $pattern = 'USB001' }
        'TallPaper' { $script:environment.PaperHeight_mm = 150.11; $pattern = 'paper size' }
        'WidePaper' { $script:environment.PaperWidth_mm = 102.62; $pattern = 'paper size' }
        'Landscape' { $script:environment.Landscape = $true; $pattern = 'orientation' }
        'MachinePolicy' { $script:machinePolicy = [pscustomobject]@{ Exists = $true; Kind = 'DWord'; Value = 0 }; $pattern = 'machine-wide' }
        'PrintingDisabled' { $script:printingDisabled = $true; $pattern = 'disabled' }
        'InvalidKind' { $script:userPolicy = [pscustomobject]@{ Exists = $true; Kind = 'String'; Value = '1' }; $pattern = 'type/value' }
        'BackupFailure' { $script:backupFailure = $true; $pattern = 'backup failed' }
    }
    Assert-Rejected { Invoke-DbmtEdgeSilentPrinting Enable } $pattern
    Assert-True ($script:policyWrites -eq 0) ('Rejected preflight must not change policy: ' + $case)
}

Reset-Fixture
Invoke-DbmtEdgeSilentPrinting Enable | Out-Null
$script:userPolicy = [pscustomobject]@{ Exists = $true; Kind = 'DWord'; Value = 0 }
$writes = $script:policyWrites
Assert-Rejected { Invoke-DbmtEdgeSilentPrinting Restore } 'changed after setup'
Assert-True ($script:policyWrites -eq $writes) 'Restore must preserve a subsequent external policy change'

Reset-Fixture
Invoke-DbmtEdgeSilentPrinting Enable | Out-Null
$script:backupState.Sid = 'another-user'
$writes = $script:policyWrites
Assert-Rejected { Invoke-DbmtEdgeSilentPrinting Restore } 'Backup validation'
Assert-True ($script:policyWrites -eq $writes) 'A mismatched backup must not be applied'

Reset-Fixture
Invoke-DbmtEdgeSilentPrinting Enable | Out-Null
Invoke-DbmtEdgeSilentPrinting Restore | Out-Null
$script:userPolicy = [pscustomobject]@{ Exists = $true; Kind = 'DWord'; Value = 0 }
Invoke-DbmtEdgeSilentPrinting Enable | Out-Null
Assert-True ($script:backupState.Previous.Value -eq 0 -and $script:backupState.Previous.Exists) 'A new setup after restore must back up the then-current value'

Write-Output 'PASS: status, enable, backup, repeat enable/restore, original values, printer/version/paper guards, policy conflicts, backup failure and later-change protection. No real registry, printer or backup changes.'
