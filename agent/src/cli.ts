import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.ts";
import { discoverRoku } from "./discover.ts";
import { IrService, createTransmitter } from "./ir.ts";
import { learnOnce, sendirToPronto } from "./learn.ts";

// Commissioning commands, run by a technician at the wall PC:
//   node src/agent.ts discover
//   node src/agent.ts learn <remote> [--preset xfinity|tv] [KEY ...]
//   node src/agent.ts send <port> <remote> <KEY>
export const COMMANDS = ["discover", "learn", "send"];

const PRESETS: Record<string, string[]> = {
  xfinity: [
    "KEY_0", "KEY_1", "KEY_2", "KEY_3", "KEY_4", "KEY_5", "KEY_6", "KEY_7", "KEY_8", "KEY_9",
    "KEY_OK", "KEY_CHANNELUP", "KEY_CHANNELDOWN", "KEY_LAST", "KEY_EPG", "KEY_INFO", "KEY_MENU", "KEY_EXIT",
    "KEY_UP", "KEY_DOWN", "KEY_LEFT", "KEY_RIGHT", "KEY_PLAYPAUSE", "KEY_REWIND", "KEY_FASTFORWARD", "KEY_POWER",
  ],
  tv: ["KEY_POWERON", "KEY_POWEROFF", "KEY_HDMI1", "KEY_HDMI2", "KEY_HDMI3", "KEY_HDMI4"],
};

export async function runCli(args: string[], configPath: string) {
  const [cmd, ...rest] = args;
  if (cmd === "discover") return discover();
  if (cmd === "learn") return learn(rest, configPath);
  if (cmd === "send") return send(rest, configPath);
}

async function discover() {
  console.log("Searching the network for Roku TVs (3s)...\n");
  const devices = await discoverRoku();
  if (!devices.length) {
    console.log("None found. Check the TVs are on this PC's network/VLAN and Fast TV start is on.");
    return;
  }
  for (const d of devices) {
    const warn = d.network === "wifi" ? "  <- on Wi-Fi; use Ethernet" : "";
    console.log(`${d.host.padEnd(16)} ${(d.name ?? "?").padEnd(24)} ${(d.model ?? "").padEnd(20)} ${d.power ?? ""}${warn}`);
  }
  console.log("\nDevice entries for the control server's site (set location to this wall's agent id, and rename to each panel's position):\n");
  devices.filter((d) => d.isTv).forEach((d, i) =>
    console.log(`    ${JSON.stringify({ id: `panel${i + 1}`, name: d.name ?? `Panel ${i + 1}`, profile: "tcl-roku-tv", location: "<agent id>", settings: { host: d.host } })},`),
  );
  console.log("\nTip: turn one panel off to see which IP is which, or use its name from Settings > System > About.");
}

async function learn(args: string[], configPath: string) {
  const presetIdx = args.indexOf("--preset");
  const preset = presetIdx >= 0 ? args.splice(presetIdx, 2)[1] : undefined;
  const [remote, ...keys] = args;
  if (!remote) throw new Error("Usage: learn <remote> [--preset xfinity|tv] [KEY ...]");
  if (preset && !PRESETS[preset]) throw new Error(`Unknown preset "${preset}" (use ${Object.keys(PRESETS).join(", ")})`);
  const toLearn = keys.length ? keys : PRESETS[preset ?? (remote.includes("xfinity") ? "xfinity" : "tv")];

  const cfg = loadConfig(configPath);
  if (cfg.ir.driver !== "globalcache" || !cfg.ir.host) throw new Error("Learning needs ir.driver = globalcache with ir.host set");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Learning "${remote}" through the iTach at ${cfg.ir.host}.`);
  console.log("Hold the remote 2-4 inches from the iTach's learning window. Type s + Enter to skip a key, q + Enter to stop.\n");
  try {
    for (const key of toLearn) {
      const answer = await rl.question(`${key}: press Enter, then press the button... `);
      if (answer.trim().toLowerCase() === "q") break;
      if (answer.trim().toLowerCase() === "s") continue;
      try {
        const pronto = sendirToPronto(await learnOnce(cfg.ir.host));
        saveCode(configPath, remote, key, pronto);
        console.log(`  saved (${pronto.split(" ").length} words)`);
      } catch (err) {
        console.log(`  failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  } finally {
    rl.close();
  }
  console.log(`\nTest a code with: node src/agent.ts send <port> ${remote} <KEY>`);
  console.log("Then copy the codes from agent.json into a custom profile's irCodes on the control server.");
}

async function send(args: string[], configPath: string) {
  const [port, remote, key] = args;
  if (!port || !remote || !key) throw new Error("Usage: send <port> <remote> <KEY>");
  const cfg = loadConfig(configPath);
  const ir = new IrService(createTransmitter(cfg.ir, cfg.simulate), cfg.codes);
  await ir.sendKey(Number(port), remote, key);
  console.log(`Sent ${remote} ${key} on port ${port}`);
}

/** Writes one code into agent.json, keeping everything else in the file. */
function saveCode(configPath: string, remote: string, key: string, pronto: string) {
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  raw.codes ??= {};
  raw.codes[remote] ??= {};
  raw.codes[remote][key] = pronto;
  writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n");
}
