# Blue Vue Control

A touch-panel control system for venues: video walls of TVs, Xfinity boxes with a TV guide, an AtlasIED Atmosphere DSP, and what each video wall shows, through the mosaic engine. **Scenes** combine everything into one button, for example "Open Venue" or "Game Day".

Every device is described by a **profile**: a YAML file listing its commands, how to read its state, and which controls to show. The touch panel builds itself from those profiles. Adding a new kind of device means writing a profile, not code (see [docs/profiles.md](docs/profiles.md)).

Built-in profiles: the mosaic engine (video wall content), AtlasIED Atmosphere, Xfinity box (IR via iTach), Roku TV (any brand), Fire TV, Apple TV (network, with a pairing code), TCL Google TV (Android TV Remote pairing, or ADB), generic IR TV, and any PJLink projector. New device types are made in the admin's **Device types** editor, with no code.

## How it fits together

```
 tablets ──http/ws──▶  control server (Windows mini PC)  ◀──ws── wall agent (each video wall PC)
                        • profile engine, scenes, guide            • connects to that wall's TVs,
                        • touch panel at :3000                       iTach and COM ports for the server
                        • devices on its own network               • keeps the mosaic software running
```

- **Site** (`data/site.json`): devices, rooms, video walls (groups of panels), scenes, channels and wall agents. Each save keeps a snapshot of the previous version.
- **Device location**: `server`, or a wall agent's id. A device on a wall agent is reached from that wall PC, which is how TVs on a wall's network, the iTach next to a wall, and RS-232 on a wall PC work.
- **Wall agents** connect out to the server, so wall PCs need no inbound firewall rule. See [agent/README.md](agent/README.md).

## Run

```bash
npm install
npm run build                       # build the touch panel (web/dist)
BLUEVUE_SIMULATE=1 npm run dev      # simulated devices, no hardware needed
npm start                           # real hardware
```

On first start the server creates `data/site.json`:
- If `config/system.local.json` is an old-format config with devices in it, it's migrated. Wall panels need the walls' `agent.json` files; see `scripts/migrate-config.ts`.
- Otherwise the server copies [config/example-site.json](config/example-site.json) as a starting point.

Open `http://<control-pc-ip>:3000` on any tablet on the network. On an iPad, use "Add to Home Screen" so it runs full-screen.

While working on the panel, `npm run dev:web` serves it with hot reload on :5173, with API calls forwarded to :3000.

## Install

### Server on the media server (Windows)
Build the package on any machine with this repo (needs internet the first time, to fetch Node):
```bash
npm run package:server     # -> release/BlueVue-Server-<version>-win-x64.zip
```
Copy the zip to the media server, unzip it (right-click → Extract All), and double-click **Install Blue Vue**. Say Yes when Windows asks for permission. The same thing from an elevated PowerShell, for options like `-Port`:
```powershell
powershell -ExecutionPolicy Bypass -File .\install-server.ps1
```
When it finishes it opens the admin in the browser and puts a **Blue Vue** icon on the desktop. **No app is needed to use Blue Vue**: any computer, tablet or phone on the network opens `http://<media-server-ip>:3000` in a web browser. The Mac app is an optional window onto the same pages.

**Updating without handling a zip:** double-click [update.bat](update.bat) on the media server. In a git copy of this project it pulls the newest version first; on its own (just the one file, anywhere) it downloads the package from GitHub. Either way it unpacks the package, runs the installer and restarts the server, keeping all data.

This installs Blue Vue as a background task that starts with Windows and restarts if it stops. Program files go to `C:\Program Files\BlueVue`, and data to `C:\ProgramData\BlueVue`, readable by Administrators only. If 3000 is taken (by something other than an earlier Blue Vue) it uses 3001, 3002 or 3003 and says so; an earlier install on the old default 8080 is moved to 3000. It opens the port in Windows Firewall on every network type (Domain, Private and Public) and prints the panel and admin addresses. Open the admin right away and set its password, since whoever opens it first sets it. To update, run the installer from a newer zip; your data is kept. The package includes its own Node, so nothing else needs installing. `install-server.ps1 -GracenoteKey <key>` stores the TV guide key; `uninstall-server.ps1` removes it. The zip's README.txt has the details.

**Two network cards** (say one for the office and one for the AV network): by default Blue Vue answers on every network. To answer on only some, open the admin's **Settings → Network cards**, choose **Only these** and tick the cards. It applies right away, with no restart, and the admin warns you before you cut off the browser you're using. The PC itself can always reach Blue Vue at `http://localhost:3000`. The installer takes the same choice with `-Listen "Ethernet 2"`, and on a first install on a PC with more than one network card it asks which to answer on (Enter for all of them). Devices are reached on whichever network they're on, and wake-on-LAN goes out on every network card.

### Mac app
```bash
npm run package:mac        # -> release/mac/Blue Vue-<version>-arm64.dmg (Apple silicon) and Blue Vue-<version>.dmg (Intel)
```
Open the dmg and drag Blue Vue to Applications. The app is signed for local use only, not by Apple, so the first time, right-click it and choose **Open**. Then type the media server's address or press **Find servers**, which scans this Mac's local network for Blue Vue on port 3000. The app remembers the server and reconnects on launch. ⌘1 shows the control panel, ⌘2 the admin, ⌘K switches servers. The pages come from the server, so updating the server updates what the app shows.

### From source (alternative)
**Install on the Windows control PC** (elevated PowerShell, from the project folder):
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```
The first run creates `config\system.local.json` and a `.env` file for secrets (the Gracenote key). Fill them in and run the script again. The second run builds the panel, sets the server to start at boot and restart if it exits, and opens port 3000 to the local network. Logs go to `logs\server.log`.

`config/system.json` only holds server settings (port, data folder, simulation, guide). Everything else is in the site.

## Setting up a site

Open **`http://<control-pc-ip>:3000/admin`** (or **⚙ Admin** on the touch panel). On the first visit you choose the admin password. From there:
- **Devices**: add a device by picking its type. The settings form comes from the device's profile. Choose whether it's reached from the control server or a wall PC. **Test** sends any command and shows the device's live traffic.
- **A TV comes back on the input it was left on**: the server remembers the input each TV was last switched to through Blue Vue (a wall card, a room card or a scene) and when, in `last-inputs.json` in the data folder, so it survives a restart. On and All on wake each TV, wait for it, and switch it back to that input. A TV nobody has switched yet uses its own **Input when turned on** setting, else its wall's (Video walls page). Blue Vue can't see an input changed with the TV's own remote, so the TV returns to the last one chosen through Blue Vue. Turning on keeps trying for about 20 seconds, because a TV in standby (Fire TVs especially) drops its connection for a few seconds at a time. There is no "all TVs to one input" button, on purpose: walls use different inputs. Each wall card still has its own input row.
- **Devices in bulk**: **+ Add TVs** finds TVs on the network (or takes address ranges like `192.168.1.145-164`) and adds them all at once, numbered and placed in a room and wall. To remove or move many, tick them in the Devices list (search or pick a type, then the top checkbox ticks everything shown) and use **Remove**, **Move to room** or **Add to wall**. Removed devices are also taken out of walls and scenes.
- **Video walls**, **Rooms**, **Scenes** (step by step, with a Run button), **Channels** (with Gracenote lookup by ZIP code).
- **Wall PCs**: a newly installed agent shows up under "Waiting for approval". Approve it, and it connects within 10 seconds.
- **Device types**: create and edit profiles in forms. **Try it** shows exactly what a command sends, **Test** checks a reply rule against a sample, and **Learn** captures IR codes from a remote through an iTach (from the server or any wall PC). Built-ins are read-only; Duplicate one to adapt it.
- **Backup**: download or restore the whole site and custom profiles, and roll back to any of the last 50 saves.

Edits are collected and applied together with **Save & apply**. The server checks the whole site first, including that every scene step's command and values fit its device, and lists any problems instead of saving. Devices that changed restart; nothing else does.

Device-specific notes:
- **Roku TVs, any brand** (`tcl-roku-tv`, shown as "Roku TV"): network control over Roku's ECP (port 8060), no pairing. On each TV, turn on **Fast TV start** (needed for power-on over the network), set **Control by mobile apps** to **Enabled** (on Limited the TV still reports its status but answers 403 to On, Off and inputs, and Blue Vue says so; its Network access can stay on Default or Permissive), turn off Auto power off, and set Power on to Last used input. On/Off and HDMI 1–4 are discrete keys. The TV reports power, model and the app on screen; the panel shows the last input sent. **+ Add TVs** with the Roku TV type finds them on the network (port 8060) with their names and MAC addresses.
- **Fire TVs** (`fire-tv`): Fire TV smart TVs (Omni, Insignia, Toshiba, Hisense) and Fire TV Sticks or Cubes, over ADB. Blue Vue has ADB built in, so nothing needs installing on the server or a wall PC (set `ADB_PATH` to use Android's own adb instead). On each TV: Settings → My Fire TV → About, press the device name 7 times, then Developer options → **ADB debugging: On**. After **Save & apply**, each TV asks **Allow debugging?**: tick **Always allow from this computer** and press Allow. That's once per TV, from the machine that reaches it; the key the TVs trust is `adbkey.pem` next to `androidtv-remote.pem` (deleting it means allowing every TV again). On/Off use the wake and sleep keys (discrete), and the TV reports whether it's awake and which app is on screen. HDMI 1–4 use the standard Android HDMI keys, so check them on your model. A Stick or Cube has no inputs and switches its TV over HDMI-CEC. The **TV pairing** page lists Fire TVs too, with which ones are still waiting for Allow.
- **TCL Google TV panels, e.g. 98QM7L / 55QM7L** (`tcl-google-tv-remote`): network control with the Android TV Remote protocol, the one the Google TV phone app uses (TCP 6466 and 6467). It doesn't need ADB, which these TVs usually have closed. Add the TV with its IP address, **Save & apply**, then open its **Test** panel in the admin and press **Pair with this TV**: the TV shows a 6-character code to type in. Pairing is done once per TV, from wherever the TV is reached (the control server or a wall PC). That machine keeps the certificate the TV learned in `androidtv-remote.pem` (in `data/` on the server, next to `agent.json` on a wall PC); deleting it means pairing every TV again. Give each TV a DHCP reservation.
  - **Power state** comes from the TV itself, which reports on/off over the connection. The protocol only has a POWER key, which toggles, so **On** and **Off** press it only when the TV reports the other state, then wait for the TV to confirm. If the TV hasn't reported its state, nothing is sent.
  - **Power-on** works only if the TV keeps its network up in standby. Leave the TV off for at least 15 minutes and try **On**. If the TV shows offline while off, fill in its MAC address so **On** tries wake-on-LAN first. If that fails too, these TVs need IR for power-on.
  - **HDMI inputs** use the standard Android HDMI 1–4 keys. Whether a TV acts on them is up to its firmware, so check each input on your model. The panel shows the last input *sent*, because the TV doesn't report its input. **Open the input menu** (the Input key) is the fallback.
  - The older `tcl-google-tv` (ADB) profile stays for TVs with network debugging turned on. It now uses the built-in ADB too.
  - **Many TVs at once:** on **Devices**, press **+ Add TVs**. **Find on the network** lists every TV of the chosen type that answers (Google TV remote port 6466, Roku 8060, Fire TV ADB 5555), from the server or a wall PC. You can also type addresses or ranges like `192.168.1.145-164`. Tick the TVs, choose a name pattern and a wall (or create one), and add them in one go. Then **Save & apply** and work down the **TV pairing** page: press Pair on each TV and type the code it shows.
- **TV walls and mosaic walls:** on **Video walls**, each wall lists its panels in order. Set **Panels across** so the touch panel draws the wall in its real shape, use **+ Add panels…** to tick several TVs at once (a TV belongs to one wall, so adding it moves it), and pick its **Mosaic wall** from the walls the mosaic engine reports. The Video Walls tab then shows one card per wall: its TVs, On/Off, its HDMI inputs, and that mosaic wall's presets. Power goes out panel by panel with the wall's pause, without waiting for each TV to confirm. Inputs go to the whole wall at once.
- **Xfinity boxes** (`xfinity-ir`): IR through a Global Caché iTach, with **one iTach port per box**. Identical boxes respond to the same codes, so if one emitter can reach two boxes, both will change channel. Learn codes once with `node src/agent.ts learn xfinity` on a wall PC, then put them in a custom profile that `extends: xfinity-ir` (see [docs/profiles.md](docs/profiles.md)).
- **Atlas** (`atlas-atmosphere`): enable third-party control in Atmosphere. Zones, sources and scenes are numbered from 0, in Atmosphere's order. Changes made from Atmosphere wall panels show up live.
- **Video walls (panels)**: a group with `"kind": "wall"` whose devices are the panels. The Video Walls tab shows each wall's panels, and its PC and mosaic software status.
- **Apple TV** (`apple-tv`): remote keys, real sleep and wake, opening apps, and what's playing, over the network. On each Apple TV set **Settings → AirPlay and HomeKit → Allow Access** to **Anyone on the Same Network** and give it a fixed IP address. Add them with **+ Add TVs** (device type Apple TV; **Find TVs** lists the ones on the network), press **Save & apply**, then on **TV pairing** press **Pair**: the Apple TV shows a 4-digit code, then a second one, and both are typed in. The first code is what control needs; the second adds what's playing. A tvOS update can make an Apple TV forget the pairing, and it then shows as "not paired" until paired again. Control runs through a small helper (`bluevue_atv.py`, built on the open-source pyatv library). The Windows server package brings its own Python for it; when running from source, install Python and `pip install pyatv==0.18.0 "srptools<2"` (srptools 2 breaks pairing with this pyatv) (or point `BLUEVUE_PYTHON` at a Python that has it). Pairing credentials are kept in `appletv-credentials.json` in the data folder.
- **Remote tab (with a live picture)**: the touch panel's **Remote** tab gives staff one device at a time: its remote on the right, and on the left a live picture of what that device is showing. It lists the Apple TVs and cable boxes only (device types in the "player" and "tuner" categories), not TVs. The picture is the NDI stream of the encoder box the device's HDMI output goes into: in the admin, open **Remote pictures**: it lists every Apple TV and cable box with a stream picker and a small live picture of the chosen stream, so you can see it's the right one before pressing **Save & apply**. The list is the NDI streams the media server finds on the network. (The same choice is also on **Devices → Edit**.) Blue Vue reads the stream off the network itself, at NDI's low-bandwidth preview quality, and only while someone is looking at it; the mosaic engine isn't involved. This is done by a small helper (`src/ndi/bluevue_ndi.py`, built on the open-source cyndilib library, which carries the NDI library). The Windows server package brings it along; when running from source, `pip install cyndilib==0.1.3 Pillow` into the Python that `BLUEVUE_PYTHON` points at. Only if the machine can't read NDI at all does Blue Vue ask the mosaic engine for the picture instead (`/api/streams/preview.jpg`). The same pictures appear on the **Video Walls** tab: every piece of a wall that shows a stream has that stream's live picture behind its name.
- **Updating from the admin**: **Settings → Software update** shows when this server's version was built and the newest one on GitHub, with **Check for updates** and **Update now**. Update now downloads the newest server package, checks it against its published SHA-256, and runs its installer; the server restarts (about a minute) and the page reloads on the new version. Devices, scenes and the admin password are kept, and the installer's output goes to `logs\update.log` in the data folder. Only a server installed on Windows from the package can do this (it runs as the `BlueVueServer` task, which has the rights to install); one run from source updates with `git pull`. `update.bat` still works and is needed once, to get a version that has the button. Each package build writes `packaging/windows/latest.json` (build time, size, checksum), which is committed with the zip.
- **Mosaic engine** (`mosaic-engine`): add one device per **canvas** the media server runs (Inside bar, Bar tower, Ultrawide, Outside TV...), each pointing at the media server (port 8090) with its **Canvas** id (`canvas-1`, `canvas-2`... listed at `http://<media-server>:8090/api/canvases`; blank is the main canvas), and the API key if one is set in the mosaic editor (Settings → Access). Each canvas's walls ("groups"), presets, scenes, NDI streams and sound outputs are read from the engine every few seconds, so anything made in the mosaic editor appears on the Video Walls tab on its own, with the active preset highlighted. Each wall gets preset buttons, a "show one stream" picker, Blank, Restart videos, what's on screen, and which streams have no signal. A TV wall's **Mosaic wall** link can point at a group on any canvas. On engines that offer them, a wall also gets **Split** (one stream, two, four, five, or one per panel) with a stream or playlist picker for each part, a **Content** switch, and the canvas gets a **Background** card (on/off, stream or playlist). Scenes can use the same commands, plus "Save what a wall shows as a preset" and "Show screen numbers on a wall PC". An older engine that doesn't report these simply doesn't show them. On the touch panel each such wall is drawn as a screen cut into its pieces: staff tap a piece (or the background strip under it), then tap what it should show in the list beside it. The split buttons above the drawing change how the wall is cut, and presets sit under it. The background can also be one video file from the media folder, and a piece can be emptied. To try all of this without hardware, run the server with `BLUEVUE_SIMULATE=1` and `BLUEVUE_DATA=data/demo` after copying `config/mosaic-demo-site.json` to `data/demo/site.json`: it simulates the venue's three canvases (Inside bar, Ultrawide, Outside TV), and splits, slots, content and background react as on the real engine. The quickest way to add the engine is **Devices → + Add mosaic engine**: enter the media server's address once, press **Read canvases**, and tick the canvases to add; each is listed with its walls and how many presets they have. A canvas whose walls don't need sound can leave it out: tick **No sound on this canvas** on its device (Devices → Edit) and the touch panel shows no sound controls for it. Each **sound output** gets volume (−60 to +12 dB), mute, what it plays, and any problem the engine reports. The engine only takes the whole list of sound outputs back, so Blue Vue reads it fresh before each change and changes only that one value. Audio doesn't follow video by itself: to make a zone's speakers follow a wall, put "Recall wall preset" and "Sound output source" in the same scene. A command for a canvas that has stopped is refused by the engine (409) rather than landing on another wall. The wall agents' local health check uses port 8095, so the agent can run on the media server without clashing with the engine's port 8090.

### TV guide (Gracenote)
```bash
export GRACENOTE_API_KEY=...
npm run gracenote -- lineups 19103            # find your Xfinity lineupId
npm run gracenote -- channels USA-PA12345-X   # channel entries with stationIds for the site
```
Set `guide.lineupId` in the config, and add `stationId`s to the site's channels. Without a key or lineup, the guide shows sample data. Any device with the `tuner` capability can be tuned from the guide.

## API

| Method | Path | Body |
|---|---|---|
| GET | `/api/ui` | everything the panel needs (devices, profiles' controls, rooms, walls, scenes, channels) |
| GET | `/api/state`, `/api/guide` | |
| GET | `/api/v2/site`, `/api/v2/profiles`, `/api/v2/profiles/:id`, `/api/v2/devices`, `/api/v2/devices/:id/log`, `/api/v2/agents` | |
| POST | `/api/v2/devices/:id/commands/:command` | `{ "params": { "zone": 0, "db": -20 } }` |
| POST | `/api/v2/devices/:id/capabilities/:cap/:action` | `{ "value": 206 }`, e.g. `tuner/tune`, `power/on` |
| POST | `/api/v2/groups/:id/commands/:command` | `{ "params": {} }` |
| POST | `/api/v2/groups/:id/capabilities/:cap/:action` | e.g. `power/on` for a whole wall of mixed TVs |
| POST | `/api/v2/scenes/:id` | |
| POST | `/api/v2/agents/:id/apps/:name/restart` | |
| WS | `/ws` | pushes `{ type: "state", state }` on every change |
| WS | `/agent` | wall agents connect here |

Bad requests return 400/404 with `{ "error": "..." }`. Commands to a device whose wall PC is offline return 503.

Scene steps: `command` (with `device` or `group`), `delay`, and `waitFor` (a device state value, with a timeout).
