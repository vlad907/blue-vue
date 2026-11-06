import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The folder holding web/, profiles/ and config/. From source this file sits
 * in src/; in a packaged build the bundle sits in app/. Either way the root
 * is one level up. BLUEVUE_ROOT overrides it.
 */
export const APP_ROOT = process.env.BLUEVUE_ROOT ?? resolve(import.meta.dirname, "..");

/** The app version, from package.json (copied next to the bundle in builds). */
export const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(resolve(APP_ROOT, "package.json"), "utf8")).version ?? "dev";
  } catch {
    return "dev";
  }
})();
