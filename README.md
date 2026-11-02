# Blue Vue Control

A touch-panel control system for venues: video walls of TVs, Xfinity boxes with a TV guide, an AtlasIED Atmosphere DSP, and what each video wall shows, through the mosaic engine. **Scenes** combine everything into one button, for example "Open Venue" or "Game Day".

Every device is described by a **profile**: a YAML file listing its commands, how to read its state, and which controls to show. The touch panel builds itself from those profiles. Adding a new kind of device means writing a profile, not code (see [docs/profiles.md](docs/profiles.md)).

Built-in profiles: the mosaic engine (video wall content), AtlasIED Atmosphere, Xfinity box (IR via iTach), TCL Roku TV, TCL Google TV, generic IR TV, and any PJLink projector. New device types are made in the admin's **Device types** editor, with no code.

## How it fits together

```
 tablets ──http/ws──▶  control server (Windows mini PC)  ◀──ws── wall agent (each video wall PC)
                        • profile engine, scenes, guide            • connects to that wall's TVs,
                        • touch panel at :8080                       iTach and COM ports for the server
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

Open `http://<control-pc-ip>:8080` on any tablet on the network. On an iPad, use "Add to Home Screen" so it runs full-screen.

While working on the panel, `npm run dev:web` serves it with hot reload on :5173, with API calls forwarded to :8080.

**Install on the Windows control PC** (elevated PowerShell, from the project folder):
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```
The first run creates `config\system.local.json` and a `.env` file for secrets (the Gracenote key). Fill them in and run the script again. The second run builds the panel, sets the server to start at boot and restart if it exits, and opens port 8080 to the local network. Logs go to `logs\server.log`.

`config/system.json` only holds server settings (port, data folder, simulation, guide). Everything else is in the site.

## Setting up a site

Open **`http://<control-pc-ip>:8080/admin`** (or **⚙ Admin** on the touch panel). On the first visit you choose the admin password. From there:
- **Devices**: add a device by picking its type. The settings form comes from the device's profile. Choose whether it's reached from the control server or a wall PC. **Test** sends any command and shows the device's live traffic.
- **Video walls**, **Rooms**, **Scenes** (step by step, with a Run button), **Channels** (with Gracenote lookup by ZIP code).
- **Wall PCs**: a newly installed agent shows up under "Waiting for approval". Approve it, and it connects within 10 seconds.
- **Device types**: create and edit profiles in forms. **Try it** shows exactly what a command sends, **Test** checks a reply rule against a sample, and **Learn** captures IR codes from a remote through an iTach (from the server or any wall PC). Built-ins are read-only; Duplicate one to adapt it.
- **Backup**: download or restore the whole site and custom profiles, and roll back to any of the last 50 saves.

Edits are collected and applied together with **Save & apply**. The server checks the whole site first, including that every scene step's command and values fit its device, and lists any problems instead of saving. Devices that changed restart; nothing else does.

Device-specific notes:
- **TCL Roku panels** (`tcl-roku-tv`): network control. On each TV, turn on Fast TV start, set Control by mobile apps to Permissive, turn off Auto power off, and set Power on to Last used input. Run `node src/agent.ts discover` on a wall PC to find them all.
- **Xfinity boxes** (`xfinity-ir`): IR through a Global Caché iTach, with **one iTach port per box**. Identical boxes respond to the same codes, so if one emitter can reach two boxes, both will change channel. Learn codes once with `node src/agent.ts learn xfinity` on a wall PC, then put them in a custom profile that `extends: xfinity-ir` (see [docs/profiles.md](docs/profiles.md)).
- **Atlas** (`atlas-atmosphere`): enable third-party control in Atmosphere. Zones, sources and scenes are numbered from 0, in Atmosphere's order. Changes made from Atmosphere wall panels show up live.
- **Video walls (panels)**: a group with `"kind": "wall"` whose devices are the panels. The Video Walls tab shows each wall's panels, and its PC and mosaic software status.
- **Mosaic engine** (`mosaic-engine`): add one device pointing at the media server (port 8090), and enter the API key if one is set in the mosaic editor (Settings → Access). Walls ("groups"), their presets, scenes and NDI streams are read from the engine every 3 seconds, so presets made in the mosaic editor appear on the Video Walls tab on their own, with the active preset highlighted. Each wall gets preset buttons, a "show one stream" picker and Blank. In scenes, use "Recall wall preset" (pick the wall, then its preset, with a crossfade time). The wall agents' local health check uses port 8095, so the agent can run on the media server without clashing with the engine's port 8090.

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
