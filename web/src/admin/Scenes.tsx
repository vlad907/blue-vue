import { useState } from "react";
import { adminApi, slugify, type SceneStep, type Site } from "./adminApi.ts";
import { useDraft } from "./draft.tsx";
import { Field, Num, ParamsForm, Pick, Text } from "./forms.tsx";
import { useLive } from "./live.tsx";

type Scene = Site["scenes"][number];

export function Scenes() {
  const { site, update, dirty, notice } = useDraft();
  const [open, setOpen] = useState<string>();

  const add = () => {
    const id = slugify("new scene", site.scenes.map((s) => s.id));
    update((s) => { s.scenes.push({ id, name: "New scene", steps: [] }); return s; });
    setOpen(id);
  };

  return (
    <div className="narrow">
      <div className="row-between">
        <h2>Scenes</h2>
        <button className="btn primary" onClick={add}>+ Add scene</button>
      </div>
      <p className="help">A scene runs its steps in order. If one step fails (say a device is offline), the rest still run, and the problems are listed afterwards.</p>
      {site.scenes.map((sc, i) => (
        <section key={sc.id} className="card">
          <div className="row-between clickable" onClick={() => setOpen(open === sc.id ? undefined : sc.id)}>
            <div>
              <h3>{sc.name}</h3>
              <span className="muted">{sc.description}</span>
            </div>
            <span className="row-tight" onClick={(e) => e.stopPropagation()}>
              <button className="btn small" disabled={i === 0} onClick={() => update((s) => { [s.scenes[i - 1], s.scenes[i]] = [s.scenes[i], s.scenes[i - 1]]; return s; })}>↑</button>
              <button
                className="btn small"
                disabled={dirty}
                title={dirty ? "Save first to run the latest version" : "Run this scene now"}
                onClick={() =>
                  adminApi.runScene(sc.id).then(
                    (r) => notice(r.errors.length ? `Finished with problems: ${r.errors.join("; ")}` : `${sc.name} ran`, r.errors.length > 0),
                    (err) => notice(err.message, true),
                  )
                }
              >
                ▶ Run
              </button>
              <span className="muted">{sc.steps.length} steps {open === sc.id ? "▾" : "▸"}</span>
            </span>
          </div>
          {open === sc.id && <SceneEditor scene={sc} index={i} />}
        </section>
      ))}
      {!site.scenes.length && <p className="empty">No scenes yet.</p>}
    </div>
  );
}

function SceneEditor({ scene, index }: { scene: Scene; index: number }) {
  const { update } = useDraft();
  const set = (fn: (sc: Scene) => void) => update((s) => { fn(s.scenes[index]); return s; });

  return (
    <>
      <div className="aform two">
        <Field label="Name"><Text value={scene.name} onChange={(v) => set((x) => { x.name = v; })} /></Field>
        <Field label="Description"><Text value={scene.description} onChange={(v) => set((x) => { x.description = v || undefined; })} /></Field>
      </div>
      <ol className="steps">
        {scene.steps.map((step, i) => (
          <li key={i} className="step">
            <div className="step-head">
              <b>{i + 1}</b>
              <Pick
                value={step.type}
                options={[{ value: "command", label: "Send a command" }, { value: "delay", label: "Wait" }, { value: "waitFor", label: "Wait until a device reports…" }]}
                onChange={(type) => set((x) => { x.steps[i] = blankStep(type); })}
              />
              <span className="grow" />
              <button className="btn small" disabled={i === 0} onClick={() => set((x) => { [x.steps[i - 1], x.steps[i]] = [x.steps[i], x.steps[i - 1]]; })}>↑</button>
              <button className="btn small" disabled={i === scene.steps.length - 1} onClick={() => set((x) => { [x.steps[i + 1], x.steps[i]] = [x.steps[i], x.steps[i + 1]]; })}>↓</button>
              <button className="icon" onClick={() => set((x) => { x.steps.splice(i, 1); })}>✕</button>
            </div>
            <StepEditor step={step} onChange={(st) => set((x) => { x.steps[i] = st; })} />
          </li>
        ))}
      </ol>
      <div className="row-tight">
        <button className="btn" onClick={() => set((x) => { x.steps.push(blankStep("command")); })}>+ Command</button>
        <button className="btn" onClick={() => set((x) => { x.steps.push(blankStep("delay")); })}>+ Wait</button>
        <span className="grow" />
        <button className="btn danger" onClick={() => confirm(`Remove ${scene.name}?`) && update((s) => { s.scenes.splice(index, 1); return s; })}>Remove scene</button>
      </div>
    </>
  );
}

function blankStep(type: SceneStep["type"]): SceneStep {
  if (type === "delay") return { type, ms: 1000 };
  if (type === "waitFor") return { type, device: "", state: "", equals: "", timeoutMs: 15000 };
  return { type, command: "", params: {} };
}

function StepEditor({ step, onChange }: { step: SceneStep; onChange: (s: SceneStep) => void }) {
  const { site, profiles } = useDraft();
  const live = useLive();

  if (step.type === "delay") {
    return (
      <div className="aform inline">
        <Field label="Seconds"><Num value={step.ms / 1000} min={0} step={0.5} onChange={(v) => onChange({ ...step, ms: Math.round((v ?? 0) * 1000) })} /></Field>
      </div>
    );
  }

  if (step.type === "waitFor") {
    const device = site.devices.find((d) => d.id === step.device);
    const declared = device ? Object.keys(profiles[device.profile]?.state ?? {}).filter((k) => !k.includes("*")) : [];
    const reported = device ? Object.keys(live?.devices[device.id]?.state ?? {}) : [];
    const keys = [...new Set([...declared, ...reported])];
    return (
      <div className="aform inline">
        <Field label="Device"><Pick value={step.device || undefined} options={site.devices.map((d) => ({ value: d.id, label: `${d.name} (${d.id})` }))} onChange={(v) => onChange({ ...step, device: v, state: "" })} /></Field>
        <Field label="Reports"><Pick value={step.state || undefined} options={keys.map((k) => ({ value: k, label: profiles[device!.profile]?.state[k]?.label ?? k }))} onChange={(v) => onChange({ ...step, state: v })} /></Field>
        <Field label="Equals"><Text value={String(step.equals)} onChange={(v) => onChange({ ...step, equals: v })} placeholder="e.g. on" /></Field>
        <Field label="Give up after (s)"><Num value={step.timeoutMs / 1000} min={1} onChange={(v) => onChange({ ...step, timeoutMs: Math.round((v ?? 15) * 1000) })} /></Field>
      </div>
    );
  }

  // A command for one device, or for every device in a group.
  const targetIsGroup = step.group !== undefined;
  const group = targetIsGroup ? site.groups.find((g) => g.id === step.group) : undefined;
  const device = site.devices.find((d) => d.id === (targetIsGroup ? group?.devices[0] : step.device));
  const profile = device ? profiles[device.profile] : undefined;
  const commands = Object.entries(profile?.commands ?? {}).filter(([, c]) => !c.hidden);
  const cmd = profile?.commands[step.command];
  // Panels share names like "Top Left", so add the wall or room to tell them apart.
  const where = (id: string) => site.groups.find((g) => g.kind === "wall" && g.devices.includes(id))?.name ?? site.rooms.find((r) => r.id === site.devices.find((d) => d.id === id)?.room)?.name;
  const targets = [
    ...site.devices.map((d) => ({ value: `d:${d.id}`, label: where(d.id) ? `${d.name} · ${where(d.id)}` : d.name })),
    ...site.groups.map((g) => ({ value: `g:${g.id}`, label: `${g.name} (all devices)` })),
  ];

  return (
    <>
      <div className="aform inline">
        <Field label="Device or wall">
          <Pick
            value={step.group !== undefined ? `g:${step.group}` : step.device ? `d:${step.device}` : undefined}
            options={targets}
            onChange={(v) => {
              const [kind, id] = [v.slice(0, 1), v.slice(2)];
              onChange(kind === "g" ? { type: "command", group: id, command: "", params: {} } : { type: "command", device: id, command: "", params: {} });
            }}
          />
        </Field>
        <Field label="Command">
          <Pick value={step.command || undefined} options={commands.map(([k, c]) => ({ value: k, label: c.label ?? k }))} onChange={(command) => onChange({ ...step, command, params: {} })} />
        </Field>
      </div>
      {cmd && <ParamsForm params={cmd.params} value={step.params} onChange={(params) => onChange({ ...step, params })} settings={device?.settings} />}
      {targetIsGroup && group && group.devices.some((id) => site.devices.find((d) => d.id === id)?.profile !== device?.profile) && (
        <p className="help">This wall has more than one device type; the command must exist on all of them.</p>
      )}
    </>
  );
}
