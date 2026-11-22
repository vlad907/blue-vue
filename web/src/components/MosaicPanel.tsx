import { useState } from "react";
import { api, type UiDevice, type UiProfile } from "../api.ts";
import { useApp } from "../context.tsx";
import { isOn } from "../template.ts";
import { Preview } from "../views/Remote.tsx";

// Mosaic walls the way staff think of them: a picture of each wall, cut into
// the pieces it's split into. Tap a piece (or the background), then tap what
// it should show in the list beside it. Used for mosaic engines that report
// splits; older ones keep the plain controls.

interface Slot { slot: number; name: string; ndiName: string; playlist: string; video: string; signal?: string }
interface Arrangement { id: string; name: string; slots: number }
export interface MosaicGroup { id: string; name?: string; presets?: { id: string; name: string }[]; arrangements?: Arrangement[] }
type Target = { kind: "slot"; group: string; slot: number } | { kind: "background" };

/** Whether this device's walls can be drawn: the engine reports splits and the device type has the commands. */
export function canDraw(profile: UiProfile, group: MosaicGroup) {
  return Array.isArray(group.arrangements) && group.arrangements.length > 0 && !!profile.commands.arrange && !!profile.commands.slot_stream;
}

/** Whether the admin has left this wall of a canvas on the touch panel. */
export function wallShown(device: UiDevice, group: string) {
  return !device.touch?.hidden && !device.touch?.walls?.[group]?.hidden;
}

/** "BOX1 (ZowieBoxPro-54506)" reads as BOX1, with the encoder's name kept as the small print. */
function streamLabel(ndi: string) {
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(ndi);
  return m ? { short: m[1], detail: m[2] } : { short: ndi, detail: "" };
}

function playing(c: { ndiName?: string; playlist?: string; video?: string }) {
  if (c.ndiName) return { text: streamLabel(c.ndiName).short, kind: "Stream" };
  if (c.playlist) return { text: c.playlist, kind: "Playlist" };
  if (c.video) return { text: c.video, kind: "Video" };
  return undefined;
}

/** A live picture of an NDI stream, read off the network by the control server. */
function streamUrl(device: UiDevice, ndiName: string) {
  return `/api/v2/streams/preview.jpg?engine=${encodeURIComponent(device.id)}&name=${encodeURIComponent(ndiName)}`;
}

/** Where each piece of a split sits, in percent of the wall: [left, top, width, height]. */
function boxes(arrangement: string, count: number): [number, number, number, number][] {
  if (arrangement === "five" && count === 5) return [[25, 0, 50, 100], [0, 0, 25, 50], [0, 50, 25, 50], [75, 0, 25, 50], [75, 50, 25, 50]];
  const cols = arrangement === "two" ? 2 : arrangement === "quad" ? 2 : Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  return Array.from({ length: count }, (_, i) => [((i % cols) * 100) / cols, (Math.floor(i / cols) * 100) / rows, 100 / cols, 100 / rows]);
}

export function MosaicPanel({ device, profile, groups, background }: { device: UiDevice; profile: UiProfile; groups: MosaicGroup[]; background: boolean }) {
  const { state, act } = useApp();
  const st = state.devices[device.id]?.state ?? {};
  const [picked, setPicked] = useState<Target>();
  const run = (command: string, params: Record<string, unknown>, ok?: string) => act(() => api.command(device.id, command, params), ok);

  // The admin may have narrowed the list (Wall sources page), e.g. to leave out the media server's own outputs.
  const allowed = device.streams;
  const everyStream = (st.streams as string[] | undefined) ?? [];
  const playlists = (st.playlists as { id: string; name: string }[] | undefined) ?? [];
  const videos = (st.videos as { name: string }[] | undefined) ?? [];
  const slotsOf = (g: string) => (st[`groups.${g}.slots`] as Slot[] | undefined) ?? [];
  const bg = { on: isOn(st["background.on"]), ndiName: String(st["background.ndiName"] ?? ""), playlist: String(st["background.playlist"] ?? ""), video: String(st["background.video"] ?? "") };
  const hasBackground = background && st["background.signal"] !== undefined && !!profile.commands.background_stream;

  // What's picked may have gone (the split changed): fall back to the first piece.
  const first = groups[0] && slotsOf(groups[0].id)[0] ? ({ kind: "slot", group: groups[0].id, slot: slotsOf(groups[0].id)[0].slot } as Target) : undefined;
  const target: Target | undefined =
    picked?.kind === "background" ? (hasBackground ? picked : first)
    : picked && slotsOf(picked.group).some((s) => s.slot === picked.slot) ? picked
    : first;
  const targetGroup = target?.kind === "slot" ? groups.find((g) => g.id === target.group) : undefined;
  const targetSlot = target?.kind === "slot" ? slotsOf(target.group).find((s) => s.slot === target.slot) : undefined;
  const current = target?.kind === "background" ? bg : targetSlot;
  // What's on the picked piece stays in the list even if it isn't one of the ticked streams, so it shows as chosen.
  const streams = allowed ? everyStream.filter((n) => allowed.includes(n) || n === current?.ndiName) : everyStream;
  const where = target?.kind === "background" ? "the background" : targetSlot ? `${targetSlot.name}${groups.length > 1 ? ` of ${targetGroup?.name ?? ""}` : ""}` : "";

  const put = (what: { ndiName?: string; playlist?: string; video?: string }, label: string) => {
    if (!target) return;
    if (target.kind === "background") {
      if (what.ndiName) return run("background_stream", { ndiName: what.ndiName }, `Background: ${label}`);
      if (what.playlist) return run("background_playlist", { playlist: what.playlist }, `Background: ${label}`);
      return run("background_video", { video: what.video }, `Background: ${label}`);
    }
    const at = { group: target.group, slot: target.slot };
    if (what.ndiName) return run("slot_stream", { ...at, ndiName: what.ndiName }, `${targetSlot?.name}: ${label}`);
    return run("slot_playlist", { ...at, playlist: what.playlist }, `${targetSlot?.name}: ${label}`);
  };

  return (
    <div className="mosaic">
      <div className="mosaic-walls">
        {groups.map((g) => {
          const slots = slotsOf(g.id);
          const arrangement = String(st[`groups.${g.id}.arrangement`] ?? "");
          const on = isOn(st[`groups.${g.id}.on`]);
          const activePreset = String(st[`groups.${g.id}.activePreset`] ?? "");
          const layout = boxes(arrangement, slots.length);
          // The admin may offer only some splits on a wall; the one it's in now stays so it shows as chosen.
          const offered = device.touch?.walls?.[g.id]?.splits;
          const splits = (g.arrangements ?? []).filter((a) => !offered || offered.includes(a.id) || a.id === arrangement);
          return (
            <div className="mosaic-wall" key={g.id}>
              <div className="row-between">
                <h4>{g.name ?? g.id}</h4>
                <button className={`switch${on ? " on" : ""}`} aria-pressed={on} title="Show or hide this wall's own content" onClick={() => run("content", { group: g.id, on: !on })}>
                  {on ? "On" : "Off"}
                </button>
              </div>
              {splits.length > 1 && <div className="split-row">
                <span className="muted">Split</span>
                {splits.map((a) => (
                  <button key={a.id} className={`split-btn${a.id === arrangement ? " active" : ""}`} title={a.name} onClick={() => run("arrange", { group: g.id, arrangement: a.id }, a.name)}>
                    <span className="split-icon" aria-hidden="true">
                      {boxes(a.id, a.slots).map(([l, t, w, h], i) => <i key={i} style={{ left: `${l}%`, top: `${t}%`, width: `${w}%`, height: `${h}%` }} />)}
                    </span>
                    {a.name}
                  </button>
                ))}
              </div>}
              <div className={`screen${arrangement === "five" ? " wide" : ""}${on ? "" : " off"}`}>
                {slots.map((s, i) => {
                  const [l, t, w, h] = layout[i] ?? [0, 0, 100, 100];
                  const now = playing(s);
                  const selected = target?.kind === "slot" && target.group === g.id && target.slot === s.slot;
                  return (
                    <button
                      key={s.slot}
                      className={`piece${selected ? " selected" : ""}${now ? "" : " empty"}${s.signal === "lost" ? " lost" : ""}${s.ndiName && on ? " live" : ""}`}
                      style={{ left: `${l}%`, top: `${t}%`, width: `${w}%`, height: `${h}%` }}
                      aria-pressed={selected}
                      onClick={() => setPicked({ kind: "slot", group: g.id, slot: s.slot })}
                    >
                      {s.ndiName && on && <Preview key={s.ndiName} url={streamUrl(device, s.ndiName)} everyMs={500} quiet />}
                      <small>{s.name}</small>
                      <b>{now?.text ?? "Empty"}</b>
                      {s.signal === "lost" && <em>No signal</em>}
                    </button>
                  );
                })}
                {!slots.length && <span className="muted screen-note">{on ? "Nothing placed on this wall yet. Pick a split." : "This wall's content is off."}</span>}
              </div>
              {(g.presets?.length ?? 0) > 0 && (
                <div className="preset-row">
                  <span className="muted">Presets</span>
                  {g.presets!.map((p) => (
                    <button key={p.id} className={`tile${p.id === activePreset ? " active" : ""}`} onClick={() => run("recall_preset", { group: g.id, preset: p.id }, p.name)}>
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {hasBackground && (
          <button className={`backdrop${target?.kind === "background" ? " selected" : ""}`} aria-pressed={target?.kind === "background"} onClick={() => setPicked({ kind: "background" })}>
            {bg.ndiName && bg.on && <Preview key={bg.ndiName} url={streamUrl(device, bg.ndiName)} everyMs={1000} quiet />}
            <small>Background (under every wall)</small>
            <b>{playing(bg)?.text ?? "Nothing chosen"}</b>
            <span className={`pill ${bg.on ? "ok" : ""}`}>{bg.on ? "on" : "off"}</span>
          </button>
        )}
      </div>

      <aside className="mosaic-side">
        {target ? (
          <>
            <h4>Show on {where}</h4>
            {target.kind === "background" && (
              <div className="row-between side-row">
                <span>Background</span>
                <button className={`switch${bg.on ? " on" : ""}`} aria-pressed={bg.on} onClick={() => run("background_on", { on: !bg.on })}>{bg.on ? "On" : "Off"}</button>
              </div>
            )}
            <div className="sources">
              {streams.map((s) => {
                const label = streamLabel(s);
                return (
                  <button key={s} className={`tile${current?.ndiName === s ? " active" : ""}`} onClick={() => put({ ndiName: s }, label.short)}>
                    {label.short}
                    {label.detail && <small>{label.detail}</small>}
                  </button>
                );
              })}
              {!streams.length && <p className="muted">No streams on the network right now.</p>}
            </div>
            {playlists.length > 0 && (
              <>
                <h4>Playlists</h4>
                <div className="sources">
                  {playlists.map((p) => (
                    <button key={p.id} className={`tile${current?.playlist === p.id ? " active" : ""}`} onClick={() => put({ playlist: p.id }, p.name)}>{p.name}</button>
                  ))}
                </div>
              </>
            )}
            {target.kind === "background" && videos.length > 0 && !!profile.commands.background_video && (
              <>
                <h4>Video files</h4>
                <div className="sources">
                  {videos.map((v) => (
                    <button key={v.name} className={`tile${bg.video === v.name ? " active" : ""}`} onClick={() => put({ video: v.name }, v.name)}>{v.name}</button>
                  ))}
                </div>
              </>
            )}
            {target.kind === "slot" && (
              <div className="side-actions">
                <button className="btn" disabled={!playing(targetSlot ?? {})} onClick={() => run("slot_empty", { group: target.group, slot: target.slot }, `${targetSlot?.name}: empty`)}>Empty this piece</button>
                {!!profile.commands.restart_videos && <button className="btn" onClick={() => run("restart_videos", { group: target.group }, "Videos restarted")}>Restart videos</button>}
              </div>
            )}
          </>
        ) : (
          <p className="muted">Pick a split for the wall, then tap a piece of it to choose what it shows.</p>
        )}
      </aside>
    </div>
  );
}
