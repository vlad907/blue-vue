import { useEffect, useRef, useState } from "react";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { ApiError, adminApi, type RawProfile } from "./adminApi.ts";
import { useDraft } from "./draft.tsx";
import { Check, Field, Pick, Text } from "./forms.tsx";
import { CapabilitiesEditor, CommandsTab, ControlsEditor, FeedbackTab, IrCodesTab } from "./ProfileSections.tsx";

const TABS = [
  { id: "general", label: "General" },
  { id: "settings", label: "Device settings" },
  { id: "commands", label: "Commands" },
  { id: "feedback", label: "Feedback & polling" },
  { id: "state", label: "State" },
  { id: "ir", label: "IR codes" },
  { id: "controls", label: "Panel controls" },
  { id: "yaml", label: "YAML" },
] as const;

export const CATEGORIES = ["display", "tuner", "audio", "video-wall", "switcher", "projector", "lighting", "other"];

/**
 * Edits one device profile. Built-in profiles open read-only (duplicate them
 * to change anything). Problems are checked on the server as you type.
 */
export function ProfileEditor({ initial, readOnly, isNew, usedBy, onClose, onSaved }: {
  initial: RawProfile;
  readOnly: boolean;
  isNew: boolean;
  usedBy: string[];
  onClose: () => void;
  onSaved: (p: RawProfile) => void;
}) {
  const { notice } = useDraft();
  const [p, setP] = useState<RawProfile>(() => structuredClone(initial));
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("general");
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(p) !== JSON.stringify(initial);
  const update = (fn: (p: RawProfile) => void) =>
    setP((cur) => {
      const next = structuredClone(cur);
      fn(next);
      return next;
    });

  // Check the profile on the server shortly after each edit.
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    const t = setTimeout(() => {
      adminApi.validateProfile(p).then((r) => mine === seq.current && setProblems(r.problems), () => {});
    }, 500);
    return () => clearTimeout(t);
  }, [p]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await adminApi.saveProfile(p);
      notice(r.usedBy.length ? `Saved; ${r.usedBy.length} device(s) restarted with it` : "Saved");
      onSaved(p);
    } catch (err) {
      if (err instanceof ApiError && err.problems.length) setProblems(err.problems);
      notice(err instanceof Error ? err.message : String(err), true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="profile-editor">
      <div className="row-between">
        <div>
          <h2>{readOnly ? "Built-in profile" : isNew ? "New device type" : "Edit device type"}: {p.name || "untitled"}</h2>
          <span className="muted">
            {p.id}
            {p.extends && <> · builds on {p.extends}</>}
            {usedBy.length > 0 && <> · used by {usedBy.length} device(s)</>}
          </span>
        </div>
        <div className="row-tight">
          <button className="btn" onClick={() => (!dirty || confirm("Close without saving?")) && onClose()}>Close</button>
          {!readOnly && (
            <button className="btn primary" disabled={saving || !p.id || (!dirty && !isNew)} onClick={save}>
              {saving ? "Saving…" : "Save device type"}
            </button>
          )}
        </div>
      </div>
      {readOnly && <p className="help">Built-in profiles can't be edited. Use Duplicate on the list to make your own copy.</p>}
      {p.extends && (
        <p className="help">
          This profile builds on <b>{p.extends}</b>: anything not set here comes from it. The tabs show only what this profile adds or overrides.
        </p>
      )}

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {problems.length > 0 && (
        <ul className="problems inline-problems">
          {problems.map((x) => <li key={x}>{x}</li>)}
        </ul>
      )}

      <fieldset disabled={readOnly} className="plain">
        {tab === "general" && <GeneralTab p={p} update={update} isNew={isNew} />}
        {tab === "settings" && <SettingsFieldsEditor fields={p.settings ?? []} onChange={(settings) => update((x) => { x.settings = settings; })} />}
        {tab === "commands" && <CommandsTab p={p} update={update} />}
        {tab === "feedback" && <FeedbackTab p={p} update={update} />}
        {tab === "state" && <StateTab p={p} update={update} />}
        {tab === "ir" && <IrCodesTab p={p} update={update} />}
        {tab === "controls" && (
          <>
            <h3 className="section">Panel controls</h3>
            <p className="help">What the touch panel shows on this device's card, top to bottom.</p>
            <ControlsEditor controls={p.controls ?? []} onChange={(controls) => update((x) => { x.controls = controls; })} p={p} />
            <h3 className="section">Standard roles</h3>
            <CapabilitiesEditor p={p} update={update} />
          </>
        )}
      </fieldset>
      {tab === "yaml" && <YamlTab p={p} onApply={setP} readOnly={readOnly} />}
    </div>
  );
}

// "\r" in the editor <-> carriage return in the profile.
const showEscapes = (s?: string) => (s ?? "").replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
const readEscapes = (s: string) => s.replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

function GeneralTab({ p, update, isNew }: { p: RawProfile; update: (fn: (p: RawProfile) => void) => void; isNew: boolean }) {
  const t = p.transport ?? {};
  const setT = (k: string, v: unknown) => update((x) => { x.transport = { ...(x.transport ?? {}), [k]: v === "" || v === undefined ? undefined : v }; });
  const num = (v: string) => (v === "" ? undefined : Number(v));
  return (
    <>
      <div className="aform two">
        <Field label="Name" required><Text value={p.name} onChange={(v) => update((x) => { x.name = v; })} /></Field>
        <Field label="Id" required help={isNew ? "Lowercase letters, numbers and dashes. Can't change after saving." : "Fixed after the first save."}>
          <Text value={p.id} disabled={!isNew} onChange={(v) => update((x) => { x.id = v.toLowerCase().replace(/[^a-z0-9-]/g, "-"); })} />
        </Field>
        <Field label="Manufacturer"><Text value={p.manufacturer} onChange={(v) => update((x) => { x.manufacturer = v || undefined; })} /></Field>
        <Field label="Model"><Text value={p.model} onChange={(v) => update((x) => { x.model = v || undefined; })} /></Field>
        <Field label="Category"><Pick value={p.category ?? "other"} options={CATEGORIES.map((c) => ({ value: c, label: c }))} onChange={(v) => update((x) => { x.category = v; })} /></Field>
      </div>
      <Field label="Description" help="Setup notes shown when someone adds this device, e.g. which settings to turn on at the device.">
        <textarea rows={3} value={p.description ?? ""} onChange={(e) => update((x) => { x.description = e.target.value || undefined; })} />
      </Field>

      <h3 className="section">Connection</h3>
      <div className="aform two">
        <Field label="How it's controlled">
          <Pick
            value={t.type}
            options={[
              { value: "tcp", label: "Network: TCP (text or bytes)" },
              { value: "udp", label: "Network: UDP" },
              { value: "http", label: "Network: HTTP / web API" },
              { value: "serial", label: "RS-232 / serial (on a wall PC)" },
              { value: "ir", label: "IR through a Global Caché iTach" },
              { value: "androidtv", label: "Android / Google TV remote (pairing code)" },
              { value: "adb", label: "Android TV (ADB)" },
              { value: "wol", label: "Wake-on-LAN only" },
            ]}
            onChange={(v) => setT("type", v)}
          />
        </Field>
        {["tcp", "udp", "http", "adb", "androidtv"].includes(t.type) && (
          <Field label="Default port" help="Devices can override it with a port setting."><input type="number" value={t.port ?? ""} onChange={(e) => setT("port", num(e.target.value))} /></Field>
        )}
        {["tcp", "udp", "serial"].includes(t.type) && (
          <>
            <Field label="Line ending added to each send" help="e.g. \r or \r\n; empty for none"><input className="mono" type="text" value={showEscapes(t.terminator)} onChange={(e) => setT("terminator", readEscapes(e.target.value))} /></Field>
            <Field label="Replies end with" help="Splits what the device sends into messages; default \n"><input className="mono" type="text" value={showEscapes(t.delimiter)} onChange={(e) => setT("delimiter", readEscapes(e.target.value))} /></Field>
          </>
        )}
        {t.type === "serial" && <Field label="Baud rate"><input type="number" value={t.baudRate ?? ""} placeholder="9600" onChange={(e) => setT("baudRate", num(e.target.value))} /></Field>}
        {t.type === "http" && <Check value={t.https === true} onChange={(v) => setT("https", v || undefined)} label="Use HTTPS" />}
        <Field label="Pause between sends (ms)"><input type="number" value={t.minGapMs ?? ""} placeholder="50" onChange={(e) => setT("minGapMs", num(e.target.value))} /></Field>
      </div>
      {t.type === "ir" && <p className="help">IR devices need "irHost" (the iTach's IP) and "irPort" settings; add them on the Device settings tab.</p>}
      {t.type === "serial" && <p className="help">Serial devices need a "serialPort" setting (e.g. COM3); add it on the Device settings tab.</p>}
    </>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FieldDef = Record<string, any>;

/** The fields shown when adding a device of this type (IP address, zones, ...). */
function SettingsFieldsEditor({ fields, onChange, nested }: { fields: FieldDef[]; onChange: (f: FieldDef[]) => void; nested?: boolean }) {
  const set = (i: number, patch: FieldDef) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <div>
      {!nested && <p className="help">These become the form people fill in when adding a device of this type. Commands use them as {"{{settings.key}}"}.</p>}
      {fields.map((f, i) => (
        <div key={i} className="step">
          <div className="aform inline">
            <Field label="Key"><input className="mono" type="text" value={f.key} onChange={(e) => set(i, { key: e.target.value.replace(/[^\w]/g, "") })} /></Field>
            <Field label="Label"><Text value={f.label} onChange={(v) => set(i, { label: v })} /></Field>
            <Field label="Type">
              <Pick value={f.type} options={["string", "number", "integer", "boolean", "enum", ...(nested ? [] : ["list"])].map((v) => ({ value: v, label: v }))} onChange={(type) => set(i, { type, fields: type === "list" ? (f.fields ?? []) : undefined })} />
            </Field>
            <Field label="Default"><Text value={f.default === undefined ? "" : typeof f.default === "object" ? JSON.stringify(f.default) : String(f.default)} onChange={(v) => set(i, { default: parseDefault(v, f.type) })} /></Field>
            {f.type === "enum" && (
              <Field label="Choices" help="Comma-separated">
                <input type="text" key={JSON.stringify(f.values)} defaultValue={(f.values ?? []).join(", ")} onBlur={(e) => set(i, { values: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
              </Field>
            )}
            <Field label="Help"><Text value={f.help} onChange={(v) => set(i, { help: v || undefined })} /></Field>
          </div>
          <div className="row-tight">
            <Check value={f.required === true} onChange={(v) => set(i, { required: v || undefined })} label="Required" />
            <span className="grow" />
            <button className="icon" onClick={() => onChange(fields.filter((_, j) => j !== i))}>✕</button>
          </div>
          {f.type === "list" && (
            <div className="nested">
              <span className="help">Columns of each row (leave empty for a simple list like favorite channels):</span>
              <SettingsFieldsEditor nested fields={f.fields ?? []} onChange={(sub) => set(i, { fields: sub.length ? sub : undefined })} />
            </div>
          )}
        </div>
      ))}
      <button className="btn small" onClick={() => onChange([...fields, { key: "", label: "", type: "string" }])}>+ Field</button>
    </div>
  );
}

function parseDefault(v: string, type: string): unknown {
  if (v === "") return undefined;
  if (type === "number" || type === "integer") return Number.isNaN(Number(v)) ? v : Number(v);
  if (type === "boolean") return v === "true";
  if (type === "list") {
    try {
      return JSON.parse(v);
    } catch {
      return [];
    }
  }
  return v;
}

function StateTab({ p, update }: { p: RawProfile; update: (fn: (p: RawProfile) => void) => void }) {
  const rows = Object.entries((p.state ?? {}) as Record<string, FieldDef>);
  const write = (next: [string, FieldDef][]) => update((x) => { x.state = Object.fromEntries(next); });
  return (
    <div>
      <p className="help">
        Values the device reports (or that commands set), like power or volume. Declaring a type makes "1"/"true" become a real on/off. Use * for numbered parts, e.g. zones.*.gain.
      </p>
      {rows.map(([key, def], i) => (
        <div key={i} className="aform inline">
          <Field label="Key"><input className="mono" type="text" value={key} onChange={(e) => write(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} /></Field>
          <Field label="Type"><Pick value={def.type ?? "string"} options={["string", "number", "boolean", "enum"].map((v) => ({ value: v, label: v }))} onChange={(type) => write(rows.map((r, j) => (j === i ? [r[0], { ...r[1], type }] : r)))} /></Field>
          <Field label="Label"><Text value={def.label} onChange={(label) => write(rows.map((r, j) => (j === i ? [r[0], { ...r[1], label: label || undefined }] : r)))} /></Field>
          <Field label="Remove"><button className="icon" onClick={() => write(rows.filter((_, j) => j !== i))}>✕</button></Field>
        </div>
      ))}
      <button className="btn small" onClick={() => write([...rows, [`value${rows.length + 1}`, { type: "string" }]])}>+ State value</button>
    </div>
  );
}

function YamlTab({ p, onApply, readOnly }: { p: RawProfile; onApply: (p: RawProfile) => void; readOnly: boolean }) {
  const [text, setText] = useState(() => toYaml(p, { lineWidth: 0 }));
  const [error, setError] = useState<string>();
  useEffect(() => setText(toYaml(p, { lineWidth: 0 })), [p]);
  return (
    <div>
      <p className="help">The whole device type as text. Paste a profile here, or edit anything the forms don't cover, then press Apply. The format is described in docs/profiles.md.</p>
      <textarea className="mono yaml" rows={28} value={text} readOnly={readOnly} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      {error && <p className="err">{error}</p>}
      <div className="row-tight">
        {!readOnly && (
          <button
            className="btn primary"
            onClick={() => {
              try {
                const parsed = parseYaml(text);
                if (!parsed || typeof parsed !== "object") throw new Error("Not a profile");
                setError(undefined);
                onApply(parsed);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            Apply YAML
          </button>
        )}
        <button
          className="btn"
          onClick={() => {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(new Blob([text], { type: "text/yaml" }));
            a.download = `${p.id || "profile"}.yaml`;
            a.click();
          }}
        >
          Download .yaml
        </button>
      </div>
    </div>
  );
}
