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

export async function scanAndroidTvs(subnets: string[] = localSubnets(), port = REMOTE_PORT): Promise<FoundTv[]> {
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
  const found = await Promise.all(open.map(async (host) => ({ host, ...(await castInfo(host)) })));
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

const ipNumber = (ip: string) => ip.split(".").reduce((n, p) => n * 256 + Number(p), 0);

/** Stand-in results for simulation mode: 20 TVs. */
export function simulatedTvs(): FoundTv[] {
  return Array.from({ length: 20 }, (_, i) => ({
    host: `192.168.1.${145 + i}`,
    name: `TCL 98QM7L ${i + 1}`,
    model: "TCL 98QM7L",
    mac: `A0:B1:C2:00:00:${(i + 1).toString(16).padStart(2, "0").toUpperCase()}`,
  }));
}
