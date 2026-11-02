import { useState } from "react";
import { adminApi, type Site } from "./adminApi.ts";
import { useDraft } from "./draft.tsx";
import { Num, Pick, Text } from "./forms.tsx";

type Channel = Site["channels"][number];

export function Channels() {
  const { site, update } = useDraft();
  const set = (i: number, patch: Partial<Channel>) => update((s) => { s.channels[i] = { ...s.channels[i], ...patch }; return s; });
  const sorted = site.channels.map((c, i) => ({ c, i })).sort((a, b) => a.c.number - b.c.number);

  return (
    <div>
      <h2>Channels</h2>
      <p className="help">The channel lineup names channels on the touch panel. Gracenote station ids add the TV guide listings.</p>
      <GracenoteImport />
      <table className="atable compact">
        <thead>
          <tr><th>Number</th><th>Name</th><th>Call sign</th><th>Gracenote station id</th><th>Category</th><th /></tr>
        </thead>
        <tbody>
          {sorted.map(({ c, i }) => (
            <tr key={i}>
              <td style={{ width: 100 }}><Num value={c.number} integer min={1} onChange={(v) => set(i, { number: v ?? 1 })} /></td>
              <td><Text value={c.name} onChange={(v) => set(i, { name: v })} /></td>
              <td><Text value={c.callSign} onChange={(v) => set(i, { callSign: v || undefined })} /></td>
              <td><Text value={c.stationId} onChange={(v) => set(i, { stationId: v || undefined })} /></td>
              <td><Text value={c.category} onChange={(v) => set(i, { category: v || undefined })} /></td>
              <td><button className="icon" onClick={() => update((s) => { s.channels.splice(i, 1); return s; })}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        className="btn"
        onClick={() => update((s) => { s.channels.push({ number: Math.max(0, ...s.channels.map((c) => c.number)) + 1, name: "New channel" }); return s; })}
      >
        + Add channel
      </button>
    </div>
  );
}

/** Looks up the Xfinity lineup by ZIP code and adds chosen channels with their station ids. */
function GracenoteImport() {
  const { site, update, notice } = useDraft();
  const [zip, setZip] = useState("");
  const [lineups, setLineups] = useState<{ id: string; name: string; type: string; location?: string }[]>();
  const [lineup, setLineup] = useState<string>();
  const [found, setFound] = useState<Channel[]>();
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState("");

  const wrap = <T,>(p: Promise<T>) => p.catch((err) => { notice(err.message, true); throw err; });

  return (
    <details className="card">
      <summary>Import from Gracenote</summary>
      <div className="row-tight">
        <Text value={zip} onChange={setZip} placeholder="ZIP code" />
        <button className="btn" disabled={!zip} onClick={() => wrap(adminApi.gracenoteLineups(zip)).then(setLineups)}>Find lineups</button>
        {lineups && (
          <Pick
            value={lineup}
            options={lineups.map((l) => ({ value: l.id, label: `${l.name} (${l.type}${l.location ? `, ${l.location}` : ""})` }))}
            onChange={(id) => {
              setLineup(id);
              wrap(adminApi.gracenoteChannels(id)).then((ch) => {
                setFound(ch);
                setPicked(new Set());
              });
            }}
          />
        )}
      </div>
      {found && (
        <>
          <div className="row-tight">
            <Text value={filter} onChange={setFilter} placeholder="Filter, e.g. ESPN" />
            <span className="muted">{picked.size} chosen</span>
            <span className="grow" />
            <button
              className="btn primary"
              disabled={!picked.size}
              onClick={() => {
                update((s) => {
                  for (const ch of found.filter((c) => picked.has(c.number))) {
                    const existing = s.channels.findIndex((c) => c.number === ch.number);
                    if (existing >= 0) s.channels[existing] = { ...s.channels[existing], callSign: ch.callSign, stationId: ch.stationId };
                    else s.channels.push(ch);
                  }
                  return s;
                });
                notice(`Added ${picked.size} channels; press Save & apply to keep them`);
                setPicked(new Set());
              }}
            >
              Add chosen channels
            </button>
          </div>
          <div className="pick-list">
            {found
              .filter((c) => !filter || `${c.number} ${c.name} ${c.callSign}`.toLowerCase().includes(filter.toLowerCase()))
              .slice(0, 400)
              .map((c) => (
                <label key={c.number} className="acheck">
                  <input
                    type="checkbox"
                    checked={picked.has(c.number)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(c.number);
                      else next.delete(c.number);
                      setPicked(next);
                    }}
                  />
                  {c.number} {c.name} {site.channels.some((x) => x.number === c.number) && <span className="muted">(in lineup)</span>}
                </label>
              ))}
          </div>
        </>
      )}
    </details>
  );
}
