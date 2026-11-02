import { useState } from "react";
import { slugify } from "./adminApi.ts";
import { useDraft } from "./draft.tsx";
import { Field, Num, Pick, Text } from "./forms.tsx";

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
  const [open, setOpen] = useState<string>();

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
      <p className="help">A wall is a group of panels. Power commands go to each panel in order, with a short pause between them so they don't all draw power at once.</p>

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
                </div>
                <h4>Panels, in order</h4>
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
                  <Pick
                    value={undefined}
                    empty="+ Add a device…"
                    options={available.map((d) => ({ value: d.id, label: d.name }))}
                    onChange={(id) => id && set((x) => { x.devices.push(id); })}
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
