import { Socket } from "node:net";
import type { Config } from "../config.ts";
import type { StateStore, ZoneState } from "../state.ts";

/**
 * AtlasIED Atmosphere (AZM4/AZM8/AZMP) third-party control.
 * Protocol: JSON-RPC 2.0 over TCP port 5321, one JSON message per line.
 * Methods: set, bump, get, sub, unsub. The DSP pushes "update" messages for
 * subscribed parameters, so the UI stays in sync with wall panels and the
 * Atmosphere web UI.
 */
export interface AtlasDsp {
  start(): void;
  stop(): void;
  setZoneGain(zone: number, db: number): Promise<void>;
  setZoneMute(zone: number, mute: boolean): Promise<void>;
  setZoneSource(zone: number, source: number): Promise<void>;
  recallScene(scene: number): Promise<void>;
}

type ParamValue = number | boolean | string;

abstract class AtlasBase implements AtlasDsp {
  constructor(protected cfg: Config, protected state: StateStore) {}

  abstract start(): void;
  abstract stop(): void;
  protected abstract set(param: string, val: ParamValue): Promise<void>;

  setZoneGain(zone: number, db: number) {
    const { minGainDb, maxGainDb } = this.cfg.atlas;
    return this.set(`ZoneGain_${zone}`, Math.min(maxGainDb, Math.max(minGainDb, db)));
  }
  setZoneMute(zone: number, mute: boolean) {
    return this.set(`ZoneMute_${zone}`, mute ? 1 : 0);
  }
  setZoneSource(zone: number, source: number) {
    return this.set(`ZoneSource_${zone}`, source);
  }
  recallScene(scene: number) {
    return this.set("RecallScene", scene);
  }

  /** Applies a parameter value (from an update or our own set) to the zone state. */
  protected applyParam(param: string, val: ParamValue) {
    const m = /^Zone(Gain|Mute|Source)_(\d+)$/.exec(param);
    if (!m) return;
    const zone = Number(m[2]);
    this.state.update((s) => {
      const z: ZoneState = (s.atlas.zones[zone] ??= {});
      if (m[1] === "Gain") z.gainDb = Number(val);
      else if (m[1] === "Mute") z.mute = val === true || Number(val) === 1;
      else z.source = Number(val);
    });
  }
}

export class AtlasTcpClient extends AtlasBase {
  private socket?: Socket;
  private buffer = "";
  private nextId = 1;
  private reconnectTimer?: NodeJS.Timeout;
  private keepaliveTimer?: NodeJS.Timeout;
  private backoffMs = 1000;
  private stopped = false;

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.keepaliveTimer);
    this.socket?.destroy();
  }

  private connect() {
    const { host, port } = this.cfg.atlas;
    const sock = new Socket();
    this.socket = sock;
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 10_000);

    sock.on("connect", () => {
      console.log(`[atlas] connected ${host}:${port}`);
      this.backoffMs = 1000;
      this.state.update((s) => void (s.atlas.connected = true));
      this.subscribeAll();
      // Atmosphere drops idle connections; a periodic get keeps the session alive.
      this.keepaliveTimer = setInterval(() => this.send("get", { param: "ZoneGain_0" }), 30_000);
    });
    sock.on("data", (chunk) => this.onData(chunk.toString("utf8")));
    sock.on("error", (err) => console.warn(`[atlas] ${err.message}`));
    sock.on("close", () => {
      clearInterval(this.keepaliveTimer);
      this.state.update((s) => void (s.atlas.connected = false));
      if (this.stopped) return;
      console.warn(`[atlas] disconnected, retrying in ${this.backoffMs}ms`);
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });

    sock.connect(port, host);
  }

  private subscribeAll() {
    for (const { index } of this.cfg.atlas.zones) {
      for (const p of ["ZoneGain", "ZoneMute", "ZoneSource"]) {
        this.send("sub", { param: `${p}_${index}`, fmt: "val" });
      }
    }
  }

  private onData(text: string) {
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.onMessage(line);
    }
  }

  private onMessage(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      console.warn(`[atlas] unparseable message: ${line}`);
      return;
    }
    if (msg.error) {
      console.warn(`[atlas] error: ${JSON.stringify(msg.error)}`);
      return;
    }
    if (msg.method === "update" || msg.result) {
      const params = msg.params ?? msg.result;
      for (const p of Array.isArray(params) ? params : [params]) {
        if (p && typeof p.param === "string" && "val" in p) this.applyParam(p.param, p.val);
      }
    }
  }

  private send(method: string, params: Record<string, unknown>) {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return false;
    this.socket.write(JSON.stringify({ jsonrpc: "2.0", method, params, id: this.nextId++ }) + "\n");
    return true;
  }

  protected async set(param: string, val: ParamValue) {
    if (!this.send("set", { param, val })) throw new Error("Atlas DSP is not connected");
    // Optimistic update; the subscription's update message will confirm or correct it.
    this.applyParam(param, val);
  }
}

export class SimulatedAtlas extends AtlasBase {
  start() {
    this.state.update((s) => {
      s.atlas.connected = true;
      for (const { index } of this.cfg.atlas.zones) s.atlas.zones[index] = { gainDb: -30, mute: false, source: 0 };
    });
  }
  stop() {}
  protected async set(param: string, val: ParamValue) {
    console.log(`[atlas:sim] set ${param} = ${val}`);
    this.applyParam(param, val);
  }
}

export function createAtlas(cfg: Config, state: StateStore): AtlasDsp {
  return cfg.simulate || !cfg.atlas.enabled ? new SimulatedAtlas(cfg, state) : new AtlasTcpClient(cfg, state);
}
