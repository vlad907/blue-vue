import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

// An emitter is one physical IR output. Identical Xfinity boxes respond to the
// same codes, so each box needs its own emitter. An emitter is either a port on
// a wall endpoint's IR hardware (`endpoint` + `port`), or a local LIRC output
// (`socket` and/or `transmitters`).
const Emitter = z.object({
  endpoint: z.string().optional(),
  port: z.number().int().positive().optional(),
  socket: z.string().optional(),
  transmitters: z.array(z.number().int().positive()).optional(),
});

// A Windows video wall PC running the Blue Vue agent (agent/).
const Endpoint = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().url(),
  token: z.string().optional(),
  tokenEnv: z.string().optional(),
});

const Channel = z.object({
  number: z.number().int().positive(),
  name: z.string(),
  callSign: z.string().optional(),
  stationId: z.string().optional(), // Gracenote station ID for guide lookups
  logo: z.string().optional(),
  category: z.string().optional(),
});

const CableBox = z.object({
  id: z.string(),
  name: z.string(),
  remote: z.string(), // remote name in lircd.conf
  emitter: z.string(),
  // Key sent after the digits so the box tunes immediately instead of waiting out its timeout.
  enterKey: z.string().nullable().default("KEY_OK"),
  atlasSource: z.number().int().nonnegative().optional(),
  favorites: z.array(z.number().int().positive()).default([]),
});

const SceneStep = z.discriminatedUnion("type", [
  z.object({ type: z.literal("wallPower"), on: z.boolean(), wall: z.string().optional() }),
  z.object({ type: z.literal("wallInput"), input: z.string(), wall: z.string().optional() }),
  z.object({ type: z.literal("wallPreset"), preset: z.string() }),
  z.object({ type: z.literal("tune"), box: z.string(), channel: z.number().int().positive() }),
  z.object({ type: z.literal("boxKey"), box: z.string(), key: z.string() }),
  z.object({ type: z.literal("zoneSource"), zone: z.number().int(), source: z.number().int() }),
  z.object({ type: z.literal("zoneGain"), zone: z.number().int(), db: z.number() }),
  z.object({ type: z.literal("zoneMute"), zone: z.number().int(), mute: z.boolean() }),
  z.object({ type: z.literal("atlasScene"), scene: z.number().int() }),
  z.object({ type: z.literal("delay"), ms: z.number().int().nonnegative() }),
]);
export type SceneStep = z.infer<typeof SceneStep>;

const Scene = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(SceneStep),
});

export const ConfigSchema = z.object({
  site: z.string().default("Blue Vue"),
  server: z.object({ host: z.string().default("0.0.0.0"), port: z.number().int().default(8080) }).default({}),
  simulate: z.boolean().default(false),
  // Holds site.json and custom profiles for the profile-driven engine.
  dataDir: z.string().default("data"),

  ir: z.object({
    driver: z.enum(["lirc", "simulated"]).default("lirc"),
    irsendPath: z.string().default("irsend"),
    defaultSocket: z.string().optional(),
    interDigitDelayMs: z.number().int().default(350),
    commandGapMs: z.number().int().default(120),
  }).default({}),
  emitters: z.record(Emitter),

  endpoints: z.array(Endpoint).default([]),
  endpointPollSeconds: z.number().int().min(2).default(10),

  cableBoxes: z.array(CableBox),
  channels: z.array(Channel),

  atlas: z.object({
    enabled: z.boolean().default(true),
    host: z.string(),
    port: z.number().int().default(5321),
    zones: z.array(z.object({ index: z.number().int(), name: z.string() })),
    sources: z.array(z.object({ index: z.number().int(), name: z.string() })),
    scenes: z.array(z.object({ index: z.number().int(), name: z.string() })).default([]),
    minGainDb: z.number().default(-80),
    maxGainDb: z.number().default(0),
  }),

  videoWall: z.object({
    driver: z.enum(["http", "simulated"]).default("simulated"),
    // Placeholder HTTP settings until the real API schema is available.
    baseUrl: z.string().optional(),
    recallPath: z.string().default("/presets/{id}/recall"),
    method: z.enum(["GET", "POST", "PUT"]).default("POST"),
    headers: z.record(z.string()).default({}),
    presets: z.array(z.object({ id: z.string(), name: z.string(), layout: z.string().optional() })),
  }),

  guide: z.object({
    enabled: z.boolean().default(true),
    baseUrl: z.string().default("http://data.tmsapi.com/v1.1"),
    apiKeyEnv: z.string().default("GRACENOTE_API_KEY"),
    lineupId: z.string().optional(),
    hours: z.number().int().min(1).max(24).default(6),
    refreshMinutes: z.number().int().min(5).default(30),
  }).default({}),

  scenes: z.array(Scene).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(path?: string): Config {
  const candidates = [path, process.env.BLUEVUE_CONFIG, "config/system.local.json", "config/system.json"]
    .filter((p): p is string => !!p)
    .map((p) => resolve(p));
  const file = candidates.find((p) => existsSync(p));
  if (!file) throw new Error(`No config found. Looked in: ${candidates.join(", ")}`);

  const cfg = ConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (process.env.BLUEVUE_SIMULATE === "1") cfg.simulate = true;
  validateRefs(cfg);
  console.log(`[config] loaded ${file}${cfg.simulate ? " (SIMULATION MODE)" : ""}`);
  return cfg;
}

function validateRefs(cfg: Config) {
  const errors: string[] = [];
  const emitters = new Set(Object.keys(cfg.emitters));
  const boxes = new Set(cfg.cableBoxes.map((b) => b.id));
  const presets = new Set(cfg.videoWall.presets.map((p) => p.id));
  const endpoints = new Set(cfg.endpoints.map((e) => e.id));

  for (const b of cfg.cableBoxes) if (!emitters.has(b.emitter)) errors.push(`box ${b.id}: unknown emitter "${b.emitter}"`);
  for (const [name, e] of Object.entries(cfg.emitters)) {
    if (e.endpoint && !endpoints.has(e.endpoint)) errors.push(`emitter ${name}: unknown endpoint "${e.endpoint}"`);
    if (e.endpoint && !e.port) errors.push(`emitter ${name}: port is required with endpoint`);
  }
  for (const e of cfg.endpoints) {
    if (!cfg.simulate && !e.token && !(e.tokenEnv && process.env[e.tokenEnv])) errors.push(`endpoint ${e.id}: no token (set token or tokenEnv)`);
  }

  const boxEmitters = cfg.cableBoxes.map((b) => b.emitter);
  if (new Set(boxEmitters).size !== boxEmitters.length) {
    console.warn("[config] WARNING: multiple cable boxes share an emitter; they will all change channel together");
  }

  for (const s of cfg.scenes) {
    for (const step of s.steps) {
      if ((step.type === "tune" || step.type === "boxKey") && !boxes.has(step.box)) errors.push(`scene ${s.id}: unknown box "${step.box}"`);
      if (step.type === "wallPreset" && !presets.has(step.preset)) errors.push(`scene ${s.id}: unknown wall preset "${step.preset}"`);
      if ((step.type === "wallPower" || step.type === "wallInput") && step.wall && !endpoints.has(step.wall)) errors.push(`scene ${s.id}: unknown wall "${step.wall}"`);
    }
  }
  if (errors.length) throw new Error("Config errors:\n  " + errors.join("\n  "));
}
