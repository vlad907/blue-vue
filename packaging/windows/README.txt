Blue Vue control server for Windows
===================================

Install (starts with Windows, restarts if it stops)
  1. Unzip this folder anywhere, e.g. the Desktop (right-click the zip,
     Extract All).
  2. Double-click "Install Blue Vue" and say Yes when Windows asks for
     permission. If Windows shows "Windows protected your PC", choose
     More info, then Run anyway.
     Blue Vue uses port 3000. If something else already has it, the
     installer picks 3001 (or 3002, 3003) and tells you. With more than one
     network card it asks which ones to answer on (Enter for all).
     Options, for those who prefer PowerShell (as Administrator):
       powershell -ExecutionPolicy Bypass -File .\install-server.ps1
       -Port <port>   -GracenoteKey <key> (TV guide)
       -Listen "Ethernet 2"  answer only on that network card (name or IP;
                             several allowed). Also in the admin: Settings.
  3. The admin opens in the browser when it finishes. Set the admin
     password straight away. Whoever opens it first sets it.
  4. Everyone else needs no app: on any computer, tablet or phone on the
     network, open the Panel address the installer printed
     (http://<this PC's address>:3000) in a web browser. On this PC, use the
     "Blue Vue" icon on the desktop. The Mac app is optional.

The server installs to C:\Program Files\BlueVue. Its data lives in
C:\ProgramData\BlueVue, which only Administrators can read:
  system.json              port and settings
  data\site.json           devices, walls, scenes (edit in the admin)
  data\androidtv-remote.pem  what Google TVs know Blue Vue by. Keep it, or pair every TV again
  logs\server.log          the server log

Update: unzip the new package and double-click "Install Blue Vue" again.
Data is kept.
Remove: double-click "Uninstall Blue Vue" (data is kept; to delete it too,
run uninstall-server.ps1 -RemoveData).

Try it without installing: double-click Start-BlueVue.cmd
(or "Start-BlueVue.cmd simulate" to try it with no real devices).

Ports: 3000 for Blue Vue, or the one the installer printed (opened in the
firewall on every network type). The Mac app's Find servers looks on
3000-3003 and the old 8080. The mosaic engine keeps 8090.
