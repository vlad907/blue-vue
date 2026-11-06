// One-time conversion from the original hand-written config to the
// profile-driven site (data/site.json plus custom profiles for learned codes).
//
//   npx tsx scripts/migrate-config.ts [--system config/system.local.json] \
//       [--agent wall1=path/to/wall1/agent.json ...] [--data data] [--force]
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { LegacyConfigSchema, type LegacyConfig } from "./legacy-config.ts";
import { ProfileLibrary } from "../src/engine/profiles.ts";
import { SiteStore, type SceneStep } from "../src/engine/site.ts";

interface AgentFile {
  name: string;
  ir?: { driver: string; host?: string };
  codes?: Record<string, Record<string, string>>;
  panels?: { id: string; name: string; driver: string; host?: string; port?: number; remote?: string; input?: string }[];
}

export function migrate(cfg: LegacyConfig, agents: Record<string, AgentFile>) {
  const warnings: string[] = [];
  const devices: Record<string, unknown>[] = [];
  const groups: Record<string, unknown>[] = [];
  const profiles: Record<string, unknown>[] = [];
  const scenes: { id: string; name: string; description?: string; steps: SceneStep[] }[] = [];

  // Learned codes from any agent become custom profiles extending the built-ins.
  const allCodes: Record<string, Record<string, string>> = {};
  for (const a of Object.values(agents)) for (const [remote, codes] of Object.entries(a.codes ?? {})) {
    allCodes[remote] = { ...allCodes[remote], ...filterPronto(codes) };
  }
  const boxRemotes = new Set(cfg.cableBoxes.map((b) => b.remote));
  const profileFor = (remote: string, base: string) => {
    const codes = allCodes[remote];
    if (!codes || !Object.keys(codes).length) return base;
    const id = `${remote}-codes`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (!profiles.some((p) => p.id === id)) {
      profiles.push({ id, name: `${remote} (learned codes)`, extends: base, irCodes: codes });
    }
    return id;
  };

  if (cfg.atlas.enabled) {
    devices.push({
      id: "atlas", name: "Atlas DSP", profile: "atlas-atmosphere",
      settings: { host: cfg.atlas.host, port: cfg.atlas.port, zones: cfg.atlas.zones, sources: cfg.atlas.sources, scenes: cfg.atlas.scenes },
    });
  }

  for (const box of cfg.cableBoxes) {
    const emitter = cfg.emitters[box.emitter];
    if (!emitter?.endpoint) {
      warnings.push(`box ${box.id}: local LIRC emitters aren't supported by profiles; move its IR to a wall agent's iTach`);
      continue;
    }
    const irHost = agents[emitter.endpoint]?.ir?.host;
    if (!irHost) warnings.push(`box ${box.id}: no agent.json for ${emitter.endpoint}, so the iTach IP is unknown; set it in the admin UI`);
    devices.push({
      id: box.id, name: box.name, profile: profileFor(box.remote, "xfinity-ir"), location: emitter.endpoint,
      settings: { irHost: irHost ?? "", irPort: emitter.port, digitDelayMs: cfg.ir.interDigitDelayMs, favorites: box.favorites },
    });
  }

  for (const ep of cfg.endpoints) {
    const agent = agents[ep.id];
    if (!agent) {
      warnings.push(`wall ${ep.id}: no agent.json given, so its panels weren't migrated (use --agent ${ep.id}=path)`);
      continue;
    }
    const ids: string[] = [];
    for (const p of agent.panels ?? []) {
      const id = `${ep.id}-${p.id}`;
      ids.push(id);
      if (p.driver === "roku" || p.driver === "adb") {
        devices.push({ id, name: `${ep.name} ${p.name}`, profile: p.driver === "roku" ? "tcl-roku-tv" : "tcl-google-tv", location: ep.id, settings: { host: p.host } });
      } else if (p.driver === "ir") {
        if (boxRemotes.has(p.remote!)) warnings.push(`panel ${id}: shares IR remote "${p.remote}" with a cable box`);
        devices.push({ id, name: `${ep.name} ${p.name}`, profile: profileFor(p.remote!, "generic-ir-tv"), location: ep.id, settings: { irHost: agent.ir?.host ?? "", irPort: p.port } });
      } else {
        warnings.push(`panel ${id}: driver "${p.driver}" skipped`);
        ids.pop();
      }
    }
    if (ids.length) groups.push({ id: ep.id, name: ep.name, kind: "wall", devices: ids, staggerMs: 250 });
  }

  const wallGroups = groups.map((g) => g.id as string);
  // The old placeholder video wall driver had no wall groups, so its presets can't be mapped;
  // add the mosaic engine in the admin and rebuild those scene steps there.
  if (cfg.videoWall.driver === "http" && cfg.videoWall.baseUrl) {
    const url = new URL(cfg.videoWall.baseUrl);
    devices.push({ id: "mosaic", name: "Mosaic engine", profile: "mosaic-engine", settings: { host: url.hostname, port: Number(url.port || 8090) } });
    warnings.push("video wall: added the mosaic engine; its old presets had no wall group, so re-add preset steps to scenes in the admin");
  }
  const hasDevice = (id: string) => devices.some((d) => d.id === id);

  for (const s of cfg.scenes) {
    const steps: SceneStep[] = [];
    for (const step of s.steps) {
      switch (step.type) {
        case "wallPower":
        case "wallInput": {
          const targets = step.wall ? [step.wall] : wallGroups;
          for (const group of targets.filter((g) => wallGroups.includes(g))) {
            steps.push(step.type === "wallPower"
              ? { type: "command", group, command: step.on ? "power_on" : "power_off", params: {} }
              : { type: "command", group, command: "input", params: { input: step.input } });
          }
          break;
        }
        case "wallPreset":
          warnings.push(`scene ${s.id}: wall preset "${step.preset}" dropped (re-add it with the mosaic engine's wall and preset)`);
          break;
        case "tune":
        case "boxKey":
          if (!hasDevice(step.box)) break;
          steps.push(step.type === "tune"
            ? { type: "command", device: step.box, command: "tune", params: { channel: step.channel } }
            : { type: "command", device: step.box, command: "key", params: { key: step.key } });
          break;
        case "zoneSource":
          steps.push({ type: "command", device: "atlas", command: "set_source", params: { zone: step.zone, source: step.source } });
          break;
        case "zoneGain":
          steps.push({ type: "command", device: "atlas", command: "set_gain", params: { zone: step.zone, db: step.db } });
          break;
        case "zoneMute":
          steps.push({ type: "command", device: "atlas", command: "set_mute", params: { zone: step.zone, mute: step.mute } });
          break;
        case "atlasScene":
          steps.push({ type: "command", device: "atlas", command: "recall_scene", params: { scene: step.scene } });
          break;
        case "delay":
          steps.push({ type: "delay", ms: step.ms });
          break;
      }
    }
    scenes.push({ id: s.id, name: s.name, description: s.description, steps: steps.filter((st) => st.type !== "command" || !st.device || hasDevice(st.device)) });
  }

  const site = {
    version: 1,
    name: cfg.site,
    rooms: [],
    devices,
    groups,
    scenes,
    channels: cfg.channels,
    agents: cfg.endpoints.map((e) => ({ id: e.id, name: e.name, token: e.token })),
  };
  return { site, profiles, warnings };
}

// Example agent.json files contain "PASTE PRONTO HEX" placeholders; skip them.
function filterPronto(codes: Record<string, string>) {
  return Object.fromEntries(Object.entries(codes).filter(([, v]) => /^0000( [0-9a-fA-F]{4})+$/.test(v.trim())));
}

// Run as a command only when this file itself is the entry point. The name
// check matters in the packaged server, where every module shares one bundle file.
if (import.meta.filename === resolve(process.argv[1] ?? "") && basename(import.meta.filename).startsWith("migrate-config")) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const systemPath = opt("--system") ?? (existsSync("config/system.local.json") ? "config/system.local.json" : "config/system.json");
  const dataDir = opt("--data") ?? "data";
  const agents: Record<string, AgentFile> = {};
  args.forEach((a, i) => {
    if (a !== "--agent") return;
    const [id, path] = args[i + 1].split("=");
    agents[id] = JSON.parse(readFileSync(path, "utf8"));
  });

  const cfg = LegacyConfigSchema.parse(JSON.parse(readFileSync(systemPath, "utf8")));
  const store = new SiteStore(dataDir);
  if (store.exists() && !args.includes("--force")) {
    console.error(`${store.file} already exists. Re-run with --force to overwrite (the current one is kept as a snapshot).`);
    process.exit(1);
  }

  const { site, profiles, warnings } = migrate(cfg, agents);
  const lib = new ProfileLibrary(join(import.meta.dirname, "..", "profiles", "builtin"), join(dataDir, "profiles")).load();
  for (const p of profiles) {
    const errors = lib.saveCustom(p);
    if (errors.length) throw new Error(`profile ${p.id}: ${errors.join("; ")}`);
    console.log(`Saved custom profile ${p.id}`);
  }
  const { errors } = store.save(site);
  if (errors.length) {
    console.error("Migrated site is invalid:\n  " + errors.join("\n  "));
    process.exit(1);
  }
  for (const w of warnings) console.warn(`warning: ${w}`);
  console.log(`Wrote ${store.file}: ${site.devices.length} devices, ${site.groups.length} walls, ${site.scenes.length} scenes`);
}
