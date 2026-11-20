import { useEffect, useRef, useState } from "react";
import type { UiDevice } from "../api.ts";
import { Controls } from "../components/Controls.tsx";
import { useApp } from "../context.tsx";

// A remote for one device at a time: its controls, and beside them a live
// picture of what it's showing (the NDI stream linked to it in the admin).

const LAST = "bluevue.remote";

export function Remote() {
  const { ui, state } = useApp();
  // The boxes staff drive by remote: cable boxes (tuners) and streaming boxes such as Apple TV (players). TVs aren't here.
  const devices = ui.devices.filter((d) => ["tuner", "player"].includes(ui.profiles[d.profile]?.category ?? ""));
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

  if (!device) return <p className="empty">No Apple TVs or cable boxes yet. Add them in the admin.</p>;
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
          {device.preview ? <Preview key={device.id} url={`/api/v2/devices/${device.id}/preview.jpg`} /> : <div className="preview empty-preview">No picture linked to this device. Link its NDI stream in the admin (Devices → Edit).</div>}
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

/**
 * Asks for a new picture a few times a second (or every `everyMs`) while the
 * tab is in front. `quiet` shows the picture or nothing: no notes over it.
 */
export function Preview({ url, everyMs = 250, quiet = false }: { url: string; everyMs?: number; quiet?: boolean }) {
  const [src, setSrc] = useState<string>();
  const [note, setNote] = useState("Waiting for the picture…");
  const last = useRef<string>();
  useEffect(() => {
    let stop = false;
    let timer: number;
    const tick = async () => {
      let wait = everyMs;
      // A tab in the background keeps the picture it has, but still gets its first one.
      if (!document.hidden || !last.current) {
        try {
          const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, { cache: "no-store" });
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
            wait = Math.max(600, everyMs);
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
  }, [url, everyMs]);
  return (
    <div className="preview">
      {src && <img src={src} alt="What this device is showing" />}
      {note && !quiet && <span className="preview-note">{note}</span>}
    </div>
  );
}
