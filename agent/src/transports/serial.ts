import { Connection, type ConnectionSettings, type RenderedPayload, type TransportConfig, describe, requireSetting } from "./types.ts";

/**
 * RS-232 / USB serial (COM3 on Windows, /dev/ttyUSB0 on Linux) via the
 * optional `serialport` package. It's loaded on first use so machines without
 * serial devices don't need it: `npm install serialport` in the agent folder.
 */
export class SerialConnection extends Connection {
  path: string;
  baudRate: number;
  terminator: string;
  delimiter: string;
  settings: ConnectionSettings;
  private port?: any;
  private buffer = "";
  private stopped = true;
  private timer?: NodeJS.Timeout;
  private backoffMs = 2000;

  constructor(cfg: TransportConfig, settings: ConnectionSettings) {
    super();
    this.path = requireSetting(settings.serialPort, "serialPort");
    this.baudRate = Number(settings.baudRate ?? cfg.baudRate ?? 9600);
    this.terminator = cfg.terminator ?? "";
    this.delimiter = cfg.delimiter ?? "\n";
    this.settings = settings;
  }

  open() {
    this.stopped = false;
    void this.connect();
  }

  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.port?.isOpen) this.port.close();
    this.setOnline(false);
  }

  private async connect() {
    let SerialPort: any;
    try {
      const pkg = "serialport"; // a variable keeps bundlers and tsc from requiring it
      ({ SerialPort } = await import(pkg));
    } catch {
      this.log("error", "serial support isn't installed: run `npm install serialport` in the agent folder");
      return;
    }
    if (this.stopped) return;
    const port = new SerialPort({
      path: this.path,
      baudRate: this.baudRate,
      dataBits: Number(this.settings.dataBits ?? 8),
      parity: String(this.settings.parity ?? "none"),
      stopBits: Number(this.settings.stopBits ?? 1),
      autoOpen: false,
    });
    this.port = port;
    port.on("data", (chunk: Buffer) => this.onData(chunk.toString("latin1")));
    port.on("error", (err: Error) => this.log("error", err.message));
    port.on("close", () => {
      this.setOnline(false);
      this.retry();
    });
    port.open((err: Error | null) => {
      if (err) {
        this.log("error", `can't open ${this.path}: ${err.message}`);
        return this.retry();
      }
      this.backoffMs = 2000;
      this.log("info", `opened ${this.path} at ${this.baudRate} baud`);
      this.setOnline(true);
    });
  }

  // USB serial adapters come and go; keep trying.
  private retry() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.connect(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
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
    if (this.buffer.length > 64_000) this.buffer = "";
  }

  send(p: RenderedPayload) {
    if (!this.port?.isOpen) return Promise.reject(new Error(`${this.path} is not open`));
    const data = p.kind === "text" ? Buffer.from(p.text + this.terminator, "latin1") : p.kind === "bytes" ? Buffer.from(p.bytes) : undefined;
    if (!data) return Promise.reject(new Error(`Serial can't send ${p.kind} payloads`));
    return new Promise<undefined>((resolve, reject) =>
      this.port.write(data, (err: Error | null) => {
        if (err) return reject(err);
        this.log("tx", describe(p));
        resolve(undefined);
      }),
    );
  }
}
