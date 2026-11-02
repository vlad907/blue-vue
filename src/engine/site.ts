import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// The site: everything a technician configures in the admin UI. Device types
// live in profiles; this file holds the instances and how they're arranged.

const Id = z.string().regex(/^[a-zA-Z0-9][\w-]*$/, "letters, numbers, dashes and underscores");

export const DeviceSchema = z.object({
  id: Id,
  name: z.string(),
  profile: z.string(),
  // "server" or the id of a wall agent the device is reached through.
  location: z.string().default("server"),
  room: z.string().optional(),
  enabled: z.boolean().default(true),
  settings: z.record(z.unknown()).default({}),
});

const SceneStep = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("command"),
    device: z.string().optional(),
    group: z.string().optional(),
    command: z.string(),
    params: z.record(z.unknown()).default({}),
  }),
  z.object({ type: z.literal("delay"), ms: z.number().int().nonnegative() }),
  z.object({
    type: z.literal("waitFor"),
    device: z.string(),
    state: z.string(),
    equals: z.union([z.string(), z.number(), z.boolean()]),
    timeoutMs: z.number().int().positive().default(15_000),
  }),
]);
export type SceneStep = z.infer<typeof SceneStep>;

export const SiteSchema = z.object({
  version: z.literal(1).default(1),
  name: z.string().default("Blue Vue"),
  rooms: z.array(z.object({ id: Id, name: z.string() })).default([]),
  devices: z.array(DeviceSchema).default([]),
  groups: z
    .array(z.object({
      id: Id,
      name: z.string(),
      kind: z.enum(["wall", "zone", "other"]).default("other"),
      devices: z.array(z.string()),
      staggerMs: z.number().int().nonnegative().default(250),
    }))
    .default([]),
  scenes: z.array(z.object({ id: Id, name: z.string(), description: z.string().optional(), steps: z.array(SceneStep) })).default([]),
  channels: z
    .array(z.object({
      number: z.number().int().positive(),
      name: z.string(),
      callSign: z.string().optional(),
      stationId: z.string().optional(),
      logo: z.string().optional(),
      category: z.string().optional(),
    }))
    .default([]),
  agents: z.array(z.object({ id: Id, name: z.string(), token: z.string().optional() })).default([]),
});
export type Site = z.infer<typeof SiteSchema>;

/** Cross-references the schema can't check: ids that must exist, unique ids. */
export function checkSite(site: Site): string[] {
  const errors: string[] = [];
  const unique = (what: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) errors.push(`duplicate ${what} id "${id}"`);
      seen.add(id);
    }
  };
  unique("device", site.devices.map((d) => d.id));
  unique("group", site.groups.map((g) => g.id));
  unique("scene", site.scenes.map((s) => s.id));
  unique("room", site.rooms.map((r) => r.id));

  const devices = new Set(site.devices.map((d) => d.id));
  const groups = new Set(site.groups.map((g) => g.id));
  const rooms = new Set(site.rooms.map((r) => r.id));
  const locations = new Set(["server", ...site.agents.map((a) => a.id)]);
  for (const d of site.devices) {
    if (d.room && !rooms.has(d.room)) errors.push(`device ${d.id}: unknown room "${d.room}"`);
    if (!locations.has(d.location)) errors.push(`device ${d.id}: unknown location "${d.location}"`);
  }
  for (const g of site.groups) for (const id of g.devices) if (!devices.has(id)) errors.push(`group ${g.id}: unknown device "${id}"`);
  for (const s of site.scenes) {
    for (const step of s.steps) {
      if (step.type === "command") {
        if (!step.device === !step.group) errors.push(`scene ${s.id}: a command step needs a device or a group`);
        if (step.device && !devices.has(step.device)) errors.push(`scene ${s.id}: unknown device "${step.device}"`);
        if (step.group && !groups.has(step.group)) errors.push(`scene ${s.id}: unknown group "${step.group}"`);
      }
      if (step.type === "waitFor" && !devices.has(step.device)) errors.push(`scene ${s.id}: unknown device "${step.device}"`);
    }
  }
  return errors;
}

const SNAPSHOTS = 50;

/** Reads and writes data/site.json, keeping timestamped snapshots for rollback. */
export class SiteStore {
  readonly file: string;
  readonly snapshotDir: string;

  constructor(readonly dataDir: string) {
    this.file = join(dataDir, "site.json");
    this.snapshotDir = join(dataDir, "snapshots");
  }

  exists() {
    return existsSync(this.file);
  }

  load(): Site {
    return SiteSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
  }

  /** Validates, snapshots the previous version, and writes atomically. Returns problems instead of saving. */
  save(input: unknown): { errors: string[]; site?: Site } {
    const parsed = SiteSchema.safeParse(input);
    if (!parsed.success) return { errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
    const errors = checkSite(parsed.data);
    if (errors.length) return { errors };

    mkdirSync(this.snapshotDir, { recursive: true });
    if (this.exists()) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      writeFileSync(join(this.snapshotDir, `site-${stamp}.json`), readFileSync(this.file));
      const old = readdirSync(this.snapshotDir).filter((f) => f.startsWith("site-")).sort();
      for (const f of old.slice(0, Math.max(0, old.length - SNAPSHOTS))) unlinkSync(join(this.snapshotDir, f));
    }
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(parsed.data, null, 2) + "\n");
    renameSync(tmp, this.file);
    return { errors: [], site: parsed.data };
  }

  snapshots(): string[] {
    return existsSync(this.snapshotDir) ? readdirSync(this.snapshotDir).filter((f) => f.startsWith("site-")).sort().reverse() : [];
  }
}
