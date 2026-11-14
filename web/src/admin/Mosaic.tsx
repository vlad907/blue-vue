import { useState } from "react";
import { adminApi, slugify, type MosaicCanvas, type SiteDevice } from "./adminApi.ts";
import { useDraft } from "./draft.tsx";
import { Field, Text } from "./forms.tsx";

// Adding the mosaic engine: give the media server's address once, see every
// canvas it runs with its walls and presets, and add one device per canvas.

export function AddMosaic({ onClose }: { onClose: () => void }) {
  const { site, update, notice } = useDraft();
  const known = site.devices.find((d) => d.profile === "mosaic-engine");
  const [host, setHost] = useState(String(known?.settings.host ?? ""));
  const [port, setPort] = useState(Number(known?.settings.port ?? 8090));
  const [apiKey, setApiKey] = useState(String(known?.settings.apiKey ?? ""));
  const [found, setFound] = useState<MosaicCanvas[]>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();

  // A canvas counts as added if the draft has a device for it too, saved or not.
  const addedAs = (c: MosaicCanvas) =>
    site.devices.find((d) => d.profile === "mosaic-engine" && String(d.settings.host ?? "") === host.trim() && String(d.settings.canvas ?? "") === c.id)?.name;

  const read = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      const r = await adminApi.mosaicCanvases(host.trim(), port);
      setFound(r.canvases);
      setPicked(new Set(r.canvases.filter((c) => !addedAs(c)).map((c) => c.id)));
      setNote(`${r.canvases.length} canvas${r.canvases.length === 1 ? "" : "es"} found${r.simulated ? " (simulated)" : ""}.`);
    } catch (err) {
      setFound(undefined);
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const chosen = (found ?? []).filter((c) => picked.has(c.id) && !addedAs(c));
  const add = () => {
    update((s) => {
      const taken = s.devices.map((d) => d.id);
      for (const c of chosen) {
        const id = slugify(`Mosaic ${c.name}`, taken);
        taken.push(id);
        const settings: Record<string, unknown> = { host: host.trim(), port, canvas: c.id };
        if (apiKey.trim()) settings.apiKey = apiKey.trim();
        s.devices.push({ id, name: `Mosaic: ${c.name}`, profile: "mosaic-engine", location: "server", enabled: true, settings } satisfies SiteDevice);
      }
      return s;
    });
    notice(`Added ${chosen.length} mosaic canvas${chosen.length === 1 ? "" : "es"}. Press Save & apply, then link each TV wall to its mosaic wall on Video walls.`);
    onClose();
  };

  return (
    <aside className="drawer wide">
      <div className="row-between">
        <h2>Add mosaic engine</h2>
        <button className="icon" onClick={onClose}>✕</button>
      </div>
      <p className="help">Reads every canvas the media server runs, with its walls and presets. Each canvas becomes one device.</p>
      <div className="aform">
        <div className="aform two">
          <Field label="Media server address" required><Text value={host} onChange={setHost} placeholder="e.g. 192.168.1.187" /></Field>
          <Field label="Port"><input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value) || 8090)} /></Field>
        </div>
        <Field label="API key" help="Only if one is set in the mosaic editor (Settings → Access).">
          <Text value={apiKey} onChange={setApiKey} />
        </Field>
      </div>
      <div className="row-tight">
        <button className="btn" disabled={busy || !host.trim()} onClick={read}>{busy ? "Reading…" : "Read canvases"}</button>
        {note && <span className="help">{note}</span>}
      </div>

      {found && found.length > 0 && (
        <table className="atable compact">
          <thead>
            <tr><th /><th>Canvas</th><th>Walls and presets</th></tr>
          </thead>
          <tbody>
            {found.map((c) => {
              const existing = addedAs(c);
              return (
                <tr key={c.id} className={existing ? "muted" : ""}>
                  <td>
                    <input
                      type="checkbox"
                      disabled={!!existing}
                      checked={picked.has(c.id) && !existing}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(c.id);
                        else next.delete(c.id);
                        setPicked(next);
                      }}
                    />
                  </td>
                  <td>
                    {c.name} <span className="muted mono">{c.id}</span>
                    {existing && <div className="help">already added as {existing}</div>}
                    {!c.running && <div className="bad-text">Not running{c.error ? `: ${c.error}` : ""}</div>}
                  </td>
                  <td>
                    {c.walls.length
                      ? c.walls.map((w) => `${w.name} (${w.presets} preset${w.presets === 1 ? "" : "s"})`).join(", ")
                      : <span className="muted">No walls reported</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="row-tight drawer-actions">
        <span className="grow muted">{chosen.length ? `${chosen.length} to add` : "Nothing chosen"}</span>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!chosen.length} onClick={add}>Add {chosen.length || ""} canvas{chosen.length === 1 ? "" : "es"}</button>
      </div>
    </aside>
  );
}
