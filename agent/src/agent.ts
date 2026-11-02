import { createServer } from "node:http";
import { resolve } from "node:path";
import { AppWatcher, SimulatedProcessControl, windowsProcessControl } from "./apps.ts";
import { COMMANDS, runCli } from "./cli.ts";
import { type AgentConfig, loadConfig } from "./config.ts";
import { AgentLink } from "./link.ts";
import { log } from "./log.ts";

const VERSION = "0.2.0";

/**
 * The wall agent: keeps an outbound link to the control server (which drives
 * this wall's devices through it) and keeps the wall software running. A tiny
 * local /health endpoint lets the installer check it started.
 */
export function createAgent(cfg: AgentConfig) {
  const apps = new AppWatcher(cfg, cfg.simulate ? new SimulatedProcessControl(cfg.apps) : windowsProcessControl);
  const link = cfg.server
    ? new AgentLink({ url: cfg.server.url, id: cfg.name, token: cfg.token, version: VERSION, simulate: cfg.simulate, apps, log })
    : undefined;

  const server = createServer((req, res) => {
    const ok = req.url === "/health";
    res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { ok: true, name: cfg.name, version: VERSION, connected: link?.connected ?? false } : { error: "Not found" }));
  });

  return {
    server,
    apps,
    link,
    start(port = cfg.port) {
      apps.start();
      link?.start();
      // Health is for the local installer only.
      return new Promise<number>((r) => server.listen(port, "127.0.0.1", () => r((server.address() as { port: number }).port)));
    },
    stop() {
      apps.stop();
      link?.stop();
      server.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (process.argv[2] === "--check") {
    try {
      const cfg = loadConfig(resolve(process.argv[3] ?? "agent.json"));
      console.log(`Config OK: ${cfg.name}${cfg.server ? ` -> ${cfg.server.url}` : " (no server.url set)"}`);
      process.exit(0);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }
  if (COMMANDS.includes(process.argv[2])) {
    const configIdx = process.argv.indexOf("--config");
    const configPath = resolve(configIdx > 0 ? process.argv.splice(configIdx, 2)[1] : "agent.json");
    try {
      await runCli(process.argv.slice(2), configPath);
      process.exit(0);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }
  const cfg = loadConfig(resolve(process.argv[2] ?? "agent.json"));
  if (!cfg.server) log("[agent] warning: no server.url in agent.json, so the control server can't reach this wall");
  const agent = createAgent(cfg);
  const port = await agent.start();
  log(`[agent] ${cfg.name} v${VERSION} running (health on 127.0.0.1:${port})${cfg.simulate ? " (SIMULATION)" : ""}`);
  process.on("SIGINT", () => { agent.stop(); process.exit(0); });
  process.on("SIGTERM", () => { agent.stop(); process.exit(0); });
}
