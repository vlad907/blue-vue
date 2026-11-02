# Blue Vue Wall Agent

A small service that runs on each **Windows video wall PC** next to your mosaic software. The central Blue Vue server sends it commands, and the agent:

- connects out to the control server, and makes the connections the server needs to this wall's devices: TVs on the wall's network, the iTach next to the wall, and RS-232 devices on this PC's COM ports
- watches the video wall software and restarts it if it stops
- includes commissioning commands to find panels and learn IR codes

It has no dependencies; you only need Node.js 22.18+ installed.

## Connecting to the control server

The agent connects **out** to the control server over a WebSocket, so the server can reach devices on this wall's network or COM ports through it. Set the server address in `agent.json`:

```json
"server": { "url": "ws://<control-server-ip>:8080/agent" }
```

The agent's `name` is its id, and its `token` must match that agent's entry in the control server's site (`agents` in `data/site.json`, or the admin UI once it exists). The agent reconnects forever. While it's offline, its devices show as offline and commands fail with a clear "wall agent is offline" error. When it comes back, every device connection is re-opened automatically.

Any profile device can live on a wall: set its **location** to the agent's id. Its TCP, UDP, HTTP, IR (iTach), ADB and **serial** connections are then made from this PC. For RS-232 devices, install serial support once with `install-windows.ps1 -Serial` (or `npm install serialport`), and set the device's `serialPort` setting (e.g. `COM3`) and `baudRate`.

## IR codes

IR devices (Xfinity boxes, IR TVs) are driven through a Global Caché iTach (IP2IR, 3 ports). Codes are **raw Pronto hex**. You can get them from Global Caché's free *Control Tower* database (it has TCL and Xfinity codes), or learn them here with `learn` (below), which uses the iTach in `ir.host`. Learned codes are saved in this agent's `agent.json`. Copy them into a custom profile on the control server; they work on every wall with the same models.

## Install on a wall PC

1. Install **Node.js 22 LTS or newer** from nodejs.org.
2. Copy this `agent` folder to `C:\BlueVue\agent`.
3. In an **Administrator** PowerShell:
   ```powershell
   cd C:\BlueVue\agent
   powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -ControlServer <control-server-ip> `
       -MosaicExe "C:\Program Files\<your mosaic app>\<app>.exe"
   ```
   The first run creates `agent.json` with a random token and prints the token. Fill in this wall's panels and IR codes (see *Commissioning* below), then run the script again. The second run:
   - validates the config
   - registers a startup task that runs as SYSTEM and restarts the agent if it exits
   - with `-MosaicExe`: registers a `BlueVueMosaic` task that launches your wall software in the signed-in user's session
   - opens port 8090 in the firewall, but only to the control server's IP
   - starts the agent
4. Add the wall to the central server's `config/system.local.json`:
   ```json
   "endpoints": [{ "id": "wall1", "name": "Main Bar", "url": "http://10.0.10.21:8090", "token": "<token from step 3>" }]
   ```

## Commissioning

Run these from the agent folder on the wall PC:

```powershell
node src/agent.ts discover                      # find every Roku TV, show IP/name/model, flag Wi-Fi panels
node src/agent.ts learn xfinity                 # walk through every Xfinity key, learning each via the iTach
node src/agent.ts learn tcl --preset tv         # learn TV power-on/off/HDMI codes (IR panels only)
node src/agent.ts learn xfinity KEY_OK KEY_LAST # re-learn specific keys
node src/agent.ts send 1 xfinity KEY_5          # test a code on iTach port 1
```

`discover` prints ready-to-paste panel entries. `learn` saves codes straight into `agent.json`; hold the remote 2–4 inches from the iTach's learning window. After editing `agent.json`, restart the agent (`Stop-ScheduledTask BlueVueAgent; Start-ScheduledTask BlueVueAgent`).

Learned codes from one wall work on every wall with the same box and TV models, so copy the `codes` section to the other walls instead of learning again.

## Keeping the wall software running

List your wall software under `apps`:

```json
"apps": [{ "name": "Mosaic", "process": "MosaicWall.exe", "task": "BlueVueMosaic", "autoRestart": true }]
```

The agent checks every `pollSeconds`. If the process isn't running, it starts the app through the `BlueVueMosaic` task, at most once a minute so it doesn't loop on an app that crashes on launch. The control panel shows the app's state on each wall card and has a **Restart** button.

The agent runs as SYSTEM, and Windows would show anything SYSTEM launches on an invisible desktop. That's why the app is started through a task that runs as the wall user. **Set each wall PC to sign in automatically** (run `netplwiz` and untick "Users must enter a user name and password"), so the wall software comes back after a power cut or Windows update.

Logs go to `logs\agent.log`. To remove the agent, run `uninstall-windows.ps1`.

Test without hardware: `BLUEVUE_SIMULATE=1 npm start`, or set `"simulate": true`.
