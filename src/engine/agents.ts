import { timingSafeEqual } from "node:crypto";
import type { WebSocket } from "ws";
import type { AgentAppStatus, AgentToServer, ServerToAgent } from "../../agent/src/link-protocol.ts";
import { toWire } from "../../agent/src/link.ts";
import { Connection, type RenderedPayload, type TransportConfig } from "../../agent/src/transports/index.ts";
import type { StateStore } from "../state.ts";

export interface AgentView {
  name: string;
  online: boolean;
  paired: boolean; // false: an agent connected with an id or token the site doesn't know
  host?: string;
  version?: string;
  apps: AgentAppStatus[];
  uptimeSec?: number;
  lastSeen?: string;
  error?: string;
}

interface AgentEntry {
  id: string;
  name: string;
  token?: string;
}

const HELLO_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 12_000;

/**
 * Accepts wall agents' outbound WebSockets and relays device connections
 * through them. Devices whose location is an agent get a RemoteConnection,
 * which behaves like a local one: it goes offline when the agent drops and is
 * re-opened automatically when the agent reconnects.
 */
export class AgentHub {
  private sockets = new Map<string, WebSocket>();
  private remotes = new Map<string, RemoteConnection>();
  private pending = new Map<number, { agent: string; resolve: (text?: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private nextReq = 1;
  private nextConn = 1;

  constructor(private getAgents: () => AgentEntry[], private state: StateStore) {
    this.syncViews();
  }

  /** Keeps state.agents in step with the site's agent list (call after site edits). */
  syncViews() {
    const agents = this.getAgents();
    this.state.update((s) => {
      for (const a of agents) {
        s.agents[a.id] = { ...(s.agents[a.id] ?? { online: false, apps: [] }), name: a.name, paired: true };
      }
      for (const id of Object.keys(s.agents)) {
        if (!agents.some((a) => a.id === id) && s.agents[id].paired) delete s.agents[id];
      }
    });
    // A changed or removed token must not keep an old session alive.
    for (const [id, ws] of this.sockets) {
      const entry = agents.find((a) => a.id === id);
      if (!entry?.token) ws.close(4001, "agent removed or token changed");
    }
  }

  accept(ws: WebSocket) {
    let id: string | undefined;
    const helloTimer = setTimeout(() => ws.close(4001, "no hello"), HELLO_TIMEOUT_MS);

    ws.on("message", (data) => {
      let msg: AgentToServer;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!id) {
        if (msg.type !== "hello") return ws.close(4001, "expected hello");
        clearTimeout(helloTimer);
        const entry = this.getAgents().find((a) => a.id === msg.id);
        if (!entry?.token || !sameToken(entry.token, msg.token)) {
          console.warn(`[agents] rejected agent "${msg.id}" from ${msg.host}: ${entry ? "wrong token" : "not in the site"}`);
          this.state.update((s) => {
            if (!s.agents[msg.id]) s.agents[msg.id] = { name: msg.id, online: false, paired: false, apps: [] };
            Object.assign(s.agents[msg.id], { host: msg.host, version: msg.version, lastSeen: new Date().toISOString(), error: entry ? "wrong token" : "not paired" });
          });
          return ws.close(4001, entry ? "wrong token" : "unknown agent");
        }
        id = msg.id;
        this.onHello(id, ws, msg.host, msg.version);
        return;
      }
      this.onMessage(id, msg);
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (id && this.sockets.get(id) === ws) this.onGone(id);
    });
    ws.on("error", () => {});
  }

  private onHello(id: string, ws: WebSocket, host: string, version: string) {
    this.sockets.get(id)?.close(4000, "replaced by a new connection");
    this.sockets.set(id, ws);
    this.sendTo(id, { type: "welcome" });
    console.log(`[agents] ${id} connected from ${host}`);
    this.state.update((s) => {
      s.agents[id] = { ...s.agents[id], online: true, host, version, lastSeen: new Date().toISOString(), error: undefined };
    });
    for (const r of this.remotes.values()) if (r.agent === id) this.openRemote(r);
  }

  private onGone(id: string) {
    this.sockets.delete(id);
    console.warn(`[agents] ${id} disconnected`);
    this.state.update((s) => void (s.agents[id] && (s.agents[id].online = false)));
    for (const r of this.remotes.values()) if (r.agent === id) r.remoteStatus(false);
    for (const [reqId, p] of this.pending) {
      if (p.agent !== id) continue;
      clearTimeout(p.timer);
      this.pending.delete(reqId);
      p.reject(new Error(`wall agent "${id}" disconnected`));
    }
  }

  private onMessage(id: string, msg: AgentToServer) {
    switch (msg.type) {
      case "status":
        this.state.update((s) => {
          Object.assign(s.agents[id], { apps: msg.apps, uptimeSec: msg.uptimeSec, lastSeen: new Date().toISOString() });
        });
        break;
      case "conn.status":
        this.remotes.get(msg.connId)?.remoteStatus(msg.online);
        break;
      case "conn.data":
        this.remotes.get(msg.connId)?.remoteData(msg.message);
        break;
      case "conn.log":
        this.remotes.get(msg.connId)?.remoteLog(msg.dir, msg.text);
        break;
      case "reply": {
        const p = this.pending.get(msg.reqId);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.reqId);
        if (msg.ok) p.resolve(msg.text);
        else p.reject(new Error(msg.error));
        break;
      }
    }
  }

  /** A connection to a device reached through the given agent. */
  connection(agent: string, transport: TransportConfig, settings: Record<string, unknown>): Connection {
    return new RemoteConnection(this, agent, `c${this.nextConn++}`, transport, settings);
  }

  register(r: RemoteConnection) {
    this.remotes.set(r.connId, r);
    if (this.sockets.has(r.agent)) this.openRemote(r);
    else r.remoteLog("info", `waiting for wall agent "${r.agent}" to connect`);
  }

  unregister(r: RemoteConnection) {
    this.remotes.delete(r.connId);
    if (this.sockets.has(r.agent)) this.sendTo(r.agent, { type: "conn.close", connId: r.connId });
  }

  private openRemote(r: RemoteConnection) {
    this.sendTo(r.agent, { type: "conn.open", connId: r.connId, transport: r.transport, settings: r.settings });
  }

  request(agent: string, build: (reqId: number) => ServerToAgent): Promise<string | undefined> {
    if (!this.sockets.has(agent)) return Promise.reject(Object.assign(new Error(`wall agent "${agent}" is offline`), { statusCode: 503 }));
    const reqId = this.nextReq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`wall agent "${agent}" didn't answer`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(reqId, { agent, resolve, reject, timer });
      this.sendTo(agent, build(reqId));
    });
  }

  async restartApp(agent: string, name: string) {
    await this.request(agent, (reqId) => ({ type: "app.restart", reqId, name }));
  }

  isOnline(agent: string) {
    return this.sockets.has(agent);
  }

  close() {
    for (const ws of this.sockets.values()) ws.close(1001, "server stopping");
  }

  private sendTo(agent: string, msg: ServerToAgent) {
    const ws = this.sockets.get(agent);
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}

export class RemoteConnection extends Connection {
  constructor(
    private hub: AgentHub,
    readonly agent: string,
    readonly connId: string,
    readonly transport: TransportConfig,
    readonly settings: Record<string, unknown>,
  ) {
    super();
  }

  open() {
    this.hub.register(this);
  }

  close() {
    this.hub.unregister(this);
    this.setOnline(false);
  }

  send(payload: RenderedPayload) {
    return this.hub.request(this.agent, (reqId) => ({ type: "conn.send", connId: this.connId, reqId, payload: toWire(payload) }));
  }

  remoteStatus(online: boolean) {
    this.setOnline(online);
  }
  remoteData(message: string) {
    this.emit("data", message);
  }
  remoteLog(dir: "tx" | "rx" | "info" | "error", text: string) {
    this.log(dir, `[${this.agent}] ${text}`);
  }
}

function sameToken(a: string, b: unknown) {
  const x = Buffer.from(a);
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}
