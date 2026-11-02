import type { ReactNode } from "react";
import type { Param } from "../api.ts";
import type { SettingField } from "./adminApi.ts";

export function Field({ label, help, required, children }: { label: string; help?: string; required?: boolean; children: ReactNode }) {
  return (
    <label className="afield">
      <span className="afield-label">
        {label}
        {required && <span className="req">*</span>}
      </span>
      {children}
      {help && <span className="help">{help}</span>}
    </label>
  );
}

export function Text({ value, onChange, placeholder, disabled }: { value: string | undefined; onChange: (v: string) => void; placeholder?: string; disabled?: boolean }) {
  return <input type="text" value={value ?? ""} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
}

/** Number input that keeps an empty box empty (undefined) instead of turning it into 0. */
export function Num({ value, onChange, min, max, step, integer }: { value: unknown; onChange: (v: number | undefined) => void; min?: number; max?: number; step?: number; integer?: boolean }) {
  return (
    <input
      type="number"
      value={value === undefined || value === null || value === "" ? "" : String(value)}
      min={min}
      max={max}
      step={step ?? (integer ? 1 : "any")}
      onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
    />
  );
}

export function Pick<T extends string | number>({ value, options, onChange, empty }: { value: T | undefined; options: { value: T; label: string }[]; onChange: (v: T) => void; empty?: string }) {
  return (
    <select
      value={value === undefined ? "" : String(value)}
      onChange={(e) => {
        const o = options.find((o) => String(o.value) === e.target.value);
        onChange((o ? o.value : e.target.value) as T);
      }}
    >
      {(value === undefined || empty !== undefined) && <option value="">{empty ?? "Choose…"}</option>}
      {/* A saved value missing from the list (renamed preset, device offline) stays visible instead of being hidden. */}
      {value !== undefined && String(value) !== "" && !options.some((o) => String(o.value) === String(value)) && (
        <option value={String(value)}>{String(value)} (not currently available)</option>
      )}
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
      ))}
    </select>
  );
}

export function Check({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="acheck">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** Builds a device's settings form from its profile's `settings` fields. */
export function SettingsForm({ fields, value, onChange }: { fields: SettingField[]; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const set = (key: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined || v === "") delete next[key];
    else next[key] = v;
    onChange(next);
  };
  return (
    <div className="aform">
      {fields.map((f) => (
        <Field key={f.key} label={f.label} help={f.help} required={f.required}>
          <SettingInput field={f} value={value[f.key] ?? f.default} onChange={(v) => set(f.key, v)} />
        </Field>
      ))}
    </div>
  );
}

function SettingInput({ field: f, value, onChange }: { field: SettingField; value: unknown; onChange: (v: unknown) => void }) {
  switch (f.type) {
    case "string":
      return <Text value={value as string} onChange={onChange} />;
    case "number":
    case "integer":
      return <Num value={value} onChange={onChange} integer={f.type === "integer"} />;
    case "boolean":
      return <Check value={value === true} onChange={onChange} label="" />;
    case "enum":
      return <Pick value={value as string} options={(f.values ?? []).map((v) => ({ value: v, label: String(v) }))} onChange={onChange} />;
    case "list":
      return f.fields?.length ? (
        <ListTable fields={f.fields} rows={Array.isArray(value) ? (value as Record<string, unknown>[]) : []} onChange={onChange} />
      ) : (
        <SimpleList value={Array.isArray(value) ? value : []} onChange={onChange} />
      );
  }
}

/** Rows of sub-fields, e.g. Atlas zones (number + name). */
function ListTable({ fields, rows, onChange }: { fields: SettingField[]; rows: Record<string, unknown>[]; onChange: (v: Record<string, unknown>[]) => void }) {
  const setCell = (i: number, key: string, v: unknown) => onChange(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  return (
    <div className="listtable">
      {rows.length > 0 && (
        <div className="lt-row lt-head" style={{ gridTemplateColumns: `repeat(${fields.length}, 1fr) 36px` }}>
          {fields.map((f) => <span key={f.key}>{f.label}</span>)}
          <span />
        </div>
      )}
      {rows.map((row, i) => (
        <div key={i} className="lt-row" style={{ gridTemplateColumns: `repeat(${fields.length}, 1fr) 36px` }}>
          {fields.map((f) => (
            <SettingInput key={f.key} field={f} value={row[f.key]} onChange={(v) => setCell(i, f.key, v)} />
          ))}
          <button className="icon" title="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button
        className="btn small"
        onClick={() => {
          // Number rows sequentially by default (zones/sources start at 0).
          const idx = fields.find((f) => f.key === "index");
          const nextIndex = idx ? Math.max(-1, ...rows.map((r) => Number(r.index ?? -1))) + 1 : undefined;
          onChange([...rows, idx ? { index: nextIndex } : {}]);
        }}
      >
        + Add row
      </button>
    </div>
  );
}

/** A list of plain values (e.g. favorite channels) typed as comma-separated text. */
function SimpleList({ value, onChange }: { value: unknown[]; onChange: (v: unknown[]) => void }) {
  return (
    <input
      type="text"
      defaultValue={value.join(", ")}
      placeholder="e.g. 206, 209, 1206"
      onBlur={(e) => {
        const items = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
        onChange(items.every((s) => /^-?\d+(\.\d+)?$/.test(s)) ? items.map(Number) : items);
      }}
    />
  );
}

/** Inputs for a command's params; dropdowns are filled from device settings where the profile says so. */
export function ParamsForm({ params, value, onChange, settings, state }: { params: Record<string, Param>; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; settings?: Record<string, unknown>; state?: Record<string, unknown> }) {
  const entries = Object.entries(params);
  if (!entries.length) return null;
  // Changing a value clears the ones whose choices depend on it (e.g. a preset when the wall changes).
  const set = (k: string, v: unknown) => {
    const next: Record<string, unknown> = { ...value, [k]: v };
    for (const [other, op] of entries) if (op.optionsFrom?.includes(`{{${k}}}`)) delete next[other];
    onChange(next);
  };
  return (
    <div className="aform inline">
      {entries.map(([name, p]) => {
        const label = p.label ?? name;
        const list = p.optionsFrom ? optionsList(p.optionsFrom, value, settings, state) : undefined;
        let input: ReactNode;
        if (Array.isArray(list) && list.length) {
          const options = list.map((it) => {
            const o = (it && typeof it === "object" ? it : { value: it, name: it }) as Record<string, unknown>;
            const v = (o.index ?? o.id ?? o.value ?? o.name) as string | number;
            return { value: v, label: `${o.name ?? v}` };
          });
          input = <Pick value={value[name] as string | number | undefined} options={options} onChange={(v) => set(name, v)} />;
        } else if (p.type === "enum") {
          input = <Pick value={value[name] as string | undefined} options={(p.values ?? []).map((v) => ({ value: v, label: p.labels?.[String(v)] ?? String(v) }))} onChange={(v) => set(name, v)} />;
        } else if (p.type === "boolean") {
          input = <Check value={value[name] === true} onChange={(v) => set(name, v)} label="" />;
        } else if (p.type === "number" || p.type === "integer") {
          input = <Num value={value[name]} onChange={(v) => set(name, v)} min={p.min} max={p.max} step={p.step} integer={p.type === "integer"} />;
        } else {
          input = <Text value={value[name] as string} onChange={(v) => set(name, v)} />;
        }
        const range = p.min !== undefined || p.max !== undefined ? `${p.min ?? ""} to ${p.max ?? ""}` : undefined;
        return (
          <Field key={name} label={label} help={range}>
            {input}
          </Field>
        );
      })}
    </div>
  );
}

/**
 * The list a param's choices come from: a settings list ("settings.zones") or
 * live device state ("state.groupList", "state.groups.{{group}}.presets",
 * where {{group}} is the value already chosen for the "group" param).
 */
function optionsList(path: string, values: Record<string, unknown>, settings?: Record<string, unknown>, state?: Record<string, unknown>) {
  const resolved = path.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(values[k] ?? ""));
  if (resolved.startsWith("state.")) return state?.[resolved.slice(6)] as unknown[] | undefined;
  return settings?.[resolved.replace(/^settings\./, "")] as unknown[] | undefined;
}

/** Default settings for a newly chosen profile, keeping values that still apply. */
export function defaultSettings(fields: SettingField[], keep: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (keep[f.key] !== undefined) out[f.key] = keep[f.key];
    else if (f.default !== undefined) out[f.key] = structuredClone(f.default);
  }
  return out;
}
