import { loadConfig } from "./config.ts";
import { CableBoxController } from "./devices/cableBox.ts";
import { TvWallController } from "./devices/tvWall.ts";
import { createAtlas } from "./drivers/atlas.ts";
import { IrQueue, createTransmitter } from "./drivers/ir/transmitter.ts";
import { createVideoWall } from "./drivers/videoWall.ts";
import { GracenoteGuide } from "./guide/gracenote.ts";
import { SceneRunner } from "./scenes.ts";
import { buildServer } from "./server.ts";
import { StateStore } from "./state.ts";

const cfg = loadConfig(process.argv[2]);
const state = new StateStore();
state.setMaxListeners(100); // one listener per connected panel

const ir = new IrQueue(createTransmitter(cfg), cfg.ir.commandGapMs);
const devices = {
  boxes: new CableBoxController(cfg, ir, state),
  tvWall: new TvWallController(cfg, ir, state),
  atlas: createAtlas(cfg, state),
  videoWall: createVideoWall(cfg, state),
};
const scenes = new SceneRunner(cfg, devices, state);
const guide = new GracenoteGuide(cfg, state);

devices.atlas.start();
guide.start();

const app = await buildServer({ cfg, state, devices, scenes, guide });
await app.listen({ host: cfg.server.host, port: cfg.server.port });
console.log(`[server] ${cfg.site} control panel at http://localhost:${cfg.server.port}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    devices.atlas.stop();
    guide.stop();
    await app.close();
    process.exit(0);
  });
}
