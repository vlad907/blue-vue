import { execFile } from "node:child_process";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import { GlobalCacheTransmitter, parsePronto } from "../ir.ts";
import { AdbClient } from "./adb/client.ts";
import { Connection, type ConnectionSettings, type RenderedPayload, type TransportConfig, describe, requireSetting } from "./types.ts";

const execFileAsync = promisify(execFile);

/** Request/response HTTP. The device counts as online while requests succeed. */
export class HttpConnection extends Connection {
  base: string;

  constructor(cfg: TransportConfig, settings: ConnectionSettings) {
    super();
    const host = requireSetting(settings.host, "host");
    const port = settings.port ?? cfg.port;
    this.base = `${cfg.https ? "https" : "http"}://${host}${port ? `:${port}` : ""}`;
  }

  open() {}
  close() {
    this.setOnline(false);
  }

  async send(p: RenderedPayload) {
    if (p.kind !== "http") throw new Error(`HTTP can't send ${p.kind} payloads`);
    this.log("tx", describe(p));
    try {
      const res = await fetch(this.base + p.path, {
        method: p.method,
        headers: p.headers,
        body: p.body,
        signal: AbortSignal.timeout(5000),
      });
      const text = await res.text();
      this.setOnline(true);
      if (res.status === 403 && this.base.endsWith(":8060")) {
        throw new Error(`HTTP 403: the Roku refused. On the TV set Settings > System > Advanced system settings > Control by mobile apps > Network access to Default or Permissive`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}${reason(text)}`);
      if (text) this.log("rx", text.length > 500 ? text.slice(0, 500) + "…" : text);
      return text;
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith("HTTP "))) this.setOnline(false);
      throw err;
    }
  }
}

/** UDP datagrams; each received datagram is one message. */
export class UdpConnection extends Connection {
  host: string;
  port: number;
  terminator: string;
  private socket?: UdpSocket;

  constructor(cfg: TransportConfig, settings: ConnectionSettings) {
    super();
    this.host = requireSetting(settings.host, "host");
    this.port = requireSetting(settings.port ?? cfg.port, "port");
    this.terminator = cfg.terminator ?? "";
  }

  open() {
    const sock = createSocket("udp4");
    this.socket = sock;
    sock.on("message", (msg) => {
      const text = msg.toString("latin1").replace(/[\r\n]+$/, "");
      this.log("rx", text);
      this.emit("data", text);
    });
    sock.on("error", (err) => this.log("error", err.message));
    sock.bind(0, () => this.setOnline(true));
  }

  close() {
    this.socket?.close();
    this.setOnline(false);
  }

  send(p: RenderedPayload) {
    const data = p.kind === "text" ? Buffer.from(p.text + this.terminator, "latin1") : p.kind === "bytes" ? p.bytes : undefined;
    if (!data) throw new Error(`UDP can't send ${p.kind} payloads`);
    if (!this.socket) throw new Error("UDP socket not open");
    return new Promise<undefined>((resolve, reject) =>
      this.socket!.send(data, this.port, this.host, (err) => {
        if (err) return reject(err);
        this.log("tx", describe(p));
        resolve(undefined);
      }),
    );
  }
}

// One queue per IR gateway: several devices share an iTach, and it can only
// emit one code at a time.
const irQueues = new Map<string, Promise<unknown>>();

/** IR through a Global Caché iTach (or GC-100) on the network. */
export class IrConnection extends Connection {
  host: string;
  irPort: number;
  module: number;
  tcpPort: number;

  constructor(_cfg: TransportConfig, settings: ConnectionSettings) {
    super();
    this.host = requireSetting(settings.irHost, "irHost");
    this.irPort = Number(requireSetting(settings.irPort, "irPort"));
    this.module = Number(settings.irModule ?? 1);
    this.tcpPort = Number(settings.irTcpPort ?? 4998);
  }

  open() {
    // IR is one-way; there's no connection to hold open.
    this.setOnline(true);
  }
  close() {
    this.setOnline(false);
  }

  send(p: RenderedPayload) {
    if (p.kind !== "ir") throw new Error(`IR can't send ${p.kind} payloads`);
    const code = parsePronto(p.pronto);
    const tx = new GlobalCacheTransmitter(this.host, this.module, this.tcpPort);
    const job = (irQueues.get(this.host) ?? Promise.resolve()).then(async () => {
      this.log("tx", `${describe(p)} on ${this.host} port ${this.irPort}`);
      await tx.send(this.irPort, code, p.repeat);
      await new Promise((r) => setTimeout(r, 80));
    });
    irQueues.set(this.host, job.catch(() => {}));
    return job.then(() => undefined);
  }
}

/**
 * Android and Fire TVs over ADB network debugging. Blue Vue speaks ADB
 * itself; set ADB_PATH to use Android's adb program instead.
 */
export class AdbConnection extends Connection {
  host: string;
  port: number;
  adb?: string;
  private client?: AdbClient;

  constructor(cfg: TransportConfig, settings: ConnectionSettings) {
    super();
    this.host = requireSetting(settings.host, "host");
    this.port = Number(settings.port ?? cfg.port ?? 5555);
    // Only the configured adb binary can run; profiles can't name programs.
    this.adb = process.env.ADB_PATH || undefined;
  }

  open() {
    if (this.adb) return;
    const c = new AdbClient(this.host, this.port);
    this.client = c;
    c.on("approval", () => this.log("info", `Asked the TV to allow debugging from this machine. On the TV, tick "Always allow" and press Allow.`));
    c.on("state", (st: string) => {
      if (st === "connected") this.log("info", `ADB connected${c.banner ? ` (${c.banner.slice(0, 120)})` : ""}`);
      if (st !== "connected") this.setOnline(false);
    });
    // Connect now so the TV's prompt shows up right after the device is saved.
    c.connect().catch((err) => this.log("error", err.message));
  }

  close() {
    this.client?.close();
    this.client = undefined;
    this.setOnline(false);
  }

  async send(p: RenderedPayload) {
    if (p.kind !== "adb") throw new Error(`ADB can't send ${p.kind} payloads`);
    this.log("tx", describe(p));
    try {
      let out: string;
      if (this.adb) {
        const target = `${this.host}:${this.port}`;
        await execFileAsync(this.adb, ["connect", target], { timeout: 5000 }).catch(() => {});
        out = (await execFileAsync(this.adb, ["-s", target, "shell", ...p.args], { timeout: 5000, maxBuffer: 4_000_000 })).stdout;
      } else {
        if (!this.client) this.open();
        out = await this.client!.shell(p.args.join(" "));
      }
      this.setOnline(true);
      if (out.trim()) this.log("rx", out.length > 500 ? out.slice(0, 500) + "…" : out.trim());
      return out;
    } catch (err) {
      this.setOnline(false);
      throw err;
    }
  }
}

/** Wake-on-LAN magic packet to the device's MAC address. */
export class WolConnection extends Connection {
  mac: Buffer;

  constructor(_cfg: TransportConfig, settings: ConnectionSettings) {
    super();
    const hex = String(requireSetting(settings.mac, "mac")).replace(/[^0-9a-f]/gi, "");
    if (hex.length !== 12) throw new Error(`Invalid MAC address "${settings.mac}"`);
    this.mac = Buffer.from(hex, "hex");
  }

  open() {
    this.setOnline(true);
  }
  close() {
    this.setOnline(false);
  }

  async send(p: RenderedPayload) {
    if (p.kind !== "wol") throw new Error(`WOL can't send ${p.kind} payloads`);
    const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(this.mac)]);
    // 255.255.255.255 leaves through one network card only, so also send to
    // each card's own network (e.g. 192.168.1.255) to reach TVs on any of them.
    const targets = ["255.255.255.255", ...broadcastAddresses()];
    const sock = createSocket("udp4");
    await new Promise<void>((resolve) => sock.bind(() => resolve()));
    sock.setBroadcast(true);
    const results = await Promise.allSettled(targets.map((t) => new Promise<void>((res, rej) => sock.send(packet, 9, t, (err) => (err ? rej(err) : res())))));
    sock.close();
    if (results.every((r) => r.status === "rejected")) throw (results[0] as PromiseRejectedResult).reason;
    this.log("tx", `${describe(p)} to ${targets.join(", ")}`);
    return undefined;
  }
}

/** The directed broadcast address of each IPv4 network this machine is on. */
export function broadcastAddresses(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      const ip = ni.address.split(".").map(Number);
      const mask = ni.netmask.split(".").map(Number);
      out.add(ip.map((b, i) => (b | (~mask[i] & 255)) & 255).join("."));
    }
  }
  return [...out];
}

/** Stand-in used in simulation mode: logs what would be sent. */
/** Why a device refused a request, when it says: the "error" or "message" of a JSON reply, or a short plain one. */
function reason(body: string): string {
  const text = body.trim();
  if (!text) return "";
  try {
    const j = JSON.parse(text) as { error?: unknown; message?: unknown };
    const why = typeof j.error === "string" ? j.error : typeof j.message === "string" ? j.message : "";
    return why ? `: ${why.slice(0, 200)}` : "";
  } catch {
    return text.length <= 120 && !text.startsWith("<") ? `: ${text}` : "";
  }
}

export class SimulatedConnection extends Connection {
  sent: RenderedPayload[] = [];
  open() {
    this.setOnline(true);
  }
  close() {
    this.setOnline(false);
  }
  async send(p: RenderedPayload) {
    this.sent.push(p);
    this.log("tx", `${describe(p)} (simulated)`);
    // A simulated Android TV reports the power it was asked for, like a real one would.
    if (p.kind === "appletv" && p.power) return JSON.stringify({ power: p.power === "on", result: `${p.power} (simulated)` });
    if (p.kind === "androidtv" && p.power) return JSON.stringify({ power: p.power === "on", result: `${p.power} (simulated)` });
    return p.kind === "http" || p.kind === "adb" ? "" : undefined;
  }
}
