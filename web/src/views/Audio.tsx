import type { Control, UiDevice } from "../api.ts";
import { Controls, resolve } from "../components/Controls.tsx";
import { useApp } from "../context.tsx";
import { render } from "../template.ts";

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
          <div className="cards zones">
            {zones.map(({ control, item }, i) => (
              <section className="card zone" key={i}>
                <h3>{render(control.label, { ...ctx, item })}</h3>
                <Controls device={device} profile={profile} controls={control.controls ?? []} item={item} />
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
