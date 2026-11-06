# Removes the Blue Vue server service and program files. Data (site, admin
# password, Android TV pairing, logs) is kept unless -RemoveData is given.
# Run in an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\uninstall-server.ps1
param(
    [string]$InstallDir = "$env:ProgramFiles\BlueVue",
    [string]$DataDir = "$env:ProgramData\BlueVue",
    [string]$TaskName = "BlueVueServer",
    [switch]$RemoveData
)
$ErrorActionPreference = "Stop"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated (Administrator) PowerShell."
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-NetFirewallRule -DisplayName "Blue Vue Server" -ErrorAction SilentlyContinue | Remove-NetFirewallRule

Start-Sleep -Seconds 1
if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
if ($RemoveData -and (Test-Path $DataDir)) {
    Remove-Item -Recurse -Force $DataDir
    Write-Host "Removed Blue Vue and its data."
} else {
    Write-Host "Removed Blue Vue. Data kept in $DataDir (re-installing picks it up again)."
}
