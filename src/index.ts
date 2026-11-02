import { loadConfig } from "./config.ts";
import { CableBoxController } from "./devices/cableBox.ts";
import { TvWallController } from "./devices/tvWall.ts";
import { createAtlas } from "./drivers/atlas.ts";
import { EndpointManager } from "./drivers/endpoints.ts";
import { IrQueue, createTransmitter } from "./drivers/ir/transmitter.ts";
import { createVideoWall } from "./drivers/videoWall.ts";
import { type Engine, startEngine } from "./engine/index.ts";
import { SiteStore } from "./engine/site.ts";
import { GracenoteGuide } from "./guide/gracenote.ts";
import { SceneRunner } from "./scenes.ts";
import { buildServer } from "./server.ts";
import { StateStore } from "./state.ts";

// Secrets (GRACENOTE_API_KEY, wall tokens) can live in a .env file next to package.json.
try {
  process.loadEnvFile();
} catch {}

const cfg = loadConfig(process.argv[2]);
const state = new StateStore();
state.setMaxListeners(100); // one listener per connected panel

const endpoints = new EndpointManager(cfg, state);
const ir = new IrQueue(createTransmitter(cfg, endpoints), cfg.ir.commandGapMs);
const devices = {
  boxes: new CableBoxController(cfg, ir, state),
  tvWall: new TvWallController(endpoints),
  atlas: createAtlas(cfg, state),
  videoWall: createVideoWall(cfg, state),
};
const scenes = new SceneRunner(cfg, devices, state);
const guide = new GracenoteGuide(cfg, state);

endpoints.start();
devices.atlas.start();
guide.start();

// The profile-driven engine runs once a site has been created (scripts/migrate-config.ts or the admin UI).
let engine: Engine | undefined;
if (new SiteStore(cfg.dataDir).exists()) engine = startEngine(cfg.dataDir, state, cfg.simulate);

const app = await buildServer({ cfg, state, devices, scenes, guide, endpoints, engine });
await app.listen({ host: cfg.server.host, port: cfg.server.port });
console.log(`[server] ${cfg.site} control panel at http://localhost:${cfg.server.port}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    endpoints.stop();
    engine?.stop();
    devices.atlas.stop();
    guide.stop();
    await app.close();
    process.exit(0);
  });
}
