import { useEffect, useRef, useState } from "react";
import type { UiDevice } from "../api.ts";
import { Controls } from "../components/Controls.tsx";
import { useApp } from "../context.tsx";

// A remote for one device at a time: its controls, and beside them a live
// picture of what it's showing (the NDI stream linked to it in the admin).

const LAST = "bluevue.remote";

export function Remote() {
  const { ui, state } = useApp();
  const walls = new Set(ui.groups.filter((g) => g.kind === "wall").flatMap((g) => g.devices));
  // Anything with a d-pad that isn't a wall panel, and anything with a picture linked.
  const devices = ui.devices.filter((d) => d.preview || (!walls.has(d.id) && ui.profiles[d.profile]?.controls.some((c) => c.type === "dpad")));
  const [chosen, setChosen] = useState(() => {
    try {
      return localStorage.getItem(LAST) ?? "";
    } catch {
      return "";
    }
  });
  const device = devices.find((d) => d.id === chosen) ?? devices[0];
  const pick = (id: string) => {
    setChosen(id);
    try {
      localStorage.setItem(LAST, id);
    } catch {
      // Private windows can refuse storage; the choice then lasts until the page reloads.
    }
  };

  if (!device) return <p className="empty">No devices with a remote yet. Add an Apple TV, a streaming box or a cable box in the admin.</p>;
  const profile = ui.profiles[device.profile];
  const view = state.devices[device.id];
  const roomName = (d: UiDevice) => ui.rooms.find((r) => r.id === d.room)?.name;

  return (
    <>
      {devices.length > 1 && (
        <div className="seg remote-pick">
          {devices.map((d) => (
            <button key={d.id} className={d.id === device.id ? "active" : ""} onClick={() => pick(d.id)}>
              {d.name}
            </button>
          ))}
        </div>
      )}
      <div className="remote">
        <div className="remote-screen">
          {device.preview ? <Preview key={device.id} device={device.id} /> : <div className="preview empty-preview">No picture linked to this device. Link its NDI stream in the admin (Devices → Edit).</div>}
          <div className="remote-title">
            <h2>{device.name}</h2>
            <span className="muted">{[profile?.name, roomName(device)].filter(Boolean).join(" · ")}</span>
            <span className={`pill ${view?.online ? "ok" : "warn"}`}>{view?.problem ?? (view?.online ? "online" : "offline")}</span>
          </div>
          {!view?.online && view?.error && <p className="err">{view.error}</p>}
        </div>
        <div className="remote-keys">
          {profile && !view?.problem && <Controls device={device} profile={profile} controls={profile.controls} />}
        </div>
      </div>
    </>
  );
}

/** Asks for a new picture a few times a second while the tab is in front. */
function Preview({ device }: { device: string }) {
  const [src, setSrc] = useState<string>();
  const [note, setNote] = useState("Waiting for the picture…");
  const last = useRef<string>();
  useEffect(() => {
    let stop = false;
    let timer: number;
    const tick = async () => {
      let wait = 250;
      if (!document.hidden) {
        try {
          const res = await fetch(`/api/v2/devices/${device}/preview.jpg?t=${Date.now()}`, { cache: "no-store" });
          if (stop) return;
          if (res.status === 200) {
            const url = URL.createObjectURL(await res.blob());
            if (stop) return URL.revokeObjectURL(url);
            if (last.current) URL.revokeObjectURL(last.current);
            last.current = url;
            setSrc(url);
            setNote(res.headers.get("x-signal") === "lost" ? "No signal from the stream" : "");
          } else if (res.status === 202) {
            setNote((n) => n || "Waiting for the picture…");
            wait = 600;
          } else {
            setNote(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Preview unavailable (${res.status})`);
            wait = 3000;
          }
        } catch {
          setNote("Can't reach the control server");
          wait = 3000;
        }
      }
      if (!stop) timer = window.setTimeout(tick, wait);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
      if (last.current) URL.revokeObjectURL(last.current);
    };
  }, [device]);
  return (
    <div className="preview">
      {src && <img src={src} alt="What this device is showing" />}
      {note && <span className="preview-note">{note}</span>}
    </div>
  );
}
