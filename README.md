# Blue Vue Control

A touch-panel control system for:

1. **Video wall TVs**: per-panel power and input control on every wall, through an agent on each wall's Windows PC ([agent/](agent/README.md))
2. **Xfinity boxes**: channel tuning, favorites and a full remote over IR
3. **TV guide**: Gracenote (TMS OnConnect) listings; tap a show to tune
4. **AtlasIED Atmosphere DSP**: zone source, gain, mute and scenes over TCP JSON-RPC
5. **Video wall processor**: layout presets over HTTP (placeholder until the API schema is final)

**Scenes** combine all of these into one button, for example "Open Venue" or "Game Day".

> **Moving to data-driven devices.** Device types are becoming **profiles**: YAML files that describe a device's commands, feedback and controls, so new devices can be added without code (see [docs/profiles.md](docs/profiles.md)). The profile engine runs alongside the original drivers whenever `data/site.json` exists. Devices can live on the control server or behind any wall agent, which connects out to the server over WebSocket. Next up: the auto-generated touch panel, then the web admin.

## Run

```bash
npm install
BLUEVUE_SIMULATE=1 npm run dev     # no hardware needed
npm start                          # real hardware
```

**Install on the Windows control PC** (elevated PowerShell, from the project folder):
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```
The first run creates `config\system.local.json` and a `.env` file for secrets (the Gracenote key and the wall tokens). Fill them in and run the script again. The second run sets the server to start at boot, restarts it if it exits, and opens port 8080 to the local network. Logs go to `logs\server.log`.

Open `http://<control-box-ip>:8080` on any tablet on the LAN. On an iPad, use "Add to Home Screen" so it runs full-screen.

Config is read from `config/system.local.json` if it exists (gitignored, for site-specific settings), otherwise from `config/system.json`.

## Hardware notes

### Video walls and IR (wall agents)
Each Windows video wall PC runs the **Blue Vue agent** (see [agent/README.md](agent/README.md)). The agent controls that wall's panels (TCL Roku TVs over the network, Google TVs over ADB, or IR as a fallback) and owns that wall's IR hardware for the Xfinity boxes. Add each wall under `endpoints`, and point each box's emitter at an endpoint and IR port:

```json
"endpoints": [{ "id": "wall1", "name": "Main Bar", "url": "http://10.0.10.21:8090", "token": "..." }],
"emitters":  { "box1": { "endpoint": "wall1", "port": 1 } }
```

- **Each Xfinity box needs its own IR port.** Identical boxes respond to the same codes, so if one emitter can reach two boxes, both will change channel.
- The control server polls every wall's panels, so the UI shows real power state for network-controlled panels. Panels driven by IR show a dashed border, because their state is only the last command sent, not a confirmed reading.
- An emitter without `endpoint` falls back to local LIRC (`socket`/`transmitters`) on a Linux control server.

### Atlas Atmosphere
TCP port 5321, newline-delimited JSON-RPC 2.0. The client subscribes to `ZoneGain_N`, `ZoneMute_N` and `ZoneSource_N`, so changes made from wall panels or the Atmosphere web UI show up live. It reconnects automatically. You may need to enable third-party control in the Atmosphere UI. Zone and source indexes are 0-based.

### Gracenote
```bash
export GRACENOTE_API_KEY=...
npm run gracenote -- lineups 19103          # find your Xfinity lineupId
npm run gracenote -- channels USA-PA12345-X  # print channel entries with stationIds
```
Set `guide.lineupId` and paste `stationId`s into `channels`. If there is no key or lineup, the guide shows simulated data.

### Video wall API
`src/drivers/videoWall.ts` currently sends a request to `baseUrl + recallPath` (with `{id}` replaced by the preset ID). Once the API schema is final, replace `HttpVideoWall.doRecall`. The rest of the app uses the `VideoWallController` interface.

## API

| Method | Path | Body |
|---|---|---|
| GET | `/api/config`, `/api/state`, `/api/guide` | |
| POST | `/api/wall/power` | `{ "on": true, "wall": "wall1", "panels": ["r1c1"] }` (wall and panels optional) |
| POST | `/api/wall/input` | `{ "input": "hdmi1", "wall": "wall1" }` |
| POST | `/api/walls/:wall/apps/:name/restart` | |
| POST | `/api/wall/preset/:id` | |
| POST | `/api/boxes/:id/tune` | `{ "channel": 206 }` |
| POST | `/api/boxes/:id/key` | `{ "key": "KEY_CHANNELUP" }` |
| POST | `/api/audio/zones/:zone` | `{ "gainDb": -20, "mute": false, "source": 1 }` |
| POST | `/api/audio/scenes/:n` | |
| POST | `/api/scenes/:id` | |
| WS | `/ws` | pushes `{ type: "state", state }` on every change |

Scene step types: `wallPower` (optional `wall`), `wallInput`, `wallPreset`, `tune`, `boxKey`, `zoneSource`, `zoneGain`, `zoneMute`, `atlasScene`, `delay`.
