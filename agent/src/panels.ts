import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentConfig, PanelConfig } from "./config.ts";
import { type IrService, sleep } from "./ir.ts";
import { log } from "./log.ts";

const execFileAsync = promisify(execFile);

export type Power = "on" | "off" | "unknown";

export interface PanelDriver {
  power(on: boolean): Promise<void>;
  input(input: string): Promise<void>;
  /** Reads real power state where the protocol supports it. */
  query(): Promise<Power>;
  /** True when the driver reports real state; false for one-way IR. */
  readonly confirmable: boolean;
}

const INPUTS = ["hdmi1", "hdmi2", "hdmi3", "hdmi4"];
const checkInput = (input: string) => {
  if (!INPUTS.includes(input)) throw new Error(`Unknown input "${input}" (use ${INPUTS.join(", ")})`);
};

/**
 * TCL Roku TVs via Roku External Control Protocol (HTTP port 8060).
 * On the TV: Settings > System > Power > Fast TV start ON (so it listens
 * while off), and Settings > System > Advanced > Control by mobile apps >
 * Network access = Default or Permissive.
 */
export class RokuPanel implements PanelDriver {
  readonly confirmable = true;
  base: string;

  constructor(host: string) {
    this.base = `http://${host}:8060`;
  }

  private async keypress(key: string) {
    const res = await fetch(`${this.base}/keypress/${key}`, { method: "POST", signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`Roku ${this.base} ${key}: HTTP ${res.status}`);
  }

  power(on: boolean) {
    return this.keypress(on ? "PowerOn" : "PowerOff");
  }

  input(input: string) {
    checkInput(input);
    return this.keypress(`InputHDMI${input.slice(4)}`);
  }

  async query(): Promise<Power> {
    const res = await fetch(`${this.base}/query/device-info`, { signal: AbortSignal.timeout(3000) });
    const xml = await res.text();
    const mode = /<power-mode>([^<]+)<\/power-mode>/.exec(xml)?.[1];
    if (!mode) return "unknown";
    return mode === "PowerOn" ? "on" : "off"; // Off states: DisplayOff, Headless, Ready
  }
}

/**
 * TCL Google TVs via ADB over the network. On the TV enable Developer options
 * and Network debugging, then accept the "Allow USB debugging" prompt the
 * first time the agent connects (tick "Always allow").
 */
export class AdbPanel implements PanelDriver {
  readonly confirmable = true;
  target: string;
  adb: string;

  constructor(host: string, adbPath = "adb") {
    this.target = host.includes(":") ? host : `${host}:5555`;
    this.adb = adbPath;
  }

  private async shell(...args: string[]) {
    await execFileAsync(this.adb, ["connect", this.target], { timeout: 5000 }).catch(() => {});
    const { stdout } = await execFileAsync(this.adb, ["-s", this.target, "shell", ...args], { timeout: 5000 });
    return stdout;
  }

  async power(on: boolean) {
    // WAKEUP/SLEEP are discrete, unlike KEYCODE_POWER which toggles.
    await this.shell("input", "keyevent", on ? "KEYCODE_WAKEUP" : "KEYCODE_SLEEP");
  }

  async input(input: string) {
    checkInput(input);
    await this.shell("input", "keyevent", `KEYCODE_TV_INPUT_HDMI_${input.slice(4)}`);
  }

  async query(): Promise<Power> {
    const out = await this.shell("dumpsys", "power");
    const m = /mWakefulness=(\w+)/.exec(out)?.[1];
    return m === "Awake" ? "on" : m ? "off" : "unknown";
  }
}

/** Any TV over IR. Needs discrete KEY_POWERON / KEY_POWEROFF codes in `codes`. */
export class IrPanel implements PanelDriver {
  readonly confirmable = false;
  ir: IrService;
  port: number;
  remote: string;

  constructor(ir: IrService, port: number, remote: string) {
    this.ir = ir;
    this.port = port;
    this.remote = remote;
  }

  power(on: boolean) {
    // Discrete codes are safe to repeat, which covers a missed first send.
    return this.ir.sendKey(this.port, this.remote, on ? "KEY_POWERON" : "KEY_POWEROFF", 2);
  }

  input(input: string) {
    checkInput(input);
    return this.ir.sendKey(this.port, this.remote, `KEY_${input.toUpperCase()}`);
  }

  async query(): Promise<Power> {
    return "unknown";
  }
}

export class SimulatedPanel implements PanelDriver {
  readonly confirmable = true;
  state: Power = "off";
  id: string;

  constructor(id: string) {
    this.id = id;
  }

  async power(on: boolean) {
    log(`[panel:sim] ${this.id} power ${on ? "on" : "off"}`);
    this.state = on ? "on" : "off";
  }
  async input(input: string) {
    checkInput(input);
    log(`[panel:sim] ${this.id} input ${input}`);
  }
  async query() {
    return this.state;
  }
}

export interface PanelStatus {
  id: string;
  name: string;
  driver: string;
  power: Power;
  reachable: boolean;
  confirmed: boolean;
  error?: string;
}

/** Owns the wall's panels: batches commands across them and caches polled state. */
export class PanelManager {
  cfg: AgentConfig;
  drivers = new Map<string, PanelDriver>();
  status = new Map<string, PanelStatus>();
  private timer?: NodeJS.Timeout;

  constructor(cfg: AgentConfig, ir: IrService) {
    this.cfg = cfg;
    for (const p of cfg.panels) {
      this.drivers.set(p.id, makeDriver(p, ir, cfg.simulate));
      this.status.set(p.id, { id: p.id, name: p.name, driver: p.driver, power: "unknown", reachable: true, confirmed: false });
    }
  }

  start() {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.cfg.pollSeconds * 1000);
  }

  stop() {
    clearInterval(this.timer);
  }

  list(): PanelStatus[] {
    return [...this.status.values()];
  }

  private select(ids?: string[]): PanelConfig[] {
    if (!ids?.length) return this.cfg.panels;
    const unknown = ids.filter((id) => !this.drivers.has(id));
    if (unknown.length) throw new Error(`Unknown panel(s): ${unknown.join(", ")}`);
    return this.cfg.panels.filter((p) => ids.includes(p.id));
  }

  /** Powers panels in sequence with a stagger to avoid a power inrush spike. Returns per-panel errors. */
  async power(on: boolean, ids?: string[]) {
    const errors: Record<string, string> = {};
    const irPortsSent = new Set<number>();

    for (const p of this.select(ids)) {
      // Panels sharing an IR port all receive the same burst; send it once.
      if (p.driver === "ir") {
        if (irPortsSent.has(p.port!)) { this.markCommanded(p.id, on); continue; }
        irPortsSent.add(p.port!);
      }
      try {
        await this.drivers.get(p.id)!.power(on);
        this.markCommanded(p.id, on);
        if (on && p.input) void this.selectInputLater(p);
      } catch (err) {
        errors[p.id] = err instanceof Error ? err.message : String(err);
        this.patch(p.id, { reachable: false, error: errors[p.id] });
      }
      await sleep(this.cfg.staggerMs);
    }
    // Re-read real state once panels have had time to react.
    setTimeout(() => void this.poll(), 4000);
    return errors;
  }

  async input(input: string, ids?: string[]) {
    const errors: Record<string, string> = {};
    for (const p of this.select(ids)) {
      try {
        await this.drivers.get(p.id)!.input(input);
      } catch (err) {
        errors[p.id] = err instanceof Error ? err.message : String(err);
      }
    }
    return errors;
  }

  // TVs ignore input changes while booting, so wait before switching.
  private async selectInputLater(p: PanelConfig) {
    await sleep(8000);
    await this.drivers.get(p.id)!.input(p.input!).catch((err) => log(`[panel] ${p.id} input ${p.input} failed: ${err.message}`));
  }

  private markCommanded(id: string, on: boolean) {
    this.patch(id, { power: on ? "on" : "off", confirmed: false });
  }

  async poll() {
    await Promise.all(
      this.cfg.panels.map(async (p) => {
        const d = this.drivers.get(p.id)!;
        if (!d.confirmable) return;
        try {
          this.patch(p.id, { power: await d.query(), reachable: true, confirmed: true, error: undefined });
        } catch (err) {
          this.patch(p.id, { reachable: false, confirmed: false, error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
  }

  private patch(id: string, update: Partial<PanelStatus>) {
    this.status.set(id, { ...this.status.get(id)!, ...update });
  }
}

function makeDriver(p: PanelConfig, ir: IrService, simulate: boolean): PanelDriver {
  if (simulate || p.driver === "simulated") return new SimulatedPanel(p.id);
  switch (p.driver) {
    case "roku": return new RokuPanel(p.host!);
    case "adb": return new AdbPanel(p.host!, process.env.ADB_PATH);
    case "ir": return new IrPanel(ir, p.port!, p.remote!);
  }
}
