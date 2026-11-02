import { useEffect, useMemo, useRef, useState } from "react";
import { adminApi, slugify, type LogEntry, type SiteDevice } from "./adminApi.ts";
import { useDraft } from "./draft.tsx";
import { Check, Field, ParamsForm, Pick, SettingsForm, Text, defaultSettings } from "./forms.tsx";
import { useLive } from "./live.tsx";

const CATEGORY_LABELS: Record<string, string> = {
  display: "Displays", tuner: "Tuners", audio: "Audio", "video-wall": "Video walls", switcher: "Switchers",
  projector: "Projectors", lighting: "Lighting", other: "Other",
};

export function Devices() {
  const { site, update, profiles, dirty } = useDraft();
  const state = useLive();
  const [editing, setEditing] = useState<string | null>(null); // device id, or "" for a new one
  const [testing, setTesting] = useState<string>();

  const agentName = (id: string) => (id === "server" ? "Control server" : site.agents.find((a) => a.id === id)?.name ?? id);
  const roomName = (id?: string) => site.rooms.find((r) => r.id === id)?.name ?? "";

  return (
    <div className="split">
      <div>
        <div className="row-between">
          <h2>Devices</h2>
          <button className="btn primary" onClick={() => setEditing("")}>+ Add device</button>
        </div>
        <table className="atable">
          <thead>
            <tr><th>Name</th><th>Type</th><th>Reached from</th><th>Room</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {site.devices.map((d) => {
              const live = state?.devices[d.id];
              const status = !live ? "not saved yet" : live.problem ? live.problem : live.online ? "online" : (live.error ?? "offline");
              const cls = !live ? "" : live.problem ? "bad" : live.online ? "ok" : "warn";
              return (
                <tr key={d.id} className={testing === d.id ? "selected" : ""}>
                  <td><b>{d.name}</b><div className="muted">{d.id}</div></td>
                  <td>{profiles[d.profile]?.name ?? <span className="bad-text">{d.profile} (missing)</span>}</td>
                  <td>{agentName(d.location)}</td>
                  <td>{roomName(d.room)}</td>
                  <td><span className={`pill ${cls}`} title={status}>{status.length > 28 ? status.slice(0, 28) + "…" : status}</span></td>
                  <td className="actions">
                    <button className="btn small" onClick={() => setEditing(d.id)}>Edit</button>
                    <button className="btn small" disabled={!live || live.problem !== undefined} onClick={() => setTesting(testing === d.id ? undefined : d.id)}>Test</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!site.devices.length && <p className="empty">No devices yet.</p>}
      </div>

      {editing !== null && (
        <DeviceEditor
          key={editing}
          device={site.devices.find((d) => d.id === editing)}
          onClose={() => setEditing(null)}
          onSave={(d, oldId) =>
            update((s) => {
              if (oldId) s.devices = s.devices.map((x) => (x.id === oldId ? d : x));
              else s.devices.push(d);
              return s;
            })
          }
          onDelete={(id) =>
            update((s) => {
              s.devices = s.devices.filter((x) => x.id !== id);
              // Drop references so the site stays valid.
              s.groups = s.groups.map((g) => ({ ...g, devices: g.devices.filter((x) => x !== id) }));
              s.scenes = s.scenes.map((sc) => ({ ...sc, steps: sc.steps.filter((st) => !("device" in st) || st.device !== id) }));
              return s;
            })
          }
        />
      )}
      {testing && editing === null && <DeviceConsole id={testing} unsaved={dirty} onClose={() => setTesting(undefined)} />}
    </div>
  );
}

function DeviceEditor({ device, onClose, onSave, onDelete }: { device?: SiteDevice; onClose: () => void; onSave: (d: SiteDevice, oldId?: string) => void; onDelete: (id: string) => void }) {
  const { site, profiles } = useDraft();
  const isNew = !device;
  const [d, setD] = useState<SiteDevice>(device ? structuredClone(device) : { id: "", name: "", profile: "", location: "server", enabled: true, settings: {} });
  const profile = profiles[d.profile];
  const taken = site.devices.map((x) => x.id).filter((id) => id !== device?.id);

  const profileOptions = useMemo(
    () =>
      Object.values(profiles)
        .sort((a, b) => (a.category + a.name).localeCompare(b.category + b.name))
        .map((p) => ({ value: p.id, label: `${CATEGORY_LABELS[p.category] ?? p.category} · ${p.name}` })),
    [profiles],
  );

  const missingRequired = profile?.settings.filter((f) => f.required && (d.settings[f.key] ?? f.default) === undefined).map((f) => f.label) ?? [];
  const canApply = d.name.trim() && d.profile && profile && !missingRequired.length;

  return (
    <aside className="drawer">
      <div className="row-between">
        <h2>{isNew ? "Add device" : `Edit ${device.name}`}</h2>
        <button className="icon" onClick={onClose}>✕</button>
      </div>
      <div className="aform">
        <Field label="Name" required>
          <Text value={d.name} onChange={(name) => setD({ ...d, name, id: isNew ? slugify(name, taken) : d.id })} placeholder="e.g. Main Bar TV 1" />
        </Field>
        <Field label="Id" help={isNew ? "Used by scenes and the API. Set from the name." : "Can't be changed after adding."}>
          <Text value={d.id} disabled={!isNew} onChange={(id) => setD({ ...d, id: slugify(id, taken) })} />
        </Field>
        <Field label="Device type" required help={profile?.description}>
          <Pick value={d.profile || undefined} options={profileOptions} onChange={(p) => setD({ ...d, profile: p, settings: defaultSettings(profiles[p].settings, d.settings) })} />
        </Field>
        <Field label="Reached from" help="A wall PC reaches devices on its own network, iTach and COM ports.">
          <Pick value={d.location} options={[{ value: "server", label: "Control server" }, ...site.agents.map((a) => ({ value: a.id, label: a.name }))]} onChange={(location) => setD({ ...d, location })} />
        </Field>
        <Field label="Room">
          <Pick value={d.room} empty="No room" options={site.rooms.map((r) => ({ value: r.id, label: r.name }))} onChange={(room) => setD({ ...d, room: room || undefined })} />
        </Field>
        <Check value={d.enabled} onChange={(enabled) => setD({ ...d, enabled })} label="Enabled" />
      </div>

      {profile && (
        <>
          <h3 className="section">Settings</h3>
          <SettingsForm fields={profile.settings} value={d.settings} onChange={(settings) => setD({ ...d, settings })} />
        </>
      )}

      {missingRequired.length > 0 && <p className="help">Still needed: {missingRequired.join(", ")}</p>}
      <div className="row-tight drawer-actions">
        {!isNew && (
          <button
            className="btn danger"
            onClick={() => {
              if (confirm(`Remove ${device.name}? It's also taken out of walls and scenes.`)) {
                onDelete(device.id);
                onClose();
              }
            }}
          >
            Remove
          </button>
        )}
        <span className="grow" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={!canApply}
          onClick={() => {
            onSave(d, device?.id);
            onClose();
          }}
        >
          {isNew ? "Add" : "Done"}
        </button>
      </div>
      <p className="help">Changes take effect when you press Save & apply.</p>
    </aside>
  );
}

/** Runs any command on a saved device and shows its live traffic. */
function DeviceConsole({ id, unsaved, onClose }: { id: string; unsaved: boolean; onClose: () => void }) {
  const { site, profiles, notice } = useDraft();
  const state = useLive();
  const device = site.devices.find((d) => d.id === id)!;
  const profile = profiles[device.profile];
  const commands = Object.entries(profile?.commands ?? {}).filter(([, c]) => !c.hidden);
  const [command, setCommand] = useState(commands[0]?.[0]);
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [log, setLog] = useState<LogEntry[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const live = state?.devices[id];

  useEffect(() => {
    let stopped = false;
    const tick = () => adminApi.deviceLog(id).then((l) => !stopped && setLog(l), () => {});
    tick();
    const t = setInterval(tick, 1000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [id]);
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log.length]);

  const cmd = command ? profile?.commands[command] : undefined;
  return (
    <aside className="drawer">
      <div className="row-between">
        <h2>Test {device.name}</h2>
        <button className="icon" onClick={onClose}>✕</button>
      </div>
      {unsaved && <p className="help">You have unsaved changes; this tests the device as last saved.</p>}
      <div className="row-tight">
        <span className={`pill ${live?.online ? "ok" : "warn"}`}>{live?.online ? "online" : "offline"}</span>
        {live?.error && <span className="muted">{live.error}</span>}
      </div>

      <h3 className="section">Send a command</h3>
      <div className="aform">
        <Field label="Command">
          <Pick value={command} options={commands.map(([k, c]) => ({ value: k, label: c.label ?? k }))} onChange={(c) => { setCommand(c); setParams({}); }} />
        </Field>
      </div>
      {cmd && <ParamsForm params={cmd.params} value={params} onChange={setParams} settings={device.settings} />}
      <button
        className="btn primary"
        disabled={!command}
        onClick={() =>
          adminApi.command(id, command!, params).then(() => notice(`Sent ${cmd?.label ?? command}`), (err) => notice(err.message, true))
        }
      >
        Send
      </button>

      <h3 className="section">State</h3>
      <pre className="state">{Object.keys(live?.state ?? {}).length ? Object.entries(live!.state).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") : "(nothing reported yet)"}</pre>

      <h3 className="section">Traffic</h3>
      <div className="traffic" ref={logRef}>
        {log.map((e, i) => (
          <div key={i} className={`t-${e.dir}`}>
            <span className="t-time">{new Date(e.t).toLocaleTimeString()}</span> <span className="t-dir">{e.dir.toUpperCase()}</span> {e.text}
          </div>
        ))}
        {!log.length && <div className="muted">No traffic yet.</div>}
      </div>
    </aside>
  );
}
