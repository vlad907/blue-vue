import { EventEmitter } from "node:events";
import { type Connection, type RenderedPayload, SimulatedConnection, createConnection } from "../../agent/src/transports/index.ts";
import { applyRules, type StateUpdates } from "./parsers.ts";
import type { Command, Param, ParseRule, Profile, Step } from "./profile-schema.ts";
import { type Context, isTruthy, lookup, render, renderValue } from "./template.ts";

export interface DeviceConfig {
  id: string;
  name: string;
  profile: string;
  location: string;
  room?: string;
  enabled: boolean;
  settings: Record<string, unknown>;
}

export interface LogEntry {
  t: string;
  dir: "tx" | "rx" | "info" | "error";
  text: string;
}

export type ConnectionFactory = (profile: Profile, settings: Record<string, unknown>, location: string) => Connection;

/** A problem with the request (bad params, unknown command), not with the device. */
export class CommandError extends Error {
  statusCode = 400;
}

const MAX_LOG = 300;
const MAX_DEPTH = 5;

/**
 * Runs one device from its profile: renders commands into payloads, sends them
 * through the transport one at a time, and turns replies into state.
 *
 * Events: "state" (updates), "status" (online), "log" (entry).
 */
export class DeviceRuntime extends EventEmitter {
  readonly state: Record<string, unknown> = {};
  readonly log: LogEntry[] = [];
  online = false;
  error?: string;

  private conn: Connection;
  private queue: Promise<unknown> = Promise.resolve();
  private timers: NodeJS.Timeout[] = [];
  private keepaliveTimer?: NodeJS.Timeout;

  // noDelays: skip waits, for previews that render a command without sending it.
  constructor(readonly device: DeviceConfig, readonly profile: Profile, factory: ConnectionFactory, private opts: { noDelays?: boolean } = {}) {
    super();
    this.conn = factory(profile, { ...device.settings }, device.location);
    // Example state is for simulation only; real devices start empty until they report.
    if (this.conn instanceof SimulatedConnection) Object.assign(this.state, structuredClone(profile.simulator.state ?? {}));
    this.conn.on("log", (dir, text) => this.addLog(dir, text));
    this.conn.on("data", (msg: string) => this.applyUpdates(applyRules(this.profile.feedback, msg, this.context())));
    this.conn.on("status", (online: boolean) => this.onStatus(online));
  }

  start() {
    this.conn.open();
    for (const poll of this.profile.polls) {
      const run = () => {
        // Persistent transports only poll while connected; request/response ones poll to find out.
        if (!this.online && !this.isRequestResponse()) return;
        this.runSteps(poll.steps, this.context(), 0, poll.parse).catch((err) => this.addLog("error", `poll: ${err.message}`));
      };
      this.timers.push(setInterval(run, poll.every * 1000));
      setTimeout(run, 200);
    }
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    clearInterval(this.keepaliveTimer);
    this.conn.close();
  }

  /** Runs a named command after validating its params. */
  async execute(name: string, params: Record<string, unknown> = {}, depth = 0) {
    const cmd = this.profile.commands[name];
    if (!cmd) throw new CommandError(`${this.device.name} has no command "${name}"`);
    if (depth > MAX_DEPTH) throw new Error("Commands call each other too deeply");
    const values = validateParams(cmd, params);
    const ctx = { ...this.context(), ...values, params: values };
    await this.runSteps(cmd.steps, ctx, depth, cmd.parse);
    if (cmd.sets) {
      const updates: StateUpdates = {};
      for (const [k, v] of Object.entries(cmd.sets)) updates[render(k, ctx)] = renderValue(v, ctx);
      this.applyUpdates(updates);
    }
  }

  private isRequestResponse() {
    return ["http", "adb"].includes(this.profile.transport.type);
  }

  private context(): Context {
    return { settings: this.device.settings, state: this.state, device: { id: this.device.id, name: this.device.name } };
  }

  private onStatus(online: boolean) {
    this.online = online;
    this.emit("status", online);
    clearInterval(this.keepaliveTimer);
    if (!online) return;
    if (this.profile.onConnect.length) {
      this.runSteps(this.profile.onConnect, this.context(), 0).catch((err) => this.addLog("error", `on connect: ${err.message}`));
    }
    const ka = this.profile.keepalive;
    if (ka) {
      this.keepaliveTimer = setInterval(
        () => this.runSteps(ka.steps, this.context(), 0).catch((err) => this.addLog("error", `keepalive: ${err.message}`)),
        ka.every * 1000,
      );
    }
  }

  private async runSteps(steps: Step[], ctx: Context, depth: number, parse?: ParseRule[]) {
    for (const step of steps) {
      if ("delay" in step) {
        if (!this.opts.noDelays) await sleep(Number(renderValue(String(step.delay), ctx)));
      } else if ("forEachChar" in step) {
        for (const ch of render(step.forEachChar, ctx)) await this.runSteps(step.steps, { ...ctx, item: ch }, depth, parse);
      } else if ("forEach" in step) {
        const list = lookup(ctx, step.forEach);
        if (!Array.isArray(list)) throw new Error(`forEach: "${step.forEach}" is not a list`);
        for (const item of list) await this.runSteps(step.steps, { ...ctx, item }, depth, parse);
      } else if ("command" in step) {
        const params: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(step.params ?? {})) params[k] = typeof v === "string" ? renderValue(v, ctx) : v;
        await this.execute(step.command, params, depth + 1);
      } else {
        const payload = this.renderPayload(step, ctx);
        const times = payload.kind === "ir" ? 1 : (step.repeat ?? 1);
        for (let i = 0; i < times; i++) {
          const reply = await this.enqueue(payload);
          if (reply) {
            const rules = [...(parse ?? []), ...this.profile.feedback];
            this.applyUpdates(applyRules(rules, reply, ctx));
          }
        }
      }
    }
  }

  private renderPayload(step: Exclude<Step, { delay: unknown } | { forEachChar: unknown } | { forEach: unknown } | { command: unknown }>, ctx: Context): RenderedPayload {
    if (step.send !== undefined) return { kind: "text", text: unescape(render(step.send, ctx)) };
    if (step.hex !== undefined) {
      const hex = render(step.hex, ctx).replace(/[^0-9a-f]/gi, "");
      if (hex.length % 2) throw new Error(`Odd number of hex digits: ${hex}`);
      return { kind: "bytes", bytes: Buffer.from(hex, "hex") };
    }
    if (step.http) {
      return {
        kind: "http",
        method: step.http.method,
        path: render(step.http.path, ctx),
        body: step.http.body === undefined ? undefined : render(step.http.body, ctx),
        headers: renderHeaders(step.http.headers, ctx),
      };
    }
    if (step.ir !== undefined) {
      const key = render(step.ir, ctx);
      // In simulation, unlearned codes still "send" so scenes can be tried out before codes are learned.
      const pronto = this.profile.irCodes[key] ?? (this.conn instanceof SimulatedConnection ? "0000 006D 0000 0001 0001 0001" : undefined);
      if (!pronto) throw new Error(`No IR code "${key}" in profile ${this.profile.id}. Learn it in the profile editor.`);
      return { kind: "ir", pronto, repeat: step.repeat ?? 1, label: key };
    }
    if (step.adb !== undefined) return { kind: "adb", args: render(step.adb, ctx).split(/\s+/).filter(Boolean) };
    if (step.androidtv) {
      const a = step.androidtv;
      if (a.power !== undefined) {
        const power = render(a.power, ctx).toLowerCase();
        if (power !== "on" && power !== "off") throw new Error(`androidtv power must be "on" or "off", not "${power}"`);
        return { kind: "androidtv", power };
      }
      if (a.appLink !== undefined) return { kind: "androidtv", appLink: render(a.appLink, ctx) };
      return { kind: "androidtv", key: typeof a.key === "number" ? a.key : render(String(a.key), ctx) };
    }
    return { kind: "wol" };
  }

  /** Sends one payload at a time per device, with the profile's minimum gap. */
  private enqueue(p: RenderedPayload): Promise<string | undefined> {
    const job = this.queue.then(async () => {
      const reply = await this.conn.send(p);
      if (!this.opts.noDelays) await sleep(this.profile.transport.minGapMs);
      return reply;
    });
    this.queue = job.catch(() => {});
    return job;
  }

  private applyUpdates(updates: StateUpdates) {
    const changed: StateUpdates = {};
    for (const [key, raw] of Object.entries(updates)) {
      const value = coerce(this.profile, key, raw);
      if (this.state[key] !== value) {
        this.state[key] = value;
        changed[key] = value;
      }
    }
    if (Object.keys(changed).length) this.emit("state", changed);
  }

  private addLog(dir: LogEntry["dir"], text: string) {
    const entry = { t: new Date().toISOString(), dir, text };
    this.log.push(entry);
    if (this.log.length > MAX_LOG) this.log.shift();
    if (dir === "error") this.error = text;
    this.emit("log", entry);
  }
}

/** Header values are templates (e.g. an API key from settings); headers that render empty are left out. */
function renderHeaders(headers: Record<string, string> | undefined, ctx: Context) {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const value = render(v, ctx);
    if (value) out[k] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Checks and converts command params against the profile's declarations. */
export function validateParams(cmd: Command, input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(cmd.params)) {
    const raw = input[name] ?? p.default;
    if (raw === undefined) throw new CommandError(`Missing parameter "${name}"`);
    out[name] = checkParam(name, p, raw);
  }
  return out;
}

function checkParam(name: string, p: Param, raw: unknown) {
  switch (p.type) {
    case "number":
    case "integer": {
      const n = Number(raw);
      if (Number.isNaN(n)) throw new CommandError(`"${name}" must be a number`);
      if (p.type === "integer" && !Number.isInteger(n)) throw new CommandError(`"${name}" must be a whole number`);
      if ((p.min !== undefined && n < p.min) || (p.max !== undefined && n > p.max)) {
        throw new CommandError(`"${name}" must be between ${p.min ?? "-∞"} and ${p.max ?? "∞"}`);
      }
      return n;
    }
    case "boolean":
      return isTruthy(raw);
    case "enum": {
      const match = p.values?.find((v) => String(v) === String(raw));
      if (match === undefined) throw new CommandError(`"${name}" must be one of ${p.values?.join(", ")}`);
      return match;
    }
    case "string":
      return String(raw);
  }
}

/** Converts a raw parsed value to the state variable's declared type. */
function coerce(profile: Profile, key: string, raw: unknown) {
  const decl = Object.entries(profile.state).find(([pattern]) => matchKey(pattern, key))?.[1];
  if (!decl) return raw;
  if (decl.type === "number") {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (decl.type === "boolean") return isTruthy(raw);
  return raw === undefined || raw === null ? raw : String(raw);
}

function matchKey(pattern: string, key: string) {
  if (pattern === key) return true;
  if (!pattern.includes("*")) return false;
  const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^.]+") + "$");
  return re.test(key);
}

// Lets profiles write "\r", "\n", "\t" and "\x0D" in send strings typed in the editor.
function unescape(s: string) {
  return s.replace(/\\(r|n|t|x[0-9a-fA-F]{2}|\\)/g, (_, c: string) =>
    c === "r" ? "\r" : c === "n" ? "\n" : c === "t" ? "\t" : c === "\\" ? "\\" : String.fromCharCode(parseInt(c.slice(1), 16)),
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms || 0)));

/**
 * Local devices connect directly; devices on a wall agent go through the hub.
 * In simulation every device gets a simulated connection.
 */
export function defaultFactory(simulate: boolean, remote?: (agent: string, profile: Profile, settings: Record<string, unknown>) => Connection): ConnectionFactory {
  return (profile, settings, location) => {
    if (location !== "server" && !simulate) {
      if (!remote) throw new Error("devices on wall agents need the agent hub");
      return remote(location, profile, settings);
    }
    return createConnection(profile.transport, settings, simulate);
  };
}
