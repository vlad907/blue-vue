import { join } from "node:path";
import { identityStore } from "../../agent/src/transports/androidtv/cert.ts";
import type { StateStore } from "../state.ts";
import { AgentHub } from "./agents.ts";
import { DeviceManager } from "./device-manager.ts";
import { defaultFactory } from "./device-runtime.ts";
import { BUILTIN_PROFILES, ProfileLibrary } from "./profiles.ts";
import { EngineSceneRunner } from "./scenes.ts";
import { type Site, SiteStore } from "./site.ts";

export { BUILTIN_PROFILES };

export interface Engine {
  simulate: boolean;
  profiles: ProfileLibrary;
  store: SiteStore;
  devices: DeviceManager;
  agents: AgentHub;
  scenes: EngineSceneRunner;
  site(): Site;
  /** Applies an already-saved site: restarts only devices that changed. */
  apply(site: Site): void;
  /** Re-reads profile files, then restarts devices whose profile changed. */
  reloadProfiles(): void;
  stop(): void;
}

/** Starts the profile-driven device engine from a data folder holding site.json. */
export function startEngine(dataDir: string, state: StateStore, simulate: boolean): Engine {
  // The Android TV remote certificate for TVs reached from the server.
  identityStore.dir = dataDir;
  const store = new SiteStore(dataDir);
  const profiles = new ProfileLibrary(BUILTIN_PROFILES, join(dataDir, "profiles")).load();
  let site = store.load();
  const agents = new AgentHub(() => site.agents, state, simulate);
  const factory = defaultFactory(simulate, (agent, profile, settings) => agents.connection(agent, profile.transport, settings));
  const devices = new DeviceManager(profiles, state, { simulate, factory });
  devices.apply(site);
  console.log(`[engine] ${site.devices.length} devices from ${store.file}${simulate ? " (simulated)" : ""}`);

  return {
    profiles,
    store,
    devices,
    simulate,
    agents,
    scenes: new EngineSceneRunner(() => site, devices, state),
    site: () => site,
    apply(next) {
      site = next;
      devices.apply(site);
      agents.syncViews();
    },
    reloadProfiles() {
      profiles.load();
      devices.apply(site);
    },
    stop: () => {
      devices.stopAll();
      agents.close();
    },
  };
}
