# Writing device profiles

A **profile** describes a type of device: how to reach it, the commands it accepts, how to read its state, and which controls to show. Adding a new kind of device means writing a profile, not code. Once you have a profile, add any number of **devices** that use it.

- Built-in profiles live in `profiles/builtin/`. They ship with Blue Vue and are read-only.
- Your own profiles go in `data/profiles/`. A custom profile with the same `id` as a built-in replaces it.
- A profile can `extends` another one and override parts of it. The usual case is adding learned IR codes to a built-in:
  ```yaml
  id: xfinity-our-codes
  name: Xfinity (our codes)
  extends: xfinity-ir
  irCodes:
    KEY_1: "0000 006D 0000 0022 0155 00AA ..."
  ```

Examples to copy from:
- `tcl-roku-tv.yaml`: HTTP, with polling
- `atlas-atmosphere.yaml`: TCP, with subscriptions and pushed updates
- `xfinity-ir.yaml`: IR, with a multi-step tune command

## Skeleton

```yaml
id: acme-projector            # lowercase letters, numbers, dashes
name: Acme Projector
manufacturer: Acme
category: projector           # display, tuner, audio, video-wall, switcher, projector, lighting, other

transport:
  type: tcp                   # tcp, udp, http, serial, ir, adb, wol
  port: 4352
  terminator: "\r"            # added to every `send`
  delimiter: "\r"             # splits replies into messages (default "\n")
  minGapMs: 100               # pause between commands

settings:                     # the fields shown when adding a device
  - { key: host, label: IP address, type: string, required: true }

commands:
  power_on:
    label: Power on
    steps: [{ send: "%1POWR 1" }]
  power_off:
    label: Power off
    steps: [{ send: "%1POWR 0" }]

state:
  power: { type: enum, values: ["on", "off"] }

polls:
  - every: 10
    steps: [{ send: "%1POWR ?" }]

feedback:                     # runs on every message from the device
  - regex: '%1POWR=(\d)'
    set: { power: "{{value | map:1=on,*=off}}" }

capabilities:
  power: { on: power_on, off: power_off, state: power }

controls:
  - { type: toggle, label: Power, on: power_on, off: power_off, state: power }
```

## Steps
A command is a list of steps, run in order.

| Step | Example |
|---|---|
| Send text (tcp/udp/serial) | `send: "VOL {{level}}"` (`\r`, `\n` and `\x0D` work) |
| Send bytes | `hex: "AA 01 {{level \| hex:2}}"` |
| HTTP request | `http: { method: POST, path: "/api/input/{{input}}", body: '{"on":true}' }` |
| IR code | `ir: KEY_POWERON` (a name from `irCodes`), plus `repeat: 2` if needed |
| ADB | `adb: input keyevent KEYCODE_WAKEUP` |
| Wake-on-LAN | `wol: true` (uses the `mac` setting) |
| Wait | `delay: 500`, or `delay: "{{settings.delayMs}}"` |
| Each character | `forEachChar: "{{channel}}"` with nested `steps`, using `{{item}}` |
| Each list item | `forEach: settings.zones` with nested `steps`, using `{{item.index}}` |
| Another command | `command: power_on` (optional `params`) |

Optional parts of a command:
- `params` declares typed inputs (`number`/`integer` with `min`/`max`, `boolean`, `string`, `enum` with `values`). Values are checked before anything is sent.
- `sets` updates state right away. Use it for one-way devices like IR.
- `parse` reads the HTTP or ADB reply.

## Templates
`{{name}}` inserts a command param, `{{settings.host}}` a device setting, `{{state.power}}` the current state, and `{{item}}` the current item in a loop. Filters chain left to right:

| Filter | Effect |
|---|---|
| `number`, `round:1` | convert to a number, or round it |
| `clamp:-80:0` | keep the value within a range |
| `scale:0:100:-80:0` | map one range onto another |
| `map:PowerOn=on,*=off` | look up a value; `*` is the fallback |
| `bool:1:0` | turn true/false into text |
| `hex:2`, `pad:3` | hex with zero padding, or pad with zeros |
| `upper`, `lower`, `digits`, `default:x`, `json` | |

## Reading state
- `regex` uses named groups (`(?<zone>\d+)`), or `value` for the first group, and runs for every match in a message.
- `xmlTag: power-mode` reads the text inside that tag.
- `jsonPath: $.status.inputs[0].name` reads a value from JSON.

The `set` keys are templates too, so one rule can fill per-zone state: `"zones.{{zone}}.gain": "{{val}}"`. Declare state types under `state:`. Keys can use `*`, e.g. `"zones.*.mute": { type: boolean }`.

## Capabilities
Capabilities connect your commands to features the rest of the system uses:
- `power`: wall cards, all-on/off, and group power
- `tuner`: TV guide tap-to-tune and favorites
- `volume`, `source`
- `layoutPresets`: video wall layouts

## Where a device connects from
Each device has a **location**: `server` (the control PC), or the id of a wall agent. With a wall agent, its connection is made from that wall PC, which is how you reach a TV on the wall's network, an iTach next to the wall, or an RS-232 device on the PC's COM port. Serial devices use the `serialPort` setting (e.g. `COM3`), plus `baudRate` (or `transport.baudRate`), and optionally `dataBits`, `parity` and `stopBits`.

## Converting the old config
```bash
npx tsx scripts/migrate-config.ts --system config/system.local.json --agent wall1=path/to/wall1/agent.json --agent wall2=...
```
This writes `data/site.json` and adds custom profiles for any learned IR codes. The server also does this automatically on first start if it finds an old-format config.
