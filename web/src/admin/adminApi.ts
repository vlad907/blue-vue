import type { Param } from "../api.ts";

// --- Site shapes (mirror src/engine/site.ts) -----------------------------------

export interface SiteDevice {
  id: string;
  name: string;
  profile: string;
  location: string;
  room?: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  preview?: { device: string; stream: string };
}

export type SceneStep =
  | { type: "command"; device?: string; group?: string; command: string; params: Record<string, unknown> }
  | { type: "delay"; ms: number }
  | { type: "waitFor"; device: string; state: string; equals: string | number | boolean; timeoutMs: number };

export interface Site {
  version: 1;
  name: string;
  rooms: { id: string; name: string }[];
  devices: SiteDevice[];
  groups: SiteGroup[];
  scenes: { id: string; name: string; description?: string; steps: SceneStep[] }[];
  channels: { number: number; name: string; callSign?: string; stationId?: string; logo?: string; category?: string }[];
  agents: { id: string; name: string; token?: string }[];
}

export interface SiteGroup {
  id: string;
  name: string;
  kind: "wall" | "zone" | "other";
  devices: string[];
  staggerMs: number;
  columns?: number;
  mosaic?: { device: string; group: string };
  powerOnInput?: string;
}

export interface ListenStatus {
  port: number;
  interfaces: string[];
  listening: string[];
  problems: string[];
}

export interface NetworkInfo {
  nics: { name: string; addresses: string[] }[];
  status: ListenStatus | null;
  via: string; // the server address this browser reached
}

export interface FoundTv {
  host: string;
  name?: string;
  model?: string;
  mac?: string;
  existing?: string; // id of the saved device already using this address
}

export interface MosaicCanvas {
  id: string;
  name: string;
  running: boolean;
  error: string;
  walls: { id: string; name: string; presets: number }[];
  existing?: string; // the saved device already on this canvas
}

export interface SettingField {
  key: string;
  label: string;
  type: "string" | "number" | "integer" | "boolean" | "enum" | "list";
  required?: boolean;
  default?: unknown;
  help?: string;
  values?: (string | number)[];
  fields?: SettingField[];
}

export interface Profile {
  id: string;
  name: string;
  manufacturer?: string;
  model?: string;
  category: string;
  description?: string;
  transport: { type: string };
  discover?: "androidtv" | "roku" | "adb" | "appletv";
  settings: SettingField[];
  commands: Record<string, { label?: string; params: Record<string, Param>; hidden?: boolean }>;
  state: Record<string, { type: string; label?: string }>;
  capabilities: Record<string, unknown>;
}

/** A profile as written in its file (the editor works on this, before `extends` is applied). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RawProfile = Record<string, any>;

export interface ProfileEntry {
  id?: string;
  name?: string;
  category?: string;
  manufacturer?: string;
  source: "builtin" | "custom";
  file: string;
  errors: string[];
}

export interface LogEntry {
  t: string;
  dir: "tx" | "rx" | "info" | "error";
  text: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly problems: string[] = []) {
    super(message);
  }
}

export interface UpdateStatus {
  current: { built: string } | null;
  cannot?: string;
  latest?: { built: string; size: number };
  available: boolean;
  checkError?: string;
  phase: "idle" | "downloading" | "unpacking" | "installing" | "failed";
  progress?: number;
  error?: string;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || res.statusText, res.status, data.problems);
  return data as T;
}

export const adminApi = {
  session: () => call<{ authenticated: boolean; setupRequired: boolean }>("GET", "/api/admin/session"),
  setup: (password: string) => call("POST", "/api/admin/setup", { password }),
  login: (password: string) => call("POST", "/api/admin/login", { password }),
  logout: () => call("POST", "/api/admin/logout", {}),
  changePassword: (current: string, next: string) => call("POST", "/api/admin/password", { current, next }),

  site: () => call<{ site: Site; hash: string }>("GET", "/api/admin/site"),
  saveSite: (site: Site, baseHash: string) => call<{ hash: string }>("PUT", "/api/admin/site", { site, baseHash }),
  snapshots: () => call<string[]>("GET", "/api/admin/snapshots"),
  restore: (name: string) => call("POST", `/api/admin/snapshots/${encodeURIComponent(name)}/restore`, {}),
  importBackup: (backup: unknown) => call("POST", "/api/admin/import", backup),

  approveAgent: (id: string, name: string) => call("POST", `/api/admin/agents/${id}/approve`, { name }),
  dismissAgent: (id: string) => call("POST", `/api/admin/agents/${id}/dismiss`, {}),
  newToken: (id: string) => call<{ token: string }>("POST", `/api/admin/agents/${id}/token`, {}),

  gracenoteLineups: (zip: string) => call<{ id: string; name: string; type: string; location?: string }[]>("GET", `/api/admin/gracenote/lineups?q=${encodeURIComponent(zip)}`),
  gracenoteChannels: (lineup: string) => call<Site["channels"]>("GET", `/api/admin/gracenote/channels?q=${encodeURIComponent(lineup)}`),

  profileRaw: (id: string) => call<{ raw: RawProfile; source: "builtin" | "custom"; errors: string[]; usedBy: string[] }>("GET", `/api/admin/profiles/${id}`),
  validateProfile: (profile: RawProfile) => call<{ problems: string[] }>("POST", "/api/admin/profiles/validate", { profile }),
  saveProfile: (profile: RawProfile) => call<{ usedBy: string[] }>("PUT", `/api/admin/profiles/${encodeURIComponent(String(profile.id))}`, { profile }),
  deleteProfile: (id: string) => call("DELETE", `/api/admin/profiles/${id}`),
  previewCommand: (profile: RawProfile, command: string, params: Record<string, unknown>, settings: Record<string, unknown>) =>
    call<{ sent?: string[]; state?: Record<string, unknown>; warnings?: string[]; problems: string[] }>("POST", "/api/admin/profiles/preview", { profile, command, params, settings }),
  parseTest: (rules: unknown[], sample: string, settings: Record<string, unknown> = {}) =>
    call<{ updates?: Record<string, unknown>; problems: string[] }>("POST", "/api/admin/profiles/parse-test", { rules, sample, settings }),
  pair: (id: string, step: "start" | "finish" | "cancel", code?: string) =>
    call<{ ok: boolean; simulated: boolean; done?: boolean; more?: boolean; message?: string }>("POST", `/api/admin/devices/${encodeURIComponent(id)}/pair`, { step, code }),
  discoverTvs: (location: string, kind: string, subnet?: string) =>
    call<{ found: FoundTv[]; subnets: string[]; simulated: boolean }>("POST", "/api/admin/discover/tvs", { location, kind, subnet }),
  mosaicCanvases: (host: string, port: number) => call<{ canvases: MosaicCanvas[]; simulated: boolean }>("POST", "/api/admin/mosaic/canvases", { host, port }),
  network: () => call<NetworkInfo>("GET", "/api/admin/network"),
  update: (fresh = false) => call<UpdateStatus>("GET", `/api/admin/update${fresh ? "?fresh=1" : ""}`),
  startUpdate: () => call<UpdateStatus>("POST", "/api/admin/update"),
  setNetwork: (interfaces: string[], force = false) => call<{ status: ListenStatus }>("PUT", "/api/admin/network", { interfaces, force }),
  learnIr: (location: string, irHost: string) => call<{ pronto: string }>("POST", "/api/admin/ir/learn", { location, irHost }),
  profiles: () => call<ProfileEntry[]>("GET", "/api/v2/profiles"),
  profile: (id: string) => call<Profile>("GET", `/api/v2/profiles/${id}`),
  deviceLog: (id: string) => call<LogEntry[]>("GET", `/api/v2/devices/${id}/log`),
  command: (id: string, command: string, params: Record<string, unknown>) => call("POST", `/api/v2/devices/${id}/commands/${command}`, { params }),
  runScene: (id: string) => call<{ ok: boolean; errors: string[] }>("POST", `/api/v2/scenes/${id}`, {}),
};

/** "Main Bar TV" -> "main-bar-tv", unique among `taken`. */
export function slugify(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
}
