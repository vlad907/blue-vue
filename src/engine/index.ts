import { join } from "node:path";
import type { StateStore } from "../state.ts";
import { AgentHub } from "./agents.ts";
import { DeviceManager } from "./device-manager.ts";
import { defaultFactory } from "./device-runtime.ts";
import { ProfileLibrary } from "./profiles.ts";
import { EngineSceneRunner } from "./scenes.ts";
import { type Site, SiteStore } from "./site.ts";

export const BUILTIN_PROFILES = join(import.meta.dirname, "..", "..", "profiles", "builtin");

export interface Engine {
  profiles: ProfileLibrary;
  store: SiteStore;
  devices: DeviceManager;
  agents: AgentHub;
  scenes: EngineSceneRunner;
  site(): Site;
  stop(): void;
}

/** Starts the profile-driven device engine from a data folder holding site.json. */
export function startEngine(dataDir: string, state: StateStore, simulate: boolean): Engine {
  const store = new SiteStore(dataDir);
  const profiles = new ProfileLibrary(BUILTIN_PROFILES, join(dataDir, "profiles")).load();
  let site = store.load();
  const agents = new AgentHub(() => site.agents, state);
  const factory = defaultFactory(simulate, (agent, profile, settings) => agents.connection(agent, profile.transport, settings));
  const devices = new DeviceManager(profiles, state, { simulate, factory });
  devices.apply(site);
  console.log(`[engine] ${site.devices.length} devices from ${store.file}${simulate ? " (simulated)" : ""}`);

  return {
    profiles,
    store,
    devices,
    agents,
    scenes: new EngineSceneRunner(() => site, devices, state),
    site: () => site,
    stop: () => {
      devices.stopAll();
      agents.close();
    },
  };
}
