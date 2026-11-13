# Installs (or updates) the Blue Vue control server as a background service
# that starts with Windows, on the media server or any always-on PC.
# Run in an elevated PowerShell from the unzipped BlueVue-Server folder:
#   powershell -ExecutionPolicy Bypass -File .\install-server.ps1
# Re-run it from a newer package to update; settings and data are kept.
param(
    [int]$Port = 3000,               # if 3000 is taken and no -Port is given, the first free of 3001, 3002, 3003 is used
    [string]$InstallDir = "$env:ProgramFiles\BlueVue",
    [string]$DataDir = "$env:ProgramData\BlueVue",
    [string]$GracenoteKey,           # optional: TV guide API key, stored in the data folder's .env
    [string[]]$Listen,               # optional: network card names or IPs to answer on, e.g. "Ethernet 2". Default: every network
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

# A port is free if nothing listens on it, or only an earlier Blue Vue does.
function Get-PortOwner([int]$p) {
    $listener = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) { return $null }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if ($proc -and $proc.ExecutablePath -and $proc.ExecutablePath.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    if ($proc) { return "$($proc.Name) (process $($proc.ProcessId))" }
    return "process $($listener.OwningProcess)"
}

# An existing install keeps its port unless -Port is given.
$config = Join-Path $DataDir "system.json"
if (-not $PSBoundParameters.ContainsKey("Port") -and (Test-Path $config)) {
    $Port = [int](Get-Content $config -Raw | ConvertFrom-Json).server.port
    # 8080 was the default before 3000; media servers often have other software around 8080-8090.
    if ($Port -eq 8080) {
        $Port = 3000
        Write-Host "Moving Blue Vue from port 8080 to 3000. Tablets, the Mac app and wall agents need the new address." -ForegroundColor Yellow
    }
}
$owner = Get-PortOwner $Port
if ($owner) {
    if ($PSBoundParameters.ContainsKey("Port")) {
        throw "Port $Port is already used by $owner. Pick another, e.g. -Port 3001."
    }
    $taken = $Port
    $Port = (3001, 3002, 3003 | Where-Object { -not (Get-PortOwner $_) } | Select-Object -First 1)
    if (-not $Port) { throw "Port $taken and the alternates are in use. Pick a free port with -Port." }
    Write-Host "Port $taken is used by $owner, so Blue Vue will use port $Port." -ForegroundColor Yellow
}

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

if (Test-Path $config) {
    $cfg = Get-Content $config -Raw | ConvertFrom-Json
    $cfg.server | Add-Member -NotePropertyName port -NotePropertyValue $Port -Force
} else {
    $cfg = [pscustomobject][ordered]@{
        server = [pscustomobject][ordered]@{ port = $Port }
        simulate = $false
        dataDir = (Join-Path $DataDir "data")
        guide = [pscustomobject][ordered]@{ enabled = $true; apiKeyEnv = "GRACENOTE_API_KEY"; lineupId = ""; hours = 6; refreshMinutes = 30 }
    }
}
# With more than one network card and no -Listen, ask which ones to answer on
# (only on a first install, and only when someone is at the keyboard).
$hasChoice = $cfg.server.PSObject.Properties.Name -contains "interfaces"
if (-not $PSBoundParameters.ContainsKey("Listen") -and -not $hasChoice -and [Environment]::UserInteractive) {
    $cards = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notmatch "^(127\.|169\.254\.)" } | Sort-Object InterfaceAlias)
    if ($cards.Count -gt 1) {
        Write-Host ""
        Write-Host "This PC has more than one network card:"
        for ($i = 0; $i -lt $cards.Count; $i++) { Write-Host ("  {0}. {1}  ({2})" -f ($i + 1), $cards[$i].InterfaceAlias, $cards[$i].IPAddress) }
        $answer = Read-Host "Answer on which? Numbers separated by commas, or Enter for all of them"
        $picked = @($answer -split "[,\s]+" | Where-Object { $_ -match "^\d+$" -and [int]$_ -ge 1 -and [int]$_ -le $cards.Count } |
            ForEach-Object { $cards[[int]$_ - 1].InterfaceAlias } | Select-Object -Unique)
        if ($picked.Count) { $Listen = $picked; $PSBoundParameters["Listen"] = $picked }
        else { $cfg.server | Add-Member -NotePropertyName interfaces -NotePropertyValue @() -Force } # all; don't ask again on updates
    }
}
if ($PSBoundParameters.ContainsKey("Listen")) {
    $names = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.InterfaceAlias; $_.IPAddress }
    foreach ($l in $Listen) { if ($names -notcontains $l) { Write-Warning "No network card or address '$l' on this PC right now. Blue Vue will start answering on it when it appears." } }
    $cfg.server | Add-Member -NotePropertyName interfaces -NotePropertyValue @($Listen) -Force
}
# Written without a byte-order mark: Windows PowerShell's "-Encoding UTF8" adds one, which older servers can't read.
[IO.File]::WriteAllText($config, ($cfg | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
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

# Panels, laptops and wall agents connect in, so open the port on every network type
# (Domain, Private and Public), since a media server's AV network is often marked Public.
Get-NetFirewallRule -DisplayName "Blue Vue Server" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "Blue Vue Server" -Direction Inbound -Protocol TCP -LocalPort $Port `
    -Action Allow -Profile Any | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Host "Starting..."
$hello = $null
for ($i = 0; $i -lt 60 -and -not $hello; $i++) {
    Start-Sleep -Seconds 1
    try { $hello = Invoke-RestMethod "http://127.0.0.1:$Port/api/hello" -TimeoutSec 2 } catch {}
}
if (-not $hello) {
    Write-Warning "The server didn't answer on port $Port. The last lines of $DataDir\logs\server.log:"
    Get-Content (Join-Path $DataDir "logs\server.log") -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
    exit 1
}

$nics = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch "^(127\.|169\.254\.)" }
$chosen = @($cfg.server.interfaces | Where-Object { $_ })
if ($chosen.Count) { $nics = $nics | Where-Object { $chosen -contains $_.InterfaceAlias -or $chosen -contains $_.IPAddress } }
$ips = $nics | Select-Object -ExpandProperty IPAddress
Write-Host ""
Write-Host "Blue Vue $($hello.version) is running for '$($hello.name)'." -ForegroundColor Green
foreach ($ip in $ips) { Write-Host "  Panel: http://${ip}:$Port      Admin: http://${ip}:$Port/admin" }
Write-Host ""
if ($chosen.Count) { Write-Host "Answering only on: $($chosen -join ', '). Change it in the admin under Settings > Network cards." }
else { Write-Host "Answering on every network. To pick one network card, see the admin's Settings > Network cards, or re-run with -Listen `"Ethernet 2`"." }
Write-Host "Next: open the admin now and set its password (the first visitor sets it)." -ForegroundColor Yellow
if ($Port -ne 3000) { Write-Host "Wall PCs: install their agents with -ServerPort $Port." }
Write-Host "Data and logs: $DataDir"
Write-Host "Port $Port is open in Windows Firewall (rule 'Blue Vue Server')."

# A "Blue Vue" icon on the desktop that opens the panel in the browser, and the
# admin opened now so its password gets set.
$desktop = [Environment]::GetFolderPath("CommonDesktopDirectory")
if ($desktop) { Set-Content -Encoding ASCII (Join-Path $desktop "Blue Vue.url") "[InternetShortcut]`r`nURL=http://localhost:$Port/" }
Write-Host "Other computers, tablets and phones need no app: they open the Panel address above in any web browser."
if ([Environment]::UserInteractive) { try { Start-Process "http://localhost:$Port/admin" } catch {} }
