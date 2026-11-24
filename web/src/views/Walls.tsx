import { useEffect, useState } from "react";
import { api, type Control, type UiDevice, type UiProfile } from "../api.ts";
import { Controls } from "../components/Controls.tsx";
import { MosaicPanel, canDraw, wallShown, type MosaicGroup } from "../components/MosaicPanel.tsx";
import { useApp } from "../context.tsx";
import { isOn } from "../template.ts";

type Wall = ReturnType<typeof useApp>["ui"]["groups"][number];

const ALL = "all";

/** The wall picked in the sub-menu, kept in the address ("#walls/centre") so a reload or a bookmark comes back to it. */
function usePicked() {
  const read = () => decodeURIComponent(location.hash.slice(1).split("/")[1] ?? "");
  const [picked, setPicked] = useState(read);
  useEffect(() => {
    const onHash = () => setPicked(read());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  return picked;
}

export function Walls() {
  const { ui, state, act } = useApp();
  const walls = ui.groups.filter((g) => g.kind === "wall");
  const linked = (deviceId: string) => new Set(walls.filter((w) => w.mosaic?.device === deviceId).map((w) => w.mosaic!.group));
  // Mosaic walls not tied to a TV wall, and engine-wide controls like scenes: one entry per canvas that has any.
  const canvases = ui.devices
    .filter((d) => ui.profiles[d.profile]?.capabilities.layoutPresets && !d.touch?.hidden)
    .map((d) => ({ device: d, profile: ui.profiles[d.profile], skip: linked(d.id) }))
    .filter((c) => mosaicParts(c.device, c.profile, c.skip, state.devices[c.device.id]?.state.groupList).any);
  const picked = usePicked();

  // One wall at a time: with several, a sub-menu picks which. "All walls" keeps the whole page.
  const entries = [...walls.map((w) => ({ id: w.id, name: w.name })), ...canvases.map((c) => ({ id: c.device.id, name: c.device.name }))];
  const menu = entries.length > 1;
  const current = !menu || picked === ALL ? ALL : entries.some((e) => e.id === picked) ? picked : entries[0].id;
  const show = (id: string) => current === ALL || current === id;

  return (
    <>
      {walls.length > 1 && (
        <div className="toolbar">
          <h2>All walls</h2>
          <div className="power">
            <button className="btn on" onClick={() => act(() => api.allWalls("on"), "All walls on")}>All on</button>
            <button className="btn off" onClick={() => act(() => api.allWalls("off"), "All walls off")}>All off</button>
            {/* No "all TVs to one input" here on purpose: walls use different inputs, and each TV returns to its own when turned on. */}
          </div>
        </div>
      )}

      {menu && (
        <nav className="seg wall-menu" aria-label="Video walls">
          {[...entries, { id: ALL, name: "All walls" }].map((e) => (
            <button key={e.id} className={current === e.id ? "active" : ""} aria-current={current === e.id ? "page" : undefined} onClick={() => { location.hash = `walls/${encodeURIComponent(e.id)}`; }}>
              {e.name}
            </button>
          ))}
        </nav>
      )}

      {canvases.filter((c) => show(c.device.id)).map((c) => (
        <MosaicSection key={c.device.id} device={c.device} profile={c.profile} skip={c.skip} />
      ))}

      <div className={`cards walls${current === ALL ? "" : " one"}`}>
        {walls.filter((w) => show(w.id)).map((w) => <WallCard key={w.id} wall={w} />)}
      </div>
      {!walls.length && !canvases.length && <p className="empty">No video walls yet. Group panels into a wall in the admin.</p>}
    </>
  );
}

function WallCard({ wall: w }: { wall: Wall }) {
  const { ui, state, act } = useApp();
  const members = w.devices.map((id) => ({ device: ui.devices.find((d) => d.id === id), view: state.devices[id] })).filter((m) => m.device) as { device: UiDevice; view?: (typeof state.devices)[string] }[];
  const powerState = (d: UiDevice) => ui.profiles[d.profile]?.capabilities.power?.state ?? "power";
  const onCount = members.filter((m) => isOn(m.view?.state[powerState(m.device)])).length;
  const inputs = inputChoices(members.map((m) => m.device), ui.profiles);
  const sourceState = (d: UiDevice) => (ui.profiles[d.profile]?.capabilities.source as { state?: string } | undefined)?.state;
  const lastInputs = new Set(members.map((m) => { const k = sourceState(m.device); return k ? String(m.view?.state[k] ?? "") : ""; }));
  const wallInput = lastInputs.size === 1 ? [...lastInputs][0] : undefined;
  // The wall's PC is the agent its panels are reached through.
  const agentId = members.find((m) => m.device.location !== "server")?.device.location;
  const agent = agentId ? state.agents[agentId] : undefined;

  return (
    <section className={`card wall${agent && !agent.online ? " offline" : ""}`}>
      <header>
        <h3>{w.name}</h3>
        <span className={`pill ${members.length && onCount === members.length ? "ok" : onCount ? "warn" : ""}`}>
          {onCount}/{members.length} on
        </span>
      </header>
      {agent && (
        <div className="apps">
          <span className={`pill ${agent.online ? "ok" : "bad"}`}>{agent.online ? "PC online" : "PC offline"}</span>
          {agent.online &&
            agent.apps.map((a) => (
              <span key={a.name} className="app">
                <span className={`pill ${a.running ? "ok" : a.running === false ? "bad" : ""}`} title={a.error ?? ""}>
                  {a.name}: {a.running ? "running" : a.running === false ? "stopped" : "?"}
                </span>
                <button className="small" onClick={() => act(() => api.restartApp(agentId!, a.name), `Restarting ${a.name}`)}>
                  Restart
                </button>
              </span>
            ))}
        </div>
      )}
      <h4>Screens <span className="hint">tap one to turn it on or off</span></h4>
      <div className="panels" style={w.columns ? { gridTemplateColumns: `repeat(${w.columns}, minmax(0, 1fr))` } : undefined}>
        {members.map(({ device, view }) => {
          const on = isOn(view?.state[powerState(device)]);
          const problem = view?.problem ?? (!view?.online ? view?.error ?? "offline" : undefined);
          return (
            <button
              key={device.id}
              className={`panel${on ? " on" : ""}${problem ? " unreachable" : ""}`}
              title={`${device.name}: ${on ? "on" : "off"}${problem ? ` (${problem})` : ""}`}
              onClick={() => act(() => api.capability(device.id, "power", on ? "off" : "on"), `${device.name} ${on ? "off" : "on"}`)}
            >
              {device.name}
            </button>
          );
        })}
      </div>
      <div className="power">
        <button className="btn on" onClick={() => act(() => api.groupCapability(w.id, "power", "on"), `${w.name} on`)}>All on</button>
        <button className="btn off" onClick={() => act(() => api.groupCapability(w.id, "power", "off"), `${w.name} off`)}>All off</button>
      </div>
      {inputs.length > 0 && (
        <div>
          <h4>Input</h4>
          <div className="tiles">
            {inputs.map((o) => (
              <button
                key={String(o.value)}
                className={`tile${wallInput === String(o.value) ? " active" : ""}`}
                title="Sent to every TV on this wall. TVs don't report their input, so this shows the last one sent."
                onClick={() => act(() => api.groupCapability(w.id, "source", "select", o.value), `${w.name}: ${o.label}`)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {w.mosaic && <LinkedMosaic link={w.mosaic} />}
    </section>
  );
}

/** The mosaic engine controls for one of its walls (presets, a stream, blank). */
function LinkedMosaic({ link }: { link: { device: string; group: string } }) {
  const { ui, state } = useApp();
  const device = ui.devices.find((d) => d.id === link.device);
  const profile = device && ui.profiles[device.profile];
  // The admin has taken this canvas or wall off the touch panel: the TV wall keeps its power and input controls.
  if (!device || !profile || !wallShown(device, link.group)) return null;
  const groupControl = profile.controls.find((c) => c.type === "group" && c.repeat);
  const list = state.devices[device.id]?.state.groupList;
  const item = Array.isArray(list) ? (list as { id: string }[]).find((g) => g.id === link.group) : undefined;
  if (!groupControl || !item) return <p className="muted">Mosaic wall “{link.group}” isn't reporting right now.</p>;
  if (canDraw(profile, item as MosaicGroup)) {
    return (
      <div className="mosaic-linked">
        <MosaicPanel device={device} profile={profile} groups={[item as MosaicGroup]} background={false} />
      </div>
    );
  }
  return (
    <div className="mosaic-linked">
      <Controls device={device} profile={profile} controls={groupControl.controls ?? []} item={item} />
    </div>
  );
}

/** What a canvas has to show outside the TV wall cards: its unlinked walls (drawn or plain) and engine-wide controls. */
function mosaicParts(device: UiDevice, profile: UiProfile, skip: Set<string>, list: unknown) {
  const groupControl = profile.controls.find((c) => c.type === "group" && c.repeat);
  const unlinked = Array.isArray(list) ? (list as { id: string; name?: string }[]).filter((g) => !skip.has(g.id) && wallShown(device, g.id)) : [];
  // Walls the engine reports splits for are drawn; tap a piece, then its source. The rest keep the plain controls.
  const drawn = unlinked.filter((g) => canDraw(profile, g as MosaicGroup)) as MosaicGroup[];
  const plain = unlinked.filter((g) => !canDraw(profile, g as MosaicGroup));
  // The drawn panel has the background in it, so the plain background card (a group with no repeat) is left out.
  const others: Control[] = profile.controls.filter((c) => c !== groupControl && (c.type === "presets" || (c.type === "group" && (!drawn.length || !!c.repeat))));
  return { groupControl, drawn, plain, others, any: unlinked.length > 0 || others.length > 0 };
}

function MosaicSection({ device, profile, skip }: { device: UiDevice; profile: UiProfile; skip: Set<string> }) {
  const { state } = useApp();
  const { groupControl, drawn, plain, others, any } = mosaicParts(device, profile, skip, state.devices[device.id]?.state.groupList);
  if (!any) return null;
  return (
    <div className="mosaic-section">
      <h2>{device.name}</h2>
      {drawn.length > 0 && <MosaicPanel device={device} profile={profile} groups={drawn} background />}
      <div className="controls">
        {groupControl &&
          plain.map((g) => (
            <div className="control-group" key={g.id}>
              <h4>{g.name ?? g.id}</h4>
              <Controls device={device} profile={profile} controls={groupControl.controls ?? []} item={g} />
            </div>
          ))}
      </div>
      <Controls device={device} profile={profile} controls={others} />
    </div>
  );
}

/** Input choices the TVs share (from their profiles' source capability), e.g. HDMI 1-4. */
function inputChoices(devices: UiDevice[], profiles: Record<string, UiProfile>) {
  let shared: { value: string | number; label: string }[] | undefined;
  for (const d of devices) {
    const p = profiles[d.profile];
    const src = p?.capabilities.source as { select: string; param: string } | undefined;
    if (!src) continue;
    const param = p.commands[src.select]?.params[src.param];
    const opts = (param?.values ?? []).map((v) => ({ value: v, label: param?.labels?.[String(v)] ?? String(v) }));
    shared = shared ? shared.filter((o) => opts.some((x) => String(x.value) === String(o.value))) : opts;
  }
  return shared ?? [];
}
