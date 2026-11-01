import type { Config, SceneStep } from "./config.ts";
import type { CableBoxController } from "./devices/cableBox.ts";
import type { TvWallController } from "./devices/tvWall.ts";
import type { AtlasDsp } from "./drivers/atlas.ts";
import type { VideoWallController } from "./drivers/videoWall.ts";
import { sleep } from "./drivers/ir/transmitter.ts";
import type { StateStore } from "./state.ts";

export interface Devices {
  boxes: CableBoxController;
  tvWall: TvWallController;
  atlas: AtlasDsp;
  videoWall: VideoWallController;
}

export interface SceneResult {
  scene: string;
  ok: boolean;
  errors: string[];
}

/**
 * Runs a scene's steps in order. A failing step is logged and skipped rather
 * than aborting: if the DSP is offline you still want the wall on and the
 * boxes tuned.
 */
export class SceneRunner {
  private running = false;

  constructor(private cfg: Config, private devices: Devices, private state: StateStore) {}

  async run(id: string): Promise<SceneResult> {
    const scene = this.cfg.scenes.find((s) => s.id === id);
    if (!scene) throw new Error(`Unknown scene "${id}"`);
    if (this.running) throw new Error("Another scene is already running");

    this.running = true;
    this.state.update((s) => void (s.busy = true));
    const errors: string[] = [];
    try {
      for (const step of scene.steps) {
        try {
          await this.runStep(step);
        } catch (err) {
          const msg = `${step.type}: ${err instanceof Error ? err.message : err}`;
          console.warn(`[scene ${id}] ${msg}`);
          errors.push(msg);
        }
      }
    } finally {
      this.running = false;
      this.state.update((s) => {
        s.busy = false;
        s.activeScene = id;
      });
    }
    return { scene: id, ok: errors.length === 0, errors };
  }

  private runStep(step: SceneStep): Promise<void> {
    const d = this.devices;
    switch (step.type) {
      case "wallPower": return d.tvWall.power(step.on);
      case "wallPreset": return d.videoWall.recallPreset(step.preset);
      case "tune": return d.boxes.tune(step.box, step.channel);
      case "boxKey": return d.boxes.key(step.box, step.key);
      case "zoneSource": return d.atlas.setZoneSource(step.zone, step.source);
      case "zoneGain": return d.atlas.setZoneGain(step.zone, step.db);
      case "zoneMute": return d.atlas.setZoneMute(step.zone, step.mute);
      case "atlasScene": return d.atlas.recallScene(step.scene);
      case "delay": return sleep(step.ms);
    }
  }
}
