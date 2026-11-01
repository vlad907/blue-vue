import { createSocket } from "node:dgram";

export interface RokuDevice {
  host: string;
  name?: string;
  model?: string;
  serial?: string;
  power?: string;
  network?: string; // "ethernet" or "wifi"
  isTv: boolean;
}

const SSDP_ADDR = "239.255.255.250";
const SEARCH = [
  "M-SEARCH * HTTP/1.1",
  `HOST: ${SSDP_ADDR}:1900`,
  'MAN: "ssdp:discover"',
  "ST: roku:ecp",
  "MX: 2",
  "", "",
].join("\r\n");

/** Finds Roku devices on the local network with SSDP, then reads each one's device-info. */
export async function discoverRoku(timeoutMs = 3000): Promise<RokuDevice[]> {
  const hosts = new Set<string>();
  const sock = createSocket({ type: "udp4", reuseAddr: true });

  sock.on("message", (msg) => {
    const location = /^location:\s*(\S+)/im.exec(msg.toString())?.[1];
    if (location) hosts.add(new URL(location).hostname);
  });

  await new Promise<void>((resolve, reject) => {
    sock.once("error", reject);
    sock.bind(0, () => {
      // Send a few times: SSDP is UDP and individual packets get dropped.
      for (const delay of [0, 300, 900]) setTimeout(() => sock.send(SEARCH, 1900, SSDP_ADDR), delay);
      setTimeout(resolve, timeoutMs);
    });
  });
  sock.close();

  const devices = await Promise.all([...hosts].map(readDeviceInfo));
  return devices.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}

export async function readDeviceInfo(host: string): Promise<RokuDevice> {
  try {
    const res = await fetch(`http://${host}:8060/query/device-info`, { signal: AbortSignal.timeout(3000) });
    const xml = await res.text();
    const tag = (t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(xml)?.[1];
    return {
      host,
      name: tag("user-device-name") || tag("friendly-device-name"),
      model: tag("model-name"),
      serial: tag("serial-number"),
      power: tag("power-mode"),
      network: tag("network-type"),
      isTv: tag("is-tv") === "true",
    };
  } catch {
    return { host, isTv: false };
  }
}
