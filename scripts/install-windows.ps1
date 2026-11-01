# Installs the Blue Vue control server as a startup task on a Windows mini PC.
# Run in an elevated PowerShell from the project folder:
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
param(
    [int]$Port = 8080,
    [string]$TaskName = "BlueVueServer"
)
$ErrorActionPreference = "Stop"
$dir = Split-Path $PSScriptRoot -Parent

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated (Administrator) PowerShell."
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js not found. Install Node 22 LTS or newer from nodejs.org first." }

Push-Location $dir
try {
    Write-Host "Installing dependencies..."
    npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }

    $local = Join-Path $dir "config\system.local.json"
    $envFile = Join-Path $dir ".env"
    if (-not (Test-Path $local)) {
        $cfg = Get-Content (Join-Path $dir "config\system.json") -Raw | ConvertFrom-Json
        $cfg.simulate = $false
        $cfg | ConvertTo-Json -Depth 20 | Set-Content $local
        if (-not (Test-Path $envFile)) {
            @"
# Secrets for the Blue Vue control server
GRACENOTE_API_KEY=
WALL1_TOKEN=
WALL2_TOKEN=
WALL3_TOKEN=
WALL4_TOKEN=
"@ | Set-Content $envFile
        }
        Write-Host "Created config\system.local.json and .env." -ForegroundColor Yellow
        Write-Host "Fill in your walls, boxes, channels and Atlas IP, put the wall tokens in .env, then re-run this script."
        exit 0
    }

    # Task Scheduler only retries tasks that fail to start, so a wrapper loop
    # restarts the server if it ever exits.
    New-Item -ItemType Directory -Force (Join-Path $dir "logs") | Out-Null
    $runner = Join-Path $dir "run-server.cmd"
    @"
@echo off
cd /d "$dir"
:loop
"$node" node_modules\tsx\dist\cli.mjs src\index.ts >> logs\server.log 2>&1
ping -n 6 127.0.0.1 >nul
goto loop
"@ | Set-Content -Encoding ASCII $runner

    $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$runner`"" -WorkingDirectory $dir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
        -User "SYSTEM" -RunLevel Highest -Force | Out-Null

    # Tablets on the local network reach the control panel on this port.
    Get-NetFirewallRule -DisplayName "Blue Vue Server" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName "Blue Vue Server" -Direction Inbound -Protocol TCP -LocalPort $Port `
        -RemoteAddress LocalSubnet -Action Allow | Out-Null

    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -like "*$dir*src\index.ts*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 5
    try {
        Invoke-RestMethod "http://localhost:$Port/api/state" -TimeoutSec 5 | Out-Null
        $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notlike "*Loopback*" -and $_.PrefixOrigin -ne "WellKnown" } | Select-Object -First 1).IPAddress
        Write-Host "Blue Vue is running: open http://${ip}:$Port on your tablet." -ForegroundColor Green
    } catch {
        Write-Warning "Server did not answer on port $Port. Check $dir\logs\server.log"
    }
} finally {
    Pop-Location
}
