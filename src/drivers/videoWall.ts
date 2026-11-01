import type { Config } from "../config.ts";
import type { StateStore } from "../state.ts";

/**
 * Video wall processor presets. The HTTP driver is a placeholder built from
 * config (baseUrl + recallPath + method) until the real API schema is ready;
 * swap its internals once that lands. Everything else talks to the interface.
 */
export interface VideoWallController {
  recallPreset(id: string): Promise<void>;
}

abstract class VideoWallBase implements VideoWallController {
  constructor(protected cfg: Config, protected state: StateStore) {}

  protected abstract doRecall(id: string): Promise<void>;

  async recallPreset(id: string) {
    if (!this.cfg.videoWall.presets.some((p) => p.id === id)) throw new Error(`Unknown video wall preset "${id}"`);
    try {
      await this.doRecall(id);
      this.state.update((s) => {
        s.videoWall.activePreset = id;
        s.videoWall.reachable = true;
      });
    } catch (err) {
      this.state.update((s) => void (s.videoWall.reachable = false));
      throw err;
    }
  }
}

export class HttpVideoWall extends VideoWallBase {
  protected async doRecall(id: string) {
    const v = this.cfg.videoWall;
    if (!v.baseUrl) throw new Error("videoWall.baseUrl is not configured");
    const url = v.baseUrl.replace(/\/$/, "") + v.recallPath.replace("{id}", encodeURIComponent(id));
    const res = await fetch(url, { method: v.method, headers: v.headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Video wall returned ${res.status} ${res.statusText}`);
  }
}

export class SimulatedVideoWall extends VideoWallBase {
  protected async doRecall(id: string) {
    console.log(`[videowall:sim] recall preset ${id}`);
  }
}

export function createVideoWall(cfg: Config, state: StateStore): VideoWallController {
  if (cfg.simulate || cfg.videoWall.driver === "simulated") {
    state.update((s) => void (s.videoWall.reachable = true));
    return new SimulatedVideoWall(cfg, state);
  }
  return new HttpVideoWall(cfg, state);
}
