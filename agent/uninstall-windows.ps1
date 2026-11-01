# Removes the Blue Vue agent startup task and firewall rule. Run elevated.
param([string]$TaskName = "BlueVueAgent")
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "BlueVueMosaic" -Confirm:$false -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName "Blue Vue Agent" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host "Blue Vue agent removed."
