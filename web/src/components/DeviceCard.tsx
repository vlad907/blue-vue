import type { UiDevice } from "../api.ts";
import { useApp } from "../context.tsx";
import { Controls } from "./Controls.tsx";

export function DeviceCard({ device }: { device: UiDevice }) {
  const { ui, state } = useApp();
  const profile = ui.profiles[device.profile];
  const view = state.devices[device.id];
  const agent = device.location !== "server" ? ui.agents.find((a) => a.id === device.location) : undefined;
  const status = view?.problem ? "problem" : view?.online ? "online" : "offline";

  return (
    <section className={`card device ${status}`}>
      <header>
        <h3>{device.name}</h3>
        <span className={`dot ${status}`} title={view?.problem ?? (view?.online ? "online" : "offline")} />
      </header>
      <div className="meta">
        {profile?.name ?? device.profile}
        {agent && <> · via {agent.name}</>}
      </div>
      {view?.problem && <p className="err">{view.problem}</p>}
      {!view?.problem && view?.error && !view.online && <p className="err">{view.error}</p>}
      {profile && !view?.problem && <Controls device={device} profile={profile} controls={profile.controls} />}
    </section>
  );
}
