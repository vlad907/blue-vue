import type { SiteDevice } from "./adminApi.ts";
import { useDraft } from "./draft.tsx";
import { Check } from "./forms.tsx";
import { useLive } from "./live.tsx";

// Which NDI streams staff can put on a wall. The media server lists everything
// on the network, its own outputs included; here the admin ticks the ones that
// belong on the touch panel, canvas by canvas.

/** "BOX1 (ZowieBoxPro-54506)": the machine's name, and its stream in brackets. */
function parts(ndi: string) {
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(ndi);
  return m ? { machine: m[1], stream: m[2] } : { machine: ndi, stream: "" };
}

export function WallSources() {
  const { site, update, dirty } = useDraft();
  const live = useLive();
  const canvases = site.devices.filter((d) => d.profile === "mosaic-engine");
  const set = (id: string, streams: SiteDevice["streams"]) =>
    update((s) => {
      const d = s.devices.find((x) => x.id === id);
      if (d) d.streams = streams;
      return s;
    });

  return (
    <div>
      <h2>Wall sources</h2>
      <p className="help">
        Choose which NDI streams staff can put on each canvas's walls. The media server lists every stream on the network, including its own outputs to
        the wall PCs; untick the ones that shouldn't be on the touch panel. A stream that's already on a wall stays there until someone changes it.
        {dirty && <b> Press Save &amp; apply to put changes on the touch panel.</b>}
      </p>
      {!canvases.length && <p className="empty">Add the mosaic engine first (Devices → + Add mosaic engine).</p>}
      {canvases.map((c) => {
        const seen = ((live?.devices[c.id]?.state.streams as string[] | undefined) ?? []).slice().sort();
        const all = c.streams === undefined;
        const ticked = new Set(c.streams ?? seen);
        // Ticked streams that are off the network right now stay listed, so they aren't lost by accident.
        const rows = [...new Set([...seen, ...(c.streams ?? [])])].sort();
        const machines = [...new Set(rows.map((r) => parts(r).machine))];
        const toggle = (name: string, on: boolean) => {
          const next = new Set(ticked);
          if (on) next.add(name);
          else next.delete(name);
          set(c.id, rows.filter((r) => next.has(r)));
        };
        const others = canvases.filter((o) => o.id !== c.id);
        return (
          <section className="card" key={c.id}>
            <div className="row-between">
              <h3>{c.name}</h3>
              <span className="muted">{all ? `Every stream (${seen.length} on the network)` : `${ticked.size} of ${rows.length} shown`}</span>
            </div>
            <div className="row-tight">
              <Check value={all} label="Show every stream, including new ones" onChange={(on) => set(c.id, on ? undefined : seen)} />
            </div>
            {!all && (
              <>
                <div className="row-tight">
                  <button className="btn" onClick={() => set(c.id, rows)}>Tick all</button>
                  <button className="btn" onClick={() => set(c.id, [])}>Untick all</button>
                  {others.length > 0 && (
                    <button className="btn" onClick={() => others.forEach((o) => set(o.id, [...ticked]))}>Use this list on every canvas</button>
                  )}
                </div>
                {/* Machines with one stream each (the encoder boxes) share one grid. */}
                <div className="source-ticks single">
                  {machines.filter((m) => rows.filter((r) => parts(r).machine === m).length === 1).map((machine) => {
                    const r = rows.find((x) => parts(x).machine === machine)!;
                    const p = parts(r);
                    return <Check key={r} value={ticked.has(r)} label={`${p.machine}${p.stream ? ` (${p.stream})` : ""}${seen.includes(r) ? "" : " (off the network)"}`} onChange={(v) => toggle(r, v)} />;
                  })}
                </div>
                {/* A machine with several streams (the media server's outputs) gets one switch for all of them. */}
                {machines.map((machine) => {
                  const mine = rows.filter((r) => parts(r).machine === machine);
                  if (mine.length < 2) return null;
                  const on = mine.filter((r) => ticked.has(r)).length;
                  return (
                    <div className="source-group" key={machine}>
                      <div className="row-tight">
                        <b>{machine}</b>
                        <span className="muted">{on} of {mine.length} shown</span>
                        <button className="btn" onClick={() => set(c.id, rows.filter((r) => ticked.has(r) || mine.includes(r)))}>All</button>
                        <button className="btn" onClick={() => set(c.id, rows.filter((r) => ticked.has(r) && !mine.includes(r)))}>None</button>
                      </div>
                      <div className="source-ticks">
                        {mine.map((r) => <Check key={r} value={ticked.has(r)} label={`${parts(r).stream}${seen.includes(r) ? "" : " (off the network)"}`} onChange={(v) => toggle(r, v)} />)}
                      </div>
                    </div>
                  );
                })}
                {!rows.length && <p className="muted">No streams on the network right now.</p>}
                {!ticked.size && rows.length > 0 && <p className="help">Nothing is ticked: staff will have no streams to choose from on this canvas.</p>}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
