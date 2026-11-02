import { Socket } from "node:net";
import { Connection, type ConnectionSettings, type RenderedPayload, type TransportConfig, describe, requireSetting } from "./types.ts";

/** Persistent TCP connection with reconnect, splitting incoming data into messages. */
export class TcpConnection extends Connection {
  host: string;
  port: number;
  terminator: string;
  delimiter: string;
  private socket?: Socket;
  private buffer = "";
  private backoffMs = 1000;
  private timer?: NodeJS.Timeout;
  private stopped = true;

  constructor(cfg: TransportConfig, settings: ConnectionSettings) {
    super();
    this.host = requireSetting(settings.host, "host");
    this.port = requireSetting(settings.port ?? cfg.port, "port");
    this.terminator = cfg.terminator ?? "";
    this.delimiter = cfg.delimiter ?? "\n";
  }

  open() {
    this.stopped = false;
    this.connect();
  }

  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.destroy();
    this.setOnline(false);
  }

  private connect() {
    const sock = new Socket();
    this.socket = sock;
    this.buffer = "";
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 10_000);
    sock.on("connect", () => {
      this.backoffMs = 1000;
      this.log("info", `connected to ${this.host}:${this.port}`);
      this.setOnline(true);
    });
    sock.on("data", (chunk) => this.onData(chunk.toString("latin1")));
    sock.on("error", (err) => this.log("error", err.message));
    sock.on("close", () => {
      this.setOnline(false);
      if (this.stopped) return;
      this.log("info", `disconnected; retrying in ${this.backoffMs / 1000}s`);
      this.timer = setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
    sock.connect(this.port, this.host);
  }

  private onData(text: string) {
    this.buffer += text;
    let i: number;
    while ((i = this.buffer.indexOf(this.delimiter)) >= 0) {
      const msg = this.buffer.slice(0, i).replace(/\r$/, "");
      this.buffer = this.buffer.slice(i + this.delimiter.length);
      if (msg.trim()) {
        this.log("rx", msg);
        this.emit("data", msg);
      }
    }
    // Guard against a device that never sends the delimiter.
    if (this.buffer.length > 64_000) this.buffer = "";
  }

  async send(p: RenderedPayload) {
    if (!this.socket || !this.online) throw new Error(`Not connected to ${this.host}:${this.port}`);
    if (p.kind === "text") this.socket.write(Buffer.from(p.text + this.terminator, "latin1"));
    else if (p.kind === "bytes") this.socket.write(p.bytes);
    else throw new Error(`TCP can't send ${p.kind} payloads`);
    this.log("tx", describe(p));
    return undefined;
  }
}
