import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { identityStore } from "../androidtv/cert.ts";

// The MAC address of each ADB TV, learned from the TV while it's awake and kept
// next to the ADB key, so wake-on-LAN still works after a restart while the TV
// sleeps. Fire TVs switch their network port off in deep standby, and a magic
// packet is the only thing that reaches them then.

const FILE = "adb-macs.json";
let cached: Record<string, string> | undefined;

function load(): Record<string, string> {
  if (cached) return cached;
  const path = join(identityStore.dir, FILE);
  try {
    cached = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>) : {};
  } catch {
    cached = {};
  }
  return cached;
}

export function learnedMac(host: string): string | undefined {
  return load()[host];
}

export function rememberMac(host: string, mac: string) {
  const all = load();
  if (all[host] === mac) return;
  all[host] = mac;
  mkdirSync(identityStore.dir, { recursive: true });
  writeFileSync(join(identityStore.dir, FILE), JSON.stringify(all, null, 2) + "\n");
}

/** For tests: forget what was loaded so a new folder takes effect. */
export function resetMacs() {
  cached = undefined;
}

/** Asks for each network port's state and MAC, one line per port: "eth0 up aa:bb:cc:dd:ee:ff". */
export const MAC_QUERY = "for i in eth0 wlan0; do echo $i $(cat /sys/class/net/$i/operstate) $(cat /sys/class/net/$i/address); done 2>/dev/null";

/** The MAC of the port that's up (Ethernet first), from MAC_QUERY's output. */
export function parseMac(out: string): string | undefined {
  const ports = out
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter(([, state, mac]) => state === "up" && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac ?? "") && mac !== "00:00:00:00:00:00");
  return ports[0]?.[2]?.toLowerCase();
}
