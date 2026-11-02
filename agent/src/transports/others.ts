import { execFile } from "node:child_process";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { promisify } from "node:util";
import { GlobalCacheTransmitter, parsePronto } from "../ir.ts";
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
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
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

/** Android TVs over ADB network debugging. */
export class AdbConnection extends Connection {
  target: string;
  adb: string;

  constructor(cfg: TransportConfig, settings: ConnectionSettings) {
    super();
    const host = requireSetting(settings.host, "host");
    this.target = `${host}:${settings.port ?? cfg.port ?? 5555}`;
    // Only the configured adb binary can run; profiles can't name programs.
    this.adb = process.env.ADB_PATH ?? "adb";
  }

  open() {}
  close() {
    this.setOnline(false);
  }

  async send(p: RenderedPayload) {
    if (p.kind !== "adb") throw new Error(`ADB can't send ${p.kind} payloads`);
    this.log("tx", describe(p));
    try {
      await execFileAsync(this.adb, ["connect", this.target], { timeout: 5000 }).catch(() => {});
      const { stdout } = await execFileAsync(this.adb, ["-s", this.target, "shell", ...p.args], { timeout: 5000, maxBuffer: 4_000_000 });
      this.setOnline(true);
      return stdout;
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

  send(p: RenderedPayload) {
    if (p.kind !== "wol") throw new Error(`WOL can't send ${p.kind} payloads`);
    const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(this.mac)]);
    const sock = createSocket("udp4");
    return new Promise<undefined>((resolve, reject) => {
      sock.bind(() => {
        sock.setBroadcast(true);
        sock.send(packet, 9, "255.255.255.255", (err) => {
          sock.close();
          if (err) return reject(err);
          this.log("tx", describe(p));
          resolve(undefined);
        });
      });
    });
  }
}

/** Stand-in used in simulation mode: logs what would be sent. */
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
    return p.kind === "http" || p.kind === "adb" ? "" : undefined;
  }
}
