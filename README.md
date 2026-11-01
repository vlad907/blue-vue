# Blue Vue Control

A touch-panel control system for:

1. **Video wall TVs**: power on/off over IR through a USB IR blaster
2. **Xfinity boxes**: channel tuning, favorites and a full remote over IR
3. **TV guide**: Gracenote (TMS OnConnect) listings; tap a show to tune
4. **AtlasIED Atmosphere DSP**: zone source, gain, mute and scenes over TCP JSON-RPC
5. **Video wall processor**: layout presets over HTTP (placeholder until the API schema is final)

**Scenes** combine all of these into one button, for example "Open Venue" or "Game Day".

## Run

```bash
npm install
BLUEVUE_SIMULATE=1 npm run dev     # no hardware needed
npm start                          # real hardware
```

Open `http://<control-box-ip>:8080` on any tablet on the LAN. On an iPad, use "Add to Home Screen" so it runs full-screen.

Config is read from `config/system.local.json` if it exists (gitignored, for site-specific settings), otherwise from `config/system.json`.

## Hardware notes

### IR (LIRC)
Run the control box on Linux (a Raspberry Pi or a NUC) with LIRC installed. IR is sent with `irsend`.

- **Each Xfinity box needs its own IR emitter.** Identical boxes respond to the same codes, so if one emitter can reach two boxes, both will change channel. Use one of these:
  - a multi-output blaster such as the Iguanaworks USB IR transceiver, with each box on its own `transmitters` channel, or
  - one blaster per box, each running its own `lircd` instance, and set `socket` on the emitter.
- Put the IR codes in `/etc/lirc/lircd.conf.d/`. The remote names (`xfinity`, `wall_tv`) and button names (`KEY_0`, `KEY_OK`, `KEY_POWERON`, …) must match the config. You can learn codes with `irrecord`, or start from the LIRC remotes database. Xfinity XR11/XR15 remotes have to be in IR mode, not RF-paired.
- For the TVs, use **discrete** power-on/power-off codes, not the power toggle. With a toggle, one panel that misses a code ends up out of sync with the rest of the wall.
- IR is one-way, so the wall power state and box channels the UI shows are the last values commanded, not confirmed.

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
| POST | `/api/wall/power` | `{ "on": true }` |
| POST | `/api/wall/preset/:id` | |
| POST | `/api/boxes/:id/tune` | `{ "channel": 206 }` |
| POST | `/api/boxes/:id/key` | `{ "key": "KEY_CHANNELUP" }` |
| POST | `/api/audio/zones/:zone` | `{ "gainDb": -20, "mute": false, "source": 1 }` |
| POST | `/api/audio/scenes/:n` | |
| POST | `/api/scenes/:id` | |
| WS | `/ws` | pushes `{ type: "state", state }` on every change |

Scene step types: `wallPower`, `wallPreset`, `tune`, `boxKey`, `zoneSource`, `zoneGain`, `zoneMute`, `atlasScene`, `delay`.
