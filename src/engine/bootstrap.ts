import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { migrate } from "../../scripts/migrate-config.ts";
import { LegacyConfigSchema } from "../../scripts/legacy-config.ts";
import { BUILTIN_PROFILES, ProfileLibrary } from "./profiles.ts";
import { SiteStore } from "./site.ts";

export const EXAMPLE_SITE = resolve(import.meta.dirname, "..", "..", "config", "example-site.json");

/**
 * Creates data/site.json on first start. An install that still has an old
 * system config with devices in it is migrated (wall panels need
 * scripts/migrate-config.ts with the walls' agent.json files); otherwise the
 * example site is copied as a starting point to edit in the admin UI.
 */
export function ensureSite(dataDir: string, configFile: string) {
  const store = new SiteStore(dataDir);
  if (store.exists()) return;

  const raw = JSON.parse(readFileSync(configFile, "utf8"));
  const isLegacy = Array.isArray(raw.cableBoxes) || Array.isArray(raw.endpoints) || raw.atlas;
  if (isLegacy) {
    const { site, profiles, warnings } = migrate(LegacyConfigSchema.parse(raw), {});
    const lib = new ProfileLibrary(BUILTIN_PROFILES, join(dataDir, "profiles")).load();
    for (const p of profiles) lib.saveCustom(p);
    const { errors } = store.save(site);
    if (errors.length) throw new Error(`Couldn't migrate ${configFile}:\n  ${errors.join("\n  ")}`);
    for (const w of warnings) console.warn(`[migrate] ${w}`);
    console.log(`[migrate] created ${store.file} from ${configFile}`);
    return;
  }

  if (!existsSync(EXAMPLE_SITE)) throw new Error(`No site at ${store.file} and no example site to start from`);
  const { errors } = store.save(JSON.parse(readFileSync(EXAMPLE_SITE, "utf8")));
  if (errors.length) throw new Error(`Example site is invalid:\n  ${errors.join("\n  ")}`);
  console.log(`[site] created ${store.file} from the example site; edit it in the admin UI`);
}
