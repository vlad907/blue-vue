Blue Vue control server for Windows
===================================

Install as a service (starts with Windows, restarts if it stops)
  1. Unzip this folder anywhere, e.g. Downloads.
  2. Open PowerShell as Administrator in this folder and run:
       powershell -ExecutionPolicy Bypass -File .\install-server.ps1
     Options: -Port <port>   -GracenoteKey <key> (TV guide)
     Blue Vue uses port 8080. If something else already has it, the
     installer picks 8088 (or 8180, 8280) and tells you.
  3. Open the admin address it prints (http://<this PC>:<port>/admin) and
     set the admin password straight away. Whoever opens it first sets it.
  4. On the Mac, open the Blue Vue app and pick this server.

The server installs to C:\Program Files\BlueVue. Its data lives in
C:\ProgramData\BlueVue, which only Administrators can read:
  system.json              port and settings
  data\site.json           devices, walls, scenes (edit in the admin)
  data\androidtv-remote.pem  what Google TVs know Blue Vue by. Keep it, or pair every TV again
  logs\server.log          the server log

Update: unzip the new package and run install-server.ps1 again. Data is kept.
Remove: run uninstall-server.ps1 (add -RemoveData to delete the data too).

Try it without installing: double-click Start-BlueVue.cmd
(or "Start-BlueVue.cmd simulate" to try it with no real devices).

Ports: 8080 for Blue Vue, or the one the installer printed (opened in the
firewall for Private and Domain networks). The Mac app's Find servers
looks on 8080, 8088, 8180 and 8280. The mosaic engine keeps 8090. The
Windows network must be set to Private for other computers to connect.
