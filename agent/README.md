# Blue Vue Wall Agent

A small service that runs on each **Windows video wall PC** next to your mosaic software. The central Blue Vue server sends it commands, and the agent:

- powers individual panels or the whole wall on and off, and switches inputs
- reports each panel's real power state (Roku and ADB panels)
- sends IR from this wall's IR hardware, typically to the Xfinity boxes at this wall
- watches the video wall software and restarts it if it stops
- includes commissioning commands to find panels and learn IR codes

It has no dependencies; you only need Node.js 22.18+ installed.

## Panel drivers

| Driver | For | Individually addressable | Reports state | Setup on the TV |
|---|---|---|---|---|
| `roku` | **TCL Roku TVs** (recommended) | yes | yes | Settings › System › Power › **Fast TV start: On**; Settings › System › Advanced system settings › **Control by mobile apps › Network access: Permissive** |
| `adb` | **TCL Google TVs** | yes | yes | Enable Developer options › **Network debugging**; accept the "Allow debugging" prompt on first connect (tick *Always allow*). Install Android platform-tools and set `ADB_PATH` if `adb` isn't on PATH. |
| `ir` | Any TV (fallback) | only one panel per IR port | no | Needs discrete `KEY_POWERON`/`KEY_POWEROFF` codes |

On **every** panel, regardless of driver:
- Turn off **Auto power off** and energy saving, so the TVs don't sleep on their own.
- Set **Power on** to **Last used input**, so the panel comes up on the PC's HDMI instead of the TV home screen.
- Give it a **DHCP reservation** so its IP never changes, and use Ethernet rather than Wi-Fi.

## IR hardware

| `ir.driver` | Hardware | Notes |
|---|---|---|
| `globalcache` | Global Caché iTach IP2IR (recommended) | 3 independent IR ports on the network. Supports discrete codes and learning (iLearn). |
| `command` | Any USB blaster that has a command-line tool (USB-UIRT, IguanaIR, …) | `args` supports the placeholders `{port}` `{pronto}` `{freq}` `{remote}` `{key}` |
| `simulated` | none | Logs only |

Codes are stored as **raw Pronto hex** under `codes[remote][key]`. You can get them from Global Caché's free *Control Tower* IR database (it has TCL and Xfinity codes), or learn them from the physical remote with Global Caché *iLearn*.

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

## API

Every endpoint except `/health` requires `Authorization: Bearer <token>`.

| Method | Path | Body |
|---|---|---|
| GET | `/health` | |
| GET | `/status` | returns `{ name, panels: [{ id, name, driver, power, reachable, confirmed }], apps: [{ name, running }] }` |
| POST | `/panels/power` | `{ "on": true, "panels": ["r1c1"] }` (omit `panels` to target the whole wall) |
| POST | `/panels/input` | `{ "input": "hdmi1", "panels": [...] }` |
| POST | `/apps/:name/restart` | |
| POST | `/ir/send` | `{ "port": 2, "remote": "xfinity", "key": "KEY_5" }` or `{ "port": 2, "pronto": "0000 ..." }` |
