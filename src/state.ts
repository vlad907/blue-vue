import { EventEmitter } from "node:events";

export interface ZoneState {
  gainDb?: number;
  mute?: boolean;
  source?: number;
}

export interface SystemState {
  // IR is one-way, so wall power and box channels are the last commanded values, not confirmed.
  wallPower: "on" | "off" | "unknown";
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
    wallPower: "unknown",
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
