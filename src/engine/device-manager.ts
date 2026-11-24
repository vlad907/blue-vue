import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { StateStore } from "../state.ts";
import { CommandError, type ConnectionFactory, type DeviceConfig, DeviceRuntime, defaultFactory } from "./device-runtime.ts";
import type { Capabilities, Profile, SettingField } from "./profile-schema.ts";
import type { ProfileLibrary } from "./profiles.ts";
import type { Site } from "./site.ts";

export interface DeviceView {
  name: string;
  profile: string;
  location: string;
  room?: string;
  online: boolean;
  state: Record<string, unknown>;
  error?: string;
  problem?: string; // config problem that stops the device from running
}

/** How patiently a TV is turned on, and when its input is selected afterwards. */
export interface PowerOnTiming {
  powerOnTries: number;
  powerOnRetryMs: number;
  inputAfterOnMs: number;
  inputAgainMs: number;
  /** After those tries: how long a TV that isn't answering is still tried in the background, and how often. */
  powerOnKeepMs: number;
  powerOnKeepEveryMs: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs every device in the site. `apply` can be called again with an edited
 * site: only devices whose config or profile changed are restarted.
 */
export class DeviceManager {
  private runtimes = new Map<string, DeviceRuntime>();
  private fingerprints = new Map<string, string>();
  private site?: Site;
  private factory: ConnectionFactory;
  private timing: PowerOnTiming;
  /** The input each TV was last switched to through Blue Vue, kept across restarts. */
  private lastInputs: Record<string, { input: string; at: string }> = {};
  /** TVs that didn't answer "on" and are still being tried in the background. */
  private waking = new Map<string, NodeJS.Timeout>();

  constructor(
    private profiles: ProfileLibrary,
    private state: StateStore,
    private opts: { simulate: boolean; factory?: ConnectionFactory; timing?: Partial<PowerOnTiming>; /** Where last inputs are kept. Not kept without it. */ inputsFile?: string },
  ) {
    try {
      if (opts.inputsFile && existsSync(opts.inputsFile)) this.lastInputs = JSON.parse(readFileSync(opts.inputsFile, "utf8").replace(/^\uFEFF/, ""));
    } catch (err) {
      console.error(`[devices] couldn't read ${opts.inputsFile}; starting without remembered inputs: ${err instanceof Error ? err.message : err}`);
    }
    this.factory = opts.factory ?? defaultFactory(opts.simulate);
    // Simulated TVs wake at once, so the panel stays snappy in simulation.
    this.timing = { powerOnTries: 8, powerOnRetryMs: 2500, powerOnKeepMs: 60 * 60_000, powerOnKeepEveryMs: 10_000, inputAfterOnMs: opts.simulate ? 200 : 4000, inputAgainMs: opts.simulate ? 200 : 6000, ...opts.timing };
  }

  apply(site: Site) {
    this.site = site;
    const wanted = new Set(site.devices.map((d) => d.id));

    for (const id of [...this.runtimes.keys()]) {
      if (!wanted.has(id)) this.remove(id);
    }
    this.state.update((s) => {
      for (const id of Object.keys(s.devices)) if (!wanted.has(id)) delete s.devices[id];
    });
    const forgotten = Object.keys(this.lastInputs).filter((id) => !wanted.has(id));
    for (const id of forgotten) delete this.lastInputs[id];
    if (forgotten.length) this.saveInputs();

    for (const device of site.devices) {
      const profile = this.profiles.get(device.profile);
      const fingerprint = JSON.stringify([device, profile ?? null]);
      if (this.fingerprints.get(device.id) === fingerprint) continue;
      this.remove(device.id);
      this.fingerprints.set(device.id, fingerprint);
      this.startDevice(device, profile);
    }
  }

  private startDevice(device: DeviceConfig, profile: Profile | undefined) {
    const base: DeviceView = { name: device.name, profile: device.profile, location: device.location, room: device.room, online: false, state: {} };
    const fail = (problem: string) => this.state.update((s) => void (s.devices[device.id] = { ...base, problem }));

    if (!device.enabled) return fail("disabled");
    if (!profile) return fail(`profile "${device.profile}" is missing or has errors`);
    let settings: Record<string, unknown>;
    try {
      settings = resolveSettings(profile.settings, device.settings);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }

    let rt: DeviceRuntime;
    try {
      rt = new DeviceRuntime({ ...device, settings }, profile, this.factory);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    this.runtimes.set(device.id, rt);
    // A TV that doesn't report its input shows the one it was last switched to, also after a restart.
    const inputKey = (profile.capabilities.source as { state?: string } | undefined)?.state;
    const remembered = this.lastInputs[device.id]?.input;
    if (inputKey && remembered && rt.state[inputKey] === undefined) rt.state[inputKey] = remembered;
    this.state.update((s) => void (s.devices[device.id] = { ...base, state: { ...rt.state } }));
    rt.on("state", (changed) => this.state.update((s) => Object.assign(s.devices[device.id].state, changed)));
    rt.on("status", (online: boolean) =>
      this.state.update((s) => {
        s.devices[device.id].online = online;
        if (online) delete s.devices[device.id].error; // what kept it offline is over
      }),
    );
    rt.on("log", (entry) => {
      if (entry.dir === "error") this.state.update((s) => void (s.devices[device.id].error = entry.text));
    });
    rt.start();
  }

  private remove(id: string) {
    this.stopWaking(id);
    this.runtimes.get(id)?.stop();
    this.runtimes.delete(id);
    this.fingerprints.delete(id);
  }

  stopAll() {
    for (const id of [...this.runtimes.keys()]) this.remove(id);
  }

  runtime(id: string): DeviceRuntime {
    const rt = this.runtimes.get(id);
    if (rt) return rt;
    const problem = this.state.state.devices[id]?.problem;
    if (problem) throw new Error(`Device "${id}" is not running: ${problem}`);
    throw Object.assign(new CommandError(`Unknown device "${id}"`), { statusCode: 404 });
  }

  async execute(deviceId: string, command: string, params: Record<string, unknown> = {}) {
    const rt = this.runtime(deviceId);
    // "On" is the same patient job wherever it comes from: a wall card, a room card, a remote or a scene.
    const power = rt.profile.capabilities.power as { on?: string; off?: string } | undefined;
    if (power?.on === command) return this.powerOn(deviceId, command, params);
    if (power?.off === command) this.stopWaking(deviceId);
    await rt.execute(command, params);
    // Selecting an input, from anywhere (a wall card, a room card, a scene), is what gets remembered.
    const src = rt.profile.capabilities.source as { select?: string; param?: string } | undefined;
    const input = src?.param ? params[src.param] : undefined;
    if (src?.select === command && input !== undefined && input !== "") this.rememberInput(deviceId, String(input));
  }

  /** The input a TV was last switched to through Blue Vue, and when. */
  lastInput(deviceId: string): { input: string; at: string } | undefined {
    return this.lastInputs[deviceId];
  }

  private rememberInput(deviceId: string, input: string) {
    if (this.lastInputs[deviceId]?.input === input) return;
    this.lastInputs[deviceId] = { input, at: new Date().toISOString() };
    this.saveInputs();
  }

  private saveInputs() {
    const file = this.opts.inputsFile;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(this.lastInputs, null, 2) + "\n");
      renameSync(`${file}.tmp`, file); // never a half-written file
    } catch (err) {
      console.error(`[devices] couldn't save ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Runs a command on every device in a group, started one after another, and reports failures per device. */
  async executeGroup(groupId: string, command: string, params: Record<string, unknown> = {}) {
    const group = this.site?.groups.find((g) => g.id === groupId);
    if (!group) throw Object.assign(new CommandError(`Unknown group "${groupId}"`), { statusCode: 404 });
    const devices = staggered(group.devices, group.staggerMs, (id) => this.execute(id, command, params));
    // A scene that turns a wall off or on by its power command takes the wall PC's screens along too.
    const power = this.powerAction(group.devices, command);
    await settle([devices, power ? this.wallScreens(group.mosaic, power === "off") : undefined]);
  }

  /** "on" or "off" when `command` is how these devices are turned on or off. */
  private powerAction(ids: string[], command: string): "on" | "off" | undefined {
    const caps = ids.flatMap((id) => this.runtimes.get(id)?.profile.capabilities.power ?? []);
    if (!caps.length) return command === "power_off" ? "off" : command === "power_on" ? "on" : undefined;
    return caps.some((c) => c.off === command) ? "off" : caps.some((c) => c.on === command) ? "on" : undefined;
  }

  /** Uses a standard capability (power, tuner, ...) without knowing the device's own command names. */
  async capability(deviceId: string, cap: keyof Capabilities, action: string, value?: unknown) {
    const rt = this.runtime(deviceId);
    const def = rt.profile.capabilities[cap] as Record<string, string> | undefined;
    if (!def?.[action]) throw new CommandError(`${rt.device.name} doesn't support ${cap}.${action}`);
    const params = def.param !== undefined && value !== undefined ? { [def.param]: value } : {};
    await this.execute(deviceId, def[action], params);
  }

  /**
   * Turns a TV on, patiently. A TV in standby often drops its connection for a
   * few seconds at a time, so "on" is tried several times. Some (Fire TVs) leave
   * the network for most of each hour while off: one that still isn't answering
   * is tried in the background until it does, and turned on then.
   */
  private async powerOn(deviceId: string, command: string, params: Record<string, unknown>) {
    const rt = this.runtime(deviceId);
    this.stopWaking(deviceId);
    const t = this.timing;
    for (let attempt = 1; ; attempt++) {
      try {
        await rt.execute(command, params);
        break;
      } catch (err) {
        if (err instanceof CommandError) throw err;
        if (attempt < t.powerOnTries) {
          await sleep(t.powerOnRetryMs);
          continue;
        }
        if (t.powerOnKeepMs <= 0) throw err;
        this.keepWaking(deviceId, command, params);
        const minutes = Math.round(t.powerOnKeepMs / 60_000);
        throw new Error(`${rt.device.name} isn't answering (a TV that's off can leave the network for a while). Blue Vue keeps trying for ${minutes >= 1 ? `${minutes} minutes` : "a while"} and turns it on when it answers. ${err instanceof Error ? err.message : err}`);
      }
    }
    await this.selectPowerOnInput(deviceId);
  }

  private keepWaking(deviceId: string, command: string, params: Record<string, unknown>) {
    const until = Date.now() + this.timing.powerOnKeepMs;
    const tick = async () => {
      const rt = this.runtimes.get(deviceId);
      if (!rt || Date.now() > until) return void this.waking.delete(deviceId);
      try {
        await rt.execute(command, params);
      } catch (err) {
        // Turned off, removed or restarted meanwhile: the timer on record is no longer this one.
        if (err instanceof CommandError || this.waking.get(deviceId) !== timer) return;
        timer = setTimeout(tick, this.timing.powerOnKeepEveryMs);
        this.waking.set(deviceId, timer);
        return;
      }
      if (this.waking.get(deviceId) !== timer) return;
      this.waking.delete(deviceId);
      await this.selectPowerOnInput(deviceId).catch(() => {});
    };
    let timer = setTimeout(tick, this.timing.powerOnKeepEveryMs);
    this.waking.set(deviceId, timer);
  }

  private stopWaking(deviceId: string) {
    clearTimeout(this.waking.get(deviceId));
    this.waking.delete(deviceId);
  }

  /**
   * The input a TV should show after it's turned on: the one it was last
   * switched to, so it comes back as it was left. A TV nobody has switched yet
   * uses its own setting, else its wall's.
   */
  powerOnInput(deviceId: string): string | undefined {
    const last = this.lastInputs[deviceId]?.input;
    if (last) return last;
    const own = this.site?.devices.find((d) => d.id === deviceId)?.settings.powerOnInput;
    if (own) return String(own);
    return this.site?.groups.find((g) => g.kind === "wall" && g.powerOnInput && g.devices.includes(deviceId))?.powerOnInput;
  }

  /**
   * After "on": waits for the TV to wake, selects its input, then selects it
   * once more a little later, since a TV that's still starting can miss the first.
   */
  private async selectPowerOnInput(deviceId: string) {
    const input = this.powerOnInput(deviceId);
    const rt = this.runtimes.get(deviceId);
    const src = rt?.profile.capabilities.source as { select?: string; param?: string } | undefined;
    if (!input || !rt || !src?.select || !src.param) return;
    // Sent straight to the TV, not through execute(): this isn't somebody choosing an input, so it
    // isn't remembered, and a TV that's only ever had its wall's default follows a change of that default.
    const select = () => rt.execute(src.select!, { [src.param!]: input });
    await sleep(this.timing.inputAfterOnMs);
    try {
      await select();
    } catch (err) {
      throw new Error(`turned on, but selecting ${input} failed: ${err instanceof Error ? err.message : err}`);
    }
    void sleep(this.timing.inputAgainMs).then(select).catch(() => {});
  }

  /** Uses a capability on every device in a group (e.g. power a wall of mixed TV models), staggered. */
  async groupCapability(groupId: string, cap: keyof Capabilities, action: string, value?: unknown) {
    const group = this.site?.groups.find((g) => g.id === groupId);
    if (!group) throw Object.assign(new CommandError(`Unknown group "${groupId}"`), { statusCode: 404 });
    // The pause is there so a wall doesn't power up all at once; inputs and the rest can go out quickly.
    const gap = cap === "power" ? group.staggerMs : Math.min(group.staggerMs, 50);
    const devices = staggered(group.devices, gap, (id) => this.capability(id, cap, action, value));
    // A wall whose screens hang off a wall PC: its screens go black with "off" and come back with
    // "on", so screens without power control of their own go dark too. The PC keeps running.
    const pc = cap === "power" && (action === "on" || action === "off") ? this.wallScreens(group.mosaic, action === "off") : undefined;
    await settle([devices, pc]);
  }

  /** Every wall off or on, with every screen of every wall PC: the ones no wall is linked to as well. */
  async allWalls(action: "on" | "off") {
    const walls = (this.site?.groups ?? []).filter((g) => g.kind === "wall");
    const jobs = walls.map((g) =>
      this.groupCapability(g.id, "power", action).catch((err) => {
        throw new Error(`${g.name}: ${err instanceof Error ? err.message : err}`);
      }));
    for (const rt of this.runtimes.values()) {
      const def = rt.profile.capabilities.pcScreens;
      if (!def) continue;
      for (const pc of this.wallPcs(rt.device.id)) {
        if (!pc.screens.length) continue;
        jobs.push(this.execute(rt.device.id, action === "off" ? def.black : def.show, { [def.param]: pc.id }).then(() => undefined, (err) => {
          throw new Error(`wall PC ${pc.name}: ${err instanceof Error ? err.message : err}`);
        }));
      }
    }
    await settle(jobs);
  }

  /** The wall PCs a mosaic device reports, each with its screens. */
  private wallPcs(deviceId: string) {
    const state = this.runtimes.get(deviceId)?.state ?? {};
    const list = Array.isArray(state.endpointList) ? (state.endpointList as { id?: unknown; name?: unknown }[]) : [];
    return list.filter((e) => e && e.id !== undefined).map((e) => {
      const screens = state[`endpoints.${e.id}.screens`];
      return { id: String(e.id), name: String(e.name ?? e.id), screens: Array.isArray(screens) ? (screens as { display?: unknown; name?: unknown }[]) : [] };
    });
  }

  /**
   * Switches a linked wall's screens to black, or back. The screens are the ones the mosaic engine
   * names after the wall ("Centre 2x2", or "Centre 2x2 (part 1 of 2x2)" when one picture is spread
   * over several). A wall PC picked in the admin goes black whole instead.
   */
  private async wallScreens(link: { device: string; group: string; pc?: string } | undefined, black: boolean) {
    if (!link) return;
    const rt = this.runtimes.get(link.device);
    const def = rt?.profile.capabilities.pcScreens;
    if (!rt || !def) return;
    const run = (pc: string, command: string, params: Record<string, unknown>) =>
      this.execute(link.device, command, params).catch((err) => {
        throw new Error(`wall PC ${pc}: ${err instanceof Error ? err.message : err}`);
      });
    if (link.pc) return run(link.pc, black ? def.black : def.show, { [def.param]: link.pc });

    const one = black ? def.blackOne : def.showOne;
    const wall = String(rt.state[`groups.${link.group}.name`] ?? "").trim().toLowerCase();
    if (!wall) return;
    const jobs: Promise<unknown>[] = [];
    for (const pc of this.wallPcs(link.device)) {
      const mine = pc.screens.filter((s) => {
        const name = String(s.name ?? "").trim().toLowerCase();
        return name === wall || name.startsWith(`${wall} (part `);
      });
      if (!mine.length) continue;
      if (mine.length === pc.screens.length || !one || !def.screenParam) jobs.push(run(pc.name, black ? def.black : def.show, { [def.param]: pc.id }));
      // One after another: each changes the same PC.
      else jobs.push(mine.reduce((p, s) => p.then(() => run(pc.name, one, { [def.param]: pc.id, [def.screenParam!]: s.display })), Promise.resolve() as Promise<unknown>));
    }
    await settle(jobs);
  }

  /** Devices whose profile offers a capability, e.g. every tuner for the TV guide. */
  withCapability(cap: keyof Capabilities): string[] {
    return [...this.runtimes.values()].filter((rt) => rt.profile.capabilities[cap]).map((rt) => rt.device.id);
  }
}

/**
 * Starts `run` for each device in order, `gapMs` apart, without waiting for
 * each to finish: panels still power up one by one (no inrush all at once),
 * but a 20-panel wall doesn't wait for every TV to confirm before the next.
 * Failures are collected per device.
 */
/** Waits for every job and reports all the failures together. */
async function settle(jobs: (Promise<unknown> | undefined)[]) {
  const results = await Promise.allSettled(jobs);
  const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason instanceof Error ? r.reason.message : String(r.reason)] : []));
  if (errors.length) throw new Error(errors.join("; "));
}

async function staggered(ids: string[], gapMs: number, run: (id: string) => Promise<unknown>) {
  const jobs: Promise<string | undefined>[] = [];
  for (const [i, id] of ids.entries()) {
    if (i > 0) await sleep(gapMs);
    jobs.push(run(id).then(() => undefined, (err) => `${id}: ${err instanceof Error ? err.message : err}`));
  }
  const errors = (await Promise.all(jobs)).filter((e): e is string => !!e);
  if (errors.length) throw new Error(errors.join("; "));
}

/** Applies defaults and checks a device's settings against its profile's fields. */
export function resolveSettings(fields: SettingField[], input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const f of fields) {
    let v = out[f.key] ?? f.default;
    if (v === undefined || v === "") {
      if (f.required) throw new Error(`Setting "${f.label}" is required`);
      continue;
    }
    if (f.type === "number" || f.type === "integer") {
      const n = Number(v);
      if (Number.isNaN(n) || (f.type === "integer" && !Number.isInteger(n))) throw new Error(`Setting "${f.label}" must be a ${f.type}`);
      v = n;
    } else if (f.type === "boolean") {
      v = v === true || v === "true" || v === 1;
    } else if (f.type === "enum" && f.values && !f.values.map(String).includes(String(v))) {
      throw new Error(`Setting "${f.label}" must be one of ${f.values.join(", ")}`);
    } else if (f.type === "list") {
      if (!Array.isArray(v)) throw new Error(`Setting "${f.label}" must be a list`);
      if (f.fields) v = v.map((row) => resolveSettings(f.fields!, row as Record<string, unknown>));
    }
    out[f.key] = v;
  }
  return out;
}
