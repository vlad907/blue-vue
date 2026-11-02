import { useEffect, useRef, useState } from "react";
import { api, type Control, type Param, type UiDevice, type UiProfile } from "../api.ts";
import { useApp } from "../context.tsx";
import { isOn, lookup, render, renderParams } from "../template.ts";

// Renders a profile's `controls` list. Each widget reads device state and runs
// the profile's commands; nothing here knows about specific devices.

interface Props {
  device: UiDevice;
  profile: UiProfile;
  controls: Control[];
  item?: unknown; // the current item inside a repeated group
}

interface Option {
  value: string | number;
  label: string;
}

export function Controls({ device, profile, controls, item }: Props) {
  return (
    <div className="controls">
      {controls.map((c, i) => (
        <ControlView key={i} device={device} profile={profile} control={c} item={item} />
      ))}
    </div>
  );
}

function ControlView({ device, profile, control: c, item }: { device: UiDevice; profile: UiProfile; control: Control; item?: unknown }) {
  const { ui, state, act } = useApp();
  const deviceState = state.devices[device.id]?.state ?? {};
  const ctx = { settings: device.settings, item, device, state: deviceState };
  const value = c.state ? resolve(render(c.state, ctx), ctx) : undefined;
  const label = render(c.label, ctx);
  const baseParams = renderParams(c.params, ctx);
  const param: Param | undefined = c.command && c.param ? profile.commands[c.command]?.params[c.param] : undefined;
  const run = (command: string | undefined, extra: Record<string, unknown> = {}, ok?: string) => {
    if (!command) return;
    void act(() => api.command(device.id, command, { ...baseParams, ...extra }), ok);
  };
  const coerce = (v: unknown) => (param?.type === "integer" || param?.type === "number" ? Number(v) : v);

  switch (c.type) {
    case "group": {
      const list = c.repeat ? resolve(c.repeat, ctx) : [undefined];
      if (!Array.isArray(list) || !list.length) return null;
      return (
        <>
          {list.map((it, i) => (
            <div className="control-group" key={i}>
              <h4>{render(c.label, { ...ctx, item: it })}</h4>
              <Controls device={device} profile={profile} controls={c.controls ?? []} item={it} />
            </div>
          ))}
        </>
      );
    }

    case "status":
      return (
        <div className="status-row">
          <span className="muted">{label}</span>
          <b>{value === undefined || value === "" ? "—" : channelLabel(ui.channels, value)}</b>
        </div>
      );

    case "button":
      return (
        <button className="btn" onClick={() => run(c.command)}>
          {label || profile.commands[c.command ?? ""]?.label || c.command}
        </button>
      );

    case "toggle": {
      const on = isOn(value);
      const click = () => {
        if (c.on && c.off) run(on ? c.off : c.on);
        else if (c.command && c.param) run(c.command, { [c.param]: !on });
      };
      return (
        <div className="row-between">
          <span>{label}</span>
          <button className={`switch${on ? " on" : ""}`} onClick={click} aria-pressed={on}>
            {on ? "On" : "Off"}
          </button>
        </div>
      );
    }

    case "slider":
      return <Slider label={label} param={param} value={typeof value === "number" ? value : undefined} onSend={(v) => run(c.command, { [c.param!]: v })} />;

    case "select": {
      const options = optionsFor(c, param, { ...ctx, ...baseParams }, ui.channels);
      return (
        <label className="field">
          <span>{label}</span>
          <select value={value === undefined ? "" : String(value)} onChange={(e) => run(c.command, { [c.param!]: coerce(e.target.value) })}>
            {value === undefined && <option value="">—</option>}
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      );
    }

    case "presets": {
      const options = optionsFor(c, param, { ...ctx, ...baseParams }, ui.channels);
      if (!options.length) return null;
      return (
        <div>
          {label && <h4>{label}</h4>}
          <div className="tiles">
            {options.map((o) => (
              <button
                key={o.value}
                className={`tile${value !== undefined && String(value) === String(o.value) ? " active" : ""}`}
                onClick={() => run(c.command, { [c.param!]: coerce(o.value) }, o.label)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      );
    }

    case "keypad":
      return <Keypad label={label || "Tune"} onEnter={(n) => run(c.command, { [c.param!]: n }, `${label || "Tune"} ${n}`)} />;

    case "dpad":
      return <Dpad keys={c.keys ?? {}} onKey={(k) => run(c.command, { [c.param!]: k })} />;
  }
}

/** Choices for a select/presets: a settings list, the param's settings list, or the enum's values. */
/**
 * Finds a value for a profile path: a device state key ("power",
 * "groups.main-wall.activePreset", or "state.streams"), or a path into the
 * settings or the repeated item ("settings.zones", "item.presets").
 */
function resolve(path: string, ctx: Record<string, unknown>): unknown {
  const state = ctx.state as Record<string, unknown>;
  if (path.startsWith("state.")) return state[path.slice(6)];
  if (/^(settings|item|device)\./.test(path)) return lookup(ctx, path);
  return state[path] ?? lookup(ctx, path);
}

function optionsFor(c: Control, param: Param | undefined, ctx: Record<string, unknown>, channels: { number: number; name: string }[]): Option[] {
  const path = c.options ?? param?.optionsFrom;
  if (path) {
    const list = resolve(render(path, ctx), ctx);
    if (!Array.isArray(list)) return [];
    return list.map((it) => {
      if (it && typeof it === "object") {
        const o = it as Record<string, unknown>;
        const v = (o.index ?? o.id ?? o.value ?? o.number ?? o.name) as string | number;
        return { value: v, label: String(o.name ?? o.label ?? v) };
      }
      return { value: it as string | number, label: channelLabel(channels, it) };
    });
  }
  return (param?.values ?? []).map((v) => ({ value: v, label: param?.labels?.[String(v)] ?? String(v) }));
}

function channelLabel(channels: { number: number; name: string }[], v: unknown) {
  const ch = channels.find((c) => String(c.number) === String(v));
  return ch ? `${ch.number} ${ch.name}` : String(v);
}

function Slider({ label, param, value, onSend }: { label: string; param?: Param; value?: number; onSend: (v: number) => void }) {
  const min = param?.min ?? 0;
  const max = param?.max ?? 100;
  const [local, setLocal] = useState<number>();
  const timer = useRef<number>();
  // Follow device state unless the user is dragging.
  useEffect(() => {
    if (local === undefined) return;
    const t = window.setTimeout(() => setLocal(undefined), 1500);
    return () => clearTimeout(t);
  }, [local]);
  const shown = local ?? value ?? min;
  return (
    <label className="field">
      <span>
        {label} <span className="muted">{value === undefined && local === undefined ? "—" : Math.round(shown)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={param?.step ?? 1}
        value={shown}
        onChange={(e) => {
          const v = Number(e.target.value);
          setLocal(v);
          // Throttle so dragging doesn't flood the device.
          clearTimeout(timer.current);
          timer.current = window.setTimeout(() => onSend(v), 100);
        }}
      />
    </label>
  );
}

function Keypad({ label, onEnter }: { label: string; onEnter: (n: number) => void }) {
  const [digits, setDigits] = useState("");
  const press = (d: string) => setDigits((s) => (s.length < 4 ? s + d : s));
  return (
    <div className="keypad-wrap">
      <div className="entry">{digits || " "}</div>
      <div className="keypad">
        {"123456789".split("").map((d) => (
          <button key={d} onClick={() => press(d)}>{d}</button>
        ))}
        <button onClick={() => setDigits((s) => s.slice(0, -1))}>⌫</button>
        <button onClick={() => press("0")}>0</button>
        <button
          className="go"
          onClick={() => {
            if (digits) onEnter(Number(digits));
            setDigits("");
          }}
        >
          {label}
        </button>
      </div>
    </div>
  );
}

const DPAD_LAYOUT: [string, string][] = [["back", "Back"], ["up", "▲"], ["guide", "Guide"], ["left", "◀"], ["ok", "OK"], ["right", "▶"], ["menu", "Menu"], ["down", "▼"], ["exit", "Exit"]];

function Dpad({ keys, onKey }: { keys: Record<string, string>; onKey: (k: string) => void }) {
  const extras = Object.keys(keys).filter((k) => !DPAD_LAYOUT.some(([name]) => name === k));
  return (
    <div className="keypad dpad">
      {DPAD_LAYOUT.map(([name, text]) =>
        keys[name] ? <button key={name} onClick={() => onKey(keys[name])}>{text}</button> : <span key={name} />,
      )}
      {extras.map((name) => (
        <button key={name} onClick={() => onKey(keys[name])}>{name}</button>
      ))}
    </div>
  );
}
