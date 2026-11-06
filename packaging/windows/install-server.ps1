# Installs (or updates) the Blue Vue control server as a background service
# that starts with Windows, on the media server or any always-on PC.
# Run in an elevated PowerShell from the unzipped BlueVue-Server folder:
#   powershell -ExecutionPolicy Bypass -File .\install-server.ps1
# Re-run it from a newer package to update; settings and data are kept.
param(
    [int]$Port = 8080,
    [string]$InstallDir = "$env:ProgramFiles\BlueVue",
    [string]$DataDir = "$env:ProgramData\BlueVue",
    [string]$GracenoteKey,           # optional: TV guide API key, stored in the data folder's .env
    [string]$TaskName = "BlueVueServer"
)
$ErrorActionPreference = "Stop"
$src = $PSScriptRoot

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated (Administrator) PowerShell."
}
if (-not (Test-Path (Join-Path $src "app\server.mjs"))) { throw "Run this from the unzipped BlueVue-Server folder." }
if ($Port -eq 8090) { throw "Port 8090 is the mosaic engine's. Pick another port." }

# Stop the running server before replacing its files.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "Stopping the running server..."
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

# Program files: replaced on every install.
if ((Resolve-Path $src).Path.TrimEnd("\") -ne $InstallDir.TrimEnd("\")) {
    Write-Host "Copying program files to $InstallDir..."
    New-Item -ItemType Directory -Force $InstallDir | Out-Null
    robocopy $src $InstallDir /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copying files failed (robocopy exit $LASTEXITCODE)" }
}

# Data: kept across updates. It holds the admin password hash, the site, the
# Android TV certificate and API keys, so only Administrators and SYSTEM can read it.
New-Item -ItemType Directory -Force (Join-Path $DataDir "logs") | Out-Null
icacls $DataDir /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" | Out-Null

$config = Join-Path $DataDir "system.json"
if (Test-Path $config) {
    $cfg = Get-Content $config -Raw | ConvertFrom-Json
    if ($PSBoundParameters.ContainsKey("Port")) { $cfg.server.port = $Port }
} else {
    $cfg = [ordered]@{
        server = [ordered]@{ port = $Port }
        simulate = $false
        dataDir = (Join-Path $DataDir "data")
        guide = [ordered]@{ enabled = $true; apiKeyEnv = "GRACENOTE_API_KEY"; lineupId = ""; hours = 6; refreshMinutes = 30 }
    }
}
$cfg | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $config
$Port = [int]$cfg.server.port

if ($GracenoteKey) {
    Set-Content -Encoding ASCII (Join-Path $DataDir ".env") "GRACENOTE_API_KEY=$GracenoteKey"
}

# Task Scheduler only retries tasks that fail to start, so a wrapper loop
# restarts the server if it ever exits. The log rolls over at about 20 MB.
$runner = Join-Path $InstallDir "run-server.cmd"
@"
@echo off
cd /d "$DataDir"
:loop
for %%F in ("logs\server.log") do if %%~zF GTR 20000000 move /y "logs\server.log" "logs\server.old.log" >nul
"$InstallDir\runtime\node.exe" "$InstallDir\app\server.mjs" "$config" >> logs\server.log 2>&1
ping -n 6 127.0.0.1 >nul
goto loop
"@ | Set-Content -Encoding ASCII $runner

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$runner`"" -WorkingDirectory $DataDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -User "SYSTEM" -RunLevel Highest -Description "Blue Vue control server (port $Port)" -Force | Out-Null

# Panels, laptops and wall agents connect in, so open the port on private networks.
Get-NetFirewallRule -DisplayName "Blue Vue Server" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "Blue Vue Server" -Direction Inbound -Protocol TCP -LocalPort $Port `
    -Action Allow -Profile Domain, Private | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Host "Starting..."
$hello = $null
for ($i = 0; $i -lt 20 -and -not $hello; $i++) {
    Start-Sleep -Seconds 1
    try { $hello = Invoke-RestMethod "http://localhost:$Port/api/hello" -TimeoutSec 2 } catch {}
}
if (-not $hello) {
    Write-Warning "The server didn't answer on port $Port. See $DataDir\logs\server.log"
    exit 1
}

$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch "^(127\.|169\.254\.)" } | Select-Object -ExpandProperty IPAddress
Write-Host ""
Write-Host "Blue Vue $($hello.version) is running for '$($hello.name)'." -ForegroundColor Green
foreach ($ip in $ips) { Write-Host "  Panel: http://${ip}:$Port      Admin: http://${ip}:$Port/admin" }
Write-Host ""
Write-Host "Next: open the admin now and set its password (the first visitor sets it)." -ForegroundColor Yellow
Write-Host "Data and logs: $DataDir"
Write-Host "The network must be set to Private in Windows for laptops and panels to connect."
