import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Connection, type ConnectionSettings, type RenderedPayload, type TransportConfig, requireSetting } from "../types.ts";
import type { FoundTv } from "../androidtv/scan.ts";

// Apple TVs are controlled through one helper process (bluevue_atv.py, built
// on the pyatv library), started the first time an Apple TV is used. It gets
// one JSON message per line and answers the same way; see the script's header.
// Pairing credentials stay in the helper's own file in the data folder.

/** Where the credentials file lives. The server sets its data folder; the agent its config folder. */
export const appleTvStore = { dir: process.cwd() };
const STORAGE_FILE = "appletv-credentials.json";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The command that runs the helper. BLUEVUE_ATV_HELPER replaces the whole
 * command (JSON list); BLUEVUE_PYTHON only the Python to use. Otherwise the
 * Python packed next to the server's Node, then whatever is on the PATH.
 */
export function helperCommand(): string[] {
  if (process.env.BLUEVUE_ATV_HELPER) return JSON.parse(process.env.BLUEVUE_ATV_HELPER);
  const script = [join(HERE, "bluevue_atv.py"), join(HERE, "appletv", "bluevue_atv.py")].find(existsSync) ?? join(HERE, "bluevue_atv.py");
  const packed = join(dirname(process.execPath), "python", process.platform === "win32" ? "python.exe" : "bin/python3");
  const python = process.env.BLUEVUE_PYTHON ?? (existsSync(packed) ? packed : process.platform === "win32" ? "python" : "python3");
  return [python, script];
}

type Reply = Record<string, unknown> & { id?: number; error?: string };

/** The helper process: started on demand, restarted if it dies. Events: "event" (message), "up". */
class Helper extends EventEmitter {
  private child?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private problem?: string;
  private restartTimer?: NodeJS.Timeout;
  private users = 0;

  /** Connections call this while open, so the helper is kept running (and restarted) for them. */
  retain() {
    this.users++;
    this.start();
  }

  release() {
    this.users = Math.max(0, this.users - 1);
  }

  private start() {
    if (this.child) return;
    clearTimeout(this.restartTimer);
    const [cmd, ...args] = helperCommand();
    const child = spawn(cmd, [...args, "--storage", join(appleTvStore.dir, STORAGE_FILE)], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.problem = undefined;
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let m: Reply & { event?: string };
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.event === "fatal") this.problem = String(m.error);
      else if (m.event === "ready") this.emit("up");
      else if (m.event) this.emit("event", m);
      else if (typeof m.id === "number") {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(m.error));
        else p.resolve(m);
      }
    });
    const gone = (why: string) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.problem ??= why;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(this.problem));
      }
      this.pending.clear();
      this.emit("down", this.problem);
      if (this.users > 0) this.restartTimer = setTimeout(() => this.start(), 15_000);
    };
    child.on("error", (err) =>
      gone((err as NodeJS.ErrnoException).code === "ENOENT" ? `Apple TV control needs Python with the pyatv package, and "${cmd}" wasn't found on this machine` : `The Apple TV helper couldn't start: ${err.message}`),
    );
    child.on("exit", (code) => gone(`The Apple TV helper stopped (exit ${code})${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""}`));
  }

  request(msg: Record<string, unknown>, timeoutMs = 20_000): Promise<Reply> {
    this.start();
    const child = this.child;
    if (!child?.stdin?.writable) return Promise.reject(new Error(this.problem ?? "The Apple TV helper isn't running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The Apple TV helper didn't answer in time"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(JSON.stringify({ id, ...msg }) + "\n");
    });
  }

  /** For tests and shutdown. */
  stop() {
    clearTimeout(this.restartTimer);
    this.users = 0;
    const child = this.child;
    this.child = undefined;
    child?.stdin?.end();
    child?.kill();
  }
}

export const helper = new Helper();
helper.setMaxListeners(0);

/**
 * One Apple TV. The helper keeps the session up and reports power, the app in
 * front and what's playing as small JSON messages ("data") that the profile's
 * feedback rules read: {"power":true}, {"app":"Netflix"}, {"paired":false}...
 */
export class AppleTvConnection extends Connection {
  host: string;
  private opened = false;
  private onEvent = (m: { event: string; host?: string; online?: boolean; data?: unknown; level?: string; text?: string }) => {
    if (m.host !== this.host) return;
    if (m.event === "status") this.setOnline(m.online === true);
    else if (m.event === "data") this.emit("data", JSON.stringify(m.data));
    else if (m.event === "log") this.log(m.level === "error" ? "error" : "info", String(m.text));
  };
  private onUp = () => this.register();
  private onDown = (why: string) => {
    this.setOnline(false);
    this.log("error", why);
  };

  constructor(_cfg: TransportConfig, settings: ConnectionSettings) {
    super();
    this.host = requireSetting(settings.host, "host");
  }

  open() {
    this.opened = true;
    helper.on("event", this.onEvent);
    helper.on("up", this.onUp);
    helper.on("down", this.onDown);
    helper.retain();
    this.register();
  }

  private register() {
    if (!this.opened) return;
    helper.request({ op: "open", host: this.host }).catch((err) => this.log("error", err.message));
  }

  close() {
    if (!this.opened) return;
    this.opened = false;
    helper.off("event", this.onEvent);
    helper.off("up", this.onUp);
    helper.off("down", this.onDown);
    helper.request({ op: "close", host: this.host }).catch(() => {});
    helper.release();
    this.setOnline(false);
  }

  async send(p: RenderedPayload) {
    if (p.kind !== "appletv") throw new Error(`Apple TV can't send ${p.kind} payloads`);
    const what = p.power ? { power: p.power } : p.app ? { app: p.app } : { key: p.key };
    this.log("tx", p.power ? `power ${p.power}` : p.app ? `open ${p.app}` : `key ${p.key}`);
    const { id: _id, ok: _ok, ...reply } = await helper.request({ op: "send", host: this.host, ...what }, 25_000);
    return Object.keys(reply).length ? JSON.stringify(reply) : undefined;
  }
}

export interface PairResult {
  /** True once nothing more is needed. False while a code is on screen. */
  done: boolean;
  /** The Apple TV is showing another code (pairing has two steps). */
  more?: boolean;
  message?: string;
}

/** One pairing step, as the admin drives it. In simulation nothing is sent. */
export async function pairAppleTv(host: string, step: "start" | "finish" | "cancel", code = "", simulate = false): Promise<PairResult> {
  if (simulate) {
    if (step === "finish" && !/^\d{4}$/.test(code.trim())) throw new Error("The code is the 4 digits shown on the Apple TV");
    return { done: step !== "start" };
  }
  const r = await helper.request({ op: "pair", host, step, code }, 30_000);
  return { done: r.done !== false, more: r.more === true, message: typeof r.message === "string" ? r.message : undefined };
}

/** Finds Apple TVs: by asking every address of the given networks, or the whole local network when none is given. */
export async function scanAppleTvs(subnets?: string[]): Promise<FoundTv[]> {
  for (const s of subnets ?? []) if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s)) throw new Error(`"${s}" isn't a network like 192.168.1`);
  const hosts = subnets?.flatMap((s) => Array.from({ length: 254 }, (_, i) => `${s}.${i + 1}`));
  const r = await helper.request({ op: "scan", hosts, timeout: 6 }, 40_000);
  const found = (r.found as { host: string; name?: string; model?: string; mac?: string }[]) ?? [];
  return found.map((t) => ({ host: t.host, name: t.name || undefined, model: t.model || undefined, mac: t.mac || undefined }));
}
