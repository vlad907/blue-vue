import { useState } from "react";
import { adminApi, type RawProfile, type SettingField } from "./adminApi.ts";
import { useDraft } from "./draft.tsx";
import { Check, Field, ParamsForm, Pick, SettingsForm, Text, defaultSettings } from "./forms.tsx";
import { MapEditor, StepsEditor } from "./StepsEditor.tsx";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = Record<string, any>;
type Update = (fn: (p: RawProfile) => void) => void;

// --- Commands ---------------------------------------------------------------

export function CommandsTab({ p, update }: { p: RawProfile; update: Update }) {
  const names = Object.keys(p.commands ?? {});
  const [current, setCurrent] = useState<string | undefined>(names[0]);
  const cmd: Any | undefined = current ? p.commands?.[current] : undefined;
  const setCmd = (fn: (c: Any) => void) => update((x) => { fn(x.commands[current!]); });

  const add = () => {
    let name = "new_command";
    for (let i = 2; p.commands?.[name]; i++) name = `new_command_${i}`;
    update((x) => { x.commands = { ...(x.commands ?? {}), [name]: { label: "New command", steps: [] } }; });
    setCurrent(name);
  };
  const rename = (to: string) => {
    if (!to || to === current || p.commands[to]) return;
    update((x) => {
      // Keep the order, and point capabilities at the new name.
      x.commands = Object.fromEntries(Object.entries(x.commands).map(([k, v]) => [k === current ? to : k, v]));
      for (const cap of Object.values((x.capabilities ?? {}) as Record<string, Any>)) for (const k of Object.keys(cap)) if (cap[k] === current) cap[k] = to;
    });
    setCurrent(to);
  };

  return (
    <div className="two-col">
      <div className="cmd-list">
        {names.map((n) => (
          <button key={n} className={n === current ? "active" : ""} onClick={() => setCurrent(n)}>
            {p.commands[n].label ?? n}
            <span className="muted mono">{n}</span>
          </button>
        ))}
        <button className="btn small" onClick={add}>+ Command</button>
      </div>
      {cmd ? (
        <div>
          <div className="aform two">
            <Field label="Label" help="What people see, e.g. Power on"><Text value={cmd.label} onChange={(v) => setCmd((c) => { c.label = v || undefined; })} /></Field>
            <Field label="Name" help="Used by scenes and roles; letters, numbers, _">
              <input className="mono" type="text" defaultValue={current} key={current} onBlur={(e) => rename(e.target.value.replace(/[^\w]/g, ""))} />
            </Field>
          </div>
          <Check value={cmd.hidden === true} onChange={(v) => setCmd((c) => { c.hidden = v || undefined; })} label="Helper only (don't offer it in scenes)" />

          <h3 className="section">Values it takes</h3>
          <ParamsEditor params={cmd.params ?? {}} onChange={(params) => setCmd((c) => { c.params = Object.keys(params).length ? params : undefined; })} />

          <h3 className="section">What it sends</h3>
          <StepsEditor steps={cmd.steps ?? []} onChange={(steps) => setCmd((c) => { c.steps = steps; })} profile={p} />

          <h3 className="section">State it sets right away</h3>
          <p className="help">For devices that don't report back (like IR), e.g. power → on, or channel → {"{{channel}}"}.</p>
          <MapEditor value={cmd.sets} onChange={(sets) => setCmd((c) => { c.sets = sets; })} keyLabel="State key" valueLabel="Value" keyPlaceholder="power" valuePlaceholder="on" />

          {["http", "adb"].includes(p.transport?.type) && (
            <>
              <h3 className="section">Read its reply</h3>
              <RulesEditor rules={cmd.parse ?? []} onChange={(parse) => setCmd((c) => { c.parse = parse.length ? parse : undefined; })} p={p} />
            </>
          )}

          <Preview p={p} command={current!} />
          <div className="row-tight drawer-actions">
            <span className="grow" />
            <button className="btn danger small" onClick={() => { if (confirm(`Delete command ${current}?`)) { update((x) => { delete x.commands[current!]; }); setCurrent(names.find((n) => n !== current)); } }}>
              Delete command
            </button>
          </div>
        </div>
      ) : (
        <p className="empty">No commands yet.</p>
      )}
    </div>
  );
}

function ParamsEditor({ params, onChange }: { params: Record<string, Any>; onChange: (p: Record<string, Any>) => void }) {
  const rows = Object.entries(params);
  const write = (next: [string, Any][]) => onChange(Object.fromEntries(next));
  const set = (i: number, patch: Any) => write(rows.map((r, j) => (j === i ? [r[0], { ...r[1], ...patch }] : r)));
  return (
    <div>
      {rows.map(([name, def], i) => (
        <div key={i} className="step">
          <div className="aform inline">
            <Field label="Name" help="Use as {{name}} in steps"><input className="mono" type="text" value={name} onChange={(e) => write(rows.map((r, j) => (j === i ? [e.target.value.replace(/[^\w]/g, ""), r[1]] : r)))} /></Field>
            <Field label="Label"><Text value={def.label} onChange={(v) => set(i, { label: v || undefined })} /></Field>
            <Field label="Type">
              <Pick value={def.type} options={["number", "integer", "boolean", "string", "enum"].map((v) => ({ value: v, label: v }))} onChange={(type) => set(i, { type })} />
            </Field>
            {(def.type === "number" || def.type === "integer") && (
              <>
                <Field label="Min"><input type="number" value={def.min ?? ""} onChange={(e) => set(i, { min: e.target.value === "" ? undefined : Number(e.target.value) })} /></Field>
                <Field label="Max"><input type="number" value={def.max ?? ""} onChange={(e) => set(i, { max: e.target.value === "" ? undefined : Number(e.target.value) })} /></Field>
              </>
            )}
            {def.type === "enum" && (
              <Field label="Choices" help="Comma-separated; label with value=Label">
                {/* Parsed when you leave the box, so commas you type aren't swallowed mid-edit. */}
                <input
                  type="text"
                  key={JSON.stringify([def.values, def.labels])}
                  defaultValue={(def.values ?? []).map((v: string) => (def.labels?.[v] ? `${v}=${def.labels[v]}` : v)).join(", ")}
                  placeholder="31=HDMI 1, 32=HDMI 2"
                  onBlur={(e) => {
                    const parts = e.target.value.split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.split("="));
                    const labels = Object.fromEntries(parts.filter((x) => x[1]).map(([k, l]) => [k.trim(), l.trim()]));
                    set(i, { values: parts.map(([k]) => k.trim()), labels: Object.keys(labels).length ? labels : undefined });
                  }}
                />
              </Field>
            )}
            <Field label="Choices from setting" help="e.g. settings.zones"><Text value={def.optionsFrom} onChange={(v) => set(i, { optionsFrom: v || undefined })} /></Field>
            <Field label="Remove"><button className="icon" onClick={() => write(rows.filter((_, j) => j !== i))}>✕</button></Field>
          </div>
        </div>
      ))}
      <button className="btn small" onClick={() => write([...rows, [`value${rows.length + 1}`, { type: "integer" }]])}>+ Value</button>
    </div>
  );
}

/** Renders a command on the server without sending it. */
function Preview({ p, command }: { p: RawProfile; command: string }) {
  const settingsFields: SettingField[] = p.settings ?? [];
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [settings, setSettings] = useState<Record<string, unknown>>(() => defaultSettings(settingsFields));
  const [result, setResult] = useState<{ sent?: string[]; state?: Record<string, unknown>; warnings?: string[]; problems: string[] }>();
  const cmd = p.commands?.[command];
  return (
    <details className="card preview" open>
      <summary>Try it: see exactly what this command sends</summary>
      {cmd?.params && Object.keys(cmd.params).length > 0 && <ParamsForm params={cmd.params} value={params} onChange={setParams} settings={settings} />}
      {settingsFields.length > 0 && (
        <details>
          <summary className="muted">Example device settings</summary>
          <SettingsForm fields={settingsFields} value={settings} onChange={setSettings} />
        </details>
      )}
      <button className="btn" onClick={() => adminApi.previewCommand(p, command, params, settings).then(setResult, (err) => setResult({ problems: [err.message] }))}>
        Show what it sends
      </button>
      {result && (
        <div className="preview-out">
          {result.problems.map((x) => <p key={x} className="err">{x}</p>)}
          {result.warnings?.map((x) => <p key={x} className="help bad-text">{x}</p>)}
          {result.sent && (
            <pre className="state">{result.sent.length ? result.sent.map((s, i) => `${i + 1}. ${s}`).join("\n") : "(nothing sent)"}</pre>
          )}
          {result.state && Object.keys(result.state).length > 0 && <div className="muted">Sets: {Object.entries(result.state).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ")}</div>}
        </div>
      )}
    </details>
  );
}

// --- Feedback & polling ------------------------------------------------------

export function FeedbackTab({ p, update }: { p: RawProfile; update: Update }) {
  const persistent = ["tcp", "udp", "serial"].includes(p.transport?.type);
  return (
    <div>
      {persistent && (
        <>
          <h3 className="section">Read messages from the device</h3>
          <p className="help">Each rule looks at every message the device sends and turns matches into state.</p>
          <RulesEditor rules={p.feedback ?? []} onChange={(feedback) => update((x) => { x.feedback = feedback.length ? feedback : undefined; })} p={p} />
        </>
      )}

      <h3 className="section">Ask for status regularly</h3>
      <p className="help">{persistent ? "Replies are read by the rules above." : "Each poll reads its own reply."}</p>
      {(p.polls ?? []).map((poll: Any, i: number) => (
        <div key={i} className="card">
          <div className="row-tight">
            <Field label="Every (seconds)">
              <input type="number" min={1} value={poll.every} onChange={(e) => update((x) => { x.polls[i].every = Number(e.target.value) || 15; })} />
            </Field>
            <span className="grow" />
            <button className="icon" onClick={() => update((x) => { x.polls.splice(i, 1); })}>✕</button>
          </div>
          <StepsEditor steps={poll.steps ?? []} onChange={(steps) => update((x) => { x.polls[i].steps = steps; })} profile={p} />
          {!persistent && (
            <>
              <h4>Read the reply</h4>
              <RulesEditor rules={poll.parse ?? []} onChange={(parse) => update((x) => { x.polls[i].parse = parse.length ? parse : undefined; })} p={p} />
            </>
          )}
        </div>
      ))}
      <button className="btn small" onClick={() => update((x) => { x.polls = [...(x.polls ?? []), { every: 15, steps: [] }]; })}>+ Status poll</button>

      {persistent && (
        <>
          <h3 className="section">Send when connected</h3>
          <p className="help">e.g. log in, or subscribe to updates. Runs again after every reconnect.</p>
          <StepsEditor steps={p.onConnect ?? []} onChange={(steps) => update((x) => { x.onConnect = steps.length ? steps : undefined; })} profile={p} />

          <h3 className="section">Keep the connection alive</h3>
          {p.keepalive ? (
            <div className="card">
              <div className="row-tight">
                <Field label="Every (seconds)"><input type="number" min={1} value={p.keepalive.every} onChange={(e) => update((x) => { x.keepalive.every = Number(e.target.value) || 30; })} /></Field>
                <span className="grow" />
                <button className="icon" onClick={() => update((x) => { delete x.keepalive; })}>✕</button>
              </div>
              <StepsEditor steps={p.keepalive.steps ?? []} onChange={(steps) => update((x) => { x.keepalive.steps = steps; })} profile={p} />
            </div>
          ) : (
            <button className="btn small" onClick={() => update((x) => { x.keepalive = { every: 30, steps: [] }; })}>+ Keepalive</button>
          )}
        </>
      )}
    </div>
  );
}

/** Parse rules, each with a sample box to test against. */
function RulesEditor({ rules, onChange, p }: { rules: Any[]; onChange: (r: Any[]) => void; p: RawProfile }) {
  const kindOf = (r: Any) => (r.xmlTag !== undefined ? "xmlTag" : r.jsonPath !== undefined ? "jsonPath" : "regex");
  const set = (i: number, r: Any) => onChange(rules.map((x, j) => (j === i ? r : x)));
  return (
    <div>
      {rules.map((r, i) => {
        const kind = kindOf(r);
        return (
          <div key={i} className="step">
            <div className="aform inline wide-second">
              <Field label="Find">
                <Pick
                  value={kind}
                  options={[{ value: "regex", label: "Pattern (regex)" }, { value: "xmlTag", label: "XML tag" }, { value: "jsonPath", label: "JSON value" }]}
                  onChange={(k) => set(i, { [k]: r[kind] ?? "", set: r.set ?? {} })}
                />
              </Field>
              <Field label={kind === "regex" ? "Pattern" : kind === "xmlTag" ? "Tag name" : "Path"} help={kind === "regex" ? "The first ( ) group becomes {{value}}; (?<name>…) groups become {{name}}" : kind === "jsonPath" ? "e.g. $.status.power" : "e.g. power-mode"}>
                <input className="mono" type="text" value={r[kind] ?? ""} onChange={(e) => set(i, { ...r, [kind]: e.target.value })} />
              </Field>
              <Field label="Remove"><button className="icon" onClick={() => onChange(rules.filter((_, j) => j !== i))}>✕</button></Field>
            </div>
            <MapEditor value={r.set} onChange={(s) => set(i, { ...r, set: s ?? {} })} keyLabel="Sets state" valueLabel="To" keyPlaceholder="power" valuePlaceholder="{{value | map:1=on,*=off}}" />
            <RuleTester rule={r} p={p} />
          </div>
        );
      })}
      <button className="btn small" onClick={() => onChange([...rules, { regex: "", set: {} }])}>+ Rule</button>
    </div>
  );
}

function RuleTester({ rule, p }: { rule: Any; p: RawProfile }) {
  const [sample, setSample] = useState("");
  const [out, setOut] = useState<string>();
  return (
    <div className="row-tight tester">
      <input className="mono" type="text" placeholder="Paste a sample reply to test, e.g. %1POWR=1" value={sample} onChange={(e) => setSample(e.target.value)} />
      <button
        className="btn small"
        disabled={!sample}
        onClick={() =>
          adminApi.parseTest([rule], sample, defaultSettings(p.settings ?? [])).then(
            (r) => setOut(r.problems.length ? r.problems.join("; ") : Object.keys(r.updates ?? {}).length ? Object.entries(r.updates!).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ") : "no match"),
            (err) => setOut(err.message),
          )
        }
      >
        Test
      </button>
      {out && <span className="mono muted">→ {out}</span>}
    </div>
  );
}

// --- IR codes ------------------------------------------------------------------

export function IrCodesTab({ p, update }: { p: RawProfile; update: Update }) {
  const { site, notice } = useDraft();
  const codes = Object.entries((p.irCodes ?? {}) as Record<string, string>);
  const [location, setLocation] = useState("server");
  const [irHost, setIrHost] = useState("");
  const [listening, setListening] = useState<string>();
  const used = new Set<string>();
  const walk = (steps: Any[] = []) => steps.forEach((s) => { if (typeof s.ir === "string" && !s.ir.includes("{{")) used.add(s.ir); walk(s.steps); });
  Object.values((p.commands ?? {}) as Record<string, Any>).forEach((c) => walk(c.steps));
  const missing = [...used].filter((k) => !p.irCodes?.[k]);

  const write = (next: [string, string][]) => update((x) => { x.irCodes = Object.fromEntries(next); });
  const learn = async (key: string) => {
    if (!irHost) return notice("Enter the iTach's IP address first", true);
    setListening(key);
    try {
      const { pronto } = await adminApi.learnIr(location, irHost);
      update((x) => { x.irCodes = { ...(x.irCodes ?? {}), [key]: pronto }; });
      notice(`Learned ${key}`);
    } catch (err) {
      notice(err instanceof Error ? err.message : String(err), true);
    } finally {
      setListening(undefined);
    }
  };

  return (
    <div>
      <p className="help">
        Codes are raw Pronto hex. Paste them (Global Caché's free Control Tower database has many), or learn them from the original remote with an iTach.
      </p>
      <section className="card">
        <h4>Learn with an iTach</h4>
        <div className="aform inline">
          <Field label="iTach reached from">
            <Pick value={location} options={[{ value: "server", label: "Control server" }, ...site.agents.map((a) => ({ value: a.id, label: a.name }))]} onChange={setLocation} />
          </Field>
          <Field label="iTach IP address"><Text value={irHost} onChange={setIrHost} placeholder="10.0.10.31" /></Field>
        </div>
        <p className="help">Press Learn, then hold the remote 2-4 inches from the iTach's learning window and press the button briefly.</p>
      </section>
      {missing.length > 0 && <p className="help bad-text">Commands use codes that aren't here yet: {missing.join(", ")}</p>}
      {[...codes, ...missing.map((k) => [k, ""] as [string, string])].map(([key, code], i) => (
        <div key={key + i} className="ir-row">
          <input className="mono" type="text" value={key} onChange={(e) => write(codes.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
          <textarea className="mono" rows={2} value={code} placeholder="0000 006D 0000 0022 ..." onChange={(e) => write(i < codes.length ? codes.map((r, j) => (j === i ? [r[0], e.target.value] : r)) : [...codes, [key, e.target.value]])} />
          <button className="btn small" disabled={!!listening} onClick={() => learn(key)}>{listening === key ? "Listening…" : "Learn"}</button>
          {i < codes.length && <button className="icon" onClick={() => write(codes.filter((_, j) => j !== i))}>✕</button>}
        </div>
      ))}
      <button className="btn small" onClick={() => write([...codes, [`KEY_${codes.length + 1}`, ""]])}>+ Code</button>
    </div>
  );
}

// --- Panel controls and roles ---------------------------------------------------

const CONTROL_TYPES = ["toggle", "button", "slider", "select", "presets", "keypad", "dpad", "status", "group"];

export function ControlsEditor({ controls, onChange, p }: { controls: Any[]; onChange: (c: Any[]) => void; p: RawProfile }) {
  const commands = Object.keys(p.commands ?? {});
  const cmdPick = (value: string | undefined, onPick: (v: string | undefined) => void) => (
    <Pick value={value} empty="—" options={commands.map((c) => ({ value: c, label: c }))} onChange={(v) => onPick(v || undefined)} />
  );
  const set = (i: number, patch: Any) => onChange(controls.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div>
      {controls.map((c, i) => (
        <div key={i} className="step">
          <div className="step-head">
            <Pick value={c.type} options={CONTROL_TYPES.map((t) => ({ value: t, label: t }))} onChange={(type) => set(i, { type })} />
            <Text value={c.label} onChange={(v) => set(i, { label: v || undefined })} placeholder="Label" />
            <span className="grow" />
            <button className="btn small" disabled={i === 0} onClick={() => onChange(controls.map((x, j) => (j === i - 1 ? controls[i] : j === i ? controls[i - 1] : x)))}>↑</button>
            <button className="icon" onClick={() => onChange(controls.filter((_, j) => j !== i))}>✕</button>
          </div>
          <div className="aform inline">
            {c.type === "toggle" && (
              <>
                <Field label="On command">{cmdPick(c.on, (on) => set(i, { on }))}</Field>
                <Field label="Off command">{cmdPick(c.off, (off) => set(i, { off }))}</Field>
              </>
            )}
            {!["status", "group"].includes(c.type) && <Field label={c.type === "toggle" ? "Or one command" : "Command"}>{cmdPick(c.command, (command) => set(i, { command }))}</Field>}
            {["toggle", "slider", "select", "presets", "keypad", "dpad"].includes(c.type) && c.command && (
              <Field label="Value goes to">
                <Pick value={c.param} empty="—" options={Object.keys(p.commands?.[c.command]?.params ?? {}).map((x) => ({ value: x, label: x }))} onChange={(param) => set(i, { param: param || undefined })} />
              </Field>
            )}
            {!["button", "keypad", "dpad", "group"].includes(c.type) && <Field label="Shows state"><input className="mono" type="text" value={c.state ?? ""} onChange={(e) => set(i, { state: e.target.value || undefined })} /></Field>}
            {["select", "presets"].includes(c.type) && <Field label="Choices from setting" help="Optional, e.g. settings.favorites"><Text value={c.options} onChange={(v) => set(i, { options: v || undefined })} /></Field>}
            {c.type === "group" && <Field label="Repeat for each" help="e.g. settings.zones; inside use {{item.name}}"><Text value={c.repeat} onChange={(v) => set(i, { repeat: v || undefined })} /></Field>}
          </div>
          {c.type === "dpad" && (
            <MapEditor value={c.keys} onChange={(keys) => set(i, { keys })} keyLabel="Button (up, down, left, right, ok, back, menu, guide, exit…)" valueLabel="Sends value" />
          )}
          {c.type === "group" && (
            <div className="nested">
              <ControlsEditor controls={c.controls ?? []} onChange={(sub) => set(i, { controls: sub })} p={p} />
            </div>
          )}
        </div>
      ))}
      <button className="btn small" onClick={() => onChange([...controls, { type: "button" }])}>+ Control</button>
    </div>
  );
}

const ROLES: { cap: string; label: string; help: string; fields: [string, string, "command" | "param" | "text"][] }[] = [
  { cap: "power", label: "Power", help: "Lets walls, All on/off and scenes switch it on and off.", fields: [["on", "On command", "command"], ["off", "Off command", "command"], ["state", "Power state", "text"]] },
  { cap: "tuner", label: "Tuner", help: "Lets the TV guide and favorites tune it.", fields: [["tune", "Tune command", "command"], ["param", "Channel value", "param"], ["state", "Channel state", "text"]] },
  { cap: "volume", label: "Volume", help: "", fields: [["set", "Set volume command", "command"], ["param", "Level value", "param"], ["mute", "Mute command", "command"]] },
  { cap: "source", label: "Input / source", help: "", fields: [["select", "Select command", "command"], ["param", "Input value", "param"]] },
  { cap: "layoutPresets", label: "Video wall layouts", help: "Shows its layouts on the Video Walls tab.", fields: [["recall", "Recall command", "command"], ["param", "Preset value", "param"], ["optionsFrom", "Layouts from setting", "text"]] },
];

export function CapabilitiesEditor({ p, update }: { p: RawProfile; update: Update }) {
  const caps = (p.capabilities ?? {}) as Record<string, Any>;
  const commands = Object.keys(p.commands ?? {});
  return (
    <div>
      {ROLES.map((role) => {
        const cap = caps[role.cap];
        const mainCmd = cap?.[role.fields[0][0]];
        return (
          <div key={role.cap} className="step">
            <Check
              value={!!cap}
              label={role.label}
              onChange={(on) => update((x) => {
                x.capabilities = { ...(x.capabilities ?? {}) };
                if (on) x.capabilities[role.cap] = {};
                else delete x.capabilities[role.cap];
              })}
            />
            {role.help && <span className="help"> {role.help}</span>}
            {cap && (
              <div className="aform inline">
                {role.fields.map(([key, label, kind]) => (
                  <Field key={key} label={label}>
                    {kind === "command" ? (
                      <Pick value={cap[key]} empty="—" options={commands.map((c) => ({ value: c, label: c }))} onChange={(v) => update((x) => { x.capabilities[role.cap][key] = v || undefined; })} />
                    ) : kind === "param" ? (
                      <Pick value={cap[key]} empty="—" options={Object.keys(p.commands?.[mainCmd]?.params ?? {}).map((x) => ({ value: x, label: x }))} onChange={(v) => update((x) => { x.capabilities[role.cap][key] = v || undefined; })} />
                    ) : (
                      <input className="mono" type="text" value={cap[key] ?? ""} onChange={(e) => update((x) => { x.capabilities[role.cap][key] = e.target.value || undefined; })} />
                    )}
                  </Field>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
