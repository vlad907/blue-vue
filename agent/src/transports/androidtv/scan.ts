import { Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { REMOTE_PORT } from "./remote.ts";

// Finds Android / Google TVs on the local network: anything accepting
// connections on the remote-control port. Names, models and MAC addresses
// come from the TV's Cast info page when it has one (best effort).

export interface FoundTv {
  host: string;
  name?: string;
  model?: string;
  mac?: string;
}

/** "192.168.1" prefixes of this machine's private IPv4 networks. */
export function localSubnets(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ni.address)) out.add(ni.address.split(".").slice(0, 3).join("."));
    }
  }
  return [...out];
}

/** How each kind of TV is found: the port it answers on, and where its name comes from. */
export type ScanKind = "androidtv" | "roku" | "adb";
const KINDS: Record<ScanKind, { port: number; info: (host: string) => Promise<Omit<FoundTv, "host">> }> = {
  androidtv: { port: REMOTE_PORT, info: castInfo },
  roku: { port: 8060, info: rokuInfo },
  adb: { port: 5555, info: async () => ({}) },
};

export function scanTvs(kind: ScanKind, subnets?: string[]) {
  return scanAndroidTvs(subnets, KINDS[kind].port, KINDS[kind].info);
}

export async function scanAndroidTvs(subnets: string[] = localSubnets(), port = REMOTE_PORT, info = castInfo): Promise<FoundTv[]> {
  for (const s of subnets) if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s)) throw new Error(`"${s}" isn't a network like 192.168.1`);
  const hosts = subnets.flatMap((s) => Array.from({ length: 254 }, (_, i) => `${s}.${i + 1}`));
  const open: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const host = hosts[next++];
      if (await isOpen(host, port, 600)) open.push(host);
    }
  };
  await Promise.all(Array.from({ length: 96 }, worker));
  const found = await Promise.all(open.map(async (host) => ({ host, ...(await info(host)) })));
  return found.sort((a, b) => ipNumber(a.host) - ipNumber(b.host));
}

function isOpen(host: string, port: number, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const s = new Socket();
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.connect(port, host);
  });
}

async function castInfo(host: string): Promise<Omit<FoundTv, "host">> {
  try {
    const res = await fetch(`http://${host}:8008/setup/eureka_info?params=name,device_info`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return {};
    const j = (await res.json()) as { name?: string; mac_address?: string; device_info?: { model_name?: string; manufacturer?: string; mac_address?: string } };
    const mac = j.device_info?.mac_address ?? j.mac_address;
    const model = [j.device_info?.manufacturer, j.device_info?.model_name].filter(Boolean).join(" ");
    return { name: j.name || undefined, model: model || undefined, mac: mac || undefined };
  } catch {
    return {};
  }
}

/** Roku's device-info page: name, model and the MAC of whichever network it's on. */
async function rokuInfo(host: string): Promise<Omit<FoundTv, "host">> {
  try {
    const res = await fetch(`http://${host}:8060/query/device-info`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return {};
    const xml = await res.text();
    const tag = (t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(xml)?.[1] || undefined;
    const model = [tag("vendor-name"), tag("model-name")].filter(Boolean).join(" ");
    const mac = tag("network-type") === "ethernet" ? tag("ethernet-mac") : tag("wifi-mac");
    return { name: tag("user-device-name") ?? tag("friendly-device-name"), model: model || undefined, mac: mac ?? tag("ethernet-mac") };
  } catch {
    return {};
  }
}

const ipNumber = (ip: string) => ip.split(".").reduce((n, p) => n * 256 + Number(p), 0);

/** Stand-in results for simulation mode: 20 TVs. */
export function simulatedTvs(kind: ScanKind = "androidtv"): FoundTv[] {
  const model = { androidtv: "TCL 98QM7L", roku: "TCL Roku TV 75S455", adb: undefined }[kind];
  const first = { androidtv: 145, roku: 170, adb: 200 }[kind];
  return Array.from({ length: 20 }, (_, i) => ({
    host: `192.168.1.${first + i}`,
    name: model && `${model} ${i + 1}`,
    model,
    mac: `A0:B1:C2:00:00:${(i + 1).toString(16).padStart(2, "0").toUpperCase()}`,
  }));
}
