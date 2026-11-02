import { useEffect, useState } from "react";
import { api, type GuideRow } from "../api.ts";
import { useApp } from "../context.tsx";

const PX_PER_MIN = 6;
const fmt = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function Guide() {
  const { ui, state, act } = useApp();
  const tuners = ui.devices.filter((d) => ui.profiles[d.profile]?.capabilities.tuner);
  const [tuner, setTuner] = useState(tuners[0]?.id);
  const [rows, setRows] = useState<GuideRow[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.guide().then((g) => {
      setRows(g.rows);
      setError(g.error);
    }, (err) => setError(err.message));
  }, [state.guide.lastUpdated]);

  const device = tuners.find((t) => t.id === tuner);
  const tunerCap = device ? ui.profiles[device.profile].capabilities.tuner : undefined;
  const current = device && tunerCap?.state ? String(state.devices[device.id]?.state[tunerCap.state] ?? "") : "";
  const tune = (channel: number) => {
    if (!device) return;
    void act(() => api.capability(device.id, "tuner", "tune", channel), `${device.name} → ${channel}`);
  };

  if (!tuners.length) return <p className="empty">No tuners (cable boxes) in this site.</p>;

  const now = Date.now();
  const start = new Date(now);
  start.setMinutes(start.getMinutes() < 30 ? 0 : 30, 0, 0);
  const t0 = start.getTime();
  const end = Math.max(t0 + 3_600_000, ...(rows ?? []).flatMap((r) => r.airings.map((a) => Date.parse(a.end))));
  const width = ((end - t0) / 60_000) * PX_PER_MIN;
  const x = (t: number) => Math.max(0, ((t - t0) / 60_000) * PX_PER_MIN);
  const slots: number[] = [];
  for (let t = t0; t < end; t += 30 * 60_000) slots.push(t);

  return (
    <>
      <div className="row-between">
        <div className="seg">
          {tuners.map((t) => (
            <button key={t.id} className={t.id === tuner ? "active" : ""} onClick={() => setTuner(t.id)}>
              {t.name}
            </button>
          ))}
        </div>
        <span className="muted">
          {error ? `Guide error: ${error}` : state.guide.lastUpdated ? `Updated ${fmt(Date.parse(state.guide.lastUpdated))}` : ""}
        </span>
      </div>

      {!rows?.length ? (
        <p className="empty">No guide data. Add Gracenote station IDs to the site's channels.</p>
      ) : (
        <div className="guide">
          <div className="guide-head">
            <div className="corner" />
            <div className="guide-track" style={{ width, height: 34 }}>
              {slots.map((t) => (
                <div key={t} className="slot" style={{ left: x(t) }}>{fmt(t)}</div>
              ))}
            </div>
          </div>
          {rows.map((r) => (
            <div key={r.channel} className="guide-row">
              <div className={`guide-ch${current === String(r.channel) ? " current" : ""}`} onClick={() => tune(r.channel)}>
                <b>{r.name}</b>
                <span>{r.channel}{r.callSign ? ` · ${r.callSign}` : ""}</span>
              </div>
              <div className="guide-track" style={{ width }}>
                {r.airings.map((a) => {
                  const s = Date.parse(a.start);
                  const e = Date.parse(a.end);
                  const left = x(s);
                  const w = x(e) - left - 4;
                  if (w <= 0) return null;
                  return (
                    <div
                      key={a.start}
                      className={`airing${s <= now && e > now ? " now" : ""}`}
                      style={{ left, width: w }}
                      title={[a.title, a.episodeTitle, a.description].filter(Boolean).join(" — ")}
                      onClick={() => tune(r.channel)}
                    >
                      {a.title}
                      {a.live && <span className="badge live">LIVE</span>}
                      {a.isNew && <span className="badge new">NEW</span>}
                      <small>{a.episodeTitle || `${fmt(s)} – ${fmt(e)}`}</small>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
