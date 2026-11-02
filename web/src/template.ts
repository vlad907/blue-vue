// The panel only needs the path part of profile templates ({{item.index}},
// {{settings.zones}}); filters are applied on the server when commands run.

export function lookup(ctx: Record<string, unknown>, path: string): unknown {
  let cur: unknown = ctx;
  for (const part of path.trim().split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const TAG = /\{\{\s*([^}|]+?)\s*(\|[^}]*)?\}\}/g;

export function render(template: string | undefined, ctx: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(TAG, (_, path: string) => {
    const v = lookup(ctx, path);
    return v === undefined || v === null ? "" : String(v);
  });
}

/** A lone {{tag}} keeps its raw value (e.g. a zone number stays a number). */
export function renderValue(value: unknown, ctx: Record<string, unknown>): unknown {
  if (typeof value !== "string") return value;
  const m = /^\{\{\s*([^}|]+?)\s*\}\}$/.exec(value.trim());
  return m ? lookup(ctx, m[1]) : render(value, ctx);
}

export function renderParams(params: Record<string, unknown> | undefined, ctx: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params ?? {})) out[k] = renderValue(v, ctx);
  return out;
}

/** Device state values that mean "on" for toggles and power tiles. */
export function isOn(v: unknown) {
  return v === true || v === "on" || v === 1 || v === "1" || v === "true";
}
