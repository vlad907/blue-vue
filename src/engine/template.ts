// A tiny, sandboxed template language for profiles:
//   {{path}}                     value from the context (params, settings, state, item)
//   {{path | filter:arg:arg}}    filters run left to right
// There is deliberately no expression evaluation: profiles are written by
// technicians in the admin UI, so only these fixed filters are available.

export type Context = Record<string, unknown>;

type Filter = (value: unknown, ...args: string[]) => unknown;

const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (Number.isNaN(n)) throw new Error(`"${v}" is not a number`);
  return n;
};

export const FILTERS: Record<string, Filter> = {
  number: (v) => num(v),
  round: (v, places = "0") => Number(num(v).toFixed(Number(places))),
  clamp: (v, min, max) => Math.min(num(max), Math.max(num(min), num(v))),
  // scale:inMin:inMax:outMin:outMax, e.g. 0-100% to a device's -80..0 dB
  scale: (v, inMin, inMax, outMin, outMax) =>
    num(outMin) + ((num(v) - num(inMin)) * (num(outMax) - num(outMin))) / (num(inMax) - num(inMin)),
  hex: (v, width = "2") => Math.round(num(v)).toString(16).toUpperCase().padStart(Number(width), "0"),
  pad: (v, width = "2", char = "0") => String(v).padStart(Number(width), char),
  upper: (v) => String(v).toUpperCase(),
  lower: (v) => String(v).toLowerCase(),
  digits: (v) => String(v).replace(/\D/g, ""),
  default: (v, fallback = "") => (v === undefined || v === null || v === "" ? fallback : v),
  // bool:trueText:falseText, e.g. {{mute | bool:1:0}}
  bool: (v, t = "true", f = "false") => (isTruthy(v) ? t : f),
  // map:A=1,B=2,*=0. Values are separated by commas in a single argument.
  map: (v, ...args) => {
    const table = args.join(":");
    let fallback: string | undefined;
    for (const pair of table.split(",")) {
      const i = pair.indexOf("=");
      if (i < 0) continue;
      const [k, out] = [pair.slice(0, i).trim(), pair.slice(i + 1).trim()];
      if (k === "*") fallback = out;
      else if (k === String(v)) return out;
    }
    return fallback ?? v;
  },
  json: (v) => JSON.stringify(v),
};

export function isTruthy(v: unknown) {
  if (typeof v === "string") return ["1", "true", "on", "yes"].includes(v.trim().toLowerCase());
  return Boolean(v);
}

/** Looks up a dotted path like "settings.zones.0.name" or "item.index". */
export function lookup(ctx: Context, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = ctx;
  for (let i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    const obj = cur as Record<string, unknown>;
    // Device state uses flat dotted keys ("zones.0.gain"), so try the rest of the path as one key first.
    const rest = parts.slice(i).join(".");
    if (i < parts.length - 1 && rest in obj) return obj[rest];
    cur = obj[parts[i]];
  }
  return cur;
}

const TAG = /\{\{\s*([^}]*?)\s*\}\}/g;

function evaluate(expr: string, ctx: Context): unknown {
  const [path, ...filters] = splitPipes(expr);
  let value: unknown = /^-?\d+(\.\d+)?$/.test(path) ? Number(path) : /^"(.*)"$/.test(path) ? path.slice(1, -1) : lookup(ctx, path);
  for (const f of filters) {
    const [name, ...args] = f.split(":");
    const fn = FILTERS[name.trim()];
    if (!fn) throw new Error(`Unknown filter "${name.trim()}" (available: ${Object.keys(FILTERS).join(", ")})`);
    value = fn(value, ...args);
  }
  return value;
}

// Splits on "|" but keeps pipes inside quoted literals.
function splitPipes(expr: string) {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of expr) {
    if (ch === '"') quoted = !quoted;
    if (ch === "|" && !quoted) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

/** Renders a template to a string. Missing values render as empty strings. */
export function render(template: string, ctx: Context): string {
  return template.replace(TAG, (_, expr: string) => {
    const v = evaluate(expr, ctx);
    return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

/**
 * Renders a template that is a single {{...}} tag to its raw value (keeping
 * numbers, booleans, arrays). Anything else renders as a string.
 */
export function renderValue(template: string, ctx: Context): unknown {
  const m = /^\{\{\s*([^}]*?)\s*\}\}$/.exec(template.trim());
  return m ? evaluate(m[1], ctx) : render(template, ctx);
}

/** Lists the filters and paths a template uses, for the editor's validation. */
export function check(template: string): string[] {
  const errors: string[] = [];
  for (const m of template.matchAll(TAG)) {
    const [, ...filters] = splitPipes(m[1]);
    for (const f of filters) {
      const name = f.split(":")[0].trim();
      if (!FILTERS[name]) errors.push(`unknown filter "${name}"`);
    }
  }
  return errors;
}
