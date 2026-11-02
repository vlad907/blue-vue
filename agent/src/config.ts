import { readFileSync } from "node:fs";

export interface AppConfig {
  name: string; // shown in the control panel, e.g. "Mosaic"
  process: string; // image name, e.g. "MosaicWall.exe"
  task: string; // scheduled task that launches it as the wall user
  autoRestart: boolean;
}

export interface IrConfig {
  driver: "globalcache" | "command" | "simulated";
  host?: string; // globalcache
  module?: number; // globalcache module address, 1 on iTach IP2IR
  command?: string; // command: executable for a USB blaster CLI
  args?: string[]; // command: placeholders {port} {pronto} {freq} {remote} {key}
}

export interface AgentConfig {
  name: string;
  port: number;
  token: string;
  simulate: boolean;
  pollSeconds: number;
  // Used by the commissioning commands (learn/send) only; devices are driven by the server.
  ir: IrConfig;
  // Learned Pronto codes: codes[remote][key]. Copy them into a custom profile's irCodes.
  codes: Record<string, Record<string, string>>;
  apps: AppConfig[];
  // Outbound link to the control server, e.g. "ws://10.0.10.5:8080/agent".
  // The agent's `name` is its id and `token` must match the site's entry.
  server?: { url: string };
}

export function loadConfig(path: string): AgentConfig {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const cfg: AgentConfig = {
    name: raw.name,
    port: raw.port ?? 8095,
    token: raw.token,
    simulate: raw.simulate ?? false,
    pollSeconds: raw.pollSeconds ?? 15,
    ir: raw.ir ?? { driver: "simulated" },
    codes: raw.codes ?? {},
    server: raw.server,
    apps: (raw.apps ?? []).map((a: any) => ({ task: "BlueVueMosaic", autoRestart: true, ...a })),
  };
  if (process.env.BLUEVUE_SIMULATE === "1") cfg.simulate = true;

  const errors: string[] = [];
  if (!cfg.name) errors.push("name is required");
  if (!cfg.token || cfg.token.length < 16) errors.push("token is required (16+ characters)");
  if (!["globalcache", "command", "simulated"].includes(cfg.ir.driver)) errors.push(`ir.driver "${cfg.ir.driver}" is invalid`);
  if (cfg.ir.driver === "globalcache" && !cfg.ir.host && !cfg.simulate) errors.push("ir.host is required for globalcache");
  if (cfg.ir.driver === "command" && !cfg.ir.command && !cfg.simulate) errors.push("ir.command is required for the command driver");

  if (raw.panels?.length) console.warn("agent.json: \"panels\" is no longer used; panels are devices in the control server's site now");
  if (cfg.server && !/^wss?:\/\/.+/.test(cfg.server.url ?? "")) errors.push("server.url must look like ws://control-server:8080/agent");
  for (const a of cfg.apps) {
    if (!a.name || !a.process) errors.push("each app needs name and process");
  }
  if (errors.length) throw new Error("Agent config errors:\n  " + errors.join("\n  "));
  return cfg;
}
