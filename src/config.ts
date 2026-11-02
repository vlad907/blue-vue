import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

// Server bootstrap settings only. Devices, rooms, walls, scenes and channels
// live in the site (data/site.json), which is edited in the admin UI.
export const ConfigSchema = z.object({
  server: z.object({ host: z.string().default("0.0.0.0"), port: z.number().int().default(8080) }).default({}),
  simulate: z.boolean().default(false),
  dataDir: z.string().default("data"),
  guide: z
    .object({
      enabled: z.boolean().default(true),
      baseUrl: z.string().default("http://data.tmsapi.com/v1.1"),
      apiKeyEnv: z.string().default("GRACENOTE_API_KEY"),
      lineupId: z.string().optional(),
      hours: z.number().int().min(1).max(24).default(6),
      refreshMinutes: z.number().int().min(5).default(30),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema> & { file: string };

export function loadConfig(path?: string): Config {
  const candidates = [path, process.env.BLUEVUE_CONFIG, "config/system.local.json", "config/system.json"]
    .filter((p): p is string => !!p)
    .map((p) => resolve(p));
  const file = candidates.find((p) => existsSync(p));
  if (!file) throw new Error(`No config found. Looked in: ${candidates.join(", ")}`);

  // Older config files also hold devices; those keys are ignored here and read by the first-run migration.
  const cfg = { ...ConfigSchema.parse(JSON.parse(readFileSync(file, "utf8"))), file };
  if (process.env.BLUEVUE_SIMULATE === "1") cfg.simulate = true;
  if (process.env.BLUEVUE_DATA) cfg.dataDir = process.env.BLUEVUE_DATA;
  cfg.dataDir = resolve(cfg.dataDir);
  console.log(`[config] loaded ${file}${cfg.simulate ? " (SIMULATION MODE)" : ""}`);
  return cfg;
}
