import type { RawProfile } from "./adminApi.ts";
import { Field, Pick, Text } from "./forms.tsx";

// Edits a list of profile steps (what a command, poll or connect sequence
// sends). Loops nest, so this renders itself for their inner steps.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Step = Record<string, any>;

const KINDS = [
  { value: "send", label: "Send text", transports: ["tcp", "udp", "serial"] },
  { value: "hex", label: "Send bytes (hex)", transports: ["tcp", "udp", "serial"] },
  { value: "http", label: "HTTP request", transports: ["http"] },
  { value: "ir", label: "IR code", transports: ["ir"] },
  { value: "adb", label: "ADB shell", transports: ["adb"] },
  { value: "wol", label: "Wake-on-LAN", transports: ["wol"] },
  { value: "androidtv", label: "Android TV remote", transports: ["androidtv"] },
  { value: "delay", label: "Wait" },
  { value: "forEachChar", label: "For each character…" },
  { value: "forEach", label: "For each item in a list…" },
  { value: "command", label: "Run another command" },
] as const;

type Kind = (typeof KINDS)[number]["value"];

export function kindOf(step: Step): Kind {
  for (const k of ["forEachChar", "forEach", "delay", "command", "send", "hex", "http", "ir", "adb", "wol", "androidtv"] as const) if (k in step) return k;
  return "send";
}

function blank(kind: Kind): Step {
  switch (kind) {
    case "send": return { send: "" };
    case "hex": return { hex: "" };
    case "http": return { http: { method: "GET", path: "/" } };
    case "ir": return { ir: "" };
    case "adb": return { adb: "" };
    case "wol": return { wol: true };
    case "androidtv": return { androidtv: { key: "HOME" } };
    case "delay": return { delay: 500 };
    case "forEachChar": return { forEachChar: "{{channel}}", steps: [] };
    case "forEach": return { forEach: "settings.zones", steps: [] };
    case "command": return { command: "" };
  }
}

/** The first payload kind that fits the transport, for new steps. */
export function defaultKind(transport: string): Kind {
  return (KINDS.find((k) => "transports" in k && (k.transports as readonly string[]).includes(transport))?.value ?? "delay") as Kind;
}

export function StepsEditor({ steps, onChange, profile }: { steps: Step[]; onChange: (s: Step[]) => void; profile: RawProfile }) {
  const transport: string = profile.transport?.type ?? "tcp";
  const kinds = KINDS.filter((k) => !("transports" in k) || (k.transports as readonly string[]).includes(transport));
  const set = (i: number, step: Step) => onChange(steps.map((s, j) => (j === i ? step : s)));

  return (
    <div className="steps-ed">
      {steps.map((step, i) => {
        const kind = kindOf(step);
        return (
          <div key={i} className="step">
            <div className="step-head">
              <b>{i + 1}</b>
              <Pick value={kind} options={kinds.map((k) => ({ value: k.value, label: k.label }))} onChange={(k) => set(i, blank(k))} />
              {!kinds.some((k) => k.value === kind) && <span className="bad-text">doesn't fit a {transport} device</span>}
              <span className="grow" />
              <button className="btn small" disabled={i === 0} onClick={() => onChange(swap(steps, i, i - 1))}>↑</button>
              <button className="btn small" disabled={i === steps.length - 1} onClick={() => onChange(swap(steps, i, i + 1))}>↓</button>
              <button className="icon" onClick={() => onChange(steps.filter((_, j) => j !== i))}>✕</button>
            </div>
            <StepFields step={step} kind={kind} onChange={(s) => set(i, s)} profile={profile} />
          </div>
        );
      })}
      <button className="btn small" onClick={() => onChange([...steps, blank(defaultKind(transport))])}>+ Step</button>
    </div>
  );
}

function StepFields({ step, kind, onChange, profile }: { step: Step; kind: Kind; onChange: (s: Step) => void; profile: RawProfile }) {
  const repeat = (
    <Field label="Repeat">
      <input type="number" min={1} max={10} value={step.repeat ?? 1} onChange={(e) => onChange({ ...step, repeat: Number(e.target.value) > 1 ? Number(e.target.value) : undefined })} />
    </Field>
  );
  switch (kind) {
    case "send":
      return (
        <div className="aform inline wide-first">
          <Field label="Text" help={'Use {{param}} for values. \\r, \\n and \\x0D work. The line ending from Connection is added.'}>
            <input className="mono" type="text" value={step.send} onChange={(e) => onChange({ ...step, send: e.target.value })} placeholder="%1POWR {{on | bool:1:0}}" />
          </Field>
          {repeat}
        </div>
      );
    case "hex":
      return (
        <Field label="Bytes" help="Hex, spaces optional, e.g. AA 01 {{level | hex:2}}">
          <input className="mono" type="text" value={step.hex} onChange={(e) => onChange({ ...step, hex: e.target.value })} />
        </Field>
      );
    case "http":
      return (
        <div className="aform inline wide-second">
          <Field label="Method">
            <Pick value={step.http.method ?? "GET"} options={["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m }))} onChange={(method) => onChange({ http: { ...step.http, method } })} />
          </Field>
          <Field label="Path" help="e.g. /keypress/{{key}}">
            <input className="mono" type="text" value={step.http.path} onChange={(e) => onChange({ http: { ...step.http, path: e.target.value } })} />
          </Field>
          <Field label="Body (optional)">
            <input className="mono" type="text" value={step.http.body ?? ""} onChange={(e) => onChange({ http: { ...step.http, body: e.target.value || undefined } })} />
          </Field>
        </div>
      );
    case "ir":
      return (
        <div className="aform inline wide-first">
          <Field label="IR code name" help="A name from the IR codes tab, e.g. KEY_POWERON or KEY_{{item}}">
            <input className="mono" type="text" list="ir-code-names" value={step.ir} onChange={(e) => onChange({ ...step, ir: e.target.value })} />
            <datalist id="ir-code-names">
              {Object.keys(profile.irCodes ?? {}).map((k) => <option key={k} value={k} />)}
            </datalist>
          </Field>
          {repeat}
        </div>
      );
    case "adb":
      return (
        <Field label="Shell command" help="e.g. input keyevent KEYCODE_WAKEUP">
          <input className="mono" type="text" value={step.adb} onChange={(e) => onChange({ ...step, adb: e.target.value })} />
        </Field>
      );
    case "wol":
      return <p className="help">Sends a wake-on-LAN packet to the device's MAC address (needs a "mac" setting).</p>;
    case "androidtv": {
      const a = step.androidtv ?? {};
      const mode = a.power !== undefined ? "power" : a.appLink !== undefined ? "appLink" : "key";
      return (
        <div className="aform inline">
          <Field label="Action">
            <Pick
              value={mode}
              options={[
                { value: "key", label: "Press a key" },
                { value: "power", label: "Power on/off (checks the TV's state first)" },
                { value: "appLink", label: "Open an app link" },
              ]}
              onChange={(m) => onChange({ androidtv: m === "power" ? { power: "on" } : m === "appLink" ? { appLink: "" } : { key: "HOME" } })}
            />
          </Field>
          <Field label={mode === "power" ? "on or off" : mode === "appLink" ? "Link" : "Key"} help={mode === "key" ? "e.g. HOME, DPAD_UP, TV_INPUT_HDMI_1, a number, or {{key}}" : undefined}>
            <input className="mono" type="text" value={String(a[mode] ?? "")} onChange={(e) => onChange({ androidtv: { [mode]: e.target.value } })} />
          </Field>
        </div>
      );
    }
    case "delay":
      return (
        <Field label="Milliseconds" help="A number, or a setting like {{settings.digitDelayMs}}">
          <Text value={String(step.delay)} onChange={(v) => onChange({ delay: /^\d+$/.test(v) ? Number(v) : v })} />
        </Field>
      );
    case "forEachChar":
    case "forEach":
      return (
        <>
          <Field
            label={kind === "forEachChar" ? "Characters of" : "Each item in"}
            help={kind === "forEachChar" ? "e.g. {{channel}}. Inside, {{item}} is the current character." : "A settings list, e.g. settings.zones. Inside, {{item.index}} etc."}
          >
            <input className="mono" type="text" value={step[kind]} onChange={(e) => onChange({ ...step, [kind]: e.target.value })} />
          </Field>
          <div className="nested">
            <StepsEditor steps={step.steps ?? []} onChange={(steps) => onChange({ ...step, steps })} profile={profile} />
          </div>
        </>
      );
    case "command":
      return (
        <div className="aform inline">
          <Field label="Command">
            <Pick value={step.command || undefined} options={Object.keys(profile.commands ?? {}).map((c) => ({ value: c, label: c }))} onChange={(command) => onChange({ ...step, command })} />
          </Field>
          <Field label="Params (JSON, optional)" help='e.g. {"input": "hdmi1"}'>
            <JsonInput value={step.params} onChange={(params) => onChange({ ...step, params })} />
          </Field>
        </div>
      );
  }
}

function JsonInput({ value, onChange }: { value: unknown; onChange: (v: Record<string, unknown> | undefined) => void }) {
  return (
    <input
      className="mono"
      type="text"
      defaultValue={value ? JSON.stringify(value) : ""}
      onBlur={(e) => {
        const t = e.target.value.trim();
        if (!t) return onChange(undefined);
        try {
          onChange(JSON.parse(t));
          e.target.classList.remove("invalid");
        } catch {
          e.target.classList.add("invalid");
        }
      }}
    />
  );
}

function swap<T>(list: T[], a: number, b: number) {
  const next = [...list];
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}

/** Key → value template rows, used for `sets` and parse-rule `set` maps. */
export function MapEditor({ value, onChange, keyLabel, valueLabel, keyPlaceholder, valuePlaceholder }: {
  value: Record<string, string> | undefined;
  onChange: (v: Record<string, string> | undefined) => void;
  keyLabel: string;
  valueLabel: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const rows = Object.entries(value ?? {});
  const write = (next: [string, string][]) => onChange(next.length ? Object.fromEntries(next) : undefined);
  return (
    <div className="listtable">
      {rows.length > 0 && (
        <div className="lt-row lt-head" style={{ gridTemplateColumns: "1fr 1fr 36px" }}>
          <span>{keyLabel}</span>
          <span>{valueLabel}</span>
          <span />
        </div>
      )}
      {rows.map(([k, v], i) => (
        <div key={i} className="lt-row" style={{ gridTemplateColumns: "1fr 1fr 36px" }}>
          <input className="mono" type="text" value={k} placeholder={keyPlaceholder} onChange={(e) => write(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
          <input className="mono" type="text" value={v} placeholder={valuePlaceholder} onChange={(e) => write(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
          <button className="icon" onClick={() => write(rows.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="btn small" onClick={() => write([...rows, [rows.some(([k]) => k === "") ? `key${rows.length}` : "", ""]])}>+ Add</button>
    </div>
  );
}
