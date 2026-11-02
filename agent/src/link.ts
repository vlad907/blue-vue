import { hostname } from "node:os";
import type { AgentToServer, ServerToAgent, WirePayload } from "./link-protocol.ts";
import { type Connection, type RenderedPayload, createConnection } from "./transports/index.ts";

export interface LinkOptions {
  url: string; // ws://control-server:8080/agent
  id: string;
  token: string;
  version: string;
  simulate: boolean;
  /** Reports wall software status; called periodically and after restarts. */
  apps?: { list(): unknown[]; restart(name: string): Promise<void> };
  log?: (msg: string) => void;
}

/**
 * The agent's outbound link to the control server. It hosts the connections
 * the server asks for (a TCP device, a COM port, an iTach) and relays their
 * traffic. It reconnects forever; connections are closed while the link is
 * down and the server re-opens them when the agent comes back.
 */
export class AgentLink {
  private ws?: WebSocket;
  private conns = new Map<string, Connection>();
  private backoffMs = 1000;
  private timer?: NodeJS.Timeout;
  private statusTimer?: NodeJS.Timeout;
  private stopped = false;
  private startedAt = Date.now();
  connected = false;
  opts: LinkOptions;

  constructor(opts: LinkOptions) {
    this.opts = opts;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.statusTimer);
    this.closeAll();
    this.ws?.close();
  }

  private log(msg: string) {
    (this.opts.log ?? console.log)(`[link] ${msg}`);
  }

  private connect() {
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      this.send({ type: "hello", id: this.opts.id, token: this.opts.token, version: this.opts.version, host: hostname() });
    };
    ws.onmessage = (ev) => {
      let msg: ServerToAgent;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      void this.onMessage(msg);
    };
    ws.onerror = () => {}; // followed by onclose
    ws.onclose = (ev) => {
      const wasConnected = this.connected;
      this.connected = false;
      clearInterval(this.statusTimer);
      this.closeAll();
      if (this.stopped) return;
      if (wasConnected || ev.code === 4001) this.log(`disconnected (${ev.code}${ev.reason ? ` ${ev.reason}` : ""}); retrying`);
      // Rejected: wait for an admin to approve this agent, retrying every 10s.
      if (ev.code === 4001) this.backoffMs = 10_000;
      this.timer = setTimeout(() => this.connect(), this.backoffMs);
      if (ev.code !== 4001) this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    };
  }

  private async onMessage(msg: ServerToAgent) {
    switch (msg.type) {
      case "welcome":
        this.connected = true;
        this.backoffMs = 1000;
        this.log(`connected to ${this.opts.url}`);
        this.sendStatus();
        this.statusTimer = setInterval(() => this.sendStatus(), 10_000);
        break;
      case "conn.open":
        this.open(msg.connId, msg.transport, msg.settings);
        break;
      case "conn.close":
        this.conns.get(msg.connId)?.close();
        this.conns.delete(msg.connId);
        break;
      case "conn.send": {
        const conn = this.conns.get(msg.connId);
        try {
          if (!conn) throw new Error("connection is not open on the agent");
          const text = await conn.send(fromWire(msg.payload));
          this.send({ type: "reply", reqId: msg.reqId, ok: true, text });
        } catch (err) {
          this.send({ type: "reply", reqId: msg.reqId, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        break;
      }
      case "app.restart":
        try {
          if (!this.opts.apps) throw new Error("this agent watches no apps");
          await this.opts.apps.restart(msg.name);
          this.send({ type: "reply", reqId: msg.reqId, ok: true });
          this.sendStatus();
        } catch (err) {
          this.send({ type: "reply", reqId: msg.reqId, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        break;
    }
  }

  private open(connId: string, transport: Parameters<typeof createConnection>[0], settings: Record<string, unknown>) {
    this.conns.get(connId)?.close();
    let conn: Connection;
    try {
      conn = createConnection(transport, settings, this.opts.simulate);
    } catch (err) {
      this.send({ type: "conn.log", connId, dir: "error", text: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.conns.set(connId, conn);
    conn.on("status", (online: boolean) => this.send({ type: "conn.status", connId, online }));
    conn.on("data", (message: string) => this.send({ type: "conn.data", connId, message }));
    conn.on("log", (dir, text) => this.send({ type: "conn.log", connId, dir, text }));
    conn.open();
  }

  private closeAll() {
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
  }

  private sendStatus() {
    this.send({ type: "status", apps: (this.opts.apps?.list() ?? []) as never, uptimeSec: Math.round((Date.now() - this.startedAt) / 1000) });
  }

  private send(msg: AgentToServer) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}

export function toWire(p: RenderedPayload): WirePayload {
  return p.kind === "bytes" ? { kind: "bytes", base64: Buffer.from(p.bytes).toString("base64") } : p;
}

export function fromWire(p: WirePayload): RenderedPayload {
  return p.kind === "bytes" ? { kind: "bytes", bytes: Buffer.from(p.base64, "base64") } : p;
}
