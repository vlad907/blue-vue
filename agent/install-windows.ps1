# Installs the Blue Vue agent as a startup task on a video wall PC.
# Run in an elevated PowerShell from the agent folder:
#   powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -ControlServer 10.0.10.5 `
#       -MosaicExe "C:\Program Files\Mosaic\MosaicWall.exe"
param(
    [Parameter(Mandatory = $true)][string]$ControlServer,   # IP allowed to reach the agent
    [int]$Port = 8090,
    [string]$MosaicExe,          # optional: video wall software to launch at logon and keep running
    [string]$WallUser = "$env:USERDOMAIN\$env:USERNAME",
    [string]$TaskName = "BlueVueAgent"
)
$ErrorActionPreference = "Stop"
$dir = $PSScriptRoot

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated (Administrator) PowerShell."
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js not found. Install Node 22 LTS or newer from nodejs.org first." }
$nodeMajor = [int]((& $node -v).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 22) { throw "Node $nodeMajor found; Node 22.18 or newer is required." }

$config = Join-Path $dir "agent.json"
if (-not (Test-Path $config)) {
    Copy-Item (Join-Path $dir "agent.example.json") $config
    $token = -join ((48..57) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
    (Get-Content $config -Raw).Replace("CHANGE-ME-to-a-long-random-string", $token) | Set-Content $config
    Write-Host "Created agent.json with a new token. Edit it with this wall's panels, then re-run this script." -ForegroundColor Yellow
    Write-Host "Token (put this in the control server's endpoints config): $token"
    exit 0
}

# Validate config before installing.
& $node (Join-Path $dir "src\agent.ts") --check $config
if ($LASTEXITCODE -ne 0) { throw "agent.json is invalid; fix the errors above." }

# Task Scheduler only retries tasks that fail to start, so a wrapper loop
# restarts the agent if it ever exits. ping is used as a sleep because
# `timeout` fails without a console.
New-Item -ItemType Directory -Force (Join-Path $dir "logs") | Out-Null
$runner = Join-Path $dir "run-agent.cmd"
@"
@echo off
cd /d "$dir"
:loop
"$node" --disable-warning=ExperimentalWarning src\agent.ts agent.json >> logs\console.log 2>&1
ping -n 6 127.0.0.1 >nul
goto loop
"@ | Set-Content -Encoding ASCII $runner

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$runner`"" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -User "SYSTEM" -RunLevel Highest -Force | Out-Null

Get-NetFirewallRule -DisplayName "Blue Vue Agent" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "Blue Vue Agent" -Direction Inbound -Protocol TCP -LocalPort $Port `
    -RemoteAddress $ControlServer -Action Allow | Out-Null

# The agent runs as SYSTEM, which can't show windows on the wall. This task
# launches the video wall software in the wall user's desktop session at logon,
# and the agent re-runs it (schtasks /Run) whenever the software stops.
if ($MosaicExe) {
    if (-not (Test-Path $MosaicExe)) { throw "MosaicExe not found: $MosaicExe" }
    $appAction = New-ScheduledTaskAction -Execute $MosaicExe -WorkingDirectory (Split-Path $MosaicExe)
    $appTrigger = New-ScheduledTaskTrigger -AtLogOn -User $WallUser
    $appPrincipal = New-ScheduledTaskPrincipal -UserId $WallUser -LogonType Interactive -RunLevel Limited
    $appSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName "BlueVueMosaic" -Action $appAction -Trigger $appTrigger `
        -Principal $appPrincipal -Settings $appSettings -Force | Out-Null
    Write-Host "Registered BlueVueMosaic to launch $(Split-Path $MosaicExe -Leaf) as $WallUser at logon."
    Write-Host "Set the wall PC to sign in to $WallUser automatically (netplwiz) so it comes back after a reboot." -ForegroundColor Yellow
}

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
try {
    $health = Invoke-RestMethod "http://localhost:$Port/health" -TimeoutSec 5
    Write-Host "Agent '$($health.name)' is running on port $Port." -ForegroundColor Green
} catch {
    Write-Warning "Agent did not answer on port $Port. Check $dir\logs\agent.log"
}
