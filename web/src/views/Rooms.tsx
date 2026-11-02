import { useState } from "react";
import { DeviceCard } from "../components/DeviceCard.tsx";
import { useApp } from "../context.tsx";

const ALL = "__all";
const NONE = "__none";

export function Rooms() {
  const { ui } = useApp();
  const [room, setRoom] = useState(ALL);
  const walls = new Set(ui.groups.filter((g) => g.kind === "wall").flatMap((g) => g.devices));
  // Wall panels have their own tab; everything else is grouped by room here.
  const devices = ui.devices.filter((d) => !walls.has(d.id));
  const unassigned = devices.filter((d) => !d.room || !ui.rooms.some((r) => r.id === d.room));
  const sections = [
    ...ui.rooms.map((r) => ({ id: r.id, name: r.name, devices: devices.filter((d) => d.room === r.id) })),
    { id: NONE, name: "Other devices", devices: unassigned },
  ].filter((s) => s.devices.length);

  return (
    <>
      {sections.length > 1 && (
        <div className="seg">
          {[{ id: ALL, name: "All" }, ...sections].map((s) => (
            <button key={s.id} className={room === s.id ? "active" : ""} onClick={() => setRoom(s.id)}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      {sections
        .filter((s) => room === ALL || room === s.id)
        .map((s) => (
          <div key={s.id}>
            <h2>{s.name}</h2>
            <div className="cards">
              {s.devices.map((d) => (
                <DeviceCard key={d.id} device={d} />
              ))}
            </div>
          </div>
        ))}
      {!sections.length && <p className="empty">No devices yet. Add them in the admin.</p>}
    </>
  );
}
