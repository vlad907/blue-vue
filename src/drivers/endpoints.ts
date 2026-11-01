import type { Config } from "../config.ts";
import type { StateStore } from "../state.ts";

export type Power = "on" | "off" | "unknown";

export interface PanelStatus {
  id: string;
  name: string;
  driver: string;
  power: Power;
  reachable: boolean;
  confirmed: boolean;
  error?: string;
}

export interface CommandResult {
  ok: boolean;
  errors: Record<string, string>;
}

/** One video wall PC running the Blue Vue agent. See agent/README.md for its API. */
export interface Endpoint {
  status(): Promise<{ panels: PanelStatus[] }>;
  power(on: boolean, panels?: string[]): Promise<CommandResult>;
  input(input: string, panels?: string[]): Promise<CommandResult>;
  irSend(port: number, remote: string, key: string): Promise<void>;
}

export class HttpEndpoint implements Endpoint {
  constructor(private url: string, private token: string) {}

  private async call(path: string, body?: unknown, timeoutMs = 5000) {
    const res = await fetch(this.url.replace(/\/$/, "") + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }

  status() {
    return this.call("/status");
  }
  // Power is staggered panel by panel on the agent, so allow time for large walls.
  power(on: boolean, panels?: string[]) {
    return this.call("/panels/power", { on, panels }, 30_000);
  }
  input(input: string, panels?: string[]) {
    return this.call("/panels/input", { input, panels }, 30_000);
  }
  async irSend(port: number, remote: string, key: string) {
    await this.call("/ir/send", { port, remote, key });
  }
}

/** In-process stand-in for an agent with a 2x2 wall of panels. */
export class SimulatedEndpoint implements Endpoint {
  panels: PanelStatus[];

  constructor(private id: string) {
    this.panels = ["r1c1", "r1c2", "r2c1", "r2c2"].map((pid) => ({
      id: pid, name: pid.toUpperCase(), driver: "simulated", power: "off", reachable: true, confirmed: true,
    }));
  }

  async status() {
    return { panels: this.panels.map((p) => ({ ...p })) };
  }
  async power(on: boolean, ids?: string[]) {
    for (const p of this.panels) if (!ids?.length || ids.includes(p.id)) p.power = on ? "on" : "off";
    console.log(`[endpoint:sim] ${this.id} power ${on ? "on" : "off"}${ids?.length ? ` (${ids.join(",")})` : ""}`);
    return { ok: true, errors: {} };
  }
  async input(input: string) {
    console.log(`[endpoint:sim] ${this.id} input ${input}`);
    return { ok: true, errors: {} };
  }
  async irSend(port: number, remote: string, key: string) {
    console.log(`[endpoint:sim] ${this.id} ir port ${port}: ${remote} ${key}`);
  }
}

/** Holds a client per wall endpoint and polls their status into shared state. */
export class EndpointManager {
  readonly endpoints = new Map<string, Endpoint>();
  private timer?: NodeJS.Timeout;

  constructor(private cfg: Config, private state: StateStore) {
    for (const e of cfg.endpoints) {
      const token = e.token ?? (e.tokenEnv ? process.env[e.tokenEnv] : undefined) ?? "";
      this.endpoints.set(e.id, cfg.simulate ? new SimulatedEndpoint(e.id) : new HttpEndpoint(e.url, token));
      state.state.walls[e.id] = { name: e.name, online: false, panels: [] };
    }
  }

  get(id: string): Endpoint {
    const ep = this.endpoints.get(id);
    if (!ep) throw new Error(`Unknown wall endpoint "${id}"`);
    return ep;
  }

  start() {
    void this.pollAll();
    this.timer = setInterval(() => void this.pollAll(), this.cfg.endpointPollSeconds * 1000);
  }

  stop() {
    clearInterval(this.timer);
  }

  async poll(id: string) {
    try {
      const { panels } = await this.get(id).status();
      this.state.update((s) => {
        s.walls[id] = { ...s.walls[id], online: true, panels, error: undefined, lastSeen: new Date().toISOString() };
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (this.state.state.walls[id]?.online) console.warn(`[endpoint] ${id} went offline: ${error}`);
      this.state.update((s) => {
        s.walls[id] = { ...s.walls[id], online: false, error };
      });
    }
  }

  pollAll() {
    return Promise.all([...this.endpoints.keys()].map((id) => this.poll(id)));
  }
}
