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

  constructor(private profiles: ProfileLibrary, private state: StateStore, private opts: { simulate: boolean; factory?: ConnectionFactory }) {
    this.factory = opts.factory ?? defaultFactory(opts.simulate);
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
    this.state.update((s) => void (s.devices[device.id] = { ...base, state: { ...rt.state } }));
    rt.on("state", (changed) => this.state.update((s) => Object.assign(s.devices[device.id].state, changed)));
    rt.on("status", (online: boolean) => this.state.update((s) => void (s.devices[device.id].online = online)));
    rt.on("log", (entry) => {
      if (entry.dir === "error") this.state.update((s) => void (s.devices[device.id].error = entry.text));
    });
    rt.start();
  }

  private remove(id: string) {
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

  execute(deviceId: string, command: string, params: Record<string, unknown> = {}) {
    return this.runtime(deviceId).execute(command, params);
  }

  /** Runs a command on every device in a group, staggered, and reports failures per device. */
  async executeGroup(groupId: string, command: string, params: Record<string, unknown> = {}) {
    const group = this.site?.groups.find((g) => g.id === groupId);
    if (!group) throw Object.assign(new CommandError(`Unknown group "${groupId}"`), { statusCode: 404 });
    const errors: string[] = [];
    for (const [i, id] of group.devices.entries()) {
      try {
        await this.execute(id, command, params);
      } catch (err) {
        errors.push(`${id}: ${err instanceof Error ? err.message : err}`);
      }
      if (i < group.devices.length - 1) await sleep(group.staggerMs);
    }
    if (errors.length) throw new Error(errors.join("; "));
  }

  /** Uses a standard capability (power, tuner, ...) without knowing the device's own command names. */
  async capability(deviceId: string, cap: keyof Capabilities, action: string, value?: unknown) {
    const rt = this.runtime(deviceId);
    const def = rt.profile.capabilities[cap] as Record<string, string> | undefined;
    if (!def?.[action]) throw new CommandError(`${rt.device.name} doesn't support ${cap}.${action}`);
    const params = def.param !== undefined && value !== undefined ? { [def.param]: value } : {};
    await rt.execute(def[action], params);
  }

  /** Devices whose profile offers a capability, e.g. every tuner for the TV guide. */
  withCapability(cap: keyof Capabilities): string[] {
    return [...this.runtimes.values()].filter((rt) => rt.profile.capabilities[cap]).map((rt) => rt.device.id);
  }
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
