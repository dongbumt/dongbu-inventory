[CmdletBinding()]
param([ValidateSet('Status', 'Enable', 'Restore')][string]$Action = 'Status')

# Run on the label PC only. No print jobs, printer changes, SM changes,
# browser termination, profile edits, or machine-wide policy writes.
function Get-DbmtSilentPolicy {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        $key = Get-Item -LiteralPath $Path -ErrorAction Stop
        if ($key.GetValueNames() -contains 'SilentPrintingEnabled') {
            return [pscustomobject]@{
                Exists = $true
                Kind = $key.GetValueKind('SilentPrintingEnabled').ToString()
                Value = $key.GetValue('SilentPrintingEnabled')
            }
        }
    }
    return [pscustomobject]@{ Exists = $false; Kind = ''; Value = $null }
}

function Set-DbmtSilentPolicy {
    param($Snapshot)
    $path = 'HKCU:\Software\Policies\Microsoft\Edge'
    if ($Snapshot.Exists) {
        if (-not (Test-Path -LiteralPath $path)) {
            New-Item -Path $path -Force -ErrorAction Stop | Out-Null
        }
        New-ItemProperty -LiteralPath $path -Name 'SilentPrintingEnabled' -PropertyType DWord -Value $Snapshot.Value -Force -ErrorAction Stop | Out-Null
    } else {
        $current = Get-DbmtSilentPolicy $path
        if ($current.Exists) {
            Remove-ItemProperty -LiteralPath $path -Name 'SilentPrintingEnabled' -ErrorAction Stop
        }
    }
}

function Test-DbmtSamePolicy {
    param($Left, $Right)
    return ($Left.Exists -eq $Right.Exists -and (-not $Left.Exists -or ($Left.Kind -eq $Right.Kind -and $Left.Value -eq $Right.Value)))
}

function Get-DbmtSilentIdentity {
    return [pscustomobject]@{
        Computer = $env:COMPUTERNAME
        Sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    }
}

function Get-DbmtSilentBackupPath {
    return Join-Path $env:LOCALAPPDATA 'DBMT-Label-Setup\edge-silent-printing-backup.json'
}

function Read-DbmtSilentBackup {
    $path = Get-DbmtSilentBackupPath
    if (Test-Path -LiteralPath $path) {
        return Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    }
    return $null
}

function Write-DbmtSilentBackup {
    param($Backup)
    $path = Get-DbmtSilentBackupPath
    $directory = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null
    }
    # Store only this one policy's previous value, not the user's Edge profile.
    [System.IO.File]::WriteAllText($path, ($Backup | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
}

function Get-DbmtLabelPrintEnvironment {
    $edgeCandidates = @(
        'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
        'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
    )
    $edge = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $edge) { throw 'Microsoft Edge was not found.' }
    $printer = @(Get-CimInstance Win32_Printer -ErrorAction Stop | Where-Object Default)
    if ($printer.Count -ne 1) { throw 'Exactly one Windows default printer is required.' }
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    $settings = New-Object System.Drawing.Printing.PrinterSettings
    $settings.PrinterName = $printer[0].Name
    if (-not $settings.IsValid) { throw 'The default printer is unavailable.' }
    $page = $settings.DefaultPageSettings
    return [pscustomobject]@{
        EdgeMajor = (Get-Item -LiteralPath $edge).VersionInfo.FileMajorPart
        Printer = $printer[0].Name
        Port = $printer[0].PortName
        PaperWidth_mm = [math]::Round($page.PaperSize.Width * 0.254, 2)
        PaperHeight_mm = [math]::Round($page.PaperSize.Height * 0.254, 2)
        Landscape = $page.Landscape
    }
}

function Invoke-DbmtEdgeSilentPrinting {
    param([ValidateSet('Status', 'Enable', 'Restore')][string]$Action)
    $ErrorActionPreference = 'Stop'
    $identity = Get-DbmtSilentIdentity
    if ($identity.Computer -ne 'POS-PC') { throw 'Run this script on the label PC (POS-PC), not the office PC.' }
    $userPath = 'HKCU:\Software\Policies\Microsoft\Edge'
    $machinePath = 'HKLM:\Software\Policies\Microsoft\Edge'
    $current = Get-DbmtSilentPolicy $userPath
    if ($current.Exists -and ($current.Kind -ne 'DWord' -or $current.Value -notin @(0, 1))) {
        throw 'Unexpected existing policy type/value. Nothing was changed.'
    }

    if ($Action -eq 'Status') {
        $machine = Get-DbmtSilentPolicy $machinePath
        [pscustomobject]@{
            Computer = $identity.Computer
            UserPolicy = $(if ($current.Exists) { $current.Value } else { 'Not configured' })
            MachinePolicy = $(if ($machine.Exists) { $machine.Value } else { 'Not configured' })
            Note = 'Registry status only. Confirm SilentPrintingEnabled = true, status OK at edge://policy.'
        }
        return
    }

    $backup = Read-DbmtSilentBackup
    if ($null -ne $backup) {
        if ($backup.Version -ne 1 -or $backup.Computer -ne $identity.Computer -or $backup.Sid -ne $identity.Sid -or
            $backup.Active -isnot [bool] -or $backup.Previous.Exists -isnot [bool] -or
            ($backup.Previous.Exists -and ($backup.Previous.Kind -ne 'DWord' -or $backup.Previous.Value -notin @(0, 1)))) {
            throw 'Backup validation failed. Nothing was changed.'
        }
    }
    $enabled = [pscustomobject]@{ Exists = $true; Kind = 'DWord'; Value = 1 }

    if ($Action -eq 'Restore') {
        if ($null -eq $backup) { throw 'No backup exists for this Windows user. Nothing was changed.' }
        if (-not $backup.Active) { Write-Output 'ALREADY RESTORED - no settings changed.'; return }
        if (-not (Test-DbmtSamePolicy $current $enabled) -and -not (Test-DbmtSamePolicy $current $backup.Previous)) {
            throw 'The policy changed after setup. Refusing to overwrite that later change.'
        }
        Set-DbmtSilentPolicy $backup.Previous
        if (-not (Test-DbmtSamePolicy (Get-DbmtSilentPolicy $userPath) $backup.Previous)) { throw 'Restore verification failed.' }
        $backup.Active = $false
        Write-DbmtSilentBackup $backup
        Write-Output 'RESTORED - original user policy restored. Close print windows and reload edge://policy. Machine policies are unchanged.'
        return
    }

    $machine = Get-DbmtSilentPolicy $machinePath
    if ($machine.Exists) {
        throw 'A machine-wide SilentPrintingEnabled policy already exists. Check edge://policy before changing anything.'
    }
    foreach ($path in @($userPath, $machinePath)) {
        $printing = Get-ItemProperty -LiteralPath $path -Name 'PrintingEnabled' -ErrorAction SilentlyContinue
        if ($null -ne $printing -and $printing.PrintingEnabled -eq 0) { throw 'Printing is disabled by another policy. Nothing was changed.' }
    }
    $environment = Get-DbmtLabelPrintEnvironment
    if ($environment.EdgeMajor -lt 144) { throw 'SilentPrintingEnabled requires Microsoft Edge 144 or newer.' }
    if ($environment.Printer -ne 'DBMT_ERP_LABEL_70x100' -or $environment.Port -ne 'USB001') {
        throw 'The Windows default printer must be DBMT_ERP_LABEL_70x100 on USB001. No printer settings were changed.'
    }
    # Accept the already observed 72.39 x 100.08 mm driver form for the first
    # supervised test; this is not a claim that its physical width is 70 mm.
    if ($environment.PaperWidth_mm -lt 68 -or $environment.PaperWidth_mm -gt 74 -or
        $environment.PaperHeight_mm -lt 98 -or $environment.PaperHeight_mm -gt 102 -or $environment.Landscape) {
        throw 'Unexpected default paper size/orientation. Check the ERP printer settings before enabling automatic printing.'
    }
    if ($null -ne $backup -and $backup.Active) {
        if (-not (Test-DbmtSamePolicy $current $enabled) -and -not (Test-DbmtSamePolicy $current $backup.Previous)) {
            throw 'Policy changed since the backup. Nothing was changed.'
        }
    } else {
        $backup = [pscustomobject]@{
            Version = 1; Computer = $identity.Computer; Sid = $identity.Sid
            Active = $true; Previous = $current; CreatedUtc = [DateTime]::UtcNow.ToString('o')
        }
        Write-DbmtSilentBackup $backup
    }
    Set-DbmtSilentPolicy $enabled
    if (-not (Test-DbmtSamePolicy (Get-DbmtSilentPolicy $userPath) $enabled)) { throw 'Policy write verification failed.' }
    Write-Output 'ENABLED - SilentPrintingEnabled = 1 for the current Windows user, across all Edge profiles.'
    $environment | Format-List
    Write-Output 'No print job was sent. Check edge://policy: Reload policies, SilentPrintingEnabled = true, status OK.'
    Write-Output 'Then reprint ONE existing label. A preview may briefly appear and close automatically.'
    Write-Output 'Default printer/paper changes affect later silent jobs. If output is wrong, stop and use -Action Restore.'
    Write-Output ('Backup: ' + (Get-DbmtSilentBackupPath))
}

# Dot-sourcing is reserved for isolated tests; no Windows changes run on import.
if ($MyInvocation.InvocationName -ne '.') {
    Invoke-DbmtEdgeSilentPrinting -Action $Action
}
