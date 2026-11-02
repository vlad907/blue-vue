import { z } from "zod";

// A profile describes a device *type* entirely as data: how to reach it, what
// commands it takes, how to read its state, and what controls to show. This
// schema is the single source of truth for profiles, both on disk and in the
// admin editor.

// --- Payloads: what one step sends, per transport ---------------------------

const HttpPayload = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  path: z.string(), // template, e.g. "/keypress/{{key}}"
  body: z.string().optional(), // template
  headers: z.record(z.string()).optional(),
});

/** One thing sent to the device. Exactly one transport key is set. */
export const Payload = z
  .object({
    send: z.string().optional(), // tcp/udp/serial text template; transport terminator is appended
    hex: z.string().optional(), // tcp/udp/serial raw bytes as hex template, e.g. "AA 01 {{level|hex:2}}"
    http: HttpPayload.optional(),
    ir: z.string().optional(), // name in irCodes (template), e.g. "KEY_{{item}}"
    adb: z.string().optional(), // adb shell arguments (template)
    wol: z.literal(true).optional(), // wake-on-LAN using settings.mac
  })
  .refine((p) => ["send", "hex", "http", "ir", "adb", "wol"].filter((k) => p[k as keyof typeof p] !== undefined).length === 1, {
    message: "a payload needs exactly one of send, hex, http, ir, adb, wol",
  });
export type Payload = z.infer<typeof Payload>;

export type Step =
  | (Payload & { repeat?: number })
  | { delay: number | string }
  | { forEachChar: string; steps: Step[] }
  | { forEach: string; steps: Step[] }
  | { command: string; params?: Record<string, unknown> };

export const Step: z.ZodType<Step, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([
    z.object({ delay: z.union([z.number(), z.string()]) }).strict(),
    z.object({ forEachChar: z.string(), steps: z.array(Step) }).strict(),
    z.object({ forEach: z.string(), steps: z.array(Step) }).strict(),
    z.object({ command: z.string(), params: z.record(z.unknown()).optional() }).strict(),
    Payload.and(z.object({ repeat: z.number().int().min(1).max(10).optional() })),
  ]),
);

// --- Parsing device responses into state ------------------------------------

/**
 * Reads values out of text the device sends back. Matches give named values
 * that `set` templates can use: regex named groups (or `value` for group 1),
 * or `value` for xmlTag/jsonPath.
 */
export const ParseRule = z
  .object({
    regex: z.string().optional(),
    xmlTag: z.string().optional(),
    jsonPath: z.string().optional(),
    set: z.record(z.string()), // state key template -> value template
  })
  .refine((r) => [r.regex, r.xmlTag, r.jsonPath].filter((x) => x !== undefined).length === 1, {
    message: "a parse rule needs exactly one of regex, xmlTag, jsonPath",
  });
export type ParseRule = z.infer<typeof ParseRule>;

// --- Commands, params, settings, state --------------------------------------

export const Param = z.object({
  type: z.enum(["number", "integer", "boolean", "string", "enum"]),
  label: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  values: z.array(z.union([z.string(), z.number()])).optional(), // for enum
  labels: z.record(z.string()).optional(), // enum value -> display label
  default: z.unknown().optional(),
  optionsFrom: z.string().optional(), // e.g. "settings.zones" to fill a dropdown from device settings
});
export type Param = z.infer<typeof Param>;

export const Command = z.object({
  label: z.string().optional(),
  params: z.record(Param).default({}),
  steps: z.array(Step).min(1),
  // Optimistic state after the command, for devices with no feedback (IR).
  sets: z.record(z.string()).optional(),
  parse: z.array(ParseRule).optional(), // applied to request/response replies (http, adb)
  hidden: z.boolean().optional(), // internal helper, not offered in scene builder
});
export type Command = z.infer<typeof Command>;

export type SettingField = {
  key: string;
  label: string;
  type: "string" | "number" | "integer" | "boolean" | "enum" | "list";
  required?: boolean;
  default?: unknown;
  help?: string;
  values?: (string | number)[];
  fields?: SettingField[]; // columns for "list" settings, e.g. zones
};
export const SettingField: z.ZodType<SettingField> = z.lazy(() =>
  z.object({
    key: z.string().regex(/^[a-zA-Z_][\w]*$/),
    label: z.string(),
    type: z.enum(["string", "number", "integer", "boolean", "enum", "list"]),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    help: z.string().optional(),
    values: z.array(z.union([z.string(), z.number()])).optional(),
    fields: z.array(SettingField).optional(),
  }),
);

export const StateVar = z.object({
  type: z.enum(["number", "boolean", "string", "enum"]).default("string"),
  label: z.string().optional(),
  values: z.array(z.string()).optional(),
});

// --- UI controls (rendered by the touch panel) ------------------------------

export type Control = {
  type: "button" | "toggle" | "slider" | "select" | "keypad" | "dpad" | "presets" | "status" | "group";
  label?: string;
  command?: string;
  params?: Record<string, unknown>;
  param?: string; // which command param the widget's value feeds
  state?: string; // state key shown by the widget
  on?: string; // toggle: command for on
  off?: string; // toggle: command for off
  keys?: Record<string, string>; // dpad/keypad: button -> param value
  repeat?: string; // group: repeat for each item of a settings list
  options?: string; // select/presets: settings list to offer, e.g. "settings.favorites"
  controls?: Control[];
};
export const Control: z.ZodType<Control> = z.lazy(() =>
  z.object({
    type: z.enum(["button", "toggle", "slider", "select", "keypad", "dpad", "presets", "status", "group"]),
    label: z.string().optional(),
    command: z.string().optional(),
    params: z.record(z.unknown()).optional(),
    param: z.string().optional(),
    state: z.string().optional(),
    on: z.string().optional(),
    off: z.string().optional(),
    keys: z.record(z.string()).optional(),
    repeat: z.string().optional(),
    options: z.string().optional(),
    controls: z.array(Control).optional(),
  }),
);

// --- Capabilities: standard roles the rest of the app relies on -------------

export const Capabilities = z
  .object({
    power: z.object({ on: z.string(), off: z.string(), state: z.string().optional() }),
    tuner: z.object({ tune: z.string(), param: z.string().default("channel"), state: z.string().optional() }),
    volume: z.object({ set: z.string(), param: z.string(), mute: z.string().optional(), state: z.string().optional() }),
    source: z.object({ select: z.string(), param: z.string(), state: z.string().optional() }),
    layoutPresets: z.object({ recall: z.string(), param: z.string(), optionsFrom: z.string().optional() }),
  })
  .partial();
export type Capabilities = z.infer<typeof Capabilities>;

// --- Transport --------------------------------------------------------------

export const Transport = z.object({
  type: z.enum(["tcp", "udp", "http", "serial", "ir", "adb", "wol"]),
  port: z.number().int().positive().optional(),
  terminator: z.string().optional(), // appended to `send` payloads, e.g. "\r"
  delimiter: z.string().optional(), // splits incoming data into messages; default "\n"
  baudRate: z.number().int().optional(), // serial
  minGapMs: z.number().int().nonnegative().default(50), // pause between sends
  https: z.boolean().optional(),
});
export type Transport = z.infer<typeof Transport>;

// --- The profile ------------------------------------------------------------

export const ProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, numbers and dashes"),
  name: z.string(),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
  category: z.enum(["display", "tuner", "audio", "video-wall", "switcher", "projector", "lighting", "other"]).default("other"),
  description: z.string().optional(),
  version: z.number().int().default(1),
  extends: z.string().optional(),

  transport: Transport,
  settings: z.array(SettingField).default([]),
  commands: z.record(Command),
  irCodes: z.record(z.string()).default({}), // Pronto hex by key name
  state: z.record(StateVar).default({}), // keys may use "*" wildcards, e.g. "zones.*.gain"
  feedback: z.array(ParseRule).default([]), // applied to every unsolicited message
  polls: z.array(z.object({ every: z.number().positive(), steps: z.array(Step), parse: z.array(ParseRule).optional() })).default([]),
  onConnect: z.array(Step).default([]),
  keepalive: z.object({ every: z.number().positive(), steps: z.array(Step) }).optional(),
  capabilities: Capabilities.default({}),
  controls: z.array(Control).default([]),
  simulator: z.object({ state: z.record(z.unknown()).default({}) }).default({}),
});
export type Profile = z.infer<typeof ProfileSchema>;
