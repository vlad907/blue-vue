import { useState } from "react";
import { slugify, type Site, type SiteGroup } from "./adminApi.ts";
import { useDraft } from "./draft.tsx";
import { Field, Num, Pick, Text } from "./forms.tsx";
import { useLive } from "./live.tsx";

export function Rooms() {
  const { site, update } = useDraft();
  const [name, setName] = useState("");
  const count = (id: string) => site.devices.filter((d) => d.room === id).length;

  return (
    <div className="narrow">
      <h2>Rooms</h2>
      <p className="help">Rooms group device cards on the touch panel's Rooms tab.</p>
      <table className="atable">
        <tbody>
          {site.rooms.map((r, i) => (
            <tr key={r.id}>
              <td>
                <Text value={r.name} onChange={(v) => update((s) => { s.rooms[i].name = v; return s; })} />
              </td>
              <td className="muted">{count(r.id)} devices</td>
              <td className="actions">
                <button className="btn small" disabled={i === 0} onClick={() => update((s) => { [s.rooms[i - 1], s.rooms[i]] = [s.rooms[i], s.rooms[i - 1]]; return s; })}>↑</button>
                <button
                  className="btn small danger"
                  onClick={() =>
                    update((s) => {
                      s.rooms = s.rooms.filter((x) => x.id !== r.id);
                      s.devices = s.devices.map((d) => (d.room === r.id ? { ...d, room: undefined } : d));
                      return s;
                    })
                  }
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row-tight">
        <Text value={name} onChange={setName} placeholder="New room name" />
        <button
          className="btn"
          disabled={!name.trim()}
          onClick={() => {
            update((s) => { s.rooms.push({ id: slugify(name, s.rooms.map((r) => r.id)), name: name.trim() }); return s; });
            setName("");
          }}
        >
          + Add room
        </button>
      </div>
    </div>
  );
}

const KINDS = [
  { value: "wall" as const, label: "Video wall (shown on the Video Walls tab)" },
  { value: "zone" as const, label: "Zone" },
  { value: "other" as const, label: "Other" },
];

export function Groups() {
  const { site, update, profiles } = useDraft();
  const live = useLive();
  const [open, setOpen] = useState<string>();
  const mosaicDevices = site.devices.filter((d) => profiles[d.profile]?.capabilities.layoutPresets);
  const mosaicWalls = (deviceId?: string) => {
    const list = deviceId ? live?.devices[deviceId]?.state.groupList : undefined;
    return Array.isArray(list) ? (list as { id: string; name?: string }[]) : [];
  };

  const addGroup = () => {
    const id = slugify("new wall", site.groups.map((g) => g.id));
    update((s) => { s.groups.push({ id, name: "New wall", kind: "wall", devices: [], staggerMs: 250 }); return s; });
    setOpen(id);
  };

  return (
    <div className="narrow">
      <div className="row-between">
        <h2>Video walls & groups</h2>
        <button className="btn primary" onClick={addGroup}>+ Add wall</button>
      </div>
      <p className="help">
        A wall is a group of panels. Power commands go to each panel in order, with a short pause between them so they don't all draw power at once.
        Link each wall to its mosaic engine wall to get its content presets on the same card.
      </p>

      {site.groups.map((g, gi) => {
        const isOpen = open === g.id;
        const available = site.devices.filter((d) => !g.devices.includes(d.id));
        const noPower = g.devices.filter((id) => {
          const d = site.devices.find((x) => x.id === id);
          return d && !profiles[d.profile]?.capabilities.power;
        });
        const set = (fn: (grp: typeof g) => void) => update((s) => { fn(s.groups[gi]); return s; });
        return (
          <section key={g.id} className="card">
            <div className="row-between clickable" onClick={() => setOpen(isOpen ? undefined : g.id)}>
              <h3>{g.name}</h3>
              <span className="muted">{g.devices.length} devices · {g.kind} {isOpen ? "▾" : "▸"}</span>
            </div>
            {isOpen && (
              <>
                <div className="aform two">
                  <Field label="Name"><Text value={g.name} onChange={(v) => set((x) => { x.name = v; })} /></Field>
                  <Field label="Kind"><Pick value={g.kind} options={KINDS} onChange={(v) => set((x) => { x.kind = v; })} /></Field>
                  <Field label="Pause between panels (ms)"><Num value={g.staggerMs} integer min={0} onChange={(v) => set((x) => { x.staggerMs = v ?? 0; })} /></Field>
                  <Field label="Panels across" help="The wall's width in panels, so the touch panel draws it in its real shape">
                    <Num value={g.columns} integer min={1} max={16} onChange={(v) => set((x) => { x.columns = v; })} />
                  </Field>
                </div>
                {g.kind === "wall" && (
                  <MosaicLink
                    group={g}
                    mosaicDevices={mosaicDevices.map((d) => ({ value: d.id, label: d.name }))}
                    wallsOf={mosaicWalls}
                    takenBy={(device, wallId) => site.groups.find((x) => x.id !== g.id && x.mosaic?.device === device && x.mosaic.group === wallId)?.name}
                    onChange={(m) => set((x) => { x.mosaic = m; })}
                  />
                )}
                <div className="row-between">
                  <h4>Panels, in order{g.columns ? ` (${g.columns} across, left to right, top to bottom)` : ""}</h4>
                  {g.devices.length > 1 && (
                    <button className="btn small" onClick={() => set((x) => { x.devices.sort((a, b) => nameOf(site, a).localeCompare(nameOf(site, b), undefined, { numeric: true })); })}>
                      Sort by name
                    </button>
                  )}
                </div>
                <ol className="members">
                  {g.devices.map((id, i) => (
                    <li key={id}>
                      <span>{site.devices.find((d) => d.id === id)?.name ?? id}</span>
                      <span className="row-tight">
                        <button className="btn small" disabled={i === 0} onClick={() => set((x) => { [x.devices[i - 1], x.devices[i]] = [x.devices[i], x.devices[i - 1]]; })}>↑</button>
                        <button className="btn small" disabled={i === g.devices.length - 1} onClick={() => set((x) => { [x.devices[i + 1], x.devices[i]] = [x.devices[i], x.devices[i + 1]]; })}>↓</button>
                        <button className="icon" onClick={() => set((x) => { x.devices = x.devices.filter((d) => d !== id); })}>✕</button>
                      </span>
                    </li>
                  ))}
                </ol>
                {noPower.length > 0 && <p className="help bad-text">These can't be powered on and off: {noPower.join(", ")}</p>}
                {available.length > 0 && (
                  <AddMembers
                    site={site}
                    group={g}
                    candidates={available.filter((d) => g.kind !== "wall" || profiles[d.profile]?.capabilities.power)}
                    onAdd={(ids) =>
                      update((s) => {
                        // A panel belongs to one wall, so adding it here takes it out of any other.
                        if (g.kind === "wall") for (const other of s.groups) if (other.kind === "wall" && other.id !== g.id) other.devices = other.devices.filter((id) => !ids.includes(id));
                        s.groups[gi].devices.push(...ids);
                        return s;
                      })
                    }
                  />
                )}
                <div className="row-tight drawer-actions">
                  <button
                    className="btn danger"
                    onClick={() => {
                      const used = site.scenes.filter((sc) => sc.steps.some((st) => "group" in st && st.group === g.id)).map((sc) => sc.name);
                      if (!confirm(used.length ? `Remove ${g.name}? It's used by: ${used.join(", ")}. Those steps will be removed.` : `Remove ${g.name}?`)) return;
                      update((s) => {
                        s.groups = s.groups.filter((x) => x.id !== g.id);
                        s.scenes = s.scenes.map((sc) => ({ ...sc, steps: sc.steps.filter((st) => !("group" in st) || st.group !== g.id) }));
                        return s;
                      });
                    }}
                  >
                    Remove wall
                  </button>
                </div>
              </>
            )}
          </section>
        );
      })}
      {!site.groups.length && <p className="empty">No walls yet.</p>}
    </div>
  );
}

const nameOf = (site: Site, id: string) => site.devices.find((d) => d.id === id)?.name ?? id;

/** Which mosaic engine wall plays on these panels. Walls are read live from the engine. */
function MosaicLink({ group: g, mosaicDevices, wallsOf, takenBy, onChange }: {
  group: SiteGroup;
  mosaicDevices: { value: string; label: string }[];
  wallsOf: (device: string) => { id: string; name?: string }[];
  takenBy: (device: string, wall: string) => string | undefined;
  onChange: (m: SiteGroup["mosaic"]) => void;
}) {
  const [chosen, setChosen] = useState(g.mosaic?.device ?? mosaicDevices[0]?.value);
  if (!mosaicDevices.length) return <p className="help">Add the mosaic engine as a device to link this wall to its content presets.</p>;
  const device = g.mosaic?.device ?? chosen ?? mosaicDevices[0].value;
  const walls = wallsOf(device);
  const clash = g.mosaic ? takenBy(g.mosaic.device, g.mosaic.group) : undefined;
  return (
    <div className="aform two">
      {mosaicDevices.length > 1 && (
        <Field label="Mosaic engine">
          <Pick value={device} options={mosaicDevices} onChange={(d) => { setChosen(d); onChange(undefined); }} />
        </Field>
      )}
      <Field
        label="Mosaic wall"
        help={walls.length ? "Its presets show on this wall's card" : "The mosaic engine isn't reporting its walls right now (save & apply, and check it's online). You can type the wall's id."}
      >
        {walls.length ? (
          <Pick
            value={g.mosaic?.group}
            empty="Not linked"
            options={walls.map((w) => ({ value: w.id, label: w.name ?? w.id }))}
            onChange={(w) => onChange(w ? { device, group: w } : undefined)}
          />
        ) : (
          <Text value={g.mosaic?.group} placeholder="e.g. main-wall" onChange={(w) => onChange(w.trim() ? { device, group: w.trim() } : undefined)} />
        )}
        {clash && <span className="bad-text">Also linked to {clash}</span>}
      </Field>
    </div>
  );
}

/** Tick several devices at once; 20 TVs one dropdown at a time is no fun. */
function AddMembers({ site, group, candidates, onAdd }: { site: Site; group: SiteGroup; candidates: Site["devices"]; onAdd: (ids: string[]) => void }) {
  const [openList, setOpenList] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const wallOf = (id: string) => site.groups.find((x) => x.kind === "wall" && x.id !== group.id && x.devices.includes(id))?.name;
  if (!openList) return <button className="btn small" onClick={() => setOpenList(true)}>+ Add panels…</button>;
  const sorted = [...candidates].sort((a, b) => Number(!!wallOf(a.id)) - Number(!!wallOf(b.id)) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return (
    <div className="card inset">
      <div className="row-between">
        <b>Add panels to {group.name}</b>
        <span className="row-tight">
          <button className="btn small" onClick={() => setPicked(sorted.filter((d) => !wallOf(d.id)).map((d) => d.id))}>Select all unassigned</button>
          <button className="btn small" onClick={() => setPicked([])}>Clear</button>
        </span>
      </div>
      <div className="checklist">
        {sorted.map((d) => (
          <label key={d.id} className="acheck">
            <input type="checkbox" checked={picked.includes(d.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, d.id] : picked.filter((x) => x !== d.id))} />
            {d.name}
            {wallOf(d.id) && <span className="muted"> (in {wallOf(d.id)}, will move)</span>}
          </label>
        ))}
      </div>
      <div className="row-tight">
        <button className="btn small primary" disabled={!picked.length} onClick={() => { onAdd(picked); setPicked([]); setOpenList(false); }}>Add {picked.length || ""}</button>
        <button className="btn small" onClick={() => { setPicked([]); setOpenList(false); }}>Cancel</button>
      </div>
    </div>
  );
}
