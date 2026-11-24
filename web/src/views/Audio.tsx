import { api, type Control, type UiDevice, type UiProfile } from "../api.ts";
import { Controls, optionsFor, resolve } from "../components/Controls.tsx";
import { useApp } from "../context.tsx";
import { streamLabel } from "../components/MosaicPanel.tsx";
import { render, renderParams } from "../template.ts";

// Sound on its own page: every audio device (the Atlas DSP), one card per zone
// with its source, volume and mute, then anything that covers the whole
// device, like its scenes. Drawn from the device type's controls, so another
// audio processor gets the same page.

/** The audio devices the panel has; the Audio menu item only shows when there are some. */
export function audioDevices(ui: ReturnType<typeof useApp>["ui"]) {
  return ui.devices.filter((d) => ui.profiles[d.profile]?.category === "audio");
}

export function Audio() {
  const { ui } = useApp();
  const devices = audioDevices(ui);
  return (
    <>
      {devices.map((d) => <AudioDevice key={d.id} device={d} title={devices.length > 1} />)}
      {!devices.length && <p className="empty">No audio devices yet. Add one in the admin.</p>}
    </>
  );
}

function AudioDevice({ device, title }: { device: UiDevice; title: boolean }) {
  const { ui, state } = useApp();
  const profile = ui.profiles[device.profile];
  const view = state.devices[device.id];
  const ctx = { settings: device.settings, device, state: view?.state ?? {} };
  // The repeated groups are the zones; each becomes a card of its own.
  const zoned = profile.controls.filter((c) => c.type === "group" && c.repeat);
  const rest: Control[] = profile.controls.filter((c) => !zoned.includes(c));
  const zones = zoned.flatMap((c) => {
    const list = resolve(render(c.repeat, ctx), ctx);
    return Array.isArray(list) ? list.map((item) => ({ control: c, item })) : [];
  });
  const groups = zoneGroups(profile, zones);
  const status = view?.problem ? "problem" : view?.online ? "online" : "offline";

  return (
    <div className="audio">
      <div className="toolbar">
        <h2>{title ? device.name : "Audio"}</h2>
        <span className={`pill ${status === "online" ? "ok" : status === "offline" ? "warn" : "bad"}`}>{status === "problem" ? "Needs setup" : status === "online" ? "Online" : "Offline"}</span>
      </div>
      {view?.problem && <p className="err">{view.problem}</p>}
      {!view?.problem && view?.error && !view.online && <p className="err">{view.error}</p>}
      {!view?.problem && (
        <>
          {groups.length > 0 && (
            <div className="cards zones">
              {groups.map((g) => <GroupSource key={g.name} device={device} profile={profile} group={g} />)}
            </div>
          )}
          <div className="cards zones">
            {zones.map(({ control, item }, i) => (
              <section className="card zone" key={i}>
                <h3>{render(control.label, { ...ctx, item })}</h3>
                {sourceOf(profile, control) && <SourcePicker device={device} profile={profile} select={sourceOf(profile, control)!} zones={[{ control, item }]} label={render(sourceOf(profile, control)!.label, { ...ctx, item }) || "Source"} toast={render(control.label, { ...ctx, item })} />}
                <Controls device={device} profile={profile} controls={(control.controls ?? []).filter((c) => c !== sourceOf(profile, control))} item={item} />
              </section>
            ))}
          </div>
          {!zones.length && <p className="empty">No zones are set up for {device.name}. Add them on the device in the admin.</p>}
          {rest.length > 0 && <Controls device={device} profile={profile} controls={rest} />}
        </>
      )}
    </div>
  );
}

interface Zone { control: Control; item: unknown }

/** The control of a zone that picks its source, for device types that have one. */
function sourceOf(profile: UiProfile, zone: Control) {
  const command = (profile.capabilities.source as { select?: string } | undefined)?.select;
  return command ? zone.controls?.find((c) => c.type === "select" && c.command === command && c.param) : undefined;
}
interface ZoneGroup { name: string; zones: Zone[]; select: Control }

/**
 * Zones the admin gave the same group name, for device types whose zones have a source picker.
 * A group of one is left out: its own card already does the job.
 */
function zoneGroups(profile: UiProfile, zones: Zone[]): ZoneGroup[] {
  const groups = new Map<string, ZoneGroup>();
  for (const z of zones) {
    const name = String((z.item as { group?: unknown } | null)?.group ?? "").trim();
    const select = sourceOf(profile, z.control);
    if (!name || !select) continue;
    const key = name.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name, zones: [], select });
    groups.get(key)!.zones.push(z);
  }
  return [...groups.values()].filter((g) => g.zones.length > 1);
}

/** One source for every zone of a group. Shows the source only while all its zones are on the same one. */
function GroupSource({ device, profile, group }: { device: UiDevice; profile: UiProfile; group: ZoneGroup }) {
  const ctx = { settings: device.settings, device };
  return (
    <section className="card zone group">
      <h3>{group.name}</h3>
      <p className="muted">{group.zones.map((z) => render(z.control.label, { ...ctx, item: z.item })).join(", ")}</p>
      <SourcePicker device={device} profile={profile} select={group.select} zones={group.zones} label="Source for all" toast={group.name} />
    </section>
  );
}

interface Choice {
  value: string;
  label: string;
  source: string | number;
  /** A stream of a canvas whose sound arrives on this source: choosing it also tells the canvas to play it. */
  play?: { device: string; command: string; params: Record<string, unknown> };
}

/**
 * The source choice of one zone or several. A source that carries a mosaic canvas's sound
 * (linked in the admin) is offered as that canvas's streams, so staff pick what to listen
 * to in one go: the zone moves to the source and the canvas plays the stream on it.
 */
function SourcePicker({ device, profile, select: c, zones, label, toast }: { device: UiDevice; profile: UiProfile; select: Control; zones: Zone[]; label: string; toast: string }) {
  const { ui, state, act } = useApp();
  const base = { settings: device.settings, device, state: state.devices[device.id]?.state ?? {} };
  const param = profile.commands[c.command!]?.params[c.param!];
  const coerce = (v: string | number) => (param?.type === "integer" || param?.type === "number" ? Number(v) : v);

  // What each source offers: itself, or the streams of the canvas wired to it.
  const groups = optionsFor(c, param, base, ui.channels).map((o) => {
    const plain: Choice[] = [{ value: `s:${o.value}`, label: o.label, source: o.value }];
    const canvas = ui.devices.find((d) => d.sound?.device === device.id && String(d.sound.source) === String(o.value));
    const cap = canvas && (ui.profiles[canvas.profile]?.capabilities.soundSource as SoundSource | undefined);
    const cs = (canvas && state.devices[canvas.id]?.state) || {};
    const out = cap && (cs[cap.outputsFrom] as { id?: string }[] | undefined)?.[0]?.id;
    if (!canvas || !cap || out === undefined) return { label: o.label, source: o.value, choices: plain, playing: undefined };
    const playing = cs[cap.state.replace("*", out)] as string | undefined;
    const all = Array.isArray(cs[cap.optionsFrom]) ? (cs[cap.optionsFrom] as string[]) : [];
    // The streams the admin ticked for this canvas, plus what it plays now so that shows as chosen.
    const offered = canvas.streams ? all.filter((n) => canvas.streams!.includes(n)) : all;
    const streams = playing && !offered.includes(playing) ? [...offered, playing] : offered;
    if (!streams.length) return { label: o.label, source: o.value, choices: plain, playing: undefined };
    const choices: Choice[] = streams.map((n) => ({
      value: `c:${o.value}:${n}`,
      label: streamLabel(n).short,
      source: o.value,
      play: { device: canvas.id, command: cap.select, params: { [cap.outputParam]: out, [cap.param]: n } },
    }));
    return { label: o.label, source: o.value, choices, playing };
  });
  const choices = groups.flatMap((g) => g.choices);

  const list = zones.map((z) => {
    const ctx = { ...base, item: z.item };
    return { name: render(z.control.label, ctx), params: renderParams(c.params, ctx), value: c.state ? resolve(render(c.state, ctx), ctx) : undefined };
  });
  const same = list.every((z) => z.value !== undefined && String(z.value) === String(list[0].value));
  const on = same ? groups.find((g) => String(g.source) === String(list[0].value)) : undefined;
  const wanted = on && (on.playing !== undefined ? `c:${on.source}:${on.playing}` : `s:${on.source}`);
  const chosen = wanted !== undefined && choices.some((x) => x.value === wanted) ? wanted : "";

  const send = (value: string) => {
    const pick = choices.find((x) => x.value === value);
    if (!pick) return;
    void act(async () => {
      const jobs = list.map((z) => ({ name: z.name, run: api.command(device.id, c.command!, { ...z.params, [c.param!]: coerce(pick.source) }) }));
      if (pick.play) jobs.push({ name: pick.label, run: api.command(pick.play.device, pick.play.command, pick.play.params) });
      const results = await Promise.allSettled(jobs.map((j) => j.run));
      const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${jobs[i].name}: ${(r.reason as Error).message}`] : []));
      if (failed.length) throw new Error(failed.join("; "));
    }, `${toast}: ${pick.label}`);
  };

  return (
    <label className="field">
      <span>{label}</span>
      <select value={chosen} onChange={(e) => e.target.value !== "" && send(e.target.value)}>
        {chosen === "" && <option value="">{list.length > 1 && !same && list.some((z) => z.value !== undefined) ? "Different sources" : "—"}</option>}
        {groups.map((g) =>
          g.choices.length === 1 && !g.choices[0].play
            ? <option key={g.choices[0].value} value={g.choices[0].value}>{g.choices[0].label}</option>
            : (
              <optgroup key={String(g.source)} label={g.label}>
                {g.choices.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
              </optgroup>
            ))}
      </select>
    </label>
  );
}

interface SoundSource { select: string; param: string; outputParam: string; outputsFrom: string; state: string; optionsFrom: string }
