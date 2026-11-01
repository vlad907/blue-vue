import { readFileSync } from "node:fs";

export type PanelDriverName = "roku" | "adb" | "ir" | "simulated";

export interface PanelConfig {
  id: string;
  name: string;
  driver: PanelDriverName;
  host?: string; // roku, adb
  port?: number; // ir: transmitter output port
  remote?: string; // ir: name in `codes`
  input?: string; // input to select after power-on, e.g. "hdmi1"
}

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
  staggerMs: number;
  pollSeconds: number;
  ir: IrConfig;
  // Pronto hex codes: codes[remote][key] = "0000 006D ..."
  codes: Record<string, Record<string, string>>;
  panels: PanelConfig[];
  apps: AppConfig[];
}

export function loadConfig(path: string): AgentConfig {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const cfg: AgentConfig = {
    name: raw.name,
    port: raw.port ?? 8090,
    token: raw.token,
    simulate: raw.simulate ?? false,
    staggerMs: raw.staggerMs ?? 250,
    pollSeconds: raw.pollSeconds ?? 15,
    ir: raw.ir ?? { driver: "simulated" },
    codes: raw.codes ?? {},
    panels: raw.panels ?? [],
    apps: (raw.apps ?? []).map((a: any) => ({ task: "BlueVueMosaic", autoRestart: true, ...a })),
  };
  if (process.env.BLUEVUE_SIMULATE === "1") cfg.simulate = true;

  const errors: string[] = [];
  if (!cfg.name) errors.push("name is required");
  if (!cfg.token || cfg.token.length < 16) errors.push("token is required (16+ characters)");
  if (!["globalcache", "command", "simulated"].includes(cfg.ir.driver)) errors.push(`ir.driver "${cfg.ir.driver}" is invalid`);
  if (cfg.ir.driver === "globalcache" && !cfg.ir.host && !cfg.simulate) errors.push("ir.host is required for globalcache");
  if (cfg.ir.driver === "command" && !cfg.ir.command && !cfg.simulate) errors.push("ir.command is required for the command driver");

  const ids = new Set<string>();
  for (const p of cfg.panels) {
    if (!p.id || ids.has(p.id)) errors.push(`panel id "${p.id}" is missing or duplicated`);
    ids.add(p.id);
    if (!["roku", "adb", "ir", "simulated"].includes(p.driver)) errors.push(`panel ${p.id}: driver "${p.driver}" is invalid`);
    if ((p.driver === "roku" || p.driver === "adb") && !p.host) errors.push(`panel ${p.id}: host is required`);
    if (p.driver === "ir") {
      if (!p.port) errors.push(`panel ${p.id}: port is required`);
      if (!p.remote || !cfg.codes[p.remote]) errors.push(`panel ${p.id}: remote "${p.remote}" not found in codes`);
    }
  }
  for (const a of cfg.apps) {
    if (!a.name || !a.process) errors.push("each app needs name and process");
  }
  if (errors.length) throw new Error("Agent config errors:\n  " + errors.join("\n  "));
  return cfg;
}
