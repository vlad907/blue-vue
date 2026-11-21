import { api, type Control, type UiDevice, type UiProfile } from "../api.ts";
import { Controls } from "../components/Controls.tsx";
import { MosaicPanel, canDraw, type MosaicGroup } from "../components/MosaicPanel.tsx";
import { useApp } from "../context.tsx";
import { isOn } from "../template.ts";

type Wall = ReturnType<typeof useApp>["ui"]["groups"][number];

export function Walls() {
  const { ui, state, act } = useApp();
  const walls = ui.groups.filter((g) => g.kind === "wall");
  const layoutDevices = ui.devices.filter((d) => ui.profiles[d.profile]?.capabilities.layoutPresets);
  const linked = (deviceId: string) => new Set(walls.filter((w) => w.mosaic?.device === deviceId).map((w) => w.mosaic!.group));

  const everyWall = (label: string, run: (w: Wall) => Promise<unknown>) =>
    act(async () => {
      const results = await Promise.allSettled(walls.map(run));
      const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${walls[i].name}: ${(r.reason as Error).message}`] : []));
      if (failed.length) throw new Error(failed.join("; "));
    }, label);

  return (
    <>
      {walls.length > 1 && (
        <div className="toolbar">
          <h2>All walls</h2>
          <div className="power">
            <button className="btn on" onClick={() => everyWall("All walls on", (w) => api.groupCapability(w.id, "power", "on"))}>All on</button>
            <button className="btn off" onClick={() => everyWall("All walls off", (w) => api.groupCapability(w.id, "power", "off"))}>All off</button>
            {/* No "all TVs to one input" here on purpose: walls use different inputs, and each TV returns to its own when turned on. */}
          </div>
        </div>
      )}

      {/* Mosaic walls not tied to a TV wall below, and engine-wide controls like scenes. */}
      {layoutDevices.map((d) => (
        <MosaicSection key={d.id} device={d} profile={ui.profiles[d.profile]} skip={linked(d.id)} />
      ))}

      <div className="cards walls">
        {walls.map((w) => <WallCard key={w.id} wall={w} />)}
      </div>
      {!walls.length && !layoutDevices.length && <p className="empty">No video walls yet. Group panels into a wall in the admin.</p>}
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
  if (!device || !profile) return null;
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

function MosaicSection({ device, profile, skip }: { device: UiDevice; profile: UiProfile; skip: Set<string> }) {
  const { state } = useApp();
  const groupControl = profile.controls.find((c) => c.type === "group" && c.repeat);
  const list = state.devices[device.id]?.state.groupList;
  const unlinked = Array.isArray(list) ? (list as { id: string; name?: string }[]).filter((g) => !skip.has(g.id)) : [];
  // Walls the engine reports splits for are drawn; tap a piece, then its source. The rest keep the plain controls.
  const drawn = unlinked.filter((g) => canDraw(profile, g as MosaicGroup)) as MosaicGroup[];
  const plain = unlinked.filter((g) => !canDraw(profile, g as MosaicGroup));
  // The drawn panel has the background in it, so the plain background card (a group with no repeat) is left out.
  const others: Control[] = profile.controls.filter((c) => c !== groupControl && (c.type === "presets" || (c.type === "group" && (!drawn.length || !!c.repeat))));
  if (!unlinked.length && !others.length) return null;
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
