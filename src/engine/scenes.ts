import type { StateStore } from "../state.ts";
import type { DeviceManager } from "./device-manager.ts";
import type { Site } from "./site.ts";

export interface SceneResult {
  scene: string;
  ok: boolean;
  errors: string[];
}

/**
 * Runs scenes built in the admin UI. A failing step is logged and skipped, so
 * one offline device doesn't stop the wall turning on or the boxes tuning.
 */
export class EngineSceneRunner {
  private running = false;

  constructor(private getSite: () => Site, private devices: DeviceManager, private state: StateStore) {}

  async run(id: string): Promise<SceneResult> {
    const scene = this.getSite().scenes.find((s) => s.id === id);
    if (!scene) throw new Error(`Unknown scene "${id}"`);
    if (this.running) throw new Error("Another scene is already running");

    this.running = true;
    this.state.update((s) => void (s.busy = true));
    const errors: string[] = [];
    try {
      for (const [i, step] of scene.steps.entries()) {
        try {
          if (step.type === "delay") {
            await new Promise((r) => setTimeout(r, step.ms));
          } else if (step.type === "command") {
            if (step.group) await this.devices.executeGroup(step.group, step.command, step.params);
            else await this.devices.execute(step.device!, step.command, step.params);
          } else {
            await this.waitFor(step.device, step.state, step.equals, step.timeoutMs);
          }
        } catch (err) {
          const msg = `step ${i + 1} (${step.type}): ${err instanceof Error ? err.message : err}`;
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

  private waitFor(device: string, key: string, equals: unknown, timeoutMs: number) {
    const matches = () => String(this.state.state.devices[device]?.state[key]) === String(equals);
    if (matches()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onChange = () => {
        if (!matches()) return;
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${device} ${key} = ${equals}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.state.off("change", onChange);
      };
      this.state.on("change", onChange);
    });
  }
}
