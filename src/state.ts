import { EventEmitter } from "node:events";
import type { AgentView } from "./engine/agents.ts";
import type { DeviceView } from "./engine/device-manager.ts";

export interface SystemState {
  devices: Record<string, DeviceView>;
  agents: Record<string, AgentView>; // wall agents connected over the agent link
  guide: { lastUpdated?: string; error?: string };
  activeScene?: string;
  busy: boolean;
}

/** Holds live system state and emits "change" with the full state whenever it is patched. */
export class StateStore extends EventEmitter {
  state: SystemState = {
    devices: {},
    agents: {},
    guide: {},
    busy: false,
  };

  update(mutator: (s: SystemState) => void) {
    mutator(this.state);
    this.emit("change", this.state);
  }
}
