import type { ParseRule } from "./profile-schema.ts";
import { type Context, render, renderValue } from "./template.ts";

/** One state update produced by a parse rule: key -> raw value. */
export type StateUpdates = Record<string, unknown>;

/**
 * Runs parse rules over a message from the device. Each match exposes named
 * values to the rule's `set` templates; a rule can match several times in one
 * message (e.g. a batch of parameter updates).
 */
export function applyRules(rules: ParseRule[], text: string, ctx: Context = {}): StateUpdates {
  const updates: StateUpdates = {};
  for (const rule of rules) {
    for (const vars of matches(rule, text)) {
      const local = { ...ctx, ...vars };
      for (const [keyTpl, valueTpl] of Object.entries(rule.set)) {
        const key = render(keyTpl, local);
        if (key) updates[key] = renderValue(valueTpl, local);
      }
    }
  }
  return updates;
}

function matches(rule: ParseRule, text: string): Record<string, unknown>[] {
  if (rule.regex !== undefined) {
    const re = new RegExp(rule.regex, "g");
    return [...text.matchAll(re)].map((m) => ({ value: m[1], match: m[0], ...m.groups }));
  }
  if (rule.xmlTag !== undefined) {
    const tag = rule.xmlTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(text);
    return m ? [{ value: decodeXml(m[1]) }] : [];
  }
  if (rule.jsonPath !== undefined) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return [];
    }
    const value = jsonPath(data, rule.jsonPath);
    return value === undefined ? [] : [{ value }];
  }
  return [];
}

/** Supports "$.a.b[0].c", "a.b.0.c" and "$" (the whole document). */
export function jsonPath(data: unknown, path: string): unknown {
  const parts = path
    .replace(/^\$\.?/, "")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let cur = data;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function decodeXml(s: string) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
