import { useState } from "react";
import { parse as parseYaml } from "yaml";
import { adminApi, type RawProfile } from "./adminApi.ts";
import { useDraft } from "./draft.tsx";
import { ProfileEditor } from "./ProfileEditor.tsx";

// Starting points for a new device type, by how the device is controlled.
const TEMPLATES: { label: string; help: string; profile: RawProfile }[] = [
  {
    label: "Network device (TCP text commands)",
    help: "Projectors, matrix switches, DSPs and most AV gear with a 'control protocol' document.",
    profile: {
      transport: { type: "tcp", port: 23, terminator: "\r", delimiter: "\r" },
      settings: [{ key: "host", label: "IP address", type: "string", required: true }],
      commands: { power_on: { label: "Power on", steps: [{ send: "POWER ON" }] }, power_off: { label: "Power off", steps: [{ send: "POWER OFF" }] } },
      capabilities: { power: { on: "power_on", off: "power_off" } },
      controls: [{ type: "toggle", label: "Power", on: "power_on", off: "power_off", state: "power" }],
    },
  },
  {
    label: "Web API (HTTP)",
    help: "Devices controlled with URLs, like Roku or most modern controllers.",
    profile: {
      transport: { type: "http", port: 80 },
      settings: [{ key: "host", label: "IP address", type: "string", required: true }],
      commands: { power_on: { label: "Power on", steps: [{ http: { method: "POST", path: "/power/on" } }], sets: { power: "on" } } },
      controls: [],
    },
  },
  {
    label: "RS-232 / serial",
    help: "Devices with a serial port, connected to a wall PC's COM port.",
    profile: {
      transport: { type: "serial", baudRate: 9600, terminator: "\r", delimiter: "\r" },
      settings: [{ key: "serialPort", label: "COM port", type: "string", required: true, default: "COM3" }],
      commands: { power_on: { label: "Power on", steps: [{ send: "PWR ON" }] } },
      controls: [],
    },
  },
  {
    label: "IR remote (through an iTach)",
    help: "Anything with an infrared remote: TVs, cable boxes, older gear.",
    profile: {
      transport: { type: "ir", minGapMs: 150 },
      settings: [
        { key: "irHost", label: "iTach IP address", type: "string", required: true },
        { key: "irPort", label: "iTach IR port", type: "integer", required: true, default: 1 },
      ],
      commands: { power_on: { label: "Power on", steps: [{ ir: "KEY_POWERON" }], sets: { power: "on" } }, power_off: { label: "Power off", steps: [{ ir: "KEY_POWEROFF" }], sets: { power: "off" } } },
      irCodes: {},
      capabilities: { power: { on: "power_on", off: "power_off", state: "power" } },
      controls: [{ type: "toggle", label: "Power", on: "power_on", off: "power_off", state: "power" }],
    },
  },
];

type Open = { raw: RawProfile; readOnly: boolean; isNew: boolean; usedBy: string[] };

export function Profiles() {
  const { profileEntries, reloadProfiles, notice } = useDraft();
  const [open, setOpen] = useState<Open>();
  const [choosing, setChoosing] = useState(false);
  const taken = profileEntries.map((e) => e.id).filter(Boolean) as string[];

  const uniqueId = (base: string) => {
    let id = base;
    for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
    return id;
  };

  const edit = async (id: string) => {
    try {
      const r = await adminApi.profileRaw(id);
      setOpen({ raw: r.raw, readOnly: r.source === "builtin", isNew: false, usedBy: r.usedBy });
    } catch (err) {
      notice(err instanceof Error ? err.message : String(err), true);
    }
  };

  const duplicate = async (id: string) => {
    const r = await adminApi.profileRaw(id);
    setOpen({ raw: { ...structuredClone(r.raw), id: uniqueId(`${id}-custom`), name: `${r.raw.name} (copy)` }, readOnly: false, isNew: true, usedBy: [] });
  };

  if (open) {
    return (
      <ProfileEditor
        key={open.raw.id}
        initial={open.raw}
        readOnly={open.readOnly}
        isNew={open.isNew}
        usedBy={open.usedBy}
        onClose={() => setOpen(undefined)}
        onSaved={async (p) => {
          await reloadProfiles();
          setOpen({ raw: p, readOnly: false, isNew: false, usedBy: open.usedBy });
        }}
      />
    );
  }

  const groups = [
    { title: "Your device types", source: "custom" as const },
    { title: "Built-in", source: "builtin" as const },
  ];

  return (
    <div className="narrow">
      <div className="row-between">
        <h2>Device types</h2>
        <div className="row-tight">
          <label className="btn">
            Import .yaml
            <input
              type="file"
              accept=".yaml,.yml,.json"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                try {
                  const raw = parseYaml(await file.text());
                  if (!raw?.id) throw new Error("That file isn't a device profile (no id)");
                  const exists = taken.includes(raw.id);
                  setOpen({ raw: exists ? { ...raw, id: uniqueId(raw.id) } : raw, readOnly: false, isNew: true, usedBy: [] });
                  if (exists) notice(`A profile "${raw.id}" already exists; importing it under a new id`);
                } catch (err) {
                  notice(err instanceof Error ? err.message : String(err), true);
                }
              }}
            />
          </label>
          <button className="btn primary" onClick={() => setChoosing(!choosing)}>+ New device type</button>
        </div>
      </div>
      <p className="help">
        A device type (profile) describes how to talk to a kind of device: its commands, how to read its status, and its touch panel controls. Make one per model, then add as many devices of it as you have.
      </p>

      {choosing && (
        <section className="card attention">
          <h3>Start from…</h3>
          <div className="tiles">
            {TEMPLATES.map((t) => (
              <button
                key={t.label}
                className="tile"
                onClick={() => {
                  setChoosing(false);
                  setOpen({ raw: { id: uniqueId("new-device"), name: "", category: "other", ...structuredClone(t.profile) }, readOnly: false, isNew: true, usedBy: [] });
                }}
              >
                {t.label}
                <small>{t.help}</small>
              </button>
            ))}
          </div>
          <p className="help">Or Duplicate a built-in type below to adapt it, e.g. to add your own learned IR codes.</p>
        </section>
      )}

      {groups.map((g) => {
        const list = profileEntries.filter((e) => e.source === g.source);
        return (
          <div key={g.source}>
            <h3 className="section">{g.title}</h3>
            {!list.length && <p className="muted">None yet.</p>}
            <table className="atable">
              <tbody>
                {list.map((e) => (
                  <tr key={e.id ?? e.file}>
                    <td>
                      <b>{e.name ?? e.id ?? e.file}</b>
                      <div className="muted">{[e.manufacturer, e.category, e.id].filter(Boolean).join(" · ")}</div>
                      {e.errors.length > 0 && <div className="err">{e.errors.slice(0, 3).join("; ")}</div>}
                    </td>
                    <td className="actions">
                      {e.id && <button className="btn small" onClick={() => edit(e.id!)}>{g.source === "builtin" ? "View" : "Edit"}</button>}
                      {e.id && <button className="btn small" onClick={() => duplicate(e.id!)}>Duplicate</button>}
                      {g.source === "custom" && e.id && (
                        <button
                          className="btn small danger"
                          onClick={async () => {
                            if (!confirm(`Delete the device type "${e.name ?? e.id}"?`)) return;
                            try {
                              await adminApi.deleteProfile(e.id!);
                              await reloadProfiles();
                              notice("Deleted");
                            } catch (err) {
                              notice(err instanceof Error ? err.message : String(err), true);
                            }
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
