import { loadConfig } from "./config.ts";
import { ensureSite } from "./engine/bootstrap.ts";
import { startEngine } from "./engine/index.ts";
import { GracenoteGuide } from "./guide/gracenote.ts";
import { buildServer } from "./server.ts";
import { StateStore } from "./state.ts";

// Secrets (GRACENOTE_API_KEY) can live in a .env file next to package.json.
try {
  process.loadEnvFile();
} catch {}

const cfg = loadConfig(process.argv[2]);
const state = new StateStore();
state.setMaxListeners(200); // one listener per connected panel

ensureSite(cfg.dataDir, cfg.file);
const engine = startEngine(cfg.dataDir, state, cfg.simulate);
const guide = new GracenoteGuide(cfg, state, () => engine.site().channels);
guide.start();

const app = await buildServer({ cfg, state, engine, guide });
await app.listen({ host: cfg.server.host, port: cfg.server.port });
console.log(`[server] ${engine.site().name} control panel at http://localhost:${cfg.server.port}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    engine.stop();
    guide.stop();
    await app.close();
    process.exit(0);
  });
}
