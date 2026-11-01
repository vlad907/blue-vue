# Blue Vue Wall Agent

A small service that runs on each **Windows video wall PC** next to your mosaic software. The central Blue Vue server sends it commands, and the agent:

- powers individual panels or the whole wall on and off, and switches inputs
- reports each panel's real power state (Roku and ADB panels)
- sends IR from this wall's IR hardware, typically to the Xfinity boxes at this wall

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
   powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -ControlServer <control-server-ip>
   ```
   The first run creates `agent.json` with a random token and prints the token. Fill in this wall's panels and IR codes, then run the script again. The second run:
   - validates the config
   - registers a startup task that runs as SYSTEM and restarts on failure
   - opens port 8090 in the firewall, but only to the control server's IP
   - starts the agent
4. Add the wall to the central server's `config/system.local.json`:
   ```json
   "endpoints": [{ "id": "wall1", "name": "Main Bar", "url": "http://10.0.10.21:8090", "token": "<token from step 3>" }]
   ```

Logs go to `logs\agent.log`. To remove the agent, run `uninstall-windows.ps1`.

Test without hardware: `BLUEVUE_SIMULATE=1 npm start`, or set `"simulate": true`.

## API

Every endpoint except `/health` requires `Authorization: Bearer <token>`.

| Method | Path | Body |
|---|---|---|
| GET | `/health` | |
| GET | `/status` | returns `{ name, panels: [{ id, name, driver, power, reachable, confirmed }] }` |
| POST | `/panels/power` | `{ "on": true, "panels": ["r1c1"] }` (omit `panels` to target the whole wall) |
| POST | `/panels/input` | `{ "input": "hdmi1", "panels": [...] }` |
| POST | `/ir/send` | `{ "port": 2, "remote": "xfinity", "key": "KEY_5" }` or `{ "port": 2, "pronto": "0000 ..." }` |
