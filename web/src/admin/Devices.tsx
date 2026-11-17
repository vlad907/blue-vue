import { useEffect, useMemo, useRef, useState } from "react";
import { adminApi, slugify, type LogEntry, type Site, type SiteDevice } from "./adminApi.ts";
import { useDraft } from "./draft.tsx";
import { Check, Field, ParamsForm, Pick, SettingsForm, Text, defaultSettings } from "./forms.tsx";
import { useLive } from "./live.tsx";
import { AddMosaic } from "./Mosaic.tsx";
import { AddTvs, PairControls, usePairing } from "./Tvs.tsx";

const CATEGORY_LABELS: Record<string, string> = {
  display: "Displays", tuner: "Tuners", player: "Streaming boxes", audio: "Audio", "video-wall": "Video walls", switcher: "Switchers",
  projector: "Projectors", lighting: "Lighting", other: "Other",
};

/** Takes devices out of the site, and out of the walls and scenes that use them, so the site stays valid. */
export function removeDevices(s: Site, ids: string[]): Site {
  const gone = new Set(ids);
  s.devices = s.devices.filter((x) => !gone.has(x.id)).map((x) => (x.preview && gone.has(x.preview.device) ? { ...x, preview: undefined } : x));
  s.groups = s.groups.map((g) => ({ ...g, devices: g.devices.filter((x) => !gone.has(x)) }));
  s.scenes = s.scenes.map((sc) => ({ ...sc, steps: sc.steps.filter((st) => !("device" in st) || !st.device || !gone.has(st.device)) }));
  return s;
}

export function Devices() {
  const { site, update, profiles, dirty } = useDraft();
  const state = useLive();
  const [editing, setEditing] = useState<string | null>(null); // device id, or "" for a new one
  const [addingTvs, setAddingTvs] = useState(false);
  const [addingMosaic, setAddingMosaic] = useState(false);
  const [testing, setTesting] = useState<string>();
  // Ticked rows, for removing or placing many devices at once.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [typeChoice, setTypeFilter] = useState<string>();
  const [search, setSearch] = useState("");

  const usedTypes = [...new Set(site.devices.map((d) => d.profile))].map((id) => ({ value: id, label: profiles[id]?.name ?? id })).sort((a, b) => a.label.localeCompare(b.label));
  const typeFilter = usedTypes.some((t) => t.value === typeChoice) ? typeChoice : undefined; // back to all once its last device is gone
  const words = search.trim().toLowerCase();
  const shown = site.devices.filter(
    (d) => (!typeFilter || d.profile === typeFilter) && (!words || `${d.name} ${d.id} ${d.settings.host ?? ""}`.toLowerCase().includes(words)),
  );
  const chosen = site.devices.filter((d) => picked.has(d.id)); // ignores ids removed since
  const allShown = shown.length > 0 && shown.every((d) => picked.has(d.id));
  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(picked);
    for (const id of ids) on ? next.add(id) : next.delete(id);
    setPicked(next);
  };
  const walls = site.groups.filter((g) => g.kind === "wall");
  const removeChosen = () => {
    const ids = chosen.map((d) => d.id);
    const inWalls = site.groups.filter((g) => g.devices.some((x) => picked.has(x))).length;
    const inScenes = site.scenes.filter((sc) => sc.steps.some((st) => "device" in st && !!st.device && picked.has(st.device))).length;
    const names = chosen.slice(0, 5).map((d) => d.name).join(", ") + (chosen.length > 5 ? ` and ${chosen.length - 5} more` : "");
    const also = inWalls || inScenes ? ` They're also taken out of ${[inWalls && `${inWalls} wall${inWalls > 1 ? "s" : ""}`, inScenes && `${inScenes} scene${inScenes > 1 ? "s" : ""}`].filter(Boolean).join(" and ")}.` : "";
    if (!confirm(`Remove ${ids.length} device${ids.length > 1 ? "s" : ""} (${names})?${also}`)) return;
    update((s) => removeDevices(s, ids));
    if (testing && picked.has(testing)) setTesting(undefined);
    setPicked(new Set());
  };

  const agentName = (id: string) => (id === "server" ? "Control server" : site.agents.find((a) => a.id === id)?.name ?? id);
  const roomName = (id?: string) => site.rooms.find((r) => r.id === id)?.name ?? "";

  return (
    <div className="split">
      <div>
        <div className="row-between">
          <h2>Devices</h2>
          <span className="row-tight">
            <button className="btn" onClick={() => { setEditing(null); setTesting(undefined); setAddingMosaic(false); setAddingTvs(true); }}>+ Add TVs</button>
            <button className="btn" onClick={() => { setEditing(null); setTesting(undefined); setAddingTvs(false); setAddingMosaic(true); }}>+ Add mosaic engine</button>
            <button className="btn primary" onClick={() => { setAddingTvs(false); setAddingMosaic(false); setEditing(""); }}>+ Add device</button>
          </span>
        </div>
        <div className="row-tight">
          <Text value={search} onChange={setSearch} placeholder="Search name or address" />
          <Pick value={typeFilter} empty="All types" options={usedTypes} onChange={(t) => setTypeFilter(t || undefined)} />
        </div>
        {chosen.length > 0 && (
          <div className="row-tight bulkbar">
            <b>{chosen.length} selected</b>
            <select value="" onChange={(e) => { const room = e.target.value === "__none__" ? undefined : e.target.value; update((s) => { for (const d of s.devices) if (picked.has(d.id)) d.room = room; return s; }); }}>
              <option value="" disabled>Move to room…</option>
              <option value="__none__">No room</option>
              {site.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            {walls.length > 0 && (
              <select value="" onChange={(e) => { const wall = e.target.value; update((s) => { const g = s.groups.find((x) => x.id === wall); if (g) g.devices.push(...chosen.map((d) => d.id).filter((id) => !g.devices.includes(id))); return s; }); }}>
                <option value="" disabled>Add to wall…</option>
                {walls.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            )}
            <span className="grow" />
            <button className="btn small" onClick={() => setPicked(new Set())}>Clear</button>
            <button className="btn small danger" onClick={removeChosen}>Remove {chosen.length}</button>
          </div>
        )}
        <table className="atable">
          <thead>
            <tr><th><input type="checkbox" title="Select all shown" checked={allShown} onChange={(e) => toggle(shown.map((d) => d.id), e.target.checked)} /></th><th>Name</th><th>Type</th><th>Reached from</th><th>Room</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {shown.map((d) => {
              const live = state?.devices[d.id];
              const status = !live ? "not saved yet" : live.problem ? live.problem : live.online ? "online" : (live.error ?? "offline");
              const cls = !live ? "" : live.problem ? "bad" : live.online ? "ok" : "warn";
              return (
                <tr key={d.id} className={testing === d.id ? "selected" : ""}>
                  <td><input type="checkbox" checked={picked.has(d.id)} onChange={(e) => toggle([d.id], e.target.checked)} /></td>
                  <td><b>{d.name}</b><div className="muted">{d.id}</div></td>
                  <td>{profiles[d.profile]?.name ?? <span className="bad-text">{d.profile} (missing)</span>}</td>
                  <td>{agentName(d.location)}</td>
                  <td>{roomName(d.room)}</td>
                  <td><span className={`pill ${cls}`} title={status}>{status.length > 28 ? status.slice(0, 28) + "…" : status}</span></td>
                  <td className="actions">
                    <button className="btn small" onClick={() => setEditing(d.id)}>Edit</button>
                    <button className="btn small" disabled={!live || live.problem !== undefined} onClick={() => { setAddingTvs(false); setAddingMosaic(false); setTesting(testing === d.id ? undefined : d.id); }}>Test</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!site.devices.length && <p className="empty">No devices yet.</p>}
        {site.devices.length > 0 && !shown.length && <p className="empty">No devices match.</p>}
      </div>

      {addingTvs && editing === null && <AddTvs onClose={() => setAddingTvs(false)} />}
      {addingMosaic && editing === null && <AddMosaic onClose={() => setAddingMosaic(false)} />}
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
          onDelete={(id) => update((s) => removeDevices(s, [id]))}
        />
      )}
      {testing && editing === null && !addingTvs && !addingMosaic && <DeviceConsole id={testing} unsaved={dirty} onClose={() => setTesting(undefined)} />}
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

      {profile && ["tuner", "player"].includes(profile.category) && <PreviewLink device={d} onChange={(preview) => setD({ ...d, preview })} />}

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
/**
 * Links a device to the NDI stream that carries its picture (its HDMI output
 * into an encoder box), so the touch panel's Remote tab shows what it's doing.
 */
function PreviewLink({ device: d, onChange }: { device: SiteDevice; onChange: (p: SiteDevice["preview"]) => void }) {
  const { site } = useDraft();
  const live = useLive();
  const engines = site.devices.filter((x) => x.profile === "mosaic-engine");
  if (!engines.length) return null;
  const engine = d.preview?.device ?? engines[0].id;
  // Every stream any canvas of that media server sees.
  const host = engines.find((e) => e.id === engine)?.settings.host;
  const streams = [...new Set(engines.filter((e) => e.settings.host === host).flatMap((e) => (live?.devices[e.id]?.state.streams as string[] | undefined) ?? []))].sort();
  const hosts = engines.filter((e, i) => engines.findIndex((x) => x.settings.host === e.settings.host) === i);
  return (
    <>
      <h3 className="section">Picture on the Remote tab</h3>
      <div className="aform">
        <Field label="NDI stream of this device" help="The encoder box this device's HDMI output goes into. The touch panel's Remote tab shows it live beside the remote.">
          <Pick
            value={d.preview?.stream}
            empty="No picture"
            options={[...new Set([...(d.preview ? [d.preview.stream] : []), ...streams])].map((s) => ({ value: s, label: s }))}
            onChange={(stream) => onChange(stream ? { device: engine, stream } : undefined)}
          />
        </Field>
        {!streams.length && <p className="help">The mosaic engine isn't reporting any streams right now, so there's nothing to pick. Or type the stream's full NDI name:</p>}
        {(!streams.length || (d.preview && !streams.includes(d.preview.stream))) && (
          <Text value={d.preview?.stream} placeholder="MACHINE (Stream)" onChange={(stream) => onChange(stream.trim() ? { device: engine, stream } : undefined)} />
        )}
        {hosts.length > 1 && d.preview && (
          <Field label="Seen by">
            <Pick value={engine} options={hosts.map((e) => ({ value: e.id, label: `${e.name} (${String(e.settings.host ?? "")})` }))} onChange={(device) => onChange({ device, stream: d.preview!.stream })} />
          </Field>
        )}
      </div>
    </>
  );
}

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

      {(profile?.transport.type === "androidtv" || profile?.transport.type === "appletv") && <PairPanel id={id} unsaved={unsaved} paired={live?.online === true} appleTv={profile.transport.type === "appletv"} />}

      <h3 className="section">Send a command</h3>
      <div className="aform">
        <Field label="Command">
          <Pick value={command} options={commands.map(([k, c]) => ({ value: k, label: c.label ?? k }))} onChange={(c) => { setCommand(c); setParams({}); }} />
        </Field>
      </div>
      {cmd && <ParamsForm params={cmd.params} value={params} onChange={setParams} settings={device.settings} state={live?.state} />}
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

/**
 * Pairs an Android / Google TV: the TV shows a code, the technician types it
 * in. Only needed once per TV (and again if the TV is reset).
 */
function PairPanel({ id, unsaved, paired, appleTv }: { id: string; unsaved: boolean; paired: boolean; appleTv: boolean }) {
  const { notice } = useDraft();
  const p = usePairing(id, () => notice("Paired. The TV connects within a few seconds."), appleTv);
  return (
    <>
      <h3 className="section">Pairing</h3>
      {paired && p.phase === "idle" && <p className="help">Connected, so this TV is paired. Pair again only if the TV was reset or shows as offline with a certificate error.</p>}
      {unsaved && <p className="help">Save & apply first if you just changed this device's IP address.</p>}
      <PairControls p={p} startLabel="Pair with this TV" />
      {p.error && <p className="bad-text">{p.error}</p>}
      {p.note && !p.error && <p className="help">{p.note}</p>}
    </>
  );
}
