import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { type Profile, ProfileSchema } from "./profile-schema.ts";
import { check } from "./template.ts";

export const BUILTIN_PROFILES = join(import.meta.dirname, "..", "..", "profiles", "builtin");

export interface ProfileEntry {
  profile?: Profile;
  raw?: Record<string, unknown>; // as written in the file, before `extends` is applied
  source: "builtin" | "custom";
  file: string;
  errors: string[];
}

/**
 * Loads device profiles from the built-in folder (shipped, read-only) and the
 * custom folder (made in the admin UI). Custom profiles can `extends` another
 * profile and override parts of it, e.g. add learned IR codes. A broken file is
 * reported, not fatal, so one bad profile can't take the system down.
 */
export class ProfileLibrary {
  private entries = new Map<string, ProfileEntry>();

  constructor(readonly builtinDir: string, readonly customDir: string) {}

  load() {
    const raw = new Map<string, { data: Record<string, unknown>; source: ProfileEntry["source"]; file: string }>();
    const broken: ProfileEntry[] = [];
    for (const [dir, source] of [[this.builtinDir, "builtin"], [this.customDir, "custom"]] as const) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir).filter((f) => /\.(ya?ml|json)$/.test(f)).sort()) {
        const file = join(dir, name);
        try {
          const data = parseYaml(readFileSync(file, "utf8"));
          if (!data || typeof data.id !== "string") throw new Error("missing id");
          if (raw.has(data.id) && raw.get(data.id)!.source === source) throw new Error(`duplicate profile id "${data.id}"`);
          // A custom profile with a built-in's id replaces it.
          raw.set(data.id, { data, source, file });
        } catch (err) {
          broken.push({ source, file, errors: [err instanceof Error ? err.message : String(err)] });
        }
      }
    }

    this.entries.clear();
    for (const [id, r] of raw) {
      try {
        const merged = resolveExtends(id, raw);
        const result = ProfileSchema.safeParse(merged);
        if (!result.success) {
          this.entries.set(id, { raw: r.data, source: r.source, file: r.file, errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
        } else {
          const errors = lint(result.data);
          this.entries.set(id, { profile: errors.length ? undefined : result.data, raw: r.data, source: r.source, file: r.file, errors });
        }
      } catch (err) {
        this.entries.set(id, { raw: r.data, source: r.source, file: r.file, errors: [err instanceof Error ? err.message : String(err)] });
      }
    }
    for (const b of broken) this.entries.set(`!${b.file}`, b);
    for (const [id, e] of this.entries) if (e.errors.length) console.warn(`[profiles] ${id}: ${e.errors.join("; ")}`);
    return this;
  }

  entry(id: string): ProfileEntry | undefined {
    return this.entries.get(id);
  }

  get(id: string): Profile | undefined {
    return this.entries.get(id)?.profile;
  }

  list(): ProfileEntry[] {
    return [...this.entries.values()];
  }

  /** Validates and saves a custom profile, then reloads. Returns problems instead of saving if invalid. */
  /** Checks a profile as written (resolving `extends` against the library) without saving it. */
  validate(data: Record<string, unknown>): { errors: string[]; profile?: Profile } {
    const id = String(data.id ?? "");
    const all = new Map([...this.entries].filter(([, e]) => e.profile).map(([k, e]) => [k, { data: e.profile as unknown as Record<string, unknown>, source: e.source, file: e.file }]));
    all.set(id, { data, source: "custom", file: "" });
    let merged: unknown;
    try {
      merged = resolveExtends(id, all);
    } catch (err) {
      return { errors: [err instanceof Error ? err.message : String(err)] };
    }
    const result = ProfileSchema.safeParse(merged);
    if (!result.success) return { errors: result.error.issues.map((i) => `${i.path.join(".") || "profile"}: ${i.message}`) };
    const errors = lint(result.data);
    return errors.length ? { errors } : { errors: [], profile: result.data };
  }

  saveCustom(data: Record<string, unknown>): string[] {
    const id = String(data.id ?? "");
    if (this.entries.get(id)?.source === "builtin") return [`"${id}" is a built-in profile; save your version under a new id`];
    const { errors } = this.validate(data);
    if (errors.length) return errors;

    mkdirSync(this.customDir, { recursive: true });
    writeFileSync(join(this.customDir, `${id}.yaml`), toYaml(data, { lineWidth: 0 }));
    this.load();
    return [];
  }

  /** Custom profiles as written (before extends is resolved), for backups. */
  customRaw(): Record<string, unknown>[] {
    if (!existsSync(this.customDir)) return [];
    return readdirSync(this.customDir)
      .filter((f) => /\.(ya?ml|json)$/.test(f))
      .map((f) => parseYaml(readFileSync(join(this.customDir, f), "utf8")))
      .filter((d) => d && typeof d.id === "string");
  }

  deleteCustom(id: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.source !== "custom") throw new Error(`"${id}" is not a custom profile`);
    unlinkSync(entry.file);
    this.load();
  }
}

// Child values override parent values; maps (commands, irCodes, state) merge key by key.
const MERGED_MAPS = ["commands", "irCodes", "state", "capabilities", "transport", "simulator"];

function resolveExtends(id: string, raw: Map<string, { data: Record<string, unknown> }>, seen: string[] = []): Record<string, unknown> {
  const r = raw.get(id);
  if (!r) throw new Error(`profile "${id}" not found`);
  const parentId = r.data.extends as string | undefined;
  if (!parentId) return r.data;
  if (seen.includes(id)) throw new Error(`extends loop: ${[...seen, id].join(" -> ")}`);
  const parent = resolveExtends(parentId, raw, [...seen, id]);
  const out: Record<string, unknown> = { ...parent, ...r.data };
  for (const key of MERGED_MAPS) {
    if (parent[key] || r.data[key]) out[key] = { ...(parent[key] as object), ...(r.data[key] as object) };
  }
  return out;
}

/** Cross-reference checks the schema can't express. */
export function lint(p: Profile): string[] {
  const errors: string[] = [];
  const commandNames = new Set(Object.keys(p.commands));
  const templates: [string, string][] = [];

  const walk = (steps: unknown[], where: string) => {
    for (const s of steps as Record<string, any>[]) {
      if (s.command && !commandNames.has(s.command)) errors.push(`${where}: unknown command "${s.command}"`);
      if (s.steps) walk(s.steps, where);
      for (const k of ["send", "hex", "ir", "adb", "forEachChar"]) if (typeof s[k] === "string") templates.push([where, s[k]]);
      if (s.http) {
        templates.push([where, s.http.path]);
        if (s.http.body) templates.push([where, s.http.body]);
        for (const h of Object.values((s.http.headers ?? {}) as Record<string, string>)) templates.push([where, h]);
      }
      const kind = s.send !== undefined || s.hex !== undefined ? "text" : s.http ? "http" : s.ir !== undefined ? "ir" : s.adb !== undefined ? "adb" : s.wol ? "wol" : undefined;
      if (kind) {
        const t = p.transport.type;
        const ok = kind === "text" ? ["tcp", "udp", "serial"].includes(t) : kind === t;
        if (!ok) errors.push(`${where}: a ${kind} step can't be sent over ${t}`);
      }
    }
  };
  for (const [name, c] of Object.entries(p.commands)) walk(c.steps, `command ${name}`);
  p.polls.forEach((poll, i) => walk(poll.steps, `poll ${i + 1}`));
  walk(p.onConnect, "onConnect");
  if (p.keepalive) walk(p.keepalive.steps, "keepalive");

  for (const [capName, cap] of Object.entries(p.capabilities)) {
    for (const [k, v] of Object.entries(cap as Record<string, string>)) {
      if (["on", "off", "tune", "set", "mute", "select", "recall"].includes(k) && !commandNames.has(v)) {
        errors.push(`capability ${capName}.${k}: unknown command "${v}"`);
      }
    }
  }
  for (const [where, t] of templates) for (const e of check(t)) errors.push(`${where}: ${e}`);
  return errors;
}
