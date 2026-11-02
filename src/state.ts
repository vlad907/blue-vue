import { EventEmitter } from "node:events";
import type { AppStatus, PanelStatus } from "./drivers/endpoints.ts";
import type { AgentView } from "./engine/agents.ts";
import type { DeviceView } from "./engine/device-manager.ts";

export interface ZoneState {
  gainDb?: number;
  mute?: boolean;
  source?: number;
}

export interface WallState {
  name: string;
  online: boolean;
  panels: PanelStatus[];
  apps?: AppStatus[];
  host?: string;
  error?: string;
  lastSeen?: string;
}

export interface SystemState {
  devices: Record<string, DeviceView>; // profile-driven devices (engine)
  agents: Record<string, AgentView>; // wall agents connected over the agent link
  walls: Record<string, WallState>;
  // IR is one-way, so box channels are the last commanded values, not confirmed.
  boxes: Record<string, { channel?: number; lastCommandAt?: string }>;
  atlas: { connected: boolean; zones: Record<number, ZoneState> };
  videoWall: { activePreset?: string; reachable: boolean };
  guide: { lastUpdated?: string; error?: string };
  activeScene?: string;
  busy: boolean;
}

/** Holds live system state and emits "change" with the full state whenever it is patched. */
export class StateStore extends EventEmitter {
  state: SystemState = {
    devices: {},
    agents: {},
    walls: {},
    boxes: {},
    atlas: { connected: false, zones: {} },
    videoWall: { reachable: false },
    guide: {},
    busy: false,
  };

  update(mutator: (s: SystemState) => void) {
    mutator(this.state);
    this.emit("change", this.state);
  }
}
