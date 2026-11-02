import { api } from "../api.ts";
import { Controls } from "../components/Controls.tsx";
import { useApp } from "../context.tsx";
import { isOn } from "../template.ts";

export function Walls() {
  const { ui, state, act } = useApp();
  const walls = ui.groups.filter((g) => g.kind === "wall");
  const layoutDevices = ui.devices.filter((d) => ui.profiles[d.profile]?.capabilities.layoutPresets);

  const allPower = (on: boolean) =>
    act(async () => {
      const results = await Promise.allSettled(walls.map((w) => api.groupCapability(w.id, "power", on ? "on" : "off")));
      const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${walls[i].name}: ${(r.reason as Error).message}`] : []));
      if (failed.length) throw new Error(failed.join("; "));
    }, `All walls ${on ? "on" : "off"}`);

  return (
    <>
      {walls.length > 1 && (
        <>
          <h2>All walls</h2>
          <div className="row">
            <button className="btn on" onClick={() => allPower(true)}>All on</button>
            <button className="btn off" onClick={() => allPower(false)}>All off</button>
          </div>
        </>
      )}

      {layoutDevices.map((d) => {
        const profile = ui.profiles[d.profile];
        const layout = profile.controls.filter((c) => c.type === "presets");
        return (
          <div key={d.id}>
            <h2>{d.name}</h2>
            <Controls device={d} profile={profile} controls={layout} />
          </div>
        );
      })}

      <div className="cards walls">
        {walls.map((w) => {
          const members = w.devices.map((id) => ({ device: ui.devices.find((d) => d.id === id), view: state.devices[id] })).filter((m) => m.device);
          const powerState = (id: string) => ui.profiles[ui.devices.find((d) => d.id === id)!.profile]?.capabilities.power?.state ?? "power";
          const onCount = members.filter((m) => isOn(m.view?.state[powerState(m.device!.id)])).length;
          // The wall's PC is the agent its panels are reached through.
          const agentId = members.find((m) => m.device!.location !== "server")?.device!.location;
          const agent = agentId ? state.agents[agentId] : undefined;
          return (
            <section key={w.id} className={`card wall${agent && !agent.online ? " offline" : ""}`}>
              <header>
                <h3>{w.name}</h3>
                <span className={`pill ${onCount === members.length ? "ok" : onCount ? "warn" : ""}`}>
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
              <div className="panels">
                {members.map(({ device, view }) => {
                  const on = isOn(view?.state[powerState(device!.id)]);
                  const problem = view?.problem ?? (!view?.online ? view?.error ?? "offline" : undefined);
                  return (
                    <button
                      key={device!.id}
                      className={`panel${on ? " on" : ""}${problem ? " unreachable" : ""}`}
                      title={`${device!.name}: ${on ? "on" : "off"}${problem ? ` (${problem})` : ""}`}
                      onClick={() => act(() => api.capability(device!.id, "power", on ? "off" : "on"), `${device!.name} ${on ? "off" : "on"}`)}
                    >
                      {device!.name}
                    </button>
                  );
                })}
              </div>
              <div className="row">
                <button className="btn on" onClick={() => act(() => api.groupCapability(w.id, "power", "on"), `${w.name} on`)}>On</button>
                <button className="btn off" onClick={() => act(() => api.groupCapability(w.id, "power", "off"), `${w.name} off`)}>Off</button>
              </div>
            </section>
          );
        })}
      </div>
      {!walls.length && !layoutDevices.length && <p className="empty">No video walls yet. Group panels into a wall in the admin.</p>}
    </>
  );
}
