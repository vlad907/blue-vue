import type { Config } from "../config.ts";
import { IrQueue, sleep } from "../drivers/ir/transmitter.ts";
import type { StateStore } from "../state.ts";

/**
 * Powers the video wall TVs over IR. Use discrete power-on/off codes, not a
 * power toggle: with a toggle, one TV that missed a code ends up out of sync
 * with the rest of the wall. Codes are repeated for reliability, which is safe
 * only because they are discrete.
 */
export class TvWallController {
  constructor(private cfg: Config, private ir: IrQueue, private state: StateStore) {}

  async power(on: boolean) {
    const t = this.cfg.videoWallTvs;
    const key = on ? t.powerOnKey : t.powerOffKey;

    await this.ir.run(async (send) => {
      for (let r = 0; r < t.repeat; r++) {
        for (const name of t.emitters) {
          await send(this.cfg.emitters[name], t.remote, key);
          // Staggering avoids an inrush spike from every panel powering at once.
          await sleep(t.staggerMs);
        }
      }
    });

    this.state.update((s) => {
      s.wallPower = on ? "on" : "off";
    });
  }
}
